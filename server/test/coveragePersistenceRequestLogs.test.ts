/**
 * Request-log reads at their edges: the list query's paging clamps and filters,
 * and the ranged (SQL) statistics the dashboard falls back to whenever a time
 * window is asked for. Each block owns a fresh database, so the counts below are
 * exact rather than "at least".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { openDatabase, type DB } from "../src/db";
import { requestLogs } from "../src/db/schema";
import { RequestLogRepo, type LogInsert } from "../src/persistence/requestLogRepo";
import { StatsQueries } from "../src/persistence/statsQueries";
import { TokenRepo } from "../src/persistence/tokenRepo";
import { ServiceRepo } from "../src/persistence/serviceRepo";

interface Instance {
  dir: string;
  sqlite: BetterSqlite3.Database;
  db: DB;
}

function open(): Instance {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydro-coverage-logs-"));
  const { db, sqlite } = openDatabase(dir);
  return { dir, sqlite, db };
}

function close(i: Instance): void {
  i.sqlite.close();
  fs.rmSync(i.dir, { recursive: true, force: true });
}

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

/** Insert a row stamped at an exact instant (the repo stamps "now"). */
function insertAt(i: Instance, atMs: number, patch: Partial<LogInsert> = {}): void {
  i.db.insert(requestLogs).values({ ...row(patch), createdAt: new Date(atMs) }).run();
}

describe("StatsQueries over a time range", () => {
  let i: Instance;
  let stats: StatsQueries;

  beforeAll(() => {
    i = open();
    stats = new StatsQueries(i.db);
    insertAt(i, 1000, { latencyMs: 10, totalTokens: 1, promptTokens: 1, completionTokens: 0, requestedService: "a" });
    insertAt(i, 2000, { latencyMs: 20, totalTokens: 2, promptTokens: 1, completionTokens: 1, requestedService: "b", httpStatus: 500 });
    insertAt(i, 3000, { latencyMs: 60, totalTokens: 4, promptTokens: 2, completionTokens: 2, requestedService: "b" });
  });
  afterAll(() => close(i));

  it("includes a row stamped exactly at `from`", () => {
    expect(stats.summary({ from: 2000 })).toMatchObject({ requests: 2, errors: 1, totalTokens: 6, avgLatencyMs: 40 });
    expect(stats.summary({ from: 2001 })).toMatchObject({ requests: 1, errors: 0, totalTokens: 4, avgLatencyMs: 60 });
  });

  it("includes a row stamped exactly at `to`", () => {
    expect(stats.summary({ to: 2000 })).toMatchObject({ requests: 2, errors: 1, totalTokens: 3, avgLatencyMs: 15 });
    expect(stats.summary({ to: 1999 })).toMatchObject({ requests: 1, errors: 0, totalTokens: 1, avgLatencyMs: 10 });
  });

  it("answers a single instant when from and to coincide", () => {
    expect(stats.summary({ from: 2000, to: 2000 })).toMatchObject({ requests: 1, errors: 1, totalTokens: 2, avgLatencyMs: 20 });
  });

  it("answers all zeroes, not nulls, for a window holding no rows", () => {
    const empty = {
      requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
      cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0, avgLatencyMs: 0,
    };
    expect(stats.summary({ from: 3001 })).toEqual(empty);
    expect(stats.summary({ to: 999 })).toEqual(empty);
    expect(stats.summary({ from: 2500, to: 1500 })).toEqual(empty); // inverted window
  });

  it("an open range is the whole table", () => {
    expect(stats.summary({})).toMatchObject({ requests: 3, errors: 1, totalTokens: 7, promptTokens: 4, completionTokens: 3, avgLatencyMs: 30 });
  });

  it("narrows the per-day series to the same window", () => {
    expect(stats.timeSeries({})).toEqual([{ day: "1970-01-01", requests: 3, totalTokens: 7, errors: 1, avgLatencyMs: 30 }]);
    expect(stats.timeSeries({ from: 2000 })).toEqual([{ day: "1970-01-01", requests: 2, totalTokens: 6, errors: 1, avgLatencyMs: 40 }]);
    expect(stats.timeSeries({ from: 2000, to: 2000 })).toEqual([{ day: "1970-01-01", requests: 1, totalTokens: 2, errors: 1, avgLatencyMs: 20 }]);
    expect(stats.timeSeries({ from: 3001 })).toEqual([]);
  });

  it("splits the series at the UTC day boundary, oldest day first", () => {
    const DAY = 86_400_000;
    insertAt(i, 2 * DAY, { latencyMs: 7, totalTokens: 9 }); // 1970-01-03T00:00:00Z
    insertAt(i, 2 * DAY - 1, { latencyMs: 3, totalTokens: 5 }); // the last ms of 1970-01-02
    expect(stats.timeSeries({ from: DAY })).toEqual([
      { day: "1970-01-02", requests: 1, totalTokens: 5, errors: 0, avgLatencyMs: 3 },
      { day: "1970-01-03", requests: 1, totalTokens: 9, errors: 0, avgLatencyMs: 7 },
    ]);
  });

  it("applies the window to the service and model/provider breakdowns", () => {
    expect(stats.byService({ to: 3000 })).toEqual([
      { key: "b", requests: 2, totalTokens: 6 },
      { key: "a", requests: 1, totalTokens: 1 },
    ]);
    expect(stats.byService({ to: 1000 })).toEqual([{ key: "a", requests: 1, totalTokens: 1 }]);
    expect(stats.byModelProvider({ from: 3000, to: 3000 })).toEqual({
      models: [{ key: "gpt-x", requests: 1, totalTokens: 4 }],
      providers: [{ key: "prov", requests: 1, totalTokens: 4 }],
    });
    expect(stats.byModelProvider({ to: 0 })).toEqual({ models: [], providers: [] });
  });
});

