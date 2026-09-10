import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { EncryptedBlob } from "@areelai/common";
import type { HttpTool } from "./toolHttp.js";

/** Epoch-millis timestamp column defaulting to "now" at the DB level. */
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(strftime('%s','now') * 1000)`);

// ---------------------------------------------------------------------------
// Model Services — the only entity exposed to clients. `definition` holds a
// step chain (kind "model_service") or the definition of any registered
// service kind (e.g. a Micro Agent), each of which may override a rich set of
// request parameters per step/stage.
// ---------------------------------------------------------------------------
export const modelServices = sqliteTable(
  "model_services",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    description: text("description"),
    /** The canonical kind of `definition`, denormalized for cheap listing and
     * filtering: "model_service" for a step chain, else the registered kind. */
    kind: text("kind").$type<string>().notNull().default("model_service"),
    definition: text("definition_json", { mode: "json" }).$type<unknown>().notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({ nameIdx: uniqueIndex("service_name_idx").on(t.name) }),
);

/** Operator-owned HTTP tools. Authentication headers are encrypted separately. */
export const hostedTools = sqliteTable("hosted_tools", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  config: text("config_json", { mode: "json" }).$type<Omit<HttpTool, "headers">>().notNull(),
  headersSecret: text("headers_secret", { mode: "json" }).$type<EncryptedBlob>().notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
}, t => ({ nameIdx: uniqueIndex("hosted_tools_name_idx").on(t.name) }));

/** Bindings live outside service definition JSON, so renaming a tool preserves them. */
export const serviceTools = sqliteTable("service_tools", {
  serviceId: integer("service_id").notNull().references(() => modelServices.id, { onDelete: "cascade" }),
  toolId: integer("tool_id").notNull().references(() => hostedTools.id, { onDelete: "cascade" }),
}, t => ({ pairIdx: uniqueIndex("service_tools_pair_idx").on(t.serviceId, t.toolId) }));

export type ModelServiceRow = typeof modelServices.$inferSelect;
export type HostedToolRow = typeof hostedTools.$inferSelect;

/** This package's tables, parents before children. */
export const MODEL_SERVICE_TABLES = ["model_services", "hosted_tools", "service_tools"] as const;
