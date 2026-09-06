import { and, desc, eq, gte, inArray, lt, lte, sql, type SQL } from "drizzle-orm";
import type { DB } from "../db";
import type { Family } from "../core/format/family";
import { asMillis } from "../util/time";
import { requestLogs, type RequestLog } from "../db/schema";

/** One request log row. Captures the full HTTP request/response (token-redacted). */
export interface LogInsert {
  traceId: string;
  tokenId: number | null;
  serviceId: number | null;
  requestedService: string | null;
  servedModel: string | null;
  servedProvider: string | null;
  ingressFormat: Family;
  egressFormat: Family | null;
  streaming: boolean;
  httpStatus: number;
  requestMethod: string | null;
  requestPath: string | null;
  requestQuery: string | null;
  requestHeaders: Record<string, string> | null;
  requestBody: string | null;
  /** The exact wire body sent upstream (after service overrides/translation). */
  upstreamRequestBody: string | null;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Subset of promptTokens served from the provider's cache. */
  cachedInputTokens: number;
  /** Anthropic cache writes (reported alongside, not inside, promptTokens). */
  cacheCreationInputTokens: number;
  /** Subset of completionTokens spent on reasoning. */
  reasoningTokens: number;
  latencyMs: number;
  attempts: number;
  attemptPath: unknown;
  error: string | null;
}

export interface LogQuery {
  tokenId?: number;
  serviceId?: number;
  status?: number;
  errorsOnly?: boolean;
  from?: number;
  to?: number;
  /** The model that actually answered -- a different question from which
   * service was requested, and the one asked first when one model misbehaves. */
  servedModel?: string;
  /** Case-insensitive substring of the error text. */
  errorContains?: string;
  /** Explicit row ids. Set by an export of hand-picked rows; when present it
   * stands alongside the other filters rather than replacing them. */
  ids?: number[];
  limit?: number;
  offset?: number;
}

/** Row summary shape the dashboard list expects (serviceName aliases requested_service). */
export interface LogSummary {
  id: number;
  createdAt: number;
  tokenId: number | null;
  serviceId: number | null;
  serviceName: string | null;
  /** Selected for the LIST so it can be shown and filtered on without opening
   * each row; both columns have always existed on the table. */
  servedModel: string | null;
  servedProvider: string | null;
  ingressFormat: string;
  egressFormat: string | null;
  streaming: boolean;
  httpStatus: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  attempts: number;
  error: string | null;
}

function ms(v: Date | number | null): number {
  return v == null ? 0 : asMillis(v);
}

export class RequestLogRepo {
  constructor(private readonly db: DB) {}

  /** Insert one row and return its id (the StatsCache tracks the highest id folded in). */
  insert(row: LogInsert): number {
    const res = this.db.insert(requestLogs).values(row).run();
    return Number(res.lastInsertRowid);
  }

  /**
   * Demote an already-logged 200 to 499 when the connection dies right after
   * the response was handed to the network. Node's 'finish' only means the
   * bytes reached the kernel's send buffer; when the peer resets the socket
   * moments later those bytes were never delivered, and the evidence arrives
   * after the row was written. Only a 200 row is amended — a failure status
   * already tells the truth.
   */
  markDeliveryFailed(traceId: string, error: string): boolean {
    const res = this.db
      .update(requestLogs)
      .set({ httpStatus: 499, error })
      .where(and(eq(requestLogs.traceId, traceId), eq(requestLogs.httpStatus, 200)))
      .run();
    return (res.changes ?? 0) > 0;
  }

  /** Delete every request log row. Returns the number deleted. */
  deleteAll(): number {
    return this.db.delete(requestLogs).run().changes ?? 0;
  }

  private buildWhere(q: LogQuery): SQL | undefined {
    const conds: SQL[] = [];
    if (q.tokenId != null) conds.push(eq(requestLogs.tokenId, q.tokenId));
    if (q.serviceId != null) conds.push(eq(requestLogs.serviceId, q.serviceId));
    if (q.status != null) conds.push(eq(requestLogs.httpStatus, q.status));
    if (q.errorsOnly) conds.push(gte(requestLogs.httpStatus, 400));
    if (q.from != null) conds.push(gte(requestLogs.createdAt, new Date(q.from)));
    if (q.to != null) conds.push(lte(requestLogs.createdAt, new Date(q.to)));
    if (q.servedModel) conds.push(eq(requestLogs.servedModel, q.servedModel));
    if (q.errorContains) {
      // LIKE, with the wildcards the operator typed treated as literal text:
      // searching for "100%" must not match every error. SQLite's LIKE is
      // already case-insensitive for ASCII.
      const needle = q.errorContains.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      conds.push(sql`${requestLogs.error} like ${`%${needle}%`} escape '\\'`);
    }
    if (q.ids?.length) conds.push(inArray(requestLogs.id, q.ids));
    return conds.length ? and(...conds) : undefined;
  }

