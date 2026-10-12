import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { openDatabase, type DB } from "../src/db";
import { RequestLogRepo, type LogInsert } from "../src/persistence/requestLogRepo";
import { SettingsRepo } from "../src/persistence/settingsRepo";
import { StatsQueries } from "../src/persistence/statsQueries";
import { StatsCache, STATS_CACHE_SETTINGS_KEY, type RequestStat } from "../src/persistence/statsCache";
import { RequestLogger } from "../src/observability/requestLogger";

let dir: string;
let sqlite: BetterSqlite3.Database;
let db: DB;
let logs: RequestLogRepo;
let settings: SettingsRepo;
let queries: StatsQueries;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydro-statscache-"));
  const opened = openDatabase(dir);
  db = opened.db;
  sqlite = opened.sqlite;
  logs = new RequestLogRepo(db);
  settings = new SettingsRepo(db);
  queries = new StatsQueries(db);
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function row(patch: Partial<LogInsert> = {}): LogInsert {
  return {
    traceId: "t",
    tokenId: null,
    serviceId: null,
    requestedService: "svc",
    servedModel: "gpt-x",
    servedProvider: "prov",
    ingressFormat: "openai_completion",
    egressFormat: "anthropic",
    streaming: false,
    httpStatus: 200,
    requestMethod: "POST",
    requestPath: "/v1/chat/completions",
    requestQuery: null,
    requestHeaders: null,
    requestBody: null,
    upstreamRequestBody: null,
    responseHeaders: null,
    responseBody: null,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    latencyMs: 100,
    attempts: 1,
    attemptPath: [],
    error: null,
    ...patch,
  };
}

/** The cache must always answer exactly what the SQL aggregation would. */
function expectMatchesSql(cache: StatsCache): void {
  expect(cache.summary()).toEqual(queries.summary({}));
  expect(cache.timeSeries()).toEqual(queries.timeSeries({}));
  expect(cache.byService()).toEqual(queries.byService({}));
  expect(cache.byModelProvider()).toEqual(queries.byModelProvider({}));
}

