import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import type { ProviderType } from "@areelai/wire-format";

/** Epoch-millis timestamp column defaulting to "now" at the DB level. */
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(strftime('%s','now') * 1000)`);

// ---------------------------------------------------------------------------
// Egress proxies — an outbound network hop a provider's traffic is sent
// through. Purely a transport concern: a proxy changes HOW a provider is
// reached, never what is sent or how the answer is read.
//
// The password is AES-256-GCM encrypted under the master key, the same scheme
// as provider API keys and client tokens.
// ---------------------------------------------------------------------------
export const proxies = sqliteTable(
  "proxies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    /** Only the schemes undici's ProxyAgent speaks. SOCKS would need a
     * hand-written connector and is deliberately not offered yet. */
    scheme: text("scheme", { enum: ["http", "https"] }).notNull().default("http"),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    username: text("username"),
    /** Master-key-encrypted proxy password (same columns as providers/tokens). */
    passwordCiphertext: text("password_ciphertext"),
    passwordIv: text("password_iv"),
    passwordTag: text("password_tag"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({ nameIdx: uniqueIndex("proxies_name_idx").on(t.name) }),
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
    altEndpoints: text("alt_endpoints", { mode: "json" }).$type<Array<{ type: ProviderType; baseUrl: string }>>(),
    /** Optional hard cap on the max output tokens this provider accepts; the
     * thinking policy fits budgets under it so a request is never rejected. */
    maxOutputTokens: integer("max_output_tokens"),
    /** Send this provider's upstream traffic through a proxy. Null = connect
     * directly. `set null` on delete so removing a proxy degrades to a direct
     * connection rather than orphaning the provider. */
    proxyId: integer("proxy_id").references(() => proxies.id, { onDelete: "set null" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({ nameIdx: uniqueIndex("providers_name_idx").on(t.name) }),
);

// ---------------------------------------------------------------------------
// Provider model catalogs — the model ids a provider itself reported from its
// /models endpoint, captured when the provider is tested. A cache of what the
// upstream offers, replaced wholesale on every refresh.
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

export type Provider = typeof providers.$inferSelect;
export type ProxyRow = typeof proxies.$inferSelect;
export type ProviderAvailableModel = typeof providerAvailableModels.$inferSelect;
export type Model = typeof models.$inferSelect;
export type ModelProvider = typeof modelProviders.$inferSelect;

/** This package's tables, parents before children (the order a copy or a
 * restore must insert in with foreign keys on). */
export const SUPPLIER_TABLES = ["proxies", "providers", "provider_available_models", "models", "model_providers"] as const;
