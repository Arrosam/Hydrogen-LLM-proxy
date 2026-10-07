import type Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
import { parseResponseRetentionDays } from "./settingsRepo";

export type RetentionPhase = "responses" | "conversations";
export interface AgeCursor { touchedAt: number; rowid: number }
export interface RetentionCursor { ttlMs?: number; responses: AgeCursor | null; conversations: AgeCursor | null }
export interface RetentionBatch { ttlMs: number; deleted: number; scanned: number; done: boolean; cursor: AgeCursor | null }
export interface RetentionResult { cursor: RetentionCursor; responses: number; conversations: number; scanned: number; batches: number; deferred?: "busy" | "failed" }
export const RETENTION_BATCH_SIZE = 32;
export const RETENTION_MAX_BATCHES = 64;
export const RETENTION_CYCLE_MS = 1_000;
export const RETENTION_YIELD_MS = 10;

/** Narrow index pages, never response JSON. No new indexes or startup migration. */
export function retentionCandidates(phase: RetentionPhase, after: false | "same" | "later"): string {
  const table = phase === "responses" ? "stored_responses" : "response_conversations";
  const index = phase === "responses" ? "stored_responses_touch_idx" : "response_conversations_touch_idx";
  return `SELECT rowid, touched_at AS touchedAt FROM ${table} INDEXED BY ${index}
    WHERE touched_at < ? ${after === "same" ? "AND touched_at = ? AND rowid > ?" : after === "later" ? "AND touched_at > ?" : ""}
    ORDER BY touched_at, rowid LIMIT ?`;
}

export function retentionBusy(error: unknown): boolean {
  return error instanceof Error && "code" in error && ["SQLITE_BUSY", "SQLITE_LOCKED"].includes(String(error.code));
}

/** Keep the last committed cursor/counts even if a later batch must defer. */
export async function runResponseRetentionCycle(queries: Pick<ResponseRetentionQueries, "batch">, previous: RetentionCursor, now = Date.now(),
  yieldBatch: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, RETENTION_YIELD_MS))): Promise<RetentionResult> {
  const result: RetentionResult = { cursor: { ...previous }, responses: 0, conversations: 0, scanned: 0, batches: 0 };
  const done = { responses: false, conversations: false };
  const started = performance.now();
  let phase: RetentionPhase = "responses";
  while (result.batches < RETENTION_MAX_BATCHES && performance.now() - started < RETENTION_CYCLE_MS) {
    if (done.responses && done.conversations) break;
    if (done[phase]) phase = phase === "responses" ? "conversations" : "responses";
    let batch: RetentionBatch;
    try { batch = queries.batch(phase, result.cursor[phase], now, result.cursor.ttlMs); }
    catch (error) { result.deferred = retentionBusy(error) ? "busy" : "failed"; break; }
    if (batch.ttlMs !== result.cursor.ttlMs) {
      result.cursor = { ttlMs: batch.ttlMs, responses: null, conversations: null };
      done.responses = done.conversations = false;
    }
    result.cursor[phase] = batch.cursor; done[phase] = batch.done;
    result[phase] += batch.deleted; result.scanned += batch.scanned; result.batches++;
    if (batch.ttlMs <= 0) break;
    phase = phase === "responses" ? "conversations" : "responses";
    if (!done.responses || !done.conversations) await yieldBatch();
  }
  return result;
}

export function retentionDelete(phase: RetentionPhase, limit: number): string {
  const ids = Array.from({ length: limit }, () => "?").join(",");
  // NOT INDEXED still permits rowid seeks. Avoid a scan of every terminal payload.
  return phase === "responses"
    ? `DELETE FROM stored_responses NOT INDEXED WHERE rowid IN (${ids}) AND touched_at < ?
       AND status IN ('completed','failed','cancelled','incomplete')`
    : `DELETE FROM response_conversations NOT INDEXED WHERE rowid IN (${ids}) AND touched_at < ?
       AND id NOT IN (SELECT conversation_id FROM stored_responses INDEXED BY stored_responses_status_idx
         WHERE status IN ('queued','in_progress') AND conversation_id IS NOT NULL)`;
}

/** Only the worker calls this in production. Recheck eligibility and active
 * reservations under the same short writer transaction as deletion. */
export class ResponseRetentionQueries {
  private readonly readTtlMs: () => number;
  private readonly selects: Record<RetentionPhase, [Database.Statement, Database.Statement, Database.Statement]>;
  private readonly deletes: Record<RetentionPhase, Database.Statement>;
  constructor(private readonly sqlite: Database.Database, private readonly batchSize = RETENTION_BATCH_SIZE, readTtlMs?: () => number) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 256) throw new Error("Invalid retention batch size");
    const setting = sqlite.prepare("SELECT value FROM settings WHERE key = 'response_retention_days'");
    this.readTtlMs = readTtlMs ?? (() => parseResponseRetentionDays((setting.get() as { value: string } | undefined)?.value) * 86_400_000);
    this.selects = {
      responses: [false, "same", "later"].map(after => sqlite.prepare(retentionCandidates("responses", after as false | "same" | "later"))) as [Database.Statement, Database.Statement, Database.Statement],
      conversations: [false, "same", "later"].map(after => sqlite.prepare(retentionCandidates("conversations", after as false | "same" | "later"))) as [Database.Statement, Database.Statement, Database.Statement],
    };
    this.deletes = { responses: sqlite.prepare(retentionDelete("responses", batchSize)), conversations: sqlite.prepare(retentionDelete("conversations", batchSize)) };
  }

  batch(phase: RetentionPhase, cursor: AgeCursor | null, now: number, previousTtl?: number): RetentionBatch {
    return this.sqlite.transaction(() => {
      const ttlMs = this.readTtlMs();
      if (ttlMs <= 0) return { ttlMs, deleted: 0, scanned: 0, done: true, cursor: null };
      // A policy change can make rows behind a saved cursor eligible.
      if (ttlMs !== previousTtl) cursor = null;
      const cutoff = now - ttlMs;
      const rows = (cursor
        ? this.selects[phase][1].all(cutoff, cursor.touchedAt, cursor.rowid, this.batchSize)
        : this.selects[phase][0].all(cutoff, this.batchSize)) as AgeCursor[];
      // SQLite's tuple comparison only seeks touched_at on this existing index.
      // Equality + rowid seeks the full tie key; then fill from later timestamps.
      if (cursor && rows.length < this.batchSize) rows.push(...this.selects[phase][2].all(cutoff, cursor.touchedAt, this.batchSize - rows.length) as AgeCursor[]);
      const ids: (number | null)[] = rows.map(row => row.rowid);
      while (ids.length < this.batchSize) ids.push(null);
      const deleted = rows.length ? this.deletes[phase].run(...ids, cutoff).changes : 0;
      const done = rows.length < this.batchSize;
      return { ttlMs, deleted, scanned: rows.length, done, cursor: done ? null : rows.at(-1)! };
    }).immediate();
  }
}