describe("StatsCache", () => {
  it("seeds from the whole table when no persisted cache exists, and persists the seed", () => {
    logs.insert(row());
    logs.insert(row({ latencyMs: 300, totalTokens: 5, promptTokens: 3, completionTokens: 2 }));
    logs.insert(row({ httpStatus: 502, servedModel: null, servedProvider: null, error: "boom", promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: 20 }));

    const cache = new StatsCache(queries, settings);
    cache.init();

    expectMatchesSql(cache);
    expect(cache.summary()).toMatchObject({ requests: 3, errors: 1, totalTokens: 20, avgLatencyMs: 140 });
    expect(settings.get(STATS_CACHE_SETTINGS_KEY)).toBeTruthy();
  });

  it("folds live requests written through the RequestLogger, average by division", () => {
    const cache = new StatsCache(queries, settings);
    cache.init();
    const logger = new RequestLogger(logs, 1000, cache);

    logger.record({
      traceId: "live",
      tokenId: null,
      serviceId: null,
      requestedService: "svc2",
      servedModel: "claude-y",
      servedProvider: "prov2",
      ingress: "openai_completion",
      streaming: false,
      httpStatus: 200,
      http: { method: "POST", path: "/v1/chat/completions", query: "", headers: {}, bodyPayload: "{}" },
      usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
      latencyMs: 60,
    });

    expectMatchesSql(cache);
    // (100 + 300 + 20 + 60) / 4
    expect(cache.summary().avgLatencyMs).toBe(120);
    expect(cache.byService().find((g) => g.key === "svc2")).toEqual({ key: "svc2", requests: 1, totalTokens: 10 });
    expect(cache.byModelProvider().models.find((g) => g.key === "claude-y")?.requests).toBe(1);
    cache.flush(); // don't leave the delayed-save timer pending across tests
  });

  it("counts a 200 demoted to 499 as one more error", () => {
    const cache = new StatsCache(queries, settings);
    cache.init();
    const logger = new RequestLogger(logs, 1000, cache);
    const before = cache.summary().errors;

    expect(logger.amendDeliveryFailure("live", "socket reset")).toBe(true);
    expect(cache.summary().errors).toBe(before + 1);
    // Amending a row that is not a 200 changes nothing.
    expect(logger.amendDeliveryFailure("live", "socket reset")).toBe(false);
    expect(cache.summary().errors).toBe(before + 1);
    const restarted = new StatsCache(queries, settings);
    restarted.init();
    expect(restarted.summary()).toEqual(cache.summary());
    expectMatchesSql(restarted);
    cache.flush();
  });

  it("rolls back both SQL demotion and cached counters when persistence fails", () => {
    logs.insert(row({traceId:"rollback"}));
    const cache = new StatsCache(queries, settings);cache.init();
    const before=cache.summary();
    const spy=vi.spyOn(settings,"set").mockImplementationOnce(()=>{throw new Error("disk full");});
    expect(()=>new RequestLogger(logs,1000,cache).amendDeliveryFailure("rollback","failed")).toThrow("disk full");
    spy.mockRestore();expect(cache.summary()).toEqual(before);expectMatchesSql(cache);
    expect(sqlite.prepare("SELECT http_status FROM request_logs WHERE trace_id = 'rollback'").get()).toEqual({http_status:200});
  });

  it("catches up rows the last flush never saw (simulated crash), without double counting", () => {
    const warm = new StatsCache(queries, settings);
    warm.init();
    warm.flush();

    // Rows written while "another process" (or a crashed one) held the counters.
    logs.insert(row({ requestedService: "svc3", totalTokens: 40, promptTokens: 30, completionTokens: 10, latencyMs: 500 }));
    logs.insert(row({ requestedService: "svc3", httpStatus: 500, totalTokens: 0, promptTokens: 0, completionTokens: 0, latencyMs: 5 }));

    const reborn = new StatsCache(queries, settings);
    reborn.init();
    expectMatchesSql(reborn);
    expect(reborn.byService().find((g) => g.key === "svc3")).toEqual({ key: "svc3", requests: 2, totalTokens: 40 });

    // A third boot with nothing new must not fold anything twice.
    const again = new StatsCache(queries, settings);
    again.init();
    expectMatchesSql(again);
  });

  it("reset() zeroes the counters and the persisted blob", () => {
    const cache = new StatsCache(queries, settings);
    cache.init();
    logs.deleteAll();
    cache.reset();

    expect(cache.summary()).toEqual({
      requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
      cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0,
      avgLatencyMs: 0,
    });
    expect(cache.timeSeries()).toEqual([]);
    expectMatchesSql(cache);

    // The zeroed state is what a restart now loads.
    const after = new StatsCache(queries, settings);
    after.init();
    expect(after.summary().requests).toBe(0);
  });

  it("a corrupt persisted blob degrades to a full reseed", () => {
    logs.insert(row({ requestedService: "svc4" }));
    settings.set(STATS_CACHE_SETTINGS_KEY, "{not json");

    const cache = new StatsCache(queries, settings);
    cache.init();
    expectMatchesSql(cache);
    expect(cache.summary().requests).toBe(1);
  });

  it("day points carry errors and an average latency, not just requests", () => {
    // The Overview chart plots four curves off these points. `expectMatchesSql`
    // already proves the cache and the SQL path agree; what it cannot prove is
    // that the two new counters mean anything, since both sides could be zero.
    logs.insert(row({ httpStatus: 500, latencyMs: 900, error: "boom" }));
    const cache = new StatsCache(queries, settings);
    cache.init();
    expectMatchesSql(cache);

    const points = cache.timeSeries();
    const summary = cache.summary();
    expect(points.length).toBeGreaterThan(0);
    expect(summary.errors).toBeGreaterThan(0);

    // Every row this suite writes is stamped now, so the day points add up to
    // exactly what the all-time summary reports. This is the invariant that
    // breaks first if the seed and the live fold disagree about either counter.
    expect(points.reduce((n, p) => n + p.requests, 0)).toBe(summary.requests);
    expect(points.reduce((n, p) => n + p.errors, 0)).toBe(summary.errors);

    // Latency is accumulated as a sum and divided per bucket, so re-weighting the
    // per-day averages by their request counts must land back on the global one
    // (within the rounding each bucket applies).
    const weighted = points.reduce((n, p) => n + p.avgLatencyMs * p.requests, 0) / summary.requests;
    expect(Math.abs(weighted - summary.avgLatencyMs)).toBeLessThanOrEqual(1);
  });
});

