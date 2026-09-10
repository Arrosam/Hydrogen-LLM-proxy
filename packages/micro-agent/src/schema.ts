import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";

/** Epoch-millis timestamp column defaulting to "now" at the DB level. */
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(strftime('%s','now') * 1000)`);

// ---------------------------------------------------------------------------
// Image (OCR) description cache. Content-addressed: the key is a hash of the
// image itself, the value the description an OCR model produced for it, so the
// same picture is never transcribed twice. `lastUsedAt` is the eviction key --
// the storage budget is enforced by deleting least-recently-used rows -- and
// it is re-stamped on every hit, which is why it is indexed.
// ---------------------------------------------------------------------------
export const imageCache = sqliteTable(
  "image_cache",
  {
    /** SHA-256 of the image content — see ocrCache.ts `imageHash`. */
    hash: text("hash").primaryKey(),
    description: text("description").notNull(),
    /** What this row costs against the budget: hash + description, UTF-8 bytes. */
    sizeBytes: integer("size_bytes").notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({ lastUsedIdx: index("image_cache_last_used_idx").on(t.lastUsedAt) }),
);

export type ImageCacheRow = typeof imageCache.$inferSelect;

/** This package's tables. */
export const MICRO_AGENT_TABLES = ["image_cache"] as const;
