import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { openDatabase, type DB } from "../src/db";
import { StatsQueries, type StatsAccumulators, type GroupCount } from "../src/persistence/statsQueries";
import { SettingsRepo } from "../src/persistence/settingsRepo";
import { StatsCache, STATS_CACHE_SETTINGS_KEY } from "../src/persistence/statsCache";
import { startStatsReader, type StatsReadTask } from "../src/persistence/statsReader";
import { RequestLogRepo } from "../src/persistence/requestLogRepo";
import { RequestLogger } from "../src/observability/requestLogger";
import { boot, type Container } from "../src/composition/container";
import { buildApp } from "../src/app";
import { startupStage, type StartupEvent } from "../src/util/startup";

let dir: string, sqlite: Database.Database, db: DB, queries: StatsQueries, settings: SettingsRepo;
let cache: StatsCache, app: FastifyInstance | undefined, container: Container | undefined;
let tasks: StatsReadTask[];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydro-startup-stats-"));
  ({ sqlite, db } = openDatabase(dir));
  queries = new StatsQueries(db); settings = new SettingsRepo(db); cache = new StatsCache(queries, settings);
  tasks = [];
  vi.stubEnv("NODE_ENV", "test");
});
afterEach(async () => {
  if (app) await app.close();
  container?.statsCache.close(); container?.sqlite.close();
  app = undefined; container = undefined;
  cache.close();
  for (const task of tasks) { task.cancel(); await task.stopped; }
  sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

function seed(n: number, bytes = 0): void {
  const insert = sqlite.prepare("insert into request_logs(trace_id,ingress_format,http_status,requested_service,served_model,served_provider,prompt_tokens,completion_tokens,total_tokens,cached_input_tokens,cache_creation_input_tokens,reasoning_tokens,latency_ms,created_at,request_body) values (?,'openai_completion',?,?,?,?,10,5,15,2,1,3,?,?,?)");
  sqlite.transaction(() => {
    for (let i = 0; i < n; i++) insert.run(`synthetic-${i}`, i % 3 === 0 ? 502 : 200, [null, "", "z", "😀", "\uFFFD"][i % 5], i % 2 ? "model-z" : null, i % 3 ? "provider-z" : null, 10 + i, Date.UTC(2026, 0, 1 + i % 2), "x".repeat(bytes));
  })();
}
function controlled() {
  let resolve!: (acc: StatsAccumulators) => void, reject!: (error: Error) => void;
  const task: StatsReadTask = { result: new Promise((yes, no) => { resolve = yes; reject = no; }), cancel: vi.fn() };
  const read = vi.fn(() => task);
  return { task, resolve, reject, read };
}
function live(trace = "live", status = 200): void {
  new RequestLogger(new RequestLogRepo(db), 1000, cache).record({
    traceId: trace, tokenId: null, serviceId: null, requestedService: "live-service", servedModel: "live-model", servedProvider: "live-provider",
    ingress: "openai_completion", streaming: false, httpStatus: status,
    http: { method: "POST", path: "/v1/chat/completions", query: "", headers: {}, bodyPayload: "{}" },
    usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 }, latencyMs: 20,
  });
}
function matchesSql(c: StatsCache): void {
  expect(c.summary()).toEqual(queries.summary({}));
  expect(c.timeSeries()).toEqual(queries.timeSeries({}));
  expectGroups(c.byService(), queries.byService({}));
  expectGroups(c.byModelProvider().models, queries.byModelProvider({}).models);
  expectGroups(c.byModelProvider().providers, queries.byModelProvider({}).providers);
}
function expectGroups(actual: GroupCount[], expected: GroupCount[]): void {
  // SQL ORDER BY count(*) DESC does not define equal-count group order. Check
  // every key/counter and the promised descending counts independently.
  expect(actual.map(g => g.requests)).toEqual([...actual.map(g => g.requests)].sort((a, b) => b - a));
  const byKey = (a: GroupCount, b: GroupCount) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key));
  expect([...actual].sort(byKey)).toEqual([...expected].sort(byKey));
}

