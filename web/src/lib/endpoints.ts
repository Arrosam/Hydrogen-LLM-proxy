/**
 * Every admin-API path the UI calls, relative to `API_PREFIX` (which `api.ts`
 * prepends). Pages name a resource here instead of spelling its path, so a
 * renamed endpoint is one edit.
 */

/** Mount point of the admin API; `api.ts` prefixes every request with it. */
export const API_PREFIX = "/admin/api";

type Id = number | string;

/** A collection path plus the path of one of its members. */
const member = (collection: string) => (id: Id): string => `${collection}/${id}`;

const SERVICES = "/services";
const MODELS = "/models";
const PROVIDERS = "/providers";
const MAPPINGS = "/mappings";
const TOKENS = "/tokens";
const PROXIES = "/proxies";
const TOOLS = "/tools";
const USERS = "/users";
const LOGS = "/logs";
const ACTIVE_REQUESTS = "/active-requests";
const UPDATE_CHECK = "/update/check";

export const API = {
  // Session
  me: "/me",
  login: "/login",
  logout: "/logout",
  changePassword: "/change-password",
  /** Public key check (no session). */
  check: "/check",

  // CRUD resources
  services: SERVICES,
  service: member(SERVICES),
  servicesValidate: `${SERVICES}/validate`,
  servicesTest: `${SERVICES}/test`,
  servicesTestOcr: `${SERVICES}/test-ocr`,
  models: MODELS,
  model: member(MODELS),
  providers: PROVIDERS,
  provider: member(PROVIDERS),
  providersTest: `${PROVIDERS}/test`,
  mappings: MAPPINGS,
  mapping: member(MAPPINGS),
  providerModels: "/provider-models",
  tokens: TOKENS,
  token: member(TOKENS),
  tokenSecret: (id: Id): string => `${TOKENS}/${id}/secret`,
  proxies: PROXIES,
  proxy: member(PROXIES),
  proxiesTest: `${PROXIES}/test`,
  tools: TOOLS,
  tool: member(TOOLS),
  toolsPreview: `${TOOLS}/preview`,
  users: USERS,
  user: member(USERS),

  // Observability
  logs: LOGS,
  log: member(LOGS),
  activeRequests: ACTIVE_REQUESTS,
  // A trace id may be client-supplied text ("/", "?", "#"), unlike the numeric ids of the other members.
  activeRequest: (traceId: string): string => member(ACTIVE_REQUESTS)(encodeURIComponent(traceId)),
  statsSummary: "/stats/summary",
  statsTimeseries: "/stats/timeseries",
  statsByService: "/stats/by-service",
  statsByModelProvider: "/stats/by-model-provider",

  // Settings
  settingsResponseRetention: "/settings/response-retention",
  settingsVersion: "/settings/version",
  settingsLogRetention: "/settings/log-retention",
  settingsImageCache: "/settings/image-cache",
  settingsUpstreamAllowlist: "/settings/upstream-allowlist",
  settingsEnv: "/settings/env",
  settingsUiLanguage: "/settings/ui-language",

  // Maintenance
  updateCheck: UPDATE_CHECK,
  /** Bypasses the server's cached release lookup. */
  updateCheckRefresh: `${UPDATE_CHECK}?refresh=1`,
  updateRestart: "/update/restart",
  backupExport: "/backup/export",
  backupRestore: "/backup/restore",

  // Model bench
  benchTargets: "/bench/targets",
  benchMedia: "/bench/media",
  benchChat: "/bench/chat",
} as const;

/** The full URL of an admin-API path, for the few callers that use `fetch` directly. */
export const apiUrl = (path: string): string => `${API_PREFIX}${path}`;