describe("StatsCache: which persisted blobs are trusted", () => {
  /** A persisted blob that, if trusted, is unmistakable: it claims 999 requests
   * and a lastId far above any row, so nothing would be folded in after it. */
  const bogus = (patch: Record<string, unknown> = {}): string =>
    JSON.stringify({
      v: 3, lastId: 1_000_000_000, requests: 999, errors: 0,
      promptTokens: 0, completionTokens: 0, totalTokens: 0,
      cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0, latencySumMs: 0,
      byDay: {}, byService: {}, byModel: {}, byProvider: {},
      ...patch,
    });

  /** Boot a cache over whatever blob is persisted. */
  function boot(blob: string): StatsCache {
    settings.set(STATS_CACHE_SETTINGS_KEY, blob);
    const cache = new StatsCache(queries, settings);
    cache.init();
    return cache;
  }

  it("carries a current-version blob forward as it is", () => {
    logs.insert(row({ requestedService: "svc5" }));
    const cache = boot(bogus());
    expect(cache.summary().requests).toBe(999);
    settings.clear(STATS_CACHE_SETTINGS_KEY);
  });

  it("discards a blob written by an older cache version and reseeds from the table", () => {
    const cache = boot(bogus({ v: 2 }));
    expectMatchesSql(cache);
    expect(cache.summary().requests).not.toBe(999);
    // The reseed is what a restart now loads.
    expect(JSON.parse(settings.get(STATS_CACHE_SETTINGS_KEY)!)).toMatchObject({ v: 3, requests: cache.summary().requests });
  });

  it.each(["byDay", "byService", "byModel", "byProvider"])("reseeds when a current-version blob has no %s", (missing) => {
    const cache = boot(bogus({ [missing]: undefined }));
    expectMatchesSql(cache);
    expect(cache.summary().requests).not.toBe(999);
  });

  it("reseeds when a counter the loader checks is not a number", () => {
    expectMatchesSql(boot(bogus({ lastId: "12" })));
    expectMatchesSql(boot(bogus({ requests: null })));
  });

  it.each(["null", "", "[]", "42"])("reseeds from a blob of %j", (blob) => {
    const cache = boot(blob);
    expectMatchesSql(cache);
    expect(cache.summary().requests).toBeGreaterThan(0);
  });
});

