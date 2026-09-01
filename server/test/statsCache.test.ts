import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { openDatabase, type DB } from "../src/db";
import { RequestLogRepo, type LogInsert } from "../src/persistence/requestLogRepo";
import { SettingsRepo } from "../src/persistence/settingsRepo";
import { StatsQueries } from "../src/persistence/statsQueries";
import { StatsCache, STATS_CACHE_SETTINGS_KEY } from "../src/persistence/statsCache";
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
    cache.flush(); // don't leave the delayed-save timer pending across tests
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
