import { and, gt, gte, isNotNull, lte, sql, type SQL } from "drizzle-orm";
import type { DB } from "../db";
import { requestLogs } from "../db/schema";

/** Bucket label of a request that named no service. */
export const UNKNOWN_SERVICE_LABEL = "(unknown)";

export interface StatsQuery {
  from?: number; // epoch ms
  to?: number;
}

/** The counters every aggregate reports: one definition of the column set, so
 * the SQL totals, the cache seed and the cache's own state cannot disagree. */
export interface StatsTotals {
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
}

export interface StatsSummary extends StatsTotals {
  avgLatencyMs: number;
}

/** The totals of an aggregate row, a missing row or column reading as zero. */
export function totalsOf(row: Partial<StatsTotals> | undefined): StatsTotals {
  return {
    requests: row?.requests ?? 0,
    errors: row?.errors ?? 0,
    promptTokens: row?.promptTokens ?? 0,
    completionTokens: row?.completionTokens ?? 0,
    totalTokens: row?.totalTokens ?? 0,
    cachedInputTokens: row?.cachedInputTokens ?? 0,
    cacheCreationInputTokens: row?.cacheCreationInputTokens ?? 0,
    reasoningTokens: row?.reasoningTokens ?? 0,
  };
}

export interface TimePoint {
  day: string; // YYYY-MM-DD (UTC)
  requests: number;
  totalTokens: number;
  errors: number;
  /** Already divided: the chart plots an average, and summing averages is wrong. */
  avgLatencyMs: number;
}

/**
 * A per-day row for the cache seed. Like GroupCount, plus the two counters the
 * Overview chart plots that no other breakdown needs. Latency is a SUM here, not
 * an average, so the cache can keep folding rows into it and divide at read time
 * -- averaging an average would weight a quiet day the same as a busy one.
 */
export interface DayCount extends GroupCount {
  errors: number;
  latencySumMs: number;
}

export interface GroupCount {
  key: string;
  requests: number;
  totalTokens: number;
}

/** The UTC day bucket every per-day aggregation groups on. One definition, so
 * the SQL path and the cache seed can never disagree about where a day starts. */
const DAY_KEY = sql<string>`strftime('%Y-%m-%d', ${requestLogs.createdAt} / 1000, 'unixepoch')`;
/** "An error" means the same thing everywhere: a 4xx or 5xx final status. */
const ERRORS_SUM = sql<number>`coalesce(sum(case when ${requestLogs.httpStatus} >= 400 then 1 else 0 end),0)`;
/** The model / provider that actually served a request, as bucket keys. */
const SERVED_MODEL_KEY = sql<string>`${requestLogs.servedModel}`;
const SERVED_PROVIDER_KEY = sql<string>`${requestLogs.servedProvider}`;
/** The per-service bucket key: the requested service, or the unknown label. */
const SERVICE_KEY = sql<string>`coalesce(${requestLogs.requestedService}, ${sql.raw(`'${UNKNOWN_SERVICE_LABEL}'`)})`;