describe("one-pass startup accumulator", () => {
  it("matches the independent aggregate SQL for dates, null/empty groups, token subsets and UTF-8 ties", () => {
    seed(10);
    const acc = queries.accumulateSince(0, 10);
    const summary = queries.summary({});
    expect(acc).toMatchObject({ maxId: 10, requests: summary.requests, errors: summary.errors, promptTokens: summary.promptTokens,
      completionTokens: summary.completionTokens, totalTokens: summary.totalTokens, cachedInputTokens: summary.cachedInputTokens,
      cacheCreationInputTokens: summary.cacheCreationInputTokens, reasoningTokens: summary.reasoningTokens, latencySumMs: 145 });
    expectGroups(acc.byService, queries.byService({}));
    expectGroups(acc.byModel, queries.byModelProvider({}).models);
    expectGroups(acc.byProvider, queries.byModelProvider({}).providers);
    expect(acc.byDay.map(day => ({ day: day.key, requests: day.requests, totalTokens: day.totalTokens, errors: day.errors, avgLatencyMs: Math.round(day.latencySumMs / day.requests) }))).toEqual(queries.timeSeries({}));
  });
  it("honors both ID boundaries, gaps and an empty tail without whole-group scans", () => {
    seed(8); sqlite.prepare("delete from request_logs where id=5").run();
    expect(queries.accumulateSince(3, 7)).toMatchObject({ maxId: 7, requests: 3, totalTokens: 45 });
    expect(queries.accumulateSince(8, 8)).toMatchObject({ maxId: 8, requests: 0, byDay: [], byModel: [] });
  });
  it("executes exactly one streaming scalar range query on a bounded payload-heavy table", () => {
    seed(256, 16 * 1024);
    const prepare = vi.spyOn(sqlite, "prepare");
    expect(queries.accumulateSince(250, 256).requests).toBe(6);
    expect(prepare).toHaveBeenCalledTimes(1);
    const query = prepare.mock.calls[0][0];
    expect(query).not.toMatch(/body|headers|json|group by/i);
    prepare.mockRestore();
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(250, 256) as { detail: string }[];
    expect(plan.some(p => /INTEGER PRIMARY KEY.*rowid>\?.*rowid<\?/.test(p.detail))).toBe(true);
    expect(plan.some(p => /served_.*_idx|SCAN request_logs/.test(p.detail))).toBe(false);
  });
  it("makes a fully caught-up cache ready without starting a reader or aggregating", async () => {
    seed(3); cache.init();
    const aggregate = vi.spyOn(queries, "accumulateSince");
    const reader = vi.fn();
    cache.prepareDeferred(); await cache.startDeferred(reader);
    expect(cache.isReady).toBe(true); expect(reader).not.toHaveBeenCalled(); expect(aggregate).not.toHaveBeenCalled();
    expect(cache.summary().requests).toBe(3);
  });
});

describe("deferred cache lifecycle", () => {
  it("merges fixed historical IDs and new live requests/delivery failures once without moving the watermark backwards", async () => {
    seed(2); cache.init(); const completed = settings.get(STATS_CACHE_SETTINGS_KEY);
    seed(1); cache.prepareDeferred(); const before = queries.accumulateSince(2, 3);
    const work = controlled(); const pending = cache.startDeferred(work.read);
    expect(cache.startDeferred(work.read)).toBe(pending); expect(work.read).toHaveBeenCalledOnce(); expect(work.read).toHaveBeenCalledWith(2, 3);
    live(); live("live-error", 500);
    new RequestLogger(new RequestLogRepo(db), 1000, cache).amendDeliveryFailure("live", "synthetic reset");
    cache.flush(); expect(settings.get(STATS_CACHE_SETTINGS_KEY)).toBe(completed); expect(() => cache.summary()).toThrow("not ready");
    work.resolve(before); await pending;
    matchesSql(cache);
    expect(JSON.parse(settings.get(STATS_CACHE_SETTINGS_KEY)!).lastId).toBe(5);
    const reborn = new StatsCache(queries, settings); reborn.prepareDeferred();
    expect(reborn.isReady).toBe(true); expect(reborn.summary()).toEqual(cache.summary()); reborn.close();
  });
  it("keeps an incomplete/failed cache unavailable without persisting its live-only counters", async () => {
    seed(1); cache.init(); const persisted = settings.get(STATS_CACHE_SETTINGS_KEY);
    seed(1); cache.prepareDeferred(); const work = controlled(); const pending = cache.startDeferred(work.read);
    live(); work.reject(new Error("synthetic private detail")); await pending;
    expect(cache.status).toBe("failed"); cache.flush(); expect(settings.get(STATS_CACHE_SETTINGS_KEY)).toBe(persisted);
    await cache.startDeferred(work.read); expect(work.read).toHaveBeenCalledOnce();
  });
  it.each(["reset", "rebuild"] as const)("rejects an obsolete worker result after %s", async operation => {
    seed(3); cache.prepareDeferred(); const old = queries.accumulateSince(0, 3);
    const work = controlled(); const pending = cache.startDeferred(work.read);
    sqlite.prepare("delete from request_logs").run();
    if (operation === "rebuild") seed(1);
    cache[operation](); const complete = settings.get(STATS_CACHE_SETTINGS_KEY);
    expect(work.task.cancel).toHaveBeenCalledOnce();
    work.resolve(old); await pending;
    expect(settings.get(STATS_CACHE_SETTINGS_KEY)).toBe(complete);
    expect(cache.summary().requests).toBe(operation === "reset" ? 0 : 1);
  });
  it("discards a late worker failure after clear instead of marking the new cache failed", async () => {
    seed(1); cache.prepareDeferred(); const work = controlled(); const pending = cache.startDeferred(work.read);
    sqlite.prepare("delete from request_logs").run(); cache.reset(); work.reject(new Error("late failure")); await pending;
    expect(cache.status).toBe("ready"); expect(cache.summary().requests).toBe(0);
  });
  it("cancels shutdown without waiting or flushing partial state", async () => {
    seed(1); cache.init(); const persisted = settings.get(STATS_CACHE_SETTINGS_KEY);
    seed(1); cache.prepareDeferred(); const old = queries.accumulateSince(1, 2);
    const work = controlled(); const pending = cache.startDeferred(work.read); live(); cache.close();
    expect(work.task.cancel).toHaveBeenCalledOnce(); expect(settings.get(STATS_CACHE_SETTINGS_KEY)).toBe(persisted);
    work.resolve(old); await pending; expect(settings.get(STATS_CACHE_SETTINGS_KEY)).toBe(persisted);
  });
});

