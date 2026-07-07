import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
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
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
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

  insert(row: LogInsert): void {
    this.db.insert(requestLogs).values(row).run();
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
    return conds.length ? and(...conds) : undefined;
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
        ingressFormat: requestLogs.ingressFormat,
        egressFormat: requestLogs.egressFormat,
        streaming: requestLogs.streaming,
        httpStatus: requestLogs.httpStatus,
        promptTokens: requestLogs.promptTokens,
        completionTokens: requestLogs.completionTokens,
        totalTokens: requestLogs.totalTokens,
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
  get(id: number): (RequestLog & { createdAtMs: number; serviceName: string | null; requestPayload: string | null; responsePayload: string | null }) | undefined {
    const row = this.db.select().from(requestLogs).where(eq(requestLogs.id, id)).get();
    if (!row) return undefined;
    return {
      ...row,
      createdAtMs: ms(row.createdAt),
      // Aliases the existing dashboard detail view reads.
      serviceName: row.requestedService,
      requestPayload: row.requestBody,
      responsePayload: row.responseBody,
    };
  }
}