describe("StatsCache: classifying a recorded request", () => {
  const stat = (patch: Partial<RequestStat> = {}): RequestStat => ({
    id: 0, httpStatus: 200,
    promptTokens: 4, completionTokens: 6, totalTokens: 10,
    cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0,
    latencyMs: 50, requestedService: "svc", servedModel: "gpt-x", servedProvider: "prov",
    ...patch,
  });

  /** A cache seeded from the table. Dropped again by `discard`, so a counter
   * these tests bump by hand never reaches the next test through the blob. */
  function fresh(): StatsCache {
    settings.clear(STATS_CACHE_SETTINGS_KEY);
    const cache = new StatsCache(queries, settings);
    cache.init();
    return cache;
  }
  function discard(cache: StatsCache): void {
    cache.flush(); // cancels the pending delayed save
    settings.clear(STATS_CACHE_SETTINGS_KEY);
  }

  it("counts a status as an error from 400 upward, and not at 399", () => {
    const cache = fresh();
    const before = cache.summary();
    const today = new Date().toISOString().slice(0, 10);
    const dayErrors = (): number => cache.timeSeries().find((p) => p.day === today)?.errors ?? 0;
    const dayBefore = dayErrors();

    cache.recordRequest(stat({ httpStatus: 399 }));
    expect(cache.summary().errors).toBe(before.errors);
    expect(cache.summary().requests).toBe(before.requests + 1);
    expect(dayErrors()).toBe(dayBefore);

    cache.recordRequest(stat({ httpStatus: 400 }));
    expect(cache.summary().errors).toBe(before.errors + 1);
    expect(cache.summary().requests).toBe(before.requests + 2);
    expect(dayErrors()).toBe(dayBefore + 1);
    discard(cache);
  });

  it("files a request with no service name under (unknown)", () => {
    const cache = fresh();
    const unknownBefore = cache.byService().find((g) => g.key === "(unknown)")?.requests ?? 0;
    cache.recordRequest(stat({ requestedService: null }));
    expect(cache.byService().find((g) => g.key === "(unknown)")).toMatchObject({ requests: unknownBefore + 1 });
    discard(cache);
  });

  it("counts a request nothing served without inventing a model or provider for it", () => {
    const cache = fresh();
    const before = { summary: cache.summary(), served: cache.byModelProvider() };
    cache.recordRequest(stat({ servedModel: null, servedProvider: null, totalTokens: 0, promptTokens: 0, completionTokens: 0 }));
    expect(cache.summary().requests).toBe(before.summary.requests + 1);
    expect(cache.byModelProvider()).toEqual(before.served);
    discard(cache);
  });

  it("adds every token counter and averages latency by division", () => {
    const cache = fresh();
    cache.reset(); // from zero, so the totals below are exact

    cache.recordRequest(stat({ latencyMs: 10, cachedInputTokens: 3, cacheCreationInputTokens: 2, reasoningTokens: 1 }));
    cache.recordRequest(stat({ latencyMs: 25, httpStatus: 500 }));
    expect(cache.summary()).toEqual({
      requests: 2, errors: 1, promptTokens: 8, completionTokens: 12, totalTokens: 20,
      cachedInputTokens: 3, cacheCreationInputTokens: 2, reasoningTokens: 1,
      avgLatencyMs: 18, // round(35 / 2)
    });
    expect(cache.byService()).toEqual([{ key: "svc", requests: 2, totalTokens: 20 }]);
    discard(cache);
  });
});

describe("StatsCache: rebuild and flush", () => {
  it("rebuild() drops history the table no longer holds, and persists the result", () => {
    settings.clear(STATS_CACHE_SETTINGS_KEY);
    logs.insert(row({ requestedService: "doomed", totalTokens: 77 }));
    const cache = new StatsCache(queries, settings);
    cache.init();
    expect(cache.byService().some((g) => g.key === "doomed")).toBe(true);

    // Rows vanish without the cache being told (a restore replaces the table).
    sqlite.prepare("DELETE FROM request_logs WHERE requested_service = 'doomed'").run();
    expect(cache.byService().some((g) => g.key === "doomed")).toBe(true); // all-time by construction

    cache.rebuild();
    expectMatchesSql(cache);
    expect(cache.byService().some((g) => g.key === "doomed")).toBe(false);

    const restarted = new StatsCache(queries, settings);
    restarted.init();
    expect(restarted.summary()).toEqual(cache.summary());
    expect(restarted.byService()).toEqual(cache.byService());
  });

  it("flush() writes nothing when no bump is pending, and once when one is", () => {
    const cache = new StatsCache(queries, settings);
    cache.init();
    const write = vi.spyOn(settings, "set");
    try {
      cache.flush();
      expect(write).not.toHaveBeenCalled();

      cache.recordDeliveryFailure();
      expect(write).not.toHaveBeenCalled(); // deferred, not written per request
      cache.flush();
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0][0]).toBe(STATS_CACHE_SETTINGS_KEY);

      cache.flush(); // already persisted
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      write.mockRestore();
      settings.clear(STATS_CACHE_SETTINGS_KEY);
    }
  });
});
