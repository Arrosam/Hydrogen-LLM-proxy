import { asc, inArray, notInArray, sql } from "drizzle-orm";
import type { DB } from "../db";
import { imageCache } from "../db/schema";

/**
 * The OCR image-description cache: hash -> description, bounded by a byte
 * budget the admin sets in the dashboard. Eviction is least-recently-used, and
 * every read re-stamps `lastUsedAt`, so the images a workload keeps sending are
 * the ones that survive.
 *
 * "Storage used" is the sum of the rows' own bytes (hash + description), not the
 * SQLite file size: a file only ever grows, so measuring it would make the
 * budget unenforceable the moment anything was evicted. The bookkeeping cost is
 * one integer column, kept on the row so the running total is a single SUM.
 */

/** Rows read per eviction round. Bounds the memory one huge eviction touches. */
const EVICT_CHUNK = 256;

/** Hashes per `IN (...)` list. SQLite's parameter ceiling is far higher, but a
 * request can carry an unbounded number of images and one statement per 200 of
 * them costs nothing. */
const PARAM_CHUNK = 200;

export interface CacheEntry {
  hash: string;
  description: string;
}

export interface PutReport {
  /** Entries written (inserted or refreshed). */
  stored: number;
  /** Entries dropped because they cannot fit in the budget at all. */
  skipped: number;
  /** Rows evicted to make room. */
  evicted: number;
}

export interface CacheStats {
  entries: number;
  usedBytes: number;
}

