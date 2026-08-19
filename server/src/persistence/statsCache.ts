import type { SettingsRepo } from "./settingsRepo";
import type { GroupCount, StatsQueries, StatsSummary, TimePoint } from "./statsQueries";

/** The settings key the cache persists under. Local-only: it describes this
 * database's request_logs, so backups neither export it nor replace it. */
export const STATS_CACHE_SETTINGS_KEY = "stats_cache";

/** How long live bumps may sit unpersisted. Losing a flush to a crash is fine:
 * init() re-aggregates every row above the persisted lastId. */
const FLUSH_DELAY_MS = 5_000;

interface Bucket {
  requests: number;
  totalTokens: number;
}

interface CacheState {
  v: 1;
  /** Highest request_logs id folded in; the startup catch-up scans above it. */
  lastId: number;
  requests: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Sum, not average -- the average is a division at read time. */
  latencySumMs: number;
  byDay: Record<string, Bucket>;
  byService: Record<string, Bucket>;
  byModel: Record<string, Bucket>;
  byProvider: Record<string, Bucket>;
}

/** The per-request numbers the cache folds in when a log row is written. */
export interface RequestStat {
  id: number;
  httpStatus: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  requestedService: string | null;
  servedModel: string | null;
  servedProvider: string | null;
}

function emptyState(): CacheState {
  return {
    v: 1,
    lastId: 0,
    requests: 0,
    errors: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    latencySumMs: 0,
    byDay: {},
    byService: {},
    byModel: {},
    byProvider: {},
  };
}

/**
 * Incremental usage statistics, so the Overview dashboard never pays for a
 * full-table aggregation. The counters live in memory and are folded forward
 * on every completed request; SQL runs only to seed them:
 *
 *  - first boot (no persisted cache): aggregate the whole table once,
 *  - every later boot: aggregate only rows above the persisted `lastId`,
 *    which also recovers whatever a crash lost between flushes.
 *
 * The cache is all-time by construction: pruning old log rows no longer
 * shrinks the totals, which is the point of accumulating them separately.
 */
export class StatsCache {
  private state: CacheState = emptyState();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly queries: StatsQueries,
    private readonly settings: SettingsRepo,
  ) {}

  /** Load the persisted counters (or start from zero when there is no usable
   * cache) and fold in every log row the persisted state has not seen. */
  init(): void {
    this.state = this.load() ?? emptyState();
    if (this.foldFromDb(this.state.lastId)) this.save();
  }

  /** Rebuild from the table alone, discarding accumulated history. For after a
   * restore replaced request_logs with rows these counters never described. */
  rebuild(): void {
    this.state = emptyState();
    this.foldFromDb(0);
    this.save();
  }

  /** Zero everything (the request log was cleared). */
  reset(): void {
    this.state = emptyState();
    this.save();
  }

  /** Fold one completed request in. Called for every log row written. */
  recordRequest(r: RequestStat): void {
    const s = this.state;
    s.requests += 1;
    if (r.httpStatus >= 400) s.errors += 1;
    s.promptTokens += r.promptTokens;
    s.completionTokens += r.completionTokens;
    s.totalTokens += r.totalTokens;
    s.latencySumMs += r.latencyMs;
    if (r.id > s.lastId) s.lastId = r.id;

    const day = new Date().toISOString().slice(0, 10); // UTC, matching the SQL seed
    bump(s.byDay, day, r.totalTokens);
    bump(s.byService, r.requestedService ?? "(unknown)", r.totalTokens);
    if (r.servedModel != null) bump(s.byModel, r.servedModel, r.totalTokens);
    if (r.servedProvider != null) bump(s.byProvider, r.servedProvider, r.totalTokens);
    this.scheduleFlush();
  }

  /** A logged 200 was demoted to 499 after the fact: one more error. */
  recordDeliveryFailure(): void {
    this.state.errors += 1;
    this.scheduleFlush();
  }

  // --- readers (the /stats endpoints; no SQL) --------------------------------

  summary(): StatsSummary {
    const s = this.state;
    return {
      requests: s.requests,
      errors: s.errors,
      promptTokens: s.promptTokens,
      completionTokens: s.completionTokens,
      totalTokens: s.totalTokens,
      avgLatencyMs: s.requests > 0 ? Math.round(s.latencySumMs / s.requests) : 0,
    };
  }

  timeSeries(): TimePoint[] {
    return Object.entries(this.state.byDay)
      .map(([day, b]) => ({ day, requests: b.requests, totalTokens: b.totalTokens }))
      .sort((a, b) => (a.day < b.day ? -1 : 1));
  }

  byService(): GroupCount[] {
    return toGroups(this.state.byService);
  }

  byModelProvider(): { models: GroupCount[]; providers: GroupCount[] } {
    return { models: toGroups(this.state.byModel), providers: toGroups(this.state.byProvider) };
  }

  // --- persistence ------------------------------------------------------------

  /** Persist now if there are unflushed bumps (for graceful shutdown). */
  flush(): void {
    if (this.flushTimer) this.save();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.save(), FLUSH_DELAY_MS);
    this.flushTimer.unref?.();
  }

  private save(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      this.settings.set(STATS_CACHE_SETTINGS_KEY, JSON.stringify(this.state));
    } catch {
      // Best-effort by design: the delayed flush can fire after shutdown closed
      // the database. Whatever this save would have written, the next startup
      // recovers by re-aggregating the rows above the last persisted lastId.
    }
  }

  private load(): CacheState | null {
    const raw = this.settings.get(STATS_CACHE_SETTINGS_KEY);
    if (!raw) return null;
    try {
      const p = JSON.parse(raw) as Partial<CacheState>;
      if (p.v !== 1 || typeof p.lastId !== "number" || typeof p.requests !== "number") return null;
      // Missing sub-objects (a hand-edited blob) degrade to a full reseed.
      if (!p.byDay || !p.byService || !p.byModel || !p.byProvider) return null;
      return { ...emptyState(), ...p, v: 1 };
    } catch {
      return null;
    }
  }

  /** Aggregate rows above `sinceId` into the state. Returns whether any were. */
  private foldFromDb(sinceId: number): boolean {
    const acc = this.queries.accumulateSince(sinceId);
    if (acc.maxId <= sinceId) return false;
    const s = this.state;
    s.lastId = acc.maxId;
    s.requests += acc.requests;
    s.errors += acc.errors;
    s.promptTokens += acc.promptTokens;
    s.completionTokens += acc.completionTokens;
    s.totalTokens += acc.totalTokens;
    s.latencySumMs += acc.latencySumMs;
    for (const g of acc.byDay) bump(s.byDay, g.key, g.totalTokens, g.requests);
    for (const g of acc.byService) bump(s.byService, g.key, g.totalTokens, g.requests);
    for (const g of acc.byModel) bump(s.byModel, g.key, g.totalTokens, g.requests);
    for (const g of acc.byProvider) bump(s.byProvider, g.key, g.totalTokens, g.requests);
    return true;
  }
}

function bump(map: Record<string, Bucket>, key: string, totalTokens: number, requests = 1): void {
  const b = (map[key] ??= { requests: 0, totalTokens: 0 });
  b.requests += requests;
  b.totalTokens += totalTokens;
}

function toGroups(map: Record<string, Bucket>): GroupCount[] {
  return Object.entries(map)
    .map(([key, b]) => ({ key, requests: b.requests, totalTokens: b.totalTokens }))
    .sort((a, b) => b.requests - a.requests);
}
