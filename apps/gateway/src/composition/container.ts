import type Database from "better-sqlite3";
import { loadConfig, type AppConfig } from "../config/index.js";
import { openDatabase, type DB } from "../db/index.js";
import type { LegacyImportReport } from "../db/legacyImport.js";
import { verifyOrInitMasterKey } from "../security/masterKey.js";
import {
  createSupplierStores,
  type Catalog,
  type MappingRepo,
  type ModelRepo,
  type ProviderModelRepo,
  type ProviderRepo,
  type ProxyRepo,
  type SupplierStores,
} from "@areelai/supplier-management";
import {
  createUserStores,
  seedAdminIfEmpty,
  Sessions,
  type SeedResult,
  type TokenRepo,
  type UsageMeter,
  type UserRepo,
  type UserStores,
} from "@areelai/user-management";
import {
  createModelServiceStores,
  EgressProxyPool,
  ServiceFactory,
  ServiceValidator,
  SsrfGuard,
  UpstreamClient,
  type HostedToolRepo,
  type ModelServiceStores,
  type ServiceRepo,
} from "@areelai/model-services";
import { createMicroAgentStores, registerMicroAgentKind, type ImageCacheRepo, type MicroAgentStores } from "@areelai/micro-agent";
import { RequestLogRepo } from "../persistence/requestLogRepo.js";
import { SettingsRepo } from "../persistence/settingsRepo.js";
import { StatsQueries } from "../persistence/statsQueries.js";
import { StatsCache } from "../persistence/statsCache.js";
import { LogPruner } from "../persistence/logPruner.js";
import { ResponseRepo } from "../persistence/responseRepo.js";
import { RequestLogger } from "../observability/requestLogger.js";
import { ActiveRequestRegistry } from "../observability/activeRequests.js";
import { UpdateService } from "../update/updateService.js";

/**
 * The composition root: owns every long-lived instance and wires the dependency
 * graph. One SQLite connection is shared by every package's stores; each
 * package sees only its own tables through its own typed handle. There is no
 * global DB/singleton -- everything is constructed here and injected.
 */
export interface Container {
  config: AppConfig;
  sqlite: Database.Database;
  /** The gateway's own tables (settings, logs, stateful Responses). */
  db: DB;
  /** Set on the boot that imported a legacy hydrogen.db. */
  legacyImport: LegacyImportReport | null;

  supplier: SupplierStores;
  user: UserStores;
  modelServices: ModelServiceStores;
  microAgent: MicroAgentStores;

  // Package stores, aliased under the names the routes use.
  providers: ProviderRepo;
  /** Egress proxy profiles; a provider may route its traffic through one. */
  proxies: ProxyRepo;
  providerModels: ProviderModelRepo;
  models: ModelRepo;
  mappings: MappingRepo;
  catalog: Catalog;
  services: ServiceRepo;
  hostedTools: HostedToolRepo;
  tokens: TokenRepo;
  users: UserRepo;
  usageMeter: UsageMeter;
  imageCache: ImageCacheRepo;
  sessions: Sessions;

  /** Dispatchers for egress proxies. Owned here so they are shut down once. */
  egressPool: EgressProxyPool;
  responses: ResponseRepo;
  logs: RequestLogRepo;
  settings: SettingsRepo;
  stats: StatsQueries;
  statsCache: StatsCache;
  pruner: LogPruner;
  ssrf: SsrfGuard;
  transport: UpstreamClient;
  validator: ServiceValidator;
  factory: ServiceFactory;
  requestLogger: RequestLogger;
  activeRequests: ActiveRequestRegistry;
  updates: UpdateService;
}