  /** Every distinct model that has actually served a request, newest first.
   * Feeds the served-model filter's dropdown. */
  distinctServedModels(): string[] {
    return this.db
      .selectDistinct({ m: requestLogs.servedModel })
      .from(requestLogs)
      .where(sql`${requestLogs.servedModel} is not null and ${requestLogs.servedModel} <> ''`)
      .all()
      .map((r) => r.m)
      .filter((m): m is string => !!m)
      .sort((a, b) => a.localeCompare(b));
  }

  query(q: LogQuery): { rows: LogSummary[]; total: number } {
    const where = this.buildWhere(q);
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
    const offset = Math.max(q.offset ?? 0, 0);

    const base = this.db
      .select({
        id: requestLogs.id,
        createdAt: requestLogs.createdAt,
        tokenId: requestLogs.tokenId,
        serviceId: requestLogs.serviceId,
        serviceName: requestLogs.requestedService,
        servedModel: requestLogs.servedModel,
        servedProvider: requestLogs.servedProvider,
        ingressFormat: requestLogs.ingressFormat,
        egressFormat: requestLogs.egressFormat,
        streaming: requestLogs.streaming,
        httpStatus: requestLogs.httpStatus,
        promptTokens: requestLogs.promptTokens,
        completionTokens: requestLogs.completionTokens,
        totalTokens: requestLogs.totalTokens,
        // Subsets of the two counts above, not additions to them (see
        // core/ir/usage.ts). Selected for the LIST, not just the detail: the
        // cached share is the number a prompt-caching setup is judged on and
        // reading it one row at a time is no way to judge anything.
        cachedInputTokens: requestLogs.cachedInputTokens,
        cacheCreationInputTokens: requestLogs.cacheCreationInputTokens,
        reasoningTokens: requestLogs.reasoningTokens,
        latencyMs: requestLogs.latencyMs,
        attempts: requestLogs.attempts,
        error: requestLogs.error,
      })
      .from(requestLogs);

    const rows = (where ? base.where(where) : base).orderBy(desc(requestLogs.id)).limit(limit).offset(offset).all();
    const countQ = this.db.select({ n: sql<number>`count(*)` }).from(requestLogs);
    const total = (where ? countQ.where(where) : countQ).get()?.n ?? 0;

    return { rows: rows.map((r) => ({ ...r, createdAt: ms(r.createdAt) })), total };
  }

  /** Full log row for the detail view, with the dashboard's field aliases. */
  get(id: number): (RequestLog & { createdAtMs: number; serviceName: string | null; requestPayload: string | null; upstreamRequestPayload: string | null; responsePayload: string | null }) | undefined {
    const row = this.db.select().from(requestLogs).where(eq(requestLogs.id, id)).get();
    if (!row) return undefined;
    return {
      ...row,
      createdAtMs: ms(row.createdAt),
      // Aliases the existing dashboard detail view reads.
      serviceName: row.requestedService,
      requestPayload: row.requestBody,
      upstreamRequestPayload: row.upstreamRequestBody,
      responsePayload: row.responseBody,
    };
  }

  /** How many rows an export of `q` would contain. Shown before the click, so
   * a 40,000-row export is a decision rather than a surprise. */
  countMatching(q: LogQuery): number {
    const where = this.buildWhere(q);
    const countQ = this.db.select({ n: sql<number>`count(*)` }).from(requestLogs);
    return (where ? countQ.where(where) : countQ).get()?.n ?? 0;
  }

  /**
   * Every FULL row matching `q`, newest first, yielded one page at a time.
   *
   * Deliberately not built on `query()`: that clamps to 500 and selects a
   * summary, both of which are right for a list and wrong for an export. The
   * caller streams what this yields, so an export's memory cost is one page --
   * flat whether the result is six rows or sixty thousand. That is what makes
   * the absence of a row cap safe: the operator's filter decides the size, and
   * nothing here silently narrows it.
   *
   * Pages by descending id rather than OFFSET, so page N costs the same as
   * page 1 instead of degrading as the export runs.
   */
  *exportRows(q: LogQuery, pageSize = 100): Generator<RequestLog & { createdAtMs: number }> {
    const where = this.buildWhere(q);
    let cursor: number | null = null;
    for (;;) {
      // Both annotated: `cursor` is assigned from `rows`, which is inferred
      // from `conds`, which is built from `cursor` -- enough of a loop for TS
      // to give up (TS7022) without the hint.
      const conds: SQL[] = [where, cursor == null ? undefined : lt(requestLogs.id, cursor)].filter(
        (c): c is SQL => c != null,
      );
      const rows: RequestLog[] = this.db
        .select()
        .from(requestLogs)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(requestLogs.id))
        .limit(pageSize)
        .all();
      if (!rows.length) return;
      for (const row of rows) yield { ...row, createdAtMs: ms(row.createdAt) };
      cursor = rows[rows.length - 1]!.id;
      if (rows.length < pageSize) return;
    }
  }
}
