import type Database from "better-sqlite3";
import { loadConfig, type AppConfig } from "../config";
import { setConfig } from "../context";
import { openDatabase, type DB } from "../db";
import { seedAdminIfEmpty, type SeedResult } from "../db/bootstrap";
import { verifyOrInitMasterKey } from "../security/masterKey";
// Side-effect import: registers all three wire formats with the format registry.
import "../core/format";
import { ProviderRepo } from "../persistence/providerRepo";
import { ModelRepo } from "../persistence/modelRepo";
import { MappingRepo } from "../persistence/mappingRepo";
import { ServiceRepo } from "../persistence/serviceRepo";
import { TokenRepo } from "../persistence/tokenRepo";
import { UserRepo } from "../persistence/userRepo";
import { RequestLogRepo } from "../persistence/requestLogRepo";
import { SettingsRepo } from "../persistence/settingsRepo";
import { StatsQueries } from "../persistence/statsQueries";
import { LogPruner } from "../persistence/logPruner";
import { Catalog } from "../catalog/catalog";
import { SsrfGuard } from "../core/upstream/ssrf";
import { UpstreamClient } from "../core/upstream/client";
import { ServiceValidator } from "../execution/serviceValidator";
import { ServiceFactory } from "../execution/serviceFactory";
import { RequestLogger } from "../observability/requestLogger";
import { UsageMeter } from "../observability/usageMeter";
import { ActiveRequestRegistry } from "../observability/activeRequests";

/**
 * The composition root: owns every long-lived instance and wires the dependency
 * graph. There is no global DB/singleton -- everything is constructed here and
 * injected. (The config singleton is the one exception, kept for the preserved
 * auth code that reads session settings synchronously.)
 */
export interface Container {
  config: AppConfig;
  sqlite: Database.Database;
  db: DB;
  providers: ProviderRepo;
  models: ModelRepo;
  mappings: MappingRepo;
  services: ServiceRepo;
  tokens: TokenRepo;
  users: UserRepo;
  logs: RequestLogRepo;
  settings: SettingsRepo;
  stats: StatsQueries;
  pruner: LogPruner;
  catalog: Catalog;
  ssrf: SsrfGuard;
  transport: UpstreamClient;
  validator: ServiceValidator;
  factory: ServiceFactory;
  requestLogger: RequestLogger;
  usageMeter: UsageMeter;
  activeRequests: ActiveRequestRegistry;
}

/** Load config, open + migrate the DB, verify the master key, seed the admin, wire everything. */
export async function boot(): Promise<Container> {
  const config = loadConfig();
  setConfig(config); // kept for auth/session (getConfig).

  const { db, sqlite } = openDatabase(config.dataDir);
  verifyOrInitMasterKey(db, config.masterKey);

  const seed = await seedAdminIfEmpty(db, config.admin);
  if (seed.created) printInitialAdmin(seed);

  const providers = new ProviderRepo(db, config.masterKey);
  const models = new ModelRepo(db);
  const mappings = new MappingRepo(db);
  const services = new ServiceRepo(db);
  const tokens = new TokenRepo(db);
  const users = new UserRepo(db);
  const logs = new RequestLogRepo(db);
  const settings = new SettingsRepo(db);
  const stats = new StatsQueries(db);
  const pruner = new LogPruner(db);

  const catalog = new Catalog(models, providers, mappings);
  const ssrf = new SsrfGuard({ allowPrivate: config.allowPrivateUpstreams, allowlist: () => settings.allowlist() });
  const transport = new UpstreamClient(ssrf);
  const validator = new ServiceValidator(catalog, services);
  const activeRequests = new ActiveRequestRegistry();
  const factory = new ServiceFactory(services, { catalog, transport, progress: activeRequests, simulatedStreamingTokenRate: config.simulatedStreamingTokenRate }, config.logPayloadMaxChars);

  const requestLogger = new RequestLogger(logs, config.logPayloadMaxChars);
  const usageMeter = new UsageMeter(tokens);

  return {
    config, sqlite, db,
    providers, models, mappings, services, tokens, users, logs, settings, stats, pruner,
    catalog, ssrf, transport, validator, factory, requestLogger, usageMeter, activeRequests,
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
