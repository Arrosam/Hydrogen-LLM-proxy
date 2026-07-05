import { and, gte, lte, sql, type SQL } from "drizzle-orm";
import { getDb } from "../db";
import { requestLogs } from "../db/schema";

export interface StatsQuery {
  from?: number; // epoch ms
  to?: number;
}

function buildWhere(q: StatsQuery): SQL | undefined {
  const conds: SQL[] = [];
  if (q.from != null) conds.push(gte(requestLogs.createdAt, new Date(q.from)));
  if (q.to != null) conds.push(lte(requestLogs.createdAt, new Date(q.to)));
  return conds.length ? and(...conds) : undefined;
}

export interface StatsSummary {
  requests: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
}

export function summary(q: StatsQuery): StatsSummary {
  const where = buildWhere(q);
  const base = getDb()
    .select({
      requests: sql<number>`count(*)`,
      errors: sql<number>`sum(case when ${requestLogs.httpStatus} >= 400 then 1 else 0 end)`,
      promptTokens: sql<number>`coalesce(sum(${requestLogs.promptTokens}),0)`,
      completionTokens: sql<number>`coalesce(sum(${requestLogs.completionTokens}),0)`,
      totalTokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}),0)`,
      avgLatencyMs: sql<number>`coalesce(avg(${requestLogs.latencyMs}),0)`,
    })
    .from(requestLogs);
  const r = (where ? base.where(where) : base).get();
  return {
    requests: r?.requests ?? 0,
    errors: r?.errors ?? 0,
    promptTokens: r?.promptTokens ?? 0,
    completionTokens: r?.completionTokens ?? 0,
    totalTokens: r?.totalTokens ?? 0,
    avgLatencyMs: Math.round(r?.avgLatencyMs ?? 0),
  };
}

export interface TimePoint {
  day: string; // YYYY-MM-DD (UTC)
  requests: number;
  totalTokens: number;
}

export function timeSeries(q: StatsQuery): TimePoint[] {
  const where = buildWhere(q);
  const day = sql<string>`strftime('%Y-%m-%d', ${requestLogs.createdAt} / 1000, 'unixepoch')`;
  const base = getDb()
    .select({
      day,
      requests: sql<number>`count(*)`,
      totalTokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}),0)`,
    })
    .from(requestLogs);
  const rows = (where ? base.where(where) : base).groupBy(day).orderBy(day).all();
  return rows.map((r) => ({ day: r.day, requests: r.requests, totalTokens: r.totalTokens }));
}

export interface GroupCount {
  key: string;
  requests: number;
  totalTokens: number;
}

/** Requests + tokens grouped by service name. */
export function byService(q: StatsQuery): GroupCount[] {
  const where = buildWhere(q);
  const key = sql<string>`coalesce(${requestLogs.serviceName}, '(unknown)')`;
  const base = getDb()
    .select({
      key,
      requests: sql<number>`count(*)`,
      totalTokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}),0)`,
    })
    .from(requestLogs);
  const rows = (where ? base.where(where) : base)
    .groupBy(key)
    .orderBy(sql`count(*) desc`)
    .all();
  return rows.map((r) => ({ key: r.key, requests: r.requests, totalTokens: r.totalTokens }));
}

/**
 * Requests grouped by the model/provider that actually served each request
 * (the last, successful attempt in attempt_path_json). Computed in JS because
 * the winning attempt lives inside a JSON array.
 */
export function byModelProvider(q: StatsQuery): { models: GroupCount[]; providers: GroupCount[] } {
  const where = buildWhere(q);
  const base = getDb()
    .select({
      attemptPath: requestLogs.attemptPath,
      totalTokens: requestLogs.totalTokens,
      httpStatus: requestLogs.httpStatus,
    })
    .from(requestLogs);
  const rows = (where ? base.where(where) : base).all();

  const models = new Map<string, GroupCount>();
  const providers = new Map<string, GroupCount>();
  for (const row of rows) {
    const path = Array.isArray(row.attemptPath) ? (row.attemptPath as AttemptLike[]) : [];
    if (path.length === 0) continue;
    // The winning attempt is the last one when the request succeeded.
    const winner = row.httpStatus < 400 ? path[path.length - 1] : null;
    if (!winner) continue;
    bump(models, winner.model, row.totalTokens);
    bump(providers, winner.provider, row.totalTokens);
  }
  return {
    models: sortDesc([...models.values()]),
    providers: sortDesc([...providers.values()]),
  };
}

interface AttemptLike {
  model: string;
  provider: string;
}

function bump(map: Map<string, GroupCount>, key: string, tokens: number): void {
  const cur = map.get(key) ?? { key, requests: 0, totalTokens: 0 };
  cur.requests += 1;
  cur.totalTokens += tokens;
  map.set(key, cur);
}

function sortDesc(arr: GroupCount[]): GroupCount[] {
  return arr.sort((a, b) => b.requests - a.requests);
}
