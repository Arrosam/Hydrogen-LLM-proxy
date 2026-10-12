/**
 * Characterization of the request-log, statistics, active-request and hosted
 * tool admin routes. Logs and stats: the query-string grammar, the switch
 * between the in-memory cache (unbounded) and SQL (from/to given), and what
 * clearing the log does to the counters. Tools are here because their route
 * file answers differently from every other CRUD file, and that is pinned.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { requestLogs } from "../src/db/schema";
import { BLOCK_THRESHOLD_MS } from "../src/observability/activeRequests";
import { StatsCache } from "../src/persistence/statsCache";
import { startAdminHarness, type AdminHarness } from "./coverageAdminHarness";

let h: AdminHarness;

beforeAll(async () => {
  h = await startAdminHarness("cov-logs");
});

afterAll(async () => {
  await h.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A log row written the way the proxy writes one: table AND stats cache. */
function record(patch: { httpStatus?: number; requestedService?: string | null; tokenId?: number | null; serviceId?: number | null; totalTokens?: number } = {}): void {
  const total = patch.totalTokens ?? 15;
  h.c.requestLogger.record({
    traceId: `t-${Math.random()}`,
    tokenId: patch.tokenId ?? null,
    serviceId: patch.serviceId ?? null,
    requestedService: patch.requestedService === undefined ? "svc" : patch.requestedService,
    servedModel: "gpt-x",
    servedProvider: "prov",
    ingress: "openai_completion",
    egress: "openai_completion",
    streaming: false,
    httpStatus: patch.httpStatus ?? 200,
    http: { method: "POST", path: "/v1/chat/completions", query: "", headers: {}, bodyPayload: "{}" },
    usage: { promptTokens: total - 5, completionTokens: 5, totalTokens: total },
    latencyMs: 100,
    error: (patch.httpStatus ?? 200) >= 400 ? "failed" : null,
  } as never);
}

/** A row written straight into the table at a chosen time, behind the cache's back. */
function insertAt(atMs: number, httpStatus = 200): void {
  h.c.db
    .insert(requestLogs)
    .values({
      traceId: `raw-${atMs}`,
      requestedService: "raw",
      servedModel: "gpt-raw",
      servedProvider: "prov-raw",
      ingressFormat: "openai_completion",
      httpStatus,
      totalTokens: 1,
      latencyMs: 10,
      createdAt: new Date(atMs),
    } as never)
    .run();
}

function wipe(): void {
  h.c.logs.deleteAll();
  h.c.statsCache.reset();
}

const SUMMARY_KEYS = ["avgLatencyMs", "cacheCreationInputTokens", "cachedInputTokens", "completionTokens", "errors", "promptTokens", "reasoningTokens", "requests", "totalTokens"];
const ZERO_SUMMARY = { requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0, avgLatencyMs: 0 };