/** Load config, open + migrate the DB, verify the master key, seed the admin, wire everything. */
export async function boot(): Promise<Container> {
  const config = loadConfig();

  const { db, sqlite, legacyImport } = openDatabase(config.dataDir, (msg) => console.log(`[db] ${msg}`));
  verifyOrInitMasterKey(db, config.masterKey);

  const supplier = createSupplierStores(sqlite, config.masterKey);
  const user = createUserStores(sqlite, config.masterKey);
  const modelServices = createModelServiceStores(sqlite, config.masterKey);
  const microAgent = createMicroAgentStores(sqlite);

  const seed = await seedAdminIfEmpty(user.db, config.admin);
  if (seed.created) printInitialAdmin(seed);

  const logs = new RequestLogRepo(db);
  const settings = new SettingsRepo(db, {
    allowPrivate: config.allowPrivateUpstreams,
    logPayloadMaxChars: config.logPayloadMaxChars,
    simulatedStreamingTokenRate: config.simulatedStreamingTokenRate,
    sessionTtlMs: config.sessionTtlMs,
    imageCacheMaxBytes: config.imageCacheMaxBytes,
    promptCacheTtlMinutes: 30,
  });
  const stats = new StatsQueries(db);
  const responses = new ResponseRepo(db, () => settings.responseRetentionDays() * 86_400_000);
  responses.failInterrupted();
  responses.prune();
  // Seed the incremental stats counters: full aggregation on first boot, then
  // only the rows the last flush missed. Everything after is in-memory bumps.
  const statsCache = new StatsCache(stats, settings);
  statsCache.init();
  const pruner = new LogPruner(db);

  // Teach model-services the Micro Agent kind, with the OCR cache under the
  // live budget setting. Until this runs, a micro_agent row is an unknown kind.
  registerMicroAgentKind({ ocrCache: microAgent.ocrCache(() => settings.imageCacheMaxBytes()) });

  const sessions = new Sessions({ secret: config.sessionSecret, ttlMs: config.sessionTtlMs, cookieSecure: config.cookieSecure });

  const ssrf = new SsrfGuard({ allowPrivate: () => settings.allowPrivate(), allowlist: () => settings.allowlist() });
  const egressPool = new EgressProxyPool();
  const transport = new UpstreamClient(ssrf, egressPool);
  const validator = new ServiceValidator(supplier.catalog, modelServices.services);
  const activeRequests = new ActiveRequestRegistry();
  const factory = new ServiceFactory(
    modelServices.services,
    {
      catalog: supplier.catalog,
      transport,
      simulatedStreamingTokenRate: () => settings.simulatedStreamingTokenRate(),
      promptCacheTtlMinutes: () => settings.promptCacheTtlMinutes(),
    },
    () => settings.logPayloadMaxChars(),
    modelServices.hostedTools,
  );
  const requestLogger = new RequestLogger(logs, () => settings.logPayloadMaxChars(), statsCache);
  const updates = new UpdateService({ repo: config.updateRepo, restartEnabled: config.updateRestartEnabled });

  return {
    config, sqlite, db, legacyImport,
    supplier, user, modelServices, microAgent,
    providers: supplier.providers,
    proxies: supplier.proxies,
    providerModels: supplier.providerModels,
    models: supplier.models,
    mappings: supplier.mappings,
    catalog: supplier.catalog,
    services: modelServices.services,
    hostedTools: modelServices.hostedTools,
    tokens: user.tokens,
    users: user.users,
    usageMeter: user.usage,
    imageCache: microAgent.imageCache,
    sessions,
    egressPool, responses, logs, settings, stats, statsCache, pruner,
    ssrf, transport, validator, factory, requestLogger, activeRequests, updates,
  };
}

/** Print the initial admin credentials prominently so the user can log in. */
function printInitialAdmin(seed: SeedResult): void {
  const line = "=".repeat(64);
  const rows = [
    "",
    line,
    "  Hydrogen - initial admin account created",
    `  URL:      http://localhost:<PORT>`,
    `  username: ${seed.username}`,
  ];
  if (seed.generated) {
    rows.push(`  password: ${seed.password}`);
    rows.push("  NOTE: this is a temporary password - you will be asked to");
    rows.push("        create a new one at first login.");
  } else {
    rows.push("  password: (the ADMIN_PASSWORD you set in the environment)");
  }
  rows.push(line, "");
  // eslint-disable-next-line no-console
  console.log(rows.join("\n"));
}
