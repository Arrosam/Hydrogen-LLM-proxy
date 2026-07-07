import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";

/** Epoch-millis timestamp column defaulting to "now" at the DB level. */
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(strftime('%s','now') * 1000)`);

// ---------------------------------------------------------------------------
// Users — dashboard accounts. Roles: 'admin' | 'manager'.
// ---------------------------------------------------------------------------
export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["admin", "manager"] }).notNull().default("manager"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => ({ usernameIdx: uniqueIndex("users_username_idx").on(t.username) }),
);

// ---------------------------------------------------------------------------
// Providers — upstream API endpoints. The API key is AES-256-GCM encrypted.
// ---------------------------------------------------------------------------
export const providers = sqliteTable(
  "providers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    type: text("type", { enum: ["openai_completion", "openai_responses", "anthropic"] }).notNull(),
    baseUrl: text("base_url").notNull(),
    keyCiphertext: text("key_ciphertext"),
    keyIv: text("key_iv"),
    keyTag: text("key_tag"),
    /** Extra headers sent upstream, as a JSON object of string -> string. */
    extraHeaders: text("extra_headers", { mode: "json" }).$type<Record<string, string>>(),
    /** Optional hard cap on the max output tokens this provider accepts; the
     * thinking policy fits budgets under it so a request is never rejected. */
    maxOutputTokens: integer("max_output_tokens"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({ nameIdx: uniqueIndex("providers_name_idx").on(t.name) }),
);

// ---------------------------------------------------------------------------
// Models — internal catalog. Served to clients only through Model Services.
// ---------------------------------------------------------------------------
export const models = sqliteTable(
  "models",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    description: text("description"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({ nameIdx: uniqueIndex("models_name_idx").on(t.name) }),
);

// ---------------------------------------------------------------------------
// Model <-> Provider mapping. Supplies the upstream model id for a pair.
// ---------------------------------------------------------------------------
export const modelProviders = sqliteTable(
  "model_providers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    modelId: integer("model_id").notNull().references(() => models.id, { onDelete: "cascade" }),
    providerId: integer("provider_id").notNull().references(() => providers.id, { onDelete: "cascade" }),
    upstreamModel: text("upstream_model").notNull(),
    priority: integer("priority").notNull().default(0),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({ pairIdx: uniqueIndex("model_providers_pair_idx").on(t.modelId, t.providerId) }),
);

// ---------------------------------------------------------------------------
// Model Services — the only entity exposed to clients. `definition` holds a
// ModelService (resilience step chain) or a MicroAgent (stage orchestration),
// each of which may override a rich set of request parameters per step/stage.
// ---------------------------------------------------------------------------
export const modelServices = sqliteTable(
  "model_services",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    description: text("description"),
    /** "model_service" | "micro_agent" — mirrors definition.kind, denormalized
     * for cheap listing/filtering. */
    kind: text("kind", { enum: ["model_service", "micro_agent"] }).notNull().default("model_service"),
    definition: text("definition_json", { mode: "json" }).$type<unknown>().notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({ nameIdx: uniqueIndex("service_name_idx").on(t.name) }),
);

// ---------------------------------------------------------------------------
// Client tokens. Secret stored only as a SHA-256 hash + short display prefix.
// ---------------------------------------------------------------------------
export const tokens = sqliteTable(
  "tokens",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    ownerUserId: integer("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Array of service ids this token may call; null/empty = all. */
    scopeServices: text("scope_services_json", { mode: "json" }).$type<number[] | null>(),
    maxRequests: integer("max_requests"),
    maxTokens: integer("max_tokens"),
    usedRequests: integer("used_requests").notNull().default(0),
    usedTokens: integer("used_tokens").notNull().default(0),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({ hashIdx: uniqueIndex("tokens_hash_idx").on(t.keyHash) }),
);

// ---------------------------------------------------------------------------
// Request logs — one row per client request. Captures the full HTTP request
// (method, path, headers, body — redacted) and response, plus the model and
// provider that actually served it as first-class indexed columns so usage can
// be sliced by model/provider with a plain GROUP BY (no JSON scanning).
// ---------------------------------------------------------------------------
export const requestLogs = sqliteTable(
  "request_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Correlates the client request with its upstream attempts. */
    traceId: text("trace_id").notNull(),
    tokenId: integer("token_id").references(() => tokens.id, { onDelete: "set null" }),
    serviceId: integer("service_id").references(() => modelServices.id, { onDelete: "set null" }),
    /** The service/agent name the client asked for (the wire "model" field). */
    requestedService: text("requested_service"),
    /** The catalog model that actually served the request (winning attempt). */
    servedModel: text("served_model"),
    /** The provider that actually served the request (winning attempt). */
    servedProvider: text("served_provider"),

    ingressFormat: text("ingress_format", { enum: ["openai_completion", "anthropic", "openai_responses"] }).notNull(),
    egressFormat: text("egress_format", { enum: ["openai_completion", "anthropic", "openai_responses"] }),
    streaming: integer("streaming", { mode: "boolean" }).notNull().default(false),
    httpStatus: integer("http_status").notNull(),

    // Full HTTP request/response capture (token/secret headers redacted).
    requestMethod: text("request_method"),
    requestPath: text("request_path"),
    requestQuery: text("request_query"),
    requestHeaders: text("request_headers_json", { mode: "json" }).$type<Record<string, string>>(),
    requestBody: text("request_body"),
    responseHeaders: text("response_headers_json", { mode: "json" }).$type<Record<string, string>>(),
    responseBody: text("response_body"),

    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    /** Structured attempt tree (steps / nested agent calls) for the detail view. */
    attemptPath: text("attempt_path_json", { mode: "json" }).$type<unknown>(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => ({
    createdIdx: index("request_logs_created_idx").on(t.createdAt),
    traceIdx: index("request_logs_trace_idx").on(t.traceId),
    tokenIdx: index("request_logs_token_idx").on(t.tokenId),
    serviceIdx: index("request_logs_service_idx").on(t.serviceId),
    requestedIdx: index("request_logs_requested_idx").on(t.requestedService),
    servedModelIdx: index("request_logs_served_model_idx").on(t.servedModel),
    servedProviderIdx: index("request_logs_served_provider_idx").on(t.servedProvider),
    statusIdx: index("request_logs_status_idx").on(t.httpStatus),
  }),
);

// ---------------------------------------------------------------------------
// Key/value settings (master-key sentinel, SSRF allowlist, log retention).
// ---------------------------------------------------------------------------
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type User = typeof users.$inferSelect;
export type Provider = typeof providers.$inferSelect;
export type Model = typeof models.$inferSelect;
export type ModelProvider = typeof modelProviders.$inferSelect;
export type ModelServiceRow = typeof modelServices.$inferSelect;
export type Token = typeof tokens.$inferSelect;
export type RequestLog = typeof requestLogs.$inferSelect;