describe("GET /logs", () => {
  let tokenId: number;
  let serviceId: number;

  beforeAll(() => {
    wipe();
    tokenId = h.c.tokens.create({ name: "log-key" }).token.id;
    const provider = h.c.providers.create({ name: "log-prov", type: "openai_completion", baseUrl: "http://provider.invalid/v1", apiKey: "k" });
    const model = h.c.models.create({ name: "log-model" });
    h.c.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "up" });
    serviceId = h.c.services.create({ name: "log-svc", definition: { timeoutMs: 30_000, steps: [{ model: "log-model", provider: "log-prov" }] } as never }).id;

    record({ httpStatus: 200 });
    record({ httpStatus: 399 });
    record({ httpStatus: 400, tokenId });
    record({ httpStatus: 404, serviceId });
    record({ httpStatus: 500, tokenId, serviceId });
  });

  const rows = async (query: string): Promise<{ rows: Array<{ id: number; httpStatus: number }>; total: number }> => {
    const res = await h.admin({ url: `/logs${query}` });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  it("returns {rows,total}, newest first, in the list shape", async () => {
    const body = await rows("");
    expect(body.total).toBe(5);
    expect(body.rows.map((r) => r.httpStatus)).toEqual([500, 404, 400, 399, 200]);
    expect(Object.keys(body.rows[0]).sort()).toEqual([
      "attempts", "cacheCreationInputTokens", "cachedInputTokens", "completionTokens", "createdAt", "egressFormat", "error", "httpStatus", "id",
      "ingressFormat", "latencyMs", "promptTokens", "reasoningTokens", "serviceId", "serviceName", "streaming", "tokenId", "totalTokens",
    ]);
    expect(body.rows[0]).toMatchObject({ httpStatus: 500, serviceName: "svc", tokenId, serviceId, totalTokens: 15, error: "failed", createdAt: expect.any(Number) });
  });

  it("errorsOnly accepts exactly 1 and true (400 and up), and ignores anything else", async () => {
    for (const v of ["1", "true"]) {
      const body = await rows(`?errorsOnly=${v}`);
      expect(body.rows.map((r) => r.httpStatus), v).toEqual([500, 404, 400]);
      expect(body.total).toBe(3);
    }
    for (const v of ["yes", "TRUE", "0", "false", ""]) expect((await rows(`?errorsOnly=${v}`)).total, v).toBe(5);
  });

  it("filters by exact status, by key and by service, and combines them", async () => {
    expect((await rows("?status=404")).rows.map((r) => r.httpStatus)).toEqual([404]);
    expect((await rows("?status=418")).total).toBe(0);
    expect((await rows(`?tokenId=${tokenId}`)).rows.map((r) => r.httpStatus)).toEqual([500, 400]);
    expect((await rows(`?serviceId=${serviceId}`)).rows.map((r) => r.httpStatus)).toEqual([500, 404]);
    expect((await rows(`?serviceId=${serviceId}&tokenId=${tokenId}`)).rows.map((r) => r.httpStatus)).toEqual([500]);
  });

  it("limit and offset page the rows without changing total; junk values fall back to the defaults", async () => {
    const page = await rows("?limit=2&offset=1");
    expect(page.rows.map((r) => r.httpStatus)).toEqual([404, 400]);
    expect(page.total).toBe(5);

    expect((await rows("?limit=0")).rows).toHaveLength(1);
    expect((await rows("?limit=-5")).rows).toHaveLength(1);
    expect((await rows("?limit=abc")).rows).toHaveLength(5);
    expect((await rows("?limit=")).rows).toHaveLength(5);
    expect((await rows("?offset=-3")).rows.map((r) => r.httpStatus)).toEqual([500, 404, 400, 399, 200]);
    expect((await rows("?offset=abc&status=abc&tokenId=abc")).total).toBe(5);
    expect((await rows("?offset=99")).rows).toEqual([]);
  });

  it("from/to bound the rows by creation time, inclusively", async () => {
    const all = (await h.admin({ url: "/logs" })).json().rows as Array<{ createdAt: number }>;
    const newest = Math.max(...all.map((r) => r.createdAt));
    expect((await rows(`?from=${newest + 1}`)).total).toBe(0);
    expect((await rows(`?to=${newest}`)).total).toBe(5);
    expect((await rows("?to=1000")).total).toBe(0);
    expect((await rows("?from=abc")).total).toBe(5);
  });

  it("GET /logs/:id returns the full row; invalid id 400, unknown id 404", async () => {
    const id = (await rows("?status=500")).rows[0].id;
    const res = await h.admin({ url: `/logs/${id}` });
    expect(res.statusCode).toBe(200);
    const { log } = res.json();
    expect(log).toMatchObject({ id, httpStatus: 500, requestedService: "svc", servedModel: "gpt-x", servedProvider: "prov", requestPath: "/v1/chat/completions", createdAtMs: expect.any(Number) });
    expect(log).toHaveProperty("requestPayload");
    expect(log).toHaveProperty("responsePayload");

    const bad = await h.admin({ url: "/logs/abc" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "invalid id" });

    const missing = await h.admin({ url: "/logs/99999" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not found" });
  });

  it("a manager cannot read or clear the log, but reads every statistic", async () => {
    const refused: Array<[Parameters<AdminHarness["manager"]>[0], string]> = [
      [{ url: "/logs" }, "view request logs"],
      [{ url: "/logs/abc" }, "view request logs"],
      [{ method: "DELETE", url: "/logs" }, "clear logs"],
    ];
    for (const [call, action] of refused) {
      const res = await h.manager(call);
      expect(res.statusCode, `${call.method ?? "GET"} ${call.url}`).toBe(403);
      expect(res.json()).toEqual({ error: `only an admin can ${action}` });
    }
    expect(h.c.logs.query({}).total).toBe(5);
    for (const url of ["/stats/summary", "/stats/timeseries", "/stats/by-service", "/stats/by-model-provider", "/stats/summary?from=1"]) {
      expect((await h.manager({ url })).statusCode, url).toBe(200);
    }
  });
});

describe("statistics", () => {
  beforeEach(() => {
    wipe();
  });

  it("an empty instance reports zeros and empty groups, from the cache and from SQL alike", async () => {
    for (const q of ["", "?from=1"]) {
      expect((await h.admin({ url: `/stats/summary${q}` })).json(), q).toEqual(ZERO_SUMMARY);
      expect((await h.admin({ url: `/stats/timeseries${q}` })).json(), q).toEqual({ points: [] });
      expect((await h.admin({ url: `/stats/by-service${q}` })).json(), q).toEqual({ groups: [] });
      expect((await h.admin({ url: `/stats/by-model-provider${q}` })).json(), q).toEqual({ models: [], providers: [] });
    }
  });

  it("each endpoint returns its shape, and the unbounded answer equals the SQL aggregation", async () => {
    record({ httpStatus: 200, requestedService: "a" });
    record({ httpStatus: 500, requestedService: "a" });
    record({ httpStatus: 200, requestedService: "b", totalTokens: 30 });

    const summary = (await h.admin({ url: "/stats/summary" })).json();
    expect(Object.keys(summary).sort()).toEqual(SUMMARY_KEYS);
    expect(summary).toMatchObject({ requests: 3, errors: 1, totalTokens: 60, completionTokens: 15, promptTokens: 45, avgLatencyMs: 100 });
    expect(summary).toEqual(h.c.stats.summary({}));

    const series = (await h.admin({ url: "/stats/timeseries" })).json();
    expect(Object.keys(series)).toEqual(["points"]);
    expect(series.points).toHaveLength(1);
    expect(series.points).toEqual(h.c.stats.timeSeries({}));

    const byService = (await h.admin({ url: "/stats/by-service" })).json();
    expect(Object.keys(byService)).toEqual(["groups"]);
    expect(byService.groups).toHaveLength(2);
    expect(byService.groups).toEqual(h.c.stats.byService({}));

    const byModel = (await h.admin({ url: "/stats/by-model-provider" })).json();
    expect(Object.keys(byModel).sort()).toEqual(["models", "providers"]);
    expect(byModel.models).toHaveLength(1);
    expect(byModel.providers).toHaveLength(1);
    expect(byModel).toEqual(h.c.stats.byModelProvider({}));
  });

  it("a from or to makes the route run SQL over that range; without one it answers from the cache", async () => {
    record({ httpStatus: 200 });
    // Three rows the cache has never seen, at fixed times.
    insertAt(1000);
    insertAt(2000, 500);
    insertAt(3000);

    const cached = (await h.admin({ url: "/stats/summary" })).json();
    expect(cached.requests).toBe(1);

    const requests = async (q: string): Promise<number> => (await h.admin({ url: `/stats/summary${q}` })).json().requests;
    expect(await requests("?from=1")).toBe(4);
    expect(await requests("?to=3000")).toBe(3);
    expect(await requests("?from=2000&to=3000")).toBe(2);
    expect(await requests("?from=2000&to=2000")).toBe(1);
    expect(await requests("?from=3001&to=4000")).toBe(0);
    expect((await h.admin({ url: "/stats/summary?from=2000&to=2000" })).json()).toMatchObject({ requests: 1, errors: 1, totalTokens: 1, avgLatencyMs: 10 });

    // An empty or unparsable bound is no bound at all: back to the cache.
    for (const q of ["?from=", "?from=abc", "?to=abc", "?from=&to="]) expect(await requests(q), q).toBe(1);

    expect((await h.admin({ url: "/stats/by-service?to=3000" })).json().groups).toEqual(h.c.stats.byService({ to: 3000 }));
    expect((await h.admin({ url: "/stats/by-service?to=3000" })).json().groups).toHaveLength(1);
    expect((await h.admin({ url: "/stats/by-service" })).json().groups).toEqual(h.c.statsCache.byService());
    expect((await h.admin({ url: "/stats/timeseries?to=3000" })).json().points).toEqual(h.c.stats.timeSeries({ to: 3000 }));
    expect((await h.admin({ url: "/stats/by-model-provider?to=3000" })).json()).toEqual(h.c.stats.byModelProvider({ to: 3000 }));
    expect((await h.admin({ url: "/stats/by-model-provider?to=3000" })).json().models).toHaveLength(1);
  });
});

describe("DELETE /logs", () => {
  it("removes every row, reports how many, and resets the statistics for good", async () => {
    wipe();
    record({ httpStatus: 200 });
    record({ httpStatus: 500 });
    record({ httpStatus: 200 });
    expect((await h.admin({ url: "/stats/summary" })).json()).toMatchObject({ requests: 3, errors: 1 });

    const res = await h.admin({ method: "DELETE", url: "/logs" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 3 });

    expect((await h.admin({ url: "/logs" })).json()).toEqual({ rows: [], total: 0 });
    expect((await h.admin({ url: "/stats/summary" })).json()).toEqual(ZERO_SUMMARY);
    expect((await h.admin({ url: "/stats/by-service" })).json()).toEqual({ groups: [] });
    expect((await h.admin({ url: "/stats/timeseries" })).json()).toEqual({ points: [] });

    // What a restart would load: a fresh cache over the same database is zero too.
    const fresh = new StatsCache(h.c.stats, h.c.settings);
    fresh.init();
    expect(fresh.summary()).toEqual(ZERO_SUMMARY);

    expect((await h.admin({ method: "DELETE", url: "/logs" })).json()).toEqual({ deleted: 0 });
  });
});

describe("active requests", () => {
  /** Register a request as if it had started `ageMs` ago. */
  function start(traceId: string, ageMs: number): void {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValueOnce(now - ageMs);
    h.c.activeRequests.start({ traceId, tokenId: null, serviceId: 7, serviceName: "svc", ingress: "openai_completion", streaming: true });
    vi.restoreAllMocks();
  }

  beforeEach(() => {
    h.c.activeRequests.clear();
  });
  afterAll(() => {
    h.c.activeRequests.clear();
  });

  it("an idle instance: empty lists plus the threshold and the server clock", async () => {
    const res = await h.admin({ url: "/active-requests" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: [], completed: [], blockThresholdMs: BLOCK_THRESHOLD_MS, now: expect.any(Number) });
    expect(BLOCK_THRESHOLD_MS).toBe(30_000);
  });

  it("lists in-flight requests blocked first, then longest-running; completed ones newest first", async () => {
    start("young", 1_000);
    start("old-blocked", 90_000);
    start("middle", 10_000);
    start("blocked", 40_000);
    start("done-1", 5_000);
    start("done-2", 5_000);
    h.c.activeRequests.record("middle", "llm", "llm.send", "sent upstream", { attempt: 1 });
    h.c.activeRequests.finish("done-1", 200);
    h.c.activeRequests.finish("done-2", 502, "upstream failed");

    const body = (await h.manager({ url: "/active-requests" })).json();
    expect(body.active.map((r: { traceId: string }) => r.traceId)).toEqual(["old-blocked", "blocked", "middle", "young"]);
    expect(body.active.map((r: { blocked: boolean }) => r.blocked)).toEqual([true, true, false, false]);
    expect(body.completed.map((r: { traceId: string }) => r.traceId)).toEqual(["done-2", "done-1"]);

    const middle = body.active[2];
    expect(Object.keys(middle).sort()).toEqual([
      "blocked", "done", "elapsedMs", "error", "eventCount", "events", "httpStatus", "ingress", "lastEventTs", "lastMessage", "lastNode", "lastPhase",
      "serviceId", "serviceName", "startedAt", "streaming", "tokenId", "traceId", "updatedAt",
    ]);
    expect(middle).toMatchObject({
      traceId: "middle", tokenId: null, serviceId: 7, serviceName: "svc", ingress: "openai_completion", streaming: true, done: false, httpStatus: null, error: null,
      eventCount: 1, lastPhase: "llm", lastNode: "llm.send", lastMessage: "sent upstream",
    });
    expect(middle.events).toEqual([{ ts: expect.any(Number), phase: "llm", node: "llm.send", message: "sent upstream", detail: { attempt: 1 } }]);
    expect(body.active[3]).toMatchObject({ eventCount: 0, lastPhase: null, lastNode: null, lastMessage: null, lastEventTs: null, events: [] });

    // A finished request is never "blocked", however long it ran.
    expect(body.completed[0]).toMatchObject({ traceId: "done-2", done: true, httpStatus: 502, error: "upstream failed", blocked: false });
    expect(body.completed[1]).toMatchObject({ traceId: "done-1", done: true, httpStatus: 200, error: null, blocked: false });
  });

  it("?traceId= filters both lists to that one request", async () => {
    start("a", 1_000);
    start("b", 1_000);
    start("c", 1_000);
    h.c.activeRequests.finish("c", 200);

    const active = (await h.admin({ url: "/active-requests?traceId=b" })).json();
    expect(active.active.map((r: { traceId: string }) => r.traceId)).toEqual(["b"]);
    expect(active.completed).toEqual([]);
    expect(active).toMatchObject({ blockThresholdMs: BLOCK_THRESHOLD_MS, now: expect.any(Number) });

    const done = (await h.admin({ url: "/active-requests?traceId=c" })).json();
    expect(done.active).toEqual([]);
    expect(done.completed.map((r: { traceId: string }) => r.traceId)).toEqual(["c"]);

    const none = (await h.admin({ url: "/active-requests?traceId=nope" })).json();
    expect(none.active).toEqual([]);
    expect(none.completed).toEqual([]);
  });

  it("at most the 20 newest completed requests are listed", async () => {
    for (let i = 1; i <= 25; i++) {
      start(`r${i}`, 10);
      h.c.activeRequests.finish(`r${i}`, 200);
    }
    const { completed } = (await h.admin({ url: "/active-requests" })).json();
    expect(completed).toHaveLength(20);
    expect(completed[0].traceId).toBe("r25");
    expect(completed[19].traceId).toBe("r6");
  });

  it("GET /active-requests/:traceId returns one request, in flight or finished; unknown is 404", async () => {
    start("live", 1_000);
    h.c.activeRequests.record("live", "init", "request.received", "received");
    h.c.activeRequests.record("live", "llm", "llm.send", "sent");
    start("finished", 1_000);
    h.c.activeRequests.finish("finished", 499, "client went away");

    const live = await h.admin({ url: "/active-requests/live" });
    expect(live.statusCode).toBe(200);
    expect(Object.keys(live.json()).sort()).toEqual(["blockThresholdMs", "request"]);
    expect(live.json().request).toMatchObject({ traceId: "live", done: false, eventCount: 2, lastNode: "llm.send" });
    expect(live.json().request.events.map((e: { node: string }) => e.node)).toEqual(["request.received", "llm.send"]);

    const finished = await h.manager({ url: "/active-requests/finished" });
    expect(finished.statusCode).toBe(200);
    expect(finished.json().request).toMatchObject({ traceId: "finished", done: true, httpStatus: 499, error: "client went away" });

    const missing = await h.admin({ url: "/active-requests/nope" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "trace not found (may have expired from the ring buffer)" });
  });

  it("/active-requests/stats is the counters route, not a trace named 'stats'", async () => {
    start("young", 1_000);
    start("stuck", 31_000);
    start("gone", 1_000);
    h.c.activeRequests.record("young", "init", "n", "m");
    h.c.activeRequests.finish("gone", 200);

    const res = await h.manager({ url: "/active-requests/stats" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: 2, completed: 1, totalEvents: 1, blocked: 1, blockThresholdMs: BLOCK_THRESHOLD_MS, now: expect.any(Number) });
  });

  it("requires a session", async () => {
    for (const url of ["/active-requests", "/active-requests/stats", "/active-requests/x"]) {
      expect((await h.as(null, { url })).statusCode, url).toBe(401);
    }
  });
});

describe("hosted tools (the route file whose conventions differ from the rest)", () => {
  const TOOL = { name: "lookup", url: "https://adapter.invalid/run", parameters: { type: "object" }, bodyTemplate: { args: "{{arguments}}" }, headers: { authorization: "Bearer tool-secret" } };
  const { headers: _headers, ...TOOL_WITHOUT_HEADERS } = TOOL;
  let id: number;

  it("POST creates with 201 {tool}, never echoing header values", async () => {
    const res = await h.admin({ method: "POST", url: "/tools", payload: TOOL });
    expect(res.statusCode).toBe(201);
    expect(Object.keys(res.json())).toEqual(["tool"]);
    expect(res.json().tool).toMatchObject({ id: expect.any(Number), name: "lookup", url: "https://adapter.invalid/run", headerNames: ["authorization"] });
    expect(res.body).not.toContain("tool-secret");
    id = res.json().tool.id;
  });

  it("GET lists {tools}", async () => {
    const res = await h.admin({ url: "/tools" });
    expect(res.statusCode).toBe(200);
    expect(res.json().tools.map((t: { id: number }) => t.id)).toEqual([id]);
    expect(res.body).not.toContain("tool-secret");
  });

  it("an invalid body is 400 with the bare messages -- no `path:` prefix, unlike the other route files", async () => {
    const res = await h.admin({ method: "POST", url: "/tools", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Required; Required; Required; Request template must be a JSON object" });

    const patch = await h.admin({ method: "PATCH", url: `/tools/${id}`, payload: {} });
    expect(patch.statusCode).toBe(400);
    expect(patch.json()).toEqual({ error: "Required; Required; Required; Request template must be a JSON object" });
  });

  it("an invalid id is 400 with zod's text rather than 'invalid id'", async () => {
    const del = await h.admin({ method: "DELETE", url: "/tools/abc" });
    expect(del.statusCode).toBe(400);
    expect(del.json()).toEqual({ error: "Expected number, received nan" });

    const patch = await h.admin({ method: "PATCH", url: "/tools/abc", payload: TOOL_WITHOUT_HEADERS });
    expect(patch.statusCode).toBe(400);
    expect(patch.json()).toEqual({ error: "Expected number, received nan" });

    const zero = await h.admin({ method: "DELETE", url: "/tools/0" });
    expect(zero.statusCode).toBe(400);
    expect(zero.json()).toEqual({ error: "Number must be greater than 0" });
  });

  it("PATCH on an unknown id is 404 'Tool not found'; the body is validated before the id", async () => {
    const res = await h.admin({ method: "PATCH", url: "/tools/99999", payload: TOOL_WITHOUT_HEADERS });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Tool not found" });

    const both = await h.admin({ method: "PATCH", url: "/tools/abc", payload: {} });
    expect(both.statusCode).toBe(400);
    expect(both.json()).toEqual({ error: "Required; Required; Required; Request template must be a JSON object" });
  });

  it("PATCH updates and keeps the stored headers when none are sent", async () => {
    const res = await h.admin({ method: "PATCH", url: `/tools/${id}`, payload: { ...TOOL_WITHOUT_HEADERS, url: "https://adapter.invalid/v2" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().tool).toMatchObject({ id, url: "https://adapter.invalid/v2", headerNames: ["authorization"] });
  });

  it("POST /tools/preview renders a template; a template error is a 400 with its message", async () => {
    const ok = await h.admin({
      method: "POST",
      url: "/tools/preview",
      payload: { bodyTemplate: { q: "{{arguments.q}}", tool: "{{tool.name}}" }, arguments: { q: "hi" }, toolName: "lookup", result: { data: { answer: 42 } }, resultPath: "/data/answer" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ body: { q: "hi", tool: "lookup" }, result: 42 });

    const noResult = await h.admin({ method: "POST", url: "/tools/preview", payload: { bodyTemplate: { q: 1 }, arguments: {}, toolName: "t" } });
    expect(noResult.json()).toEqual({ body: { q: 1 } });

    const bad = await h.admin({ method: "POST", url: "/tools/preview", payload: { bodyTemplate: [], arguments: {}, toolName: "t" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "Request body must be a JSON object" });

    const shape = await h.admin({ method: "POST", url: "/tools/preview", payload: {} });
    expect(shape.statusCode).toBe(400);
    expect(shape.json()).toEqual({ error: "Required; Required" });
  });

  it("DELETE answers 200 {deleted:true} -- not {ok:true} -- and has no existence check", async () => {
    const missing = await h.admin({ method: "DELETE", url: "/tools/99999" });
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toEqual({ deleted: true });

    const ok = await h.admin({ method: "DELETE", url: `/tools/${id}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ deleted: true });
    expect((await h.admin({ url: "/tools" })).json()).toEqual({ tools: [] });
  });

  it("a manager is refused the whole file by one hook, with one message, the list included", async () => {
    const calls: Array<Parameters<AdminHarness["manager"]>[0]> = [
      { url: "/tools" },
      { method: "POST", url: "/tools", payload: TOOL },
      { method: "PATCH", url: "/tools/abc", payload: {} },
      { method: "DELETE", url: "/tools/abc" },
      { method: "POST", url: "/tools/preview", payload: {} },
    ];
    for (const call of calls) {
      const res = await h.manager(call);
      expect(res.statusCode, `${call.method ?? "GET"} ${call.url}`).toBe(403);
      expect(res.json()).toEqual({ error: "only an admin can configure hosted tools" });
    }
  });
});
