import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import type { Message } from "@areelai/wire-format";

// Row types of the packages' tables, re-exported for the gateway's own code.
export type { User, Token } from "@areelai/user-management";
export type { Provider, ProxyRow, ProviderAvailableModel, Model, ModelProvider } from "@areelai/supplier-management";
export type { ModelServiceRow } from "@areelai/model-services";
export type { ImageCacheRow } from "@areelai/micro-agent";

/** Epoch-millis timestamp column defaulting to "now" at the DB level. */
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(strftime('%s','now') * 1000)`);

// ---------------------------------------------------------------------------
// The gateway's own tables: settings, the request log and its stats, and the
// stateful Responses store. References into other packages' tables (tokens,
// services) are plain ids: each package owns its rows, and the cascades that
// used to cross those lines are explicit calls in the gateway instead.
// ---------------------------------------------------------------------------

export const responseConversations = sqliteTable("response_conversations", {
  id: text("id").primaryKey(),
  tokenId: integer("token_id").notNull(),
  metadata: text("metadata_json", { mode: "json" }).$type<Record<string, string>>().notNull(),
  /** Incremented by item mutations; used to reject overlapping conversation turns. */
  revision: integer("revision").notNull().default(0),
  createdAt: createdAt(),
  touchedAt: integer("touched_at").notNull(),
}, t => ({ ownerIdx: index("response_conversations_token_idx").on(t.tokenId), ageIdx: index("response_conversations_touch_idx").on(t.touchedAt) }));

export const conversationItems = sqliteTable("conversation_items", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  id: text("id").notNull(),
  conversationId: text("conversation_id").notNull().references(() => responseConversations.id, { onDelete: "cascade" }),
  item: text("item_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
}, t => ({ itemIdx: index("conversation_items_id_idx").on(t.conversationId, t.id), orderIdx: index("conversation_items_order_idx").on(t.conversationId, t.sequence) }));

export const storedResponses = sqliteTable("stored_responses", {
  id: text("id").primaryKey(),
  tokenId: integer("token_id").notNull(),
  serviceId: integer("service_id"),
  previousResponseId: text("previous_response_id"),
  conversationId: text("conversation_id"),
  status: text("status", { enum: ["queued", "in_progress", "completed", "failed", "cancelled", "incomplete"] }).notNull(),
  background: integer("background", { mode: "boolean" }).notNull().default(false),
  response: text("response_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  inputItems: text("input_items_json", { mode: "json" }).$type<Record<string, unknown>[]>().notNull(),
  /** Full independent snapshot: deleting an ancestor never corrupts a completed child. */
  history: text("history_json", { mode: "json" }).$type<Message[]>().notNull(),
  createdAt: createdAt(),
  touchedAt: integer("touched_at").notNull(),
}, t => ({ ownerIdx: index("stored_responses_token_idx").on(t.tokenId), ageIdx: index("stored_responses_touch_idx").on(t.touchedAt), statusIdx: index("stored_responses_status_idx").on(t.status) }));

// ---------------------------------------------------------------------------
// Request logs — one row per client request. Captures the full HTTP request
// (method, path, headers, body — redacted) and response, plus the model and
// provider that actually served it as first-class indexed columns.
// ---------------------------------------------------------------------------
export const requestLogs = sqliteTable(
  "request_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Correlates the client request with its upstream attempts. */
    traceId: text("trace_id").notNull(),
    tokenId: integer("token_id"),
    serviceId: integer("service_id"),
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
    /** The exact wire body sent upstream (after service overrides/translation). */
    upstreamRequestBody: text("upstream_request_body"),
    responseHeaders: text("response_headers_json", { mode: "json" }).$type<Record<string, string>>(),
    responseBody: text("response_body"),

    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    /** Prompt tokens the provider served from its cache. A SUBSET of
     * promptTokens, not an addition to it -- see the convention in
     * wire-format's usage module. */
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    /** Anthropic cache_creation_input_tokens: prompt tokens written INTO the
     * cache on this request. Also a SUBSET of promptTokens. */
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
// Key/value settings (master-key sentinel, SSRF allowlist, log retention,
// the legacy-import record).
// ---------------------------------------------------------------------------
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const responseEvents = sqliteTable("response_events", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  responseId: text("response_id").notNull().references(() => storedResponses.id, { onDelete: "cascade" }),
  event: text("event", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
}, t => ({ responseIdx: index("response_events_response_idx").on(t.responseId, t.sequence) }));

export type RequestLog = typeof requestLogs.$inferSelect;

/** The gateway's tables, parents before children. */
export const GATEWAY_TABLES = ["response_conversations", "conversation_items", "stored_responses", "response_events", "request_logs", "settings"] as const;