/** `count(*)`: the requests column of every aggregate. */
const REQUEST_COUNT = sql<number>`count(*)`;
/** The six token columns, summed; spread into a select in this order. */
const TOKEN_SUMS = {
  promptTokens: sql<number>`coalesce(sum(${requestLogs.promptTokens}),0)`,
  completionTokens: sql<number>`coalesce(sum(${requestLogs.completionTokens}),0)`,
  totalTokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}),0)`,
  cachedInputTokens: sql<number>`coalesce(sum(${requestLogs.cachedInputTokens}),0)`,
  cacheCreationInputTokens: sql<number>`coalesce(sum(${requestLogs.cacheCreationInputTokens}),0)`,
  reasoningTokens: sql<number>`coalesce(sum(${requestLogs.reasoningTokens}),0)`,
};
const LATENCY_SUM = sql<number>`coalesce(sum(${requestLogs.latencyMs}),0)`;

/** Everything the StatsCache accumulates, aggregated in one pass over the rows
 * above `sinceId`. Latency comes back as a SUM so the cache can keep adding to
 * it and derive the average by division. */
export interface StatsAccumulators extends StatsTotals {
  /** Highest row id covered (== sinceId when no rows were above it). */
  maxId: number;
  latencySumMs: number;
  byDay: DayCount[];
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
        requests: REQUEST_COUNT,
        errors: sql<number>`sum(case when ${requestLogs.httpStatus} >= 400 then 1 else 0 end)`,
        ...TOKEN_SUMS,
        avgLatencyMs: sql<number>`coalesce(avg(${requestLogs.latencyMs}),0)`,
      })
      .from(requestLogs);
    const r = (where ? base.where(where) : base).get();
    return {
      ...totalsOf(r),
      avgLatencyMs: Math.round(r?.avgLatencyMs ?? 0),
    };
  }

  timeSeries(q: StatsQuery): TimePoint[] {
    const where = this.range(q);
    const day = DAY_KEY;
    const base = this.db
      .select({
        day,
        requests: REQUEST_COUNT,
        totalTokens: TOKEN_SUMS.totalTokens,
        errors: ERRORS_SUM,
        // Rounded in SQL so the wire type is an integer either way -- the cached
        // path rounds too, and a chart that flips between 12 and 12.4 ms across
        // the two sources reads as a bug.
        avgLatencyMs: sql<number>`cast(round(coalesce(avg(${requestLogs.latencyMs}),0)) as integer)`,
      })
      .from(requestLogs);
    return (where ? base.where(where) : base).groupBy(day).orderBy(day).all();
  }

  /** Requests + tokens grouped by the requested service name. */
  byService(q: StatsQuery): GroupCount[] {
    return this.groupBy(this.range(q), SERVICE_KEY);
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
        requests: REQUEST_COUNT,
        errors: ERRORS_SUM,
        ...TOKEN_SUMS,
        latencySumMs: LATENCY_SUM,
      })
      .from(requestLogs)
      .where(above)
      .get();
    return {
      maxId: Math.max(sinceId, totals?.maxId ?? 0),
      ...totalsOf(totals),
      latencySumMs: totals?.latencySumMs ?? 0,
      byDay: this.groupByDay(above),
      byService: this.groupBy(above, SERVICE_KEY),
      byModel: this.groupBy(and(above, isNotNull(requestLogs.servedModel)), SERVED_MODEL_KEY),
      byProvider: this.groupBy(and(above, isNotNull(requestLogs.servedProvider)), SERVED_PROVIDER_KEY),
    };
  }

  /** Requests grouped by the model/provider that actually served each request. */
  byModelProvider(q: StatsQuery): { models: GroupCount[]; providers: GroupCount[] } {
    const range = this.range(q);
    const servedModel = and(range, isNotNull(requestLogs.servedModel));
    const servedProvider = and(range, isNotNull(requestLogs.servedProvider));
    return {
      models: this.groupBy(servedModel, SERVED_MODEL_KEY),
      providers: this.groupBy(servedProvider, SERVED_PROVIDER_KEY),
    };
  }

  /** byDay for the cache seed: the plain grouping plus the chart's two extra
   * counters. Separate from `groupBy` so the other breakdowns do not carry two
   * columns they never read. */
  private groupByDay(where: SQL | undefined): DayCount[] {
    const base = this.db
      .select({
        key: DAY_KEY,
        requests: REQUEST_COUNT,
        totalTokens: TOKEN_SUMS.totalTokens,
        errors: ERRORS_SUM,
        latencySumMs: LATENCY_SUM,
      })
      .from(requestLogs);
    return (where ? base.where(where) : base).groupBy(DAY_KEY).orderBy(DAY_KEY).all();
  }

  private groupBy(where: SQL | undefined, key: SQL<string>): GroupCount[] {
    const base = this.db
      .select({
        key,
        requests: REQUEST_COUNT,
        totalTokens: TOKEN_SUMS.totalTokens,
      })
      .from(requestLogs);
    return (where ? base.where(where) : base).groupBy(key).orderBy(sql`count(*) desc`).all();
  }
}
