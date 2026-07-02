import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";

/** Epoch-millis timestamp column with a DB-level default of "now". */
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(strftime('%s','now') * 1000)`);

// ---------------------------------------------------------------------------
// Users (dashboard accounts) - roles: 'admin' | 'manager'
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
  (t) => ({
    usernameIdx: uniqueIndex("users_username_idx").on(t.username),
  }),
);

// ---------------------------------------------------------------------------
// Providers (upstream API endpoints). API key is encrypted at rest.
// type: 'openai' | 'anthropic' | 'openai_compatible'
// ---------------------------------------------------------------------------
export const providers = sqliteTable(
  "providers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    type: text("type", { enum: ["openai", "anthropic", "openai_compatible"] }).notNull(),
    baseUrl: text("base_url").notNull(),
    // AES-256-GCM encrypted API key (nullable for keyless local upstreams).
    keyCiphertext: text("key_ciphertext"),
    keyIv: text("key_iv"),
    keyTag: text("key_tag"),
    // Extra headers sent to the upstream, JSON object of string->string.
    extraHeaders: text("extra_headers", { mode: "json" }).$type<Record<string, string>>(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({
    nameIdx: uniqueIndex("providers_name_idx").on(t.name),
  }),
);

// ---------------------------------------------------------------------------
// Models (internal catalog). A model is served by one or more providers.
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
  (t) => ({
    nameIdx: uniqueIndex("models_name_idx").on(t.name),
  }),
);

// ---------------------------------------------------------------------------
// Model <-> Provider mapping. Supplies the upstream model id for a pair.
// (priority is display/order only; routing never auto-picks a provider.)
// ---------------------------------------------------------------------------
export const modelProviders = sqliteTable(
  "model_providers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    modelId: integer("model_id")
      .notNull()
      .references(() => models.id, { onDelete: "cascade" }),
    providerId: integer("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    upstreamModel: text("upstream_model").notNull(),
    priority: integer("priority").notNull().default(0),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({
    pairIdx: uniqueIndex("model_providers_pair_idx").on(t.modelId, t.providerId),
  }),
);

// ---------------------------------------------------------------------------
// Model Use Behaviors (MUB) - the ONLY entity exposed to clients.
// steps_json holds the ordered resilience workflow (see core/mub types).
// ---------------------------------------------------------------------------
export const modelUseBehaviors = sqliteTable(
  "model_use_behaviors",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    description: text("description"),
    steps: text("steps_json", { mode: "json" }).$type<unknown>().notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({
    nameIdx: uniqueIndex("mub_name_idx").on(t.name),
  }),
);

// ---------------------------------------------------------------------------
// Client tokens. Secret stored only as a SHA-256 hash + short prefix.
// scope_mubs_json = array of MUB ids this token may call (null/empty = all).
// ---------------------------------------------------------------------------
export const tokens = sqliteTable(
  "tokens",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    ownerUserId: integer("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    scopeMubs: text("scope_mubs_json", { mode: "json" }).$type<number[] | null>(),
    maxRequests: integer("max_requests"),
    maxTokens: integer("max_tokens"),
    usedRequests: integer("used_requests").notNull().default(0),
    usedTokens: integer("used_tokens").notNull().default(0),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({
    hashIdx: uniqueIndex("tokens_hash_idx").on(t.keyHash),
  }),
);

// ---------------------------------------------------------------------------
// Request logs - one row per client request (across all MUB attempts).
// ---------------------------------------------------------------------------
export const requestLogs = sqliteTable(
  "request_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tokenId: integer("token_id").references(() => tokens.id, { onDelete: "set null" }),
    mubId: integer("mub_id").references(() => modelUseBehaviors.id, { onDelete: "set null" }),
    mubName: text("mub_name"),
    ingressFormat: text("ingress_format", { enum: ["openai", "anthropic"] }).notNull(),
    egressFormat: text("egress_format", { enum: ["openai", "anthropic"] }),
    streaming: integer("streaming", { mode: "boolean" }).notNull().default(false),
    httpStatus: integer("http_status").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    // Each attempt: { step, model, provider, httpStatus, retries, error?, latencyMs }
    attemptPath: text("attempt_path_json", { mode: "json" }).$type<unknown>(),
    requestPayload: text("request_payload_json"),
    responsePayload: text("response_payload_json"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => ({
    createdIdx: index("request_logs_created_idx").on(t.createdAt),
    tokenIdx: index("request_logs_token_idx").on(t.tokenId),
    mubIdx: index("request_logs_mub_idx").on(t.mubId),
  }),
);

// ---------------------------------------------------------------------------
// Key/value settings (holds the master-key verification sentinel).
// ---------------------------------------------------------------------------
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type User = typeof users.$inferSelect;
export type Provider = typeof providers.$inferSelect;
export type Model = typeof models.$inferSelect;
export type ModelProvider = typeof modelProviders.$inferSelect;
export type ModelUseBehavior = typeof modelUseBehaviors.$inferSelect;
export type Token = typeof tokens.$inferSelect;
export type RequestLog = typeof requestLogs.$inferSelect;
