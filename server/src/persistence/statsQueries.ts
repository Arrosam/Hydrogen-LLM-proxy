import { and, gt, gte, isNotNull, lte, sql, type SQL } from "drizzle-orm";
import type { DB } from "../db";
import { requestLogs } from "../db/schema";

export interface StatsQuery {
  from?: number; // epoch ms
  to?: number;
}

export interface StatsSummary {
  requests: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Subset of promptTokens the providers served from cache. */
  cachedInputTokens: number;
  /** Prompt tokens written into an Anthropic cache (reported separately). */
  cacheCreationInputTokens: number;
  /** Subset of completionTokens spent on reasoning. */
  reasoningTokens: number;
  avgLatencyMs: number;
}

export interface TimePoint {
  day: string; // YYYY-MM-DD (UTC)
  requests: number;
  totalTokens: number;
}

export interface GroupCount {
  key: string;
  requests: number;
  totalTokens: number;
}

/** Everything the StatsCache accumulates, aggregated in one pass over the rows
 * above `sinceId`. Latency comes back as a SUM so the cache can keep adding to
 * it and derive the average by division. */
export interface StatsAccumulators {
  /** Highest row id covered (== sinceId when no rows were above it). */
  maxId: number;
  requests: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
  latencySumMs: number;
  byDay: GroupCount[];
  byService: GroupCount[];
  byModel: GroupCount[];
  byProvider: GroupCount[];
}

/**
 * Usage statistics. Because `served_model` and `served_provider` are now
 * first-class indexed columns, the model/provider breakdown is a plain GROUP BY
 * -- exact over the whole range, no JSON scanning and no row cap (the old design
 * had to parse every attempt_path_json in JS, which OOM'd on large tables).
 */
export class StatsQueries {
  constructor(private readonly db: DB) {}

  private range(q: StatsQuery): SQL | undefined {
    const conds: SQL[] = [];
    if (q.from != null) conds.push(gte(requestLogs.createdAt, new Date(q.from)));
    if (q.to != null) conds.push(lte(requestLogs.createdAt, new Date(q.to)));
    return conds.length ? and(...conds) : undefined;
  }

  summary(q: StatsQuery): StatsSummary {
    const where = this.range(q);
    const base = this.db
      .select({
        requests: sql<number>`count(*)`,
        errors: sql<number>`sum(case when ${requestLogs.httpStatus} >= 400 then 1 else 0 end)`,
        promptTokens: sql<number>`coalesce(sum(${requestLogs.promptTokens}),0)`,
        completionTokens: sql<number>`coalesce(sum(${requestLogs.completionTokens}),0)`,
        totalTokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}),0)`,
        cachedInputTokens: sql<number>`coalesce(sum(${requestLogs.cachedInputTokens}),0)`,
        cacheCreationInputTokens: sql<number>`coalesce(sum(${requestLogs.cacheCreationInputTokens}),0)`,
        reasoningTokens: sql<number>`coalesce(sum(${requestLogs.reasoningTokens}),0)`,
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
      cachedInputTokens: r?.cachedInputTokens ?? 0,
      cacheCreationInputTokens: r?.cacheCreationInputTokens ?? 0,
      reasoningTokens: r?.reasoningTokens ?? 0,
      avgLatencyMs: Math.round(r?.avgLatencyMs ?? 0),
    };
  }

  timeSeries(q: StatsQuery): TimePoint[] {
    const where = this.range(q);
    const day = sql<string>`strftime('%Y-%m-%d', ${requestLogs.createdAt} / 1000, 'unixepoch')`;
    const base = this.db
      .select({
        day,
        requests: sql<number>`count(*)`,
        totalTokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}),0)`,
      })
      .from(requestLogs);
    return (where ? base.where(where) : base).groupBy(day).orderBy(day).all();
  }

  /** Requests + tokens grouped by the requested service name. */
  byService(q: StatsQuery): GroupCount[] {
    return this.groupBy(this.range(q), sql<string>`coalesce(${requestLogs.requestedService}, '(unknown)')`);
  }

  /**
   * Seed/catch-up aggregation for the StatsCache: every row with id > sinceId,
   * in one pass. Runs once at startup (over the whole table on first boot, over
   * the unflushed tail after that), never per dashboard view.
   */
  accumulateSince(sinceId: number): StatsAccumulators {
    const above = gt(requestLogs.id, sinceId);
    const totals = this.db
      .select({
        maxId: sql<number>`coalesce(max(${requestLogs.id}),0)`,
        requests: sql<number>`count(*)`,
        errors: sql<number>`coalesce(sum(case when ${requestLogs.httpStatus} >= 400 then 1 else 0 end),0)`,
        promptTokens: sql<number>`coalesce(sum(${requestLogs.promptTokens}),0)`,
        completionTokens: sql<number>`coalesce(sum(${requestLogs.completionTokens}),0)`,
        totalTokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}),0)`,
        cachedInputTokens: sql<number>`coalesce(sum(${requestLogs.cachedInputTokens}),0)`,
        cacheCreationInputTokens: sql<number>`coalesce(sum(${requestLogs.cacheCreationInputTokens}),0)`,
        reasoningTokens: sql<number>`coalesce(sum(${requestLogs.reasoningTokens}),0)`,
        latencySumMs: sql<number>`coalesce(sum(${requestLogs.latencyMs}),0)`,
      })
      .from(requestLogs)
      .where(above)
      .get();
    const day = sql<string>`strftime('%Y-%m-%d', ${requestLogs.createdAt} / 1000, 'unixepoch')`;
    return {
      maxId: Math.max(sinceId, totals?.maxId ?? 0),
      requests: totals?.requests ?? 0,
      errors: totals?.errors ?? 0,
      promptTokens: totals?.promptTokens ?? 0,
      completionTokens: totals?.completionTokens ?? 0,
      totalTokens: totals?.totalTokens ?? 0,
      cachedInputTokens: totals?.cachedInputTokens ?? 0,
      cacheCreationInputTokens: totals?.cacheCreationInputTokens ?? 0,
      reasoningTokens: totals?.reasoningTokens ?? 0,
      latencySumMs: totals?.latencySumMs ?? 0,
      byDay: this.groupBy(above, day),
      byService: this.groupBy(above, sql<string>`coalesce(${requestLogs.requestedService}, '(unknown)')`),
      byModel: this.groupBy(and(above, isNotNull(requestLogs.servedModel)), sql<string>`${requestLogs.servedModel}`),
      byProvider: this.groupBy(and(above, isNotNull(requestLogs.servedProvider)), sql<string>`${requestLogs.servedProvider}`),
    };
  }

  /** Requests grouped by the model/provider that actually served each request. */
  byModelProvider(q: StatsQuery): { models: GroupCount[]; providers: GroupCount[] } {
    const range = this.range(q);
    const servedModel = and(range, isNotNull(requestLogs.servedModel));
    const servedProvider = and(range, isNotNull(requestLogs.servedProvider));
    return {
      models: this.groupBy(servedModel, sql<string>`${requestLogs.servedModel}`),
      providers: this.groupBy(servedProvider, sql<string>`${requestLogs.servedProvider}`),
    };
  }

  private groupBy(where: SQL | undefined, key: SQL<string>): GroupCount[] {
    const base = this.db
      .select({
        key,
        requests: sql<number>`count(*)`,
        totalTokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}),0)`,
      })
      .from(requestLogs);
    return (where ? base.where(where) : base).groupBy(key).orderBy(sql`count(*) desc`).all();
  }
}
