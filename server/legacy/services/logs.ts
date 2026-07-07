import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { getDb } from "../db";
import type { Family } from "../core/ir";
import { asMillis } from "../util/time";
import { requestLogs, type RequestLog } from "../db/schema";

export interface LogInsert {
  tokenId: number | null;
  serviceId: number | null;
  serviceName: string | null;
  ingressFormat: Family;
  egressFormat: Family | null;
  streaming: boolean;
  httpStatus: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  attempts: number;
  attemptPath: unknown;
  requestPayload: string | null;
  responsePayload: string | null;
  error: string | null;
}

export function insertLog(row: LogInsert): void {
  getDb().insert(requestLogs).values(row).run();
}

export interface LogQuery {
  tokenId?: number;
  serviceId?: number;
  status?: number;
  errorsOnly?: boolean;
  from?: number; // epoch ms
  to?: number;
  limit?: number;
  offset?: number;
}

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

function buildWhere(q: LogQuery): SQL | undefined {
  const conds: SQL[] = [];
  if (q.tokenId != null) conds.push(eq(requestLogs.tokenId, q.tokenId));
  if (q.serviceId != null) conds.push(eq(requestLogs.serviceId, q.serviceId));
  if (q.status != null) conds.push(eq(requestLogs.httpStatus, q.status));
  if (q.errorsOnly) conds.push(gte(requestLogs.httpStatus, 400));
  if (q.from != null) conds.push(gte(requestLogs.createdAt, new Date(q.from)));
  if (q.to != null) conds.push(lte(requestLogs.createdAt, new Date(q.to)));
  return conds.length ? and(...conds) : undefined;
}

export function queryLogs(q: LogQuery): { rows: LogSummary[]; total: number } {
  const db = getDb();
  const where = buildWhere(q);
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
  const offset = Math.max(q.offset ?? 0, 0);

  const base = db
    .select({
      id: requestLogs.id,
      createdAt: requestLogs.createdAt,
      tokenId: requestLogs.tokenId,
      serviceId: requestLogs.serviceId,
      serviceName: requestLogs.serviceName,
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

  const rows = (where ? base.where(where) : base)
    .orderBy(desc(requestLogs.id))
    .limit(limit)
    .offset(offset)
    .all();

  const countQ = db.select({ n: sql<number>`count(*)` }).from(requestLogs);
  const total = (where ? countQ.where(where) : countQ).get()?.n ?? 0;

  return {
    rows: rows.map((r) => ({ ...r, createdAt: ms(r.createdAt) })),
    total,
  };
}

export function getLog(id: number): (RequestLog & { createdAtMs: number }) | undefined {
  const row = getDb().select().from(requestLogs).where(eq(requestLogs.id, id)).get();
  if (!row) return undefined;
  return { ...row, createdAtMs: ms(row.createdAt) };
}