describe("readonly source worker and diagnostics", () => {
  it("reads only the captured range and leaves database/WAL bytes unchanged", async () => {
    seed(6, 1024); sqlite.pragma("wal_checkpoint(TRUNCATE)");
    const file = path.join(dir, "hydrogen.db");
    const digest = () => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const before = digest(), walBefore = fs.readFileSync(file + "-wal");
    const events: StartupEvent[] = [];
    const task = startStatsReader(file, 2, 5, event => events.push(event)); tasks.push(task);
    expect(() => startStatsReader(file, 0, 6)).toThrow("still active");
    expect(await task.result).toEqual(queries.accumulateSince(2, 5)); await task.stopped;
    expect(digest()).toBe(before); expect(fs.readFileSync(file + "-wal")).toEqual(walBefore);
    expect(events.map(e => `${e.stage}:${e.phase}`)).toEqual(["stats.worker.open:begin", "stats.worker.open:done", "stats.worker.scan:begin", "stats.worker.scan:done"]);
  });
  it("fails a missing-file worker without creating a database", async () => {
    const file = path.join(dir, "missing.db"); const task = startStatsReader(file, 0, 1); tasks.push(task);
    await expect(task.result).rejects.toThrow("initialization failed"); await task.stopped;
    expect(fs.existsSync(file)).toBe(false);
  });
  it("reports warm migration metadata without rebuilding indexes or exposing SQL/data", () => {
    const events: StartupEvent[] = []; const opened = openDatabase(dir, event => events.push(event)); opened.sqlite.close();
    expect(events.some(e => e.stage === "db.migrate.sql" && e.operation === "read_journal")).toBe(true);
    expect(events.some(e => e.operation === "create_index" || e.operation === "alter_table")).toBe(false);
    expect(events.some(e => e.stage === "db.migrate" && e.phase === "done")).toBe(true);
    for (const event of events) expect(Object.keys(event).every(k => ["event", "stage", "phase", "elapsedMs", "operation"].includes(k))).toBe(true);
    expect(startupStage(() => { throw new Error("diagnostic failed"); }, "test", () => 42)).toBe(42);
  });
});

describe("pending startup HTTP contract", () => {
  it("serves health and login, returns Retry-After for all stats including ranges, then returns exact totals", async () => {
    seed(3);
    vi.stubEnv("DATA_DIR", dir); vi.stubEnv("ADMIN_PASSWORD", "synthetic-password");
    vi.stubEnv("SESSION_SECRET", "synthetic-startup-session-secret"); vi.stubEnv("PROXY_MASTER_KEY", "07".repeat(32));
    container = await boot({ deferredStats: true }); app = await buildApp(container);
    const work = controlled(); const pending = container.statsCache.startDeferred(work.read);
    expect((await app.inject("/healthz")).statusCode).toBe(200);
    expect((await app.inject("/admin/api/stats/summary")).statusCode).toBe(401);
    const login = await app.inject({ method: "POST", url: "/admin/api/login", payload: { username: "admin", password: "synthetic-password" } });
    expect(login.statusCode).toBe(200); const cookie = `hydrogen_session=${login.cookies[0].value}`;
    const aggregate = vi.spyOn(container.stats, "summary");
    for (const endpoint of ["summary", "timeseries", "by-service", "by-model-provider"]) for (const suffix of ["", "?from=0"]) {
      const response = await app.inject({ url: `/admin/api/stats/${endpoint}${suffix}`, headers: { cookie } });
      expect(response.statusCode).toBe(503); expect(response.headers["retry-after"]).toBe("5");
      expect(response.json()).toEqual({ error: "Statistics are initializing. Reload shortly.", code: "statistics_initializing" });
    }
    expect(aggregate).not.toHaveBeenCalled();
    work.resolve(queries.accumulateSince(0, 3)); await pending;
    const ready = await app.inject({ url: "/admin/api/stats/summary", headers: { cookie } });
    expect(ready.statusCode).toBe(200); expect(ready.json()).toEqual(queries.summary({}));
  });
});