/** What one entry costs against the budget. */
export function entrySize(hash: string, description: string): number {
  return Buffer.byteLength(hash, "utf8") + Buffer.byteLength(description, "utf8");
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Anything with the subset of the drizzle surface this repo uses — the real DB
 * or the transaction handle it hands a callback. */
type Queryable = Pick<DB, "select" | "insert" | "update" | "delete">;

export class ImageCacheRepo {
  constructor(private readonly db: DB) {}

  /** Descriptions known for these hashes. Absent keys are cache misses. Does not
   * touch `lastUsedAt` — call {@link touch} once the hits are actually used. */
  lookup(hashes: string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (hashes.length === 0) return out;
    for (const chunk of chunked([...new Set(hashes)], PARAM_CHUNK)) {
      const rows = this.db
        .select({ hash: imageCache.hash, description: imageCache.description })
        .from(imageCache)
        .where(inArray(imageCache.hash, chunk))
        .all();
      for (const r of rows) out.set(r.hash, r.description);
    }
    return out;
  }

  /** Re-stamp cache hits as just-used, so eviction sees them as fresh. */
  touch(hashes: string[], nowMs: number): void {
    if (hashes.length === 0) return;
    const at = new Date(nowMs);
    for (const chunk of chunked([...new Set(hashes)], PARAM_CHUNK)) {
      this.db.update(imageCache).set({ lastUsedAt: at }).where(inArray(imageCache.hash, chunk)).run();
    }
  }

  /**
   * Write descriptions, evicting least-recently-used rows first so the cache
   * stays within `maxBytes`.
   *
   * The whole batch is costed and freed for in ONE eviction pass before anything
   * is written: freeing room for the first image only would leave every other
   * image of the same request overflowing the budget, and a per-image pass would
   * evict rows this same batch is about to make room for anyway. An entry that
   * is being rewritten costs only the difference against the row already there,
   * and is never itself an eviction candidate.
   */
  put(entries: CacheEntry[], nowMs: number, maxBytes: number): PutReport {
    const report: PutReport = { stored: 0, skipped: 0, evicted: 0 };
    if (entries.length === 0) return report;
    if (maxBytes <= 0) {
      // Budget of zero = the cache is off. Nothing is stored, and nothing that
      // was stored before should still be occupying space.
      report.skipped = entries.length;
      this.clear();
      return report;
    }

    // Last write wins for a hash repeated inside one batch.
    const wanted = new Map<string, string>();
    for (const e of entries) wanted.set(e.hash, e.description);

    return this.db.transaction((tx) => {
      const existing = this.sizesOf(tx, [...wanted.keys()]);

      // An entry larger than the entire budget can never be held: storing it
      // would evict everything and still overflow.
      const writable: Array<{ hash: string; description: string; size: number; delta: number }> = [];
      for (const [hash, description] of wanted) {
        const size = entrySize(hash, description);
        if (size > maxBytes) {
          report.skipped++;
          continue;
        }
        writable.push({ hash, description, size, delta: size - (existing.get(hash) ?? 0) });
      }
      if (writable.length === 0) return report;

      const needed = writable.reduce((n, w) => n + w.delta, 0);
      const used = this.usedBytes(tx);
      if (used + needed > maxBytes) {
        report.evicted = this.evict(tx, used + needed - maxBytes, new Set(writable.map((w) => w.hash)));
      }

      // Re-read rather than assume: eviction frees what it could, which is less
      // than asked for when the only rows left are the ones being rewritten.
      let total = this.usedBytes(tx);
      const at = new Date(nowMs);
      // Cheapest first. Room was freed for the batch as a whole, so writing an
      // entry that shrinks a row before one that grows keeps every intermediate
      // total inside the budget — otherwise the grower could be turned away for
      // space the shrinker was about to give back.
      writable.sort((a, b) => a.delta - b.delta);
      for (const w of writable) {
        if (total + w.delta > maxBytes) {
          report.skipped++;
          continue;
        }
        tx.insert(imageCache)
          .values({ hash: w.hash, description: w.description, sizeBytes: w.size, lastUsedAt: at })
          .onConflictDoUpdate({
            target: imageCache.hash,
            set: { description: w.description, sizeBytes: w.size, lastUsedAt: at },
          })
          .run();
        total += w.delta;
        report.stored++;
      }
      return report;
    });
  }

  /**
   * Bring the cache back inside `maxBytes` after the budget itself changed.
   * Returns the number of rows evicted. A budget of 0 empties it.
   */
  enforceBudget(maxBytes: number): number {
    if (maxBytes <= 0) return this.clear();
    return this.db.transaction((tx) => {
      const used = this.usedBytes(tx);
      if (used <= maxBytes) return 0;
      return this.evict(tx, used - maxBytes, new Set());
    });
  }

  stats(): CacheStats {
    const row = this.db
      .select({
        entries: sql<number>`count(*)`,
        usedBytes: sql<number>`coalesce(sum(${imageCache.sizeBytes}), 0)`,
      })
      .from(imageCache)
      .get();
    return { entries: Number(row?.entries ?? 0), usedBytes: Number(row?.usedBytes ?? 0) };
  }

  /** Drop every entry. Returns the number of rows removed. */
  clear(): number {
    return this.db.delete(imageCache).run().changes ?? 0;
  }

  // --- internals -------------------------------------------------------------

  private usedBytes(tx: Queryable): number {
    const row = tx
      .select({ total: sql<number>`coalesce(sum(${imageCache.sizeBytes}), 0)` })
      .from(imageCache)
      .get();
    return Number(row?.total ?? 0);
  }

  private sizesOf(tx: Queryable, hashes: string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const chunk of chunked(hashes, PARAM_CHUNK)) {
      const rows = tx
        .select({ hash: imageCache.hash, sizeBytes: imageCache.sizeBytes })
        .from(imageCache)
        .where(inArray(imageCache.hash, chunk))
        .all();
      for (const r of rows) out.set(r.hash, r.sizeBytes);
    }
    return out;
  }

  /**
   * Delete least-recently-used rows until `needBytes` have been freed, skipping
   * `protectedHashes` (the rows the caller is about to rewrite). Stops early
   * when nothing evictable is left, so the caller must re-check the total rather
   * than trust that the room appeared.
   */
  private evict(tx: Queryable, needBytes: number, protectedHashes: ReadonlySet<string>): number {
    // Excluding the protected hashes in SQL (not by filtering the result) is
    // what guarantees progress: every row a round reads is one it may delete,
    // so a round either frees bytes or finds the table empty.
    const keep = [...protectedHashes];
    let freed = 0;
    let removed = 0;
    while (freed < needBytes) {
      const rows = tx
        .select({ hash: imageCache.hash, sizeBytes: imageCache.sizeBytes })
        .from(imageCache)
        .where(keep.length ? notInArray(imageCache.hash, keep) : undefined)
        // `hash` breaks ties so a batch stamped with one timestamp evicts in a
        // stable order instead of an arbitrary one.
        .orderBy(asc(imageCache.lastUsedAt), asc(imageCache.hash))
        .limit(EVICT_CHUNK)
        .all();
      if (rows.length === 0) break;

      const victims: string[] = [];
      for (const r of rows) {
        victims.push(r.hash);
        freed += r.sizeBytes;
        if (freed >= needBytes) break;
      }
      tx.delete(imageCache).where(inArray(imageCache.hash, victims)).run();
      removed += victims.length;
    }
    return removed;
  }
}