describe("RequestLogRepo.query", () => {
  let i: Instance;
  let logs: RequestLogRepo;
  let tokenA: number;
  let tokenB: number;
  let serviceA: number;
  let serviceB: number;

  const ids = (q: Parameters<RequestLogRepo["query"]>[0]): number[] => logs.query(q).rows.map((r) => r.id);

  beforeAll(() => {
    i = open();
    logs = new RequestLogRepo(i.db);
    const tokens = new TokenRepo(i.db, Buffer.alloc(32, 7));
    tokenA = tokens.create({ name: "a" }).token.id;
    tokenB = tokens.create({ name: "b" }).token.id;
    const services = new ServiceRepo(i.db);
    const definition = { timeoutMs: 5000, steps: [{ model: "gpt-x", provider: "prov" }] };
    serviceA = services.create({ name: "svc-a", description: null, definition }).id;
    serviceB = services.create({ name: "svc-b", description: null, definition }).id;

    // ids 1..6, oldest first
    logs.insert(row({ httpStatus: 200, tokenId: tokenA, serviceId: serviceA }));
    logs.insert(row({ httpStatus: 399, tokenId: tokenA, serviceId: serviceB }));
    logs.insert(row({ httpStatus: 400, tokenId: tokenB, serviceId: serviceA }));
    logs.insert(row({ httpStatus: 404, tokenId: tokenB, serviceId: serviceB, error: "not found" }));
    logs.insert(row({ httpStatus: 500, error: "boom" }));
    logs.insert(row({ httpStatus: 200, requestedService: "other" }));
  });
  afterAll(() => close(i));

  it("lists newest first and reports the unpaged total", () => {
    const { rows, total } = logs.query({});
    expect(total).toBe(6);
    expect(rows.map((r) => r.id)).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it("returns the list shape the dashboard reads", () => {
    const newest = logs.query({ limit: 1 }).rows[0];
    expect(newest).toMatchObject({
      id: 6, tokenId: null, serviceId: null, serviceName: "other",
      ingressFormat: "openai_completion", egressFormat: "anthropic", streaming: false, httpStatus: 200,
      promptTokens: 10, completionTokens: 5, totalTokens: 15,
      cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0,
      latencyMs: 100, attempts: 1, error: null,
    });
    expect(typeof newest.createdAt).toBe("number");
    expect(Math.abs(newest.createdAt - Date.now())).toBeLessThan(60_000);
    // The list never carries the captured bodies.
    expect(newest).not.toHaveProperty("requestBody");
    expect(newest).not.toHaveProperty("responseBody");
  });

  it("raises a limit below one to one row", () => {
    expect(ids({ limit: 0 })).toEqual([6]);
    expect(ids({ limit: -5 })).toEqual([6]);
  });

  it("treats a negative offset as zero", () => {
    expect(ids({ offset: -3, limit: 2 })).toEqual(ids({ offset: 0, limit: 2 }));
    expect(ids({ offset: -3, limit: 2 })).toEqual([6, 5]);
  });

  it("pages with offset, and runs out cleanly past the end", () => {
    expect(ids({ limit: 2, offset: 2 })).toEqual([4, 3]);
    expect(ids({ limit: 2, offset: 5 })).toEqual([1]);
    expect(logs.query({ limit: 2, offset: 6 })).toEqual({ rows: [], total: 6 });
  });

  it("does not let limit or offset change the total", () => {
    expect(logs.query({ limit: 1 }).total).toBe(6);
    expect(logs.query({ limit: 1, offset: 4 }).total).toBe(6);
    expect(logs.query({ errorsOnly: true, limit: 1, offset: 1 }).total).toBe(3);
  });

  it("matches a status exactly", () => {
    expect(ids({ status: 404 })).toEqual([4]);
    expect(logs.query({ status: 404 }).total).toBe(1);
    expect(ids({ status: 200 })).toEqual([6, 1]);
    expect(logs.query({ status: 418 })).toEqual({ rows: [], total: 0 });
  });

  it("errorsOnly starts at 400: 399 is not an error", () => {
    expect(ids({ errorsOnly: true })).toEqual([5, 4, 3]);
    expect(logs.query({ errorsOnly: true }).total).toBe(3);
    expect(ids({ errorsOnly: false })).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it("filters by API key and by service, and combines filters with AND", () => {
    expect(ids({ tokenId: tokenA })).toEqual([2, 1]);
    expect(ids({ tokenId: tokenB })).toEqual([4, 3]);
    expect(ids({ serviceId: serviceA })).toEqual([3, 1]);
    expect(ids({ serviceId: serviceB })).toEqual([4, 2]);
    expect(ids({ tokenId: tokenB, serviceId: serviceB })).toEqual([4]);
    expect(ids({ tokenId: tokenA, errorsOnly: true })).toEqual([]);
    expect(ids({ status: 404, errorsOnly: true })).toEqual([4]);
    expect(logs.query({ tokenId: 9999 })).toEqual({ rows: [], total: 0 });
  });

  it("filters on an inclusive time window", () => {
    insertAt(i, 1000, { traceId: "old-1" }); // id 7
    insertAt(i, 2000, { traceId: "old-2" }); // id 8
    try {
      expect(ids({ to: 2000 })).toEqual([8, 7]);
      expect(ids({ from: 1000, to: 1000 })).toEqual([7]);
      expect(ids({ from: 1001, to: 2000 })).toEqual([8]);
      expect(logs.query({ from: 1001, to: 1999 })).toEqual({ rows: [], total: 0 });
      expect(logs.query({ from: 2001 }).total).toBe(6); // everything stamped "now"
      expect(logs.query({ to: 2000 }).rows[0].createdAt).toBe(2000);
    } finally {
      i.sqlite.prepare("DELETE FROM request_logs WHERE trace_id IN ('old-1', 'old-2')").run();
    }
  });

  it("defaults to 50 rows and never returns more than 500", () => {
    const before = logs.query({}).total;
    logs.transaction(() => {
      for (let n = before; n < 501; n++) logs.insert(row({ traceId: "bulk" }));
    });
    expect(logs.query({}).total).toBe(501);

    expect(logs.query({}).rows).toHaveLength(50);
    expect(logs.query({ limit: 500 }).rows).toHaveLength(500);
    const capped = logs.query({ limit: 501 });
    expect(capped.rows).toHaveLength(500);
    expect(capped.total).toBe(501);
    expect(logs.query({ limit: 100_000 }).rows).toHaveLength(500);
    // The one row the cap left out is the oldest.
    expect(capped.rows[capped.rows.length - 1].id).toBe(2);
    expect(ids({ limit: 501, offset: 500 })).toEqual([1]);
  });
});
