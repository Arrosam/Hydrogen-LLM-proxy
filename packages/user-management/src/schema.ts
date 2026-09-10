import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    /** Array of service ids this token may call; null/empty = all. The ids
     * belong to another package's table, so this is a plain reference. */
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

export type User = typeof users.$inferSelect;
export type Token = typeof tokens.$inferSelect;

/** This package's tables, parents before children. */
export const USER_TABLES = ["users", "tokens"] as const;
