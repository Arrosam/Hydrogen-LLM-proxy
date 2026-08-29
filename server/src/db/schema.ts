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
    /** Additional wire-format endpoints this provider serves, beyond the
     * primary `type`+`baseUrl` (e.g. the same gateway exposing both Chat
     * Completions and Responses). Same API key and extra headers apply. */
    altEndpoints: text("alt_endpoints", { mode: "json" }).$type<Array<{ type: "openai_completion" | "openai_responses" | "anthropic"; baseUrl: string }>>(),
    /** Optional hard cap on the max output tokens this provider accepts; the
     * thinking policy fits budgets under it so a request is never rejected. */
    maxOutputTokens: integer("max_output_tokens"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({ nameIdx: uniqueIndex("providers_name_idx").on(t.name) }),
);

// ---------------------------------------------------------------------------
// Provider model catalogs — the model ids a provider itself reported from its
// /models endpoint, captured when the provider is tested. Not configuration:
// a cache of what the upstream offers, so mapping a model can be a pick from a
// list instead of a hand-typed id. Replaced wholesale on every refresh.
// ---------------------------------------------------------------------------
export const providerAvailableModels = sqliteTable(
  "provider_available_models",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    providerId: integer("provider_id").notNull().references(() => providers.id, { onDelete: "cascade" }),
    /** The upstream model id, verbatim as the provider reported it. */
    modelId: text("model_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    pairIdx: uniqueIndex("provider_available_models_pair_idx").on(t.providerId, t.modelId),
    providerIdx: index("provider_available_models_provider_idx").on(t.providerId),
  }),
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
    /** Wire families this mapping may use, of the provider's available
     * endpoints. Null/empty = the provider's primary type only. */
    families: text("families", { mode: "json" }).$type<string[]>(),
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
// Client tokens. The SHA-256 hash is what authentication looks up; the secret
// itself is also kept, AES-256-GCM under the master key (same scheme as
// provider API keys), so an admin can copy an issued key again later.
// ---------------------------------------------------------------------------
export const tokens = sqliteTable(
  "tokens",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    /** Master-key-encrypted secret. Null on tokens issued before v1.5.2 —
     * those were hash-only and can never be shown again. */
    keyCiphertext: text("key_ciphertext"),
    keyIv: text("key_iv"),
    keyTag: text("key_tag"),
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
    /** The exact wire body sent upstream (after service overrides/translation),
     * for seeing the effective temperature/thinking/etc. Null when no upstream
     * call was made (auth/resolve errors) or for embeddings passthrough. */
    upstreamRequestBody: text("upstream_request_body"),
    responseHeaders: text("response_headers_json", { mode: "json" }).$type<Record<string, string>>(),
    responseBody: text("response_body"),

    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    /** Prompt tokens the provider served from its cache. A SUBSET of
     * promptTokens, not an addition to it: every provider reports the cache hit
     * inside the prompt count, so summing the two would double-count. Kept
     * because the cached share is what a prompt-caching setup is judged on, and
     * it is billed at a fraction of the miss rate. */
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    /** Anthropic cache_creation_input_tokens: prompt tokens written INTO the
     * cache on this request (billed at a premium). Reported separately from the
     * prompt count by that API, so it stands on its own here too. */
    cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
    /** Reasoning tokens inside completionTokens (a subset, same as cached). */
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
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
// Image (OCR) description cache. Content-addressed: the key is a hash of the
// image itself, the value the description an OCR model produced for it, so the
// same picture is never transcribed twice. `lastUsedAt` is the eviction key --
// the storage budget in settings is enforced by deleting least-recently-used
// rows -- and it is re-stamped on every hit, which is why it is indexed.
//
// Not part of a backup package: nothing here is configuration or history, and
// every row can be rebuilt by re-running OCR.
// ---------------------------------------------------------------------------
export const imageCache = sqliteTable(
  "image_cache",
  {
    /** SHA-256 of the image content — see execution/ocrCache.ts `imageHash`. */
    hash: text("hash").primaryKey(),
    description: text("description").notNull(),
    /** What this row costs against the budget: hash + description, UTF-8 bytes.
     * Stored rather than derived so the running total is one indexed SUM. */
    sizeBytes: integer("size_bytes").notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({ lastUsedIdx: index("image_cache_last_used_idx").on(t.lastUsedAt) }),
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
export type ProviderAvailableModel = typeof providerAvailableModels.$inferSelect;
export type Model = typeof models.$inferSelect;
export type ModelProvider = typeof modelProviders.$inferSelect;
export type ModelServiceRow = typeof modelServices.$inferSelect;
export type Token = typeof tokens.$inferSelect;
export type RequestLog = typeof requestLogs.$inferSelect;
export type ImageCacheRow = typeof imageCache.$inferSelect;
