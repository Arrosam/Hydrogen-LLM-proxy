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
    const day = DAY_KEY;
    const base = this.db
      .select({
        day,
        requests: sql<number>`count(*)`,
        totalTokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}),0)`,
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
    return this.groupBy(this.range(q), sql<string>`coalesce(${requestLogs.requestedService}, '(unknown)')`);
  }

  /** A primary-key end seek, not an aggregate scan of log payloads. */
  highestId(): number {
    return this.db.select({ id: sql<number>`coalesce(max(${requestLogs.id}),0)` }).from(requestLogs).get()?.id ?? 0;
  }

  /** One scalar projection/iteration over (sinceId, throughId]. No payload
   * deserialization, whole-table GROUP BY, or five repeated payload-page walks.
   * Production startup runs this in its dedicated readonly worker. */
  accumulateSince(sinceId: number, throughId?: number): StatsAccumulators {
    const acc: StatsAccumulators = {
      maxId: sinceId, requests: 0, errors: 0, promptTokens: 0, completionTokens: 0,
      totalTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0,
      reasoningTokens: 0, latencySumMs: 0, byDay: [], byService: [], byModel: [], byProvider: [],
    };
    const days = new Map<string, DayCount>();
    const services = new Map<string, GroupCount>();
    const models = new Map<string, GroupCount>();
    const providers = new Map<string, GroupCount>();
    const query = this.db
      .select({
        id: requestLogs.id, day: DAY_KEY.as("day"), httpStatus: sql<number>`${requestLogs.httpStatus}`.as("httpStatus"),
        promptTokens: sql<number>`${requestLogs.promptTokens}`.as("promptTokens"),
        completionTokens: sql<number>`${requestLogs.completionTokens}`.as("completionTokens"),
        totalTokens: sql<number>`${requestLogs.totalTokens}`.as("totalTokens"),
        cachedInputTokens: sql<number>`${requestLogs.cachedInputTokens}`.as("cachedInputTokens"),
        cacheCreationInputTokens: sql<number>`${requestLogs.cacheCreationInputTokens}`.as("cacheCreationInputTokens"),
        reasoningTokens: sql<number>`${requestLogs.reasoningTokens}`.as("reasoningTokens"),
        latencyMs: sql<number>`${requestLogs.latencyMs}`.as("latencyMs"),
        requestedService: sql<string | null>`${requestLogs.requestedService}`.as("requestedService"),
        servedModel: sql<string | null>`${requestLogs.servedModel}`.as("servedModel"),
        servedProvider: sql<string | null>`${requestLogs.servedProvider}`.as("servedProvider"),
      })
      .from(requestLogs)
      .where(and(gt(requestLogs.id, sinceId), throughId == null ? undefined : lte(requestLogs.id, throughId)))
      .orderBy(requestLogs.id)
      .toSQL();
    // The locked Drizzle sync driver has no iteration API; use its owned native
    // connection for streaming instead of .all() materializing the whole tail.
    const rows = this.db.$client.prepare(query.sql).iterate(...query.params);
    for (const raw of rows) {
      const r = raw as { id: number; day: string; httpStatus: number; promptTokens: number; completionTokens: number;
        totalTokens: number; cachedInputTokens: number; cacheCreationInputTokens: number; reasoningTokens: number;
        latencyMs: number; requestedService: string | null; servedModel: string | null; servedProvider: string | null };
      const error = r.httpStatus >= 400 ? 1 : 0;
      acc.maxId = r.id; acc.requests++; acc.errors += error;
      acc.promptTokens += r.promptTokens; acc.completionTokens += r.completionTokens;
      acc.totalTokens += r.totalTokens; acc.cachedInputTokens += r.cachedInputTokens;
      acc.cacheCreationInputTokens += r.cacheCreationInputTokens; acc.reasoningTokens += r.reasoningTokens;
      acc.latencySumMs += r.latencyMs;
      const day = days.get(r.day) ?? { key: r.day, requests: 0, totalTokens: 0, errors: 0, latencySumMs: 0 };
      day.requests++; day.totalTokens += r.totalTokens; day.errors += error; day.latencySumMs += r.latencyMs;
      days.set(r.day, day);
      addGroup(services, r.requestedService ?? "(unknown)", r.totalTokens);
      if (r.servedModel != null) addGroup(models, r.servedModel, r.totalTokens);
      if (r.servedProvider != null) addGroup(providers, r.servedProvider, r.totalTokens);
    }
    acc.byDay = [...days.values()].sort((a, b) => compareKey(a.key, b.key));
    const groups = (map: Map<string, GroupCount>) => [...map.values()].sort((a, b) => b.requests - a.requests || compareKey(a.key, b.key));
    acc.byService = groups(services); acc.byModel = groups(models); acc.byProvider = groups(providers);
    return acc;
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

function addGroup(map: Map<string, GroupCount>, key: string, tokens: number): void {
  const group = map.get(key) ?? { key, requests: 0, totalTokens: 0 };
  group.requests++; group.totalTokens += tokens; map.set(key, group);
}

/** Deterministic seed tie order; existing group APIs promise count order only. */
function compareKey(a: string, b: string): number {
  if (a == null || b == null) return a == null ? (b == null ? 0 : -1) : 1;
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
