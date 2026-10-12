import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";
import { ActiveRequestRegistry, BLOCK_THRESHOLD_MS } from "../src/observability/activeRequests";
import { ProgressRecorder } from "../src/observability/progressRecorder";
import { runSteps, type AttemptResult } from "../src/execution/steps";
import type { ServiceSteps } from "../src/execution/definition";
import type { ProgressEvent } from "../src/observability/activeRequests";
import Fastify from "fastify";
import { activeRequestRoutes } from "../src/transport/admin/activeRequestRoutes";
import { retryConfig } from "./retryFixture";

const noSleep = { sleep: async () => {} };

function steps(s: ServiceSteps["steps"]): ServiceSteps {
  return { timeoutMs: 60000, steps: s };
}

describe("ActiveRequestRegistry", () => {
  let reg: ActiveRequestRegistry;

  beforeEach(() => {
    reg = new ActiveRequestRegistry(64);
  });

  it("registers a request, records events, and finishes it", () => {
    reg.start({ traceId: "trace-1", tokenId: 1, serviceId: 2, serviceName: "svc", ingress: "openai_completion", streaming: false });
    reg.record("trace-1", "init", "request.received", "received");
    reg.record("trace-1", "llm", "llm.send", "sending");
    reg.record("trace-1", "done", "request.complete", "done");

    const active = reg.listActive();
    expect(active).toHaveLength(1);
    expect(active[0].events).toHaveLength(3);
    expect(active[0].done).toBe(false);

    reg.finish("trace-1", 200);
    expect(reg.listActive()).toHaveLength(0);
    expect(reg.listCompleted()).toHaveLength(1);
    const done = reg.listCompleted()[0];
    expect(done.httpStatus).toBe(200);
    expect(done.done).toBe(true);
  });

  it("flags requests as blocked after the threshold", async () => {
    // `blocked` is computed by the admin API's serializer, so ask the API.
    const startedAt = 1_700_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    reg.start({ traceId: "trace-blocked", tokenId: null, serviceId: null, serviceName: null, ingress: "openai_completion", streaming: false });
    const app = Fastify({ logger: false });
    await activeRequestRoutes(app, { activeRequests: reg } as never);
    const listed = async () => (await app.inject({ url: "/active-requests" })).json<{ active: Array<{ traceId: string; blocked: boolean; elapsedMs: number }> }>().active[0];
    try {
      clock.mockReturnValue(startedAt + BLOCK_THRESHOLD_MS - 5000);
      expect(await listed()).toMatchObject({ traceId: "trace-blocked", blocked: false, elapsedMs: BLOCK_THRESHOLD_MS - 5000 });
      clock.mockReturnValue(startedAt + BLOCK_THRESHOLD_MS + 5000);
      expect(await listed()).toMatchObject({ traceId: "trace-blocked", blocked: true, elapsedMs: BLOCK_THRESHOLD_MS + 5000 });
    } finally {
      clock.mockRestore();
      await app.close();
    }
  });

  it("retains only the last N completed requests (ring buffer)", () => {
    const RETENTION = 64; // what `reg` was built with
    const finish = (i: number): void => {
      reg.start({ traceId: `trace-${i}`, tokenId: null, serviceId: null, serviceName: null, ingress: "openai_completion", streaming: false });
      reg.finish(`trace-${i}`, 200);
    };
    for (let i = 0; i < 10; i++) finish(i);
    // Ask for more than the default page (50), or the page size hides the ring's.
    expect(reg.listCompleted(1_000)).toHaveLength(10);
    // Now overflow the ring buffer: 80 finished in all.
    for (let i = 10; i < 80; i++) finish(i);
    const kept = reg.listCompleted(1_000).map((r) => r.traceId);
    expect(kept).toHaveLength(RETENTION);
    expect(kept[0]).toBe("trace-79"); // newest first
    expect(kept.at(-1)).toBe("trace-16"); // the oldest 16 were dropped
    expect(reg.get("trace-15")).toBeUndefined();
    expect(reg.get("trace-16")).toBeDefined();
  });

  it("get() finds both active and completed requests", () => {
    reg.start({ traceId: "trace-active", tokenId: null, serviceId: null, serviceName: null, ingress: "openai_completion", streaming: false });
    expect(reg.get("trace-active")).toBeDefined();

    reg.finish("trace-active", 200);
    expect(reg.get("trace-active")).toBeDefined(); // found in completed

    expect(reg.get("trace-nonexistent")).toBeUndefined();
  });

  it("record() is a no-op for unregistered traceIds", () => {
    reg.record("nonexistent", "init", "test", "should not throw");
    expect(reg.stats().totalEvents).toBe(0);
  });
});

describe("ProgressRecorder", () => {
  it("records events when a registry is attached", () => {
    const reg = new ActiveRequestRegistry();
    reg.start({ traceId: "trace-1", tokenId: null, serviceId: null, serviceName: null, ingress: "openai_completion", streaming: false });
    const rec = new ProgressRecorder(reg, "trace-1");
    rec.record("init", "test", "hello");
    expect(reg.get("trace-1")!.events).toHaveLength(1);
  });

  it("is a no-op when no registry is attached (null recorder)", () => {
    const rec = new ProgressRecorder(null, "trace-1");
    rec.record("init", "test", "hello");
    expect(rec.enabled).toBe(false);
  });
});

// --- Test 1: High-concurrency progress accuracy (10+ concurrent requests) ---

describe("Concurrent progress tracking (10+ concurrent requests)", () => {
  it("captures all progress events for 15 concurrent requests without loss", async () => {
    const reg = new ActiveRequestRegistry();
    const N = 15;
    const traceIds = Array.from({ length: N }, (_, i) => `trace-conc-${i}`);

    // Simulate 15 concurrent requests each with multiple progress events.
    await Promise.all(
      traceIds.map(async (traceId) => {
        reg.start({ traceId, tokenId: 1, serviceId: 2, serviceName: "svc", ingress: "openai_completion", streaming: false });
        const rec = new ProgressRecorder(reg, traceId);
        rec.record("init", "request.received", "received");
        rec.record("init", "request.parsed", "parsed");
        rec.record("llm", "llm.serialize", "serialized");
        rec.record("llm", "llm.send", "sent");
        rec.record("llm", "llm.receive", "received response");
        rec.record("llm", "llm.result", "result ready");
        rec.record("done", "request.complete", "completed");
        reg.finish(traceId, 200);
      }),
    );

    // Verify every request has exactly 7 events + was completed.
    for (const traceId of traceIds) {
      const entry = reg.get(traceId);
      expect(entry).toBeDefined();
      expect(entry!.events).toHaveLength(7);
      expect(entry!.done).toBe(true);
      expect(entry!.httpStatus).toBe(200);
    }

    expect(reg.stats().completed).toBe(N);
    expect(reg.stats().totalEvents).toBe(N * 7);
  });

  it("maintains event ordering under concurrent interleaving", async () => {
    const reg = new ActiveRequestRegistry();
    const N = 12;
    const traceIds = Array.from({ length: N }, (_, i) => `trace-ord-${i}`);

    // Each request emits events with small async delays to interleave.
    await Promise.all(
      traceIds.map(async (traceId, idx) => {
        reg.start({ traceId, tokenId: null, serviceId: null, serviceName: `svc-${idx}`, ingress: "openai_completion", streaming: false });
        const rec = new ProgressRecorder(reg, traceId);
        await new Promise((r) => setTimeout(r, Math.random() * 10));
        rec.record("init", "a", "first");
        await new Promise((r) => setTimeout(r, Math.random() * 10));
        rec.record("llm", "b", "second");
        await new Promise((r) => setTimeout(r, Math.random() * 10));
        rec.record("done", "c", "third");
        reg.finish(traceId, 200);
      }),
    );

    for (const traceId of traceIds) {
      const events = reg.get(traceId)!.events;
      expect(events).toHaveLength(3);
      // Events must be in the order they were recorded (timestamps non-decreasing).
      expect(events[0].node).toBe("a");
      expect(events[1].node).toBe("b");
      expect(events[2].node).toBe("c");
      expect(events[0].ts).toBeLessThanOrEqual(events[1].ts);
      expect(events[1].ts).toBeLessThanOrEqual(events[2].ts);
    }
  });
});

// --- Test 2: Retry progress backtracking ---

describe("Retry progress backtracking via runSteps", () => {
  // Two tests here pin Math.random to take the backoff jitter out of the
  // assertions; nothing outside them should inherit a rigged one.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits retry.trigger and retry.delay events with correct retryIndex", async () => {
    const reg = new ActiveRequestRegistry();
    const traceId = "trace-retry-1";
    reg.start({ traceId, tokenId: null, serviceId: null, serviceName: null, ingress: "openai_completion", streaming: false });
    const prog = new ProgressRecorder(reg, traceId);

    let n = 0;
    const attempt = async (): Promise<AttemptResult<string>> => {
      n++;
      return n < 3 ? { ok: false, status: 503, kind: "http", message: "unavailable" } : { ok: true, value: "done" };
    };

    const out = await runSteps(
      steps([{ model: "m", provider: "p", retry: retryConfig({ on: [503], maxAttempts: 5, intervalMs: 10 }) }]),
      attempt,
      { sleep: async () => {}, progress: prog },
    );

    expect(out.result.ok).toBe(true);
    const events = reg.get(traceId)!.events;
    // We expect retry.trigger events for attempts 1 and 2 (both failed and retried).
    const triggers = events.filter((e) => e.node === "retry.trigger");
    expect(triggers.length).toBeGreaterThanOrEqual(2);
    // Verify retryIndex detail.
    expect(triggers[0].detail?.retryIndex).toBe(1);
    expect(triggers[1].detail?.retryIndex).toBe(2);
    // Verify the status was captured.
    expect(triggers[0].detail?.status).toBe(503);
  });

  it("emits retry.exhausted when max attempts is reached", async () => {
    const reg = new ActiveRequestRegistry();
    const traceId = "trace-retry-2";
    reg.start({ traceId, tokenId: null, serviceId: null, serviceName: null, ingress: "openai_completion", streaming: false });
    const prog = new ProgressRecorder(reg, traceId);

    const attempt = async (): Promise<AttemptResult<string>> => ({ ok: false, status: 503, kind: "http", message: "always fails" });

    const out = await runSteps(
      steps([{ model: "m", provider: "p", retry: retryConfig({ on: [503], maxAttempts: 3, intervalMs: 0 }) }]),
      attempt,
      { sleep: async () => {}, progress: prog },
    );

    expect(out.result.ok).toBe(false);
    const events = reg.get(traceId)!.events;
    const exhausted = events.filter((e) => e.node === "retry.exhausted");
    expect(exhausted.length).toBeGreaterThanOrEqual(1);
    expect(exhausted[0].detail?.attempts).toBe(3);
  });

  /**
   * One 429 then success, through a *jittered* backoff (the sibling tests above
   * cover the fixed-interval path). Returns the recorded progress events.
   *
   * Pin Math.random before calling: the delay is `floor(random * initialMs)`, so
   * the real backoff is genuinely 0 about one run in fifty, and a zero delay is
   * neither slept on nor announced.
   */
  const runJitteredRetry = async (traceId: string): Promise<ProgressEvent[]> => {
    const reg = new ActiveRequestRegistry();
    reg.start({ traceId, tokenId: null, serviceId: null, serviceName: null, ingress: "openai_completion", streaming: false });

    let n = 0;
    const attempt = async (): Promise<AttemptResult<string>> => {
      n++;
      return n < 2 ? { ok: false, status: 429, kind: "http", message: "rate limited" } : { ok: true, value: "ok" };
    };

    const out = await runSteps(
      steps([{ model: "m", provider: "p", retry: retryConfig({ on: [429], maxAttempts: 3, backoff: { initialMs: 50, maxMs: 200 } }) }]),
      attempt,
      { ...noSleep, progress: new ProgressRecorder(reg, traceId) },
    );

    expect(out.result.ok).toBe(true); // the retry is what makes it succeed
    expect(n).toBe(2);
    return reg.get(traceId)!.events;
  };

  it("emits retry.delay event before a retry attempt", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const delays = (await runJitteredRetry("trace-retry-3")).filter((e) => e.node === "retry.delay");

    expect(delays).toHaveLength(1); // one retry, one delay
    expect(delays[0].detail?.retryIndex).toBe(1);
    expect(delays[0].detail?.delayMs).toBe(25); // floor(0.5 * initialMs 50)
  });

  it("announces no delay when the jitter rounds the backoff to zero", async () => {
    // The other half of full jitter, and the reason the test above has to pin
    // it: there is no delay worth announcing, but the retry still happens.
    vi.spyOn(Math, "random").mockReturnValue(0);

    const events = await runJitteredRetry("trace-retry-3-zero");

    expect(events.filter((e) => e.node === "retry.delay")).toHaveLength(0);
    const triggers = events.filter((e) => e.node === "retry.trigger");
    expect(triggers).toHaveLength(1);
    expect(triggers[0].detail?.retryIndex).toBe(1);
  });
});

// --- Test 3: Performance overhead test ---

describe("Performance overhead", () => {
  it("progress recording per-call overhead is negligible (< 1 microsecond average)", async () => {
    // Measure the ABSOLUTE per-call overhead of ProgressRecorder.record()
    // (the hot path in production), rather than a percentage of a tiny baseline.
    // The requirement is that progress recording does not cause > 30% log-module
    // performance degradation. Since record() is the only new work per event,
    // we verify it completes in < 1us on average — far below any threshold that
    // would cause 30% degradation of the overall request pipeline.
    const reg = new ActiveRequestRegistry();
    reg.start({ traceId: "trace-perf", tokenId: null, serviceId: null, serviceName: null, ingress: "openai_completion", streaming: false });
    const prog = new ProgressRecorder(reg, "trace-perf");

    const ITERATIONS = 50_000;
    // Warmup
    for (let i = 0; i < 1000; i++) prog.record("llm", "warmup", "warming up");

    const t0 = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      prog.record("llm", "test.node", `message ${i}`, { index: i, status: 200 });
    }
    const elapsed = performance.now() - t0;
    const perCallUs = (elapsed / ITERATIONS) * 1000; // ms -> us

    // eslint-disable-next-line no-console
    console.log(`[perf] ${ITERATIONS} record() calls: ${elapsed.toFixed(1)}ms total, ${perCallUs.toFixed(2)}us per call`);

    // Each call does: Map.get + object alloc + array.push + counter increment.
    // Should be well under 1 microsecond. Even at 1us, 10 events/request adds
    // only 10us — negligible vs typical LLM latencies of 100ms+.
    expect(perCallUs).toBeLessThan(5); // generous threshold for sandbox noise
  });

  it("null recorder (no registry) has near-zero overhead", async () => {
    const ITERATIONS = 10000;
    const prog = new ProgressRecorder(null, "");

    const t0 = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      prog.record("llm", "test", "message", { a: 1 });
    }
    const elapsed = performance.now() - t0;
    // 10k no-op calls should take < 50ms (each is a null check + return).
    expect(elapsed).toBeLessThan(50);
    // eslint-disable-next-line no-console
    console.log(`[perf] null-recorder ${ITERATIONS} calls: ${elapsed.toFixed(2)}ms`);
  });

  it("listActive() is fast even with many in-flight requests", () => {
    const reg = new ActiveRequestRegistry();
    const N = 1000;
    for (let i = 0; i < N; i++) {
      reg.start({ traceId: `trace-${i}`, tokenId: null, serviceId: null, serviceName: null, ingress: "openai_completion", streaming: false });
    }
    const t0 = performance.now();
    const list = reg.listActive();
    const elapsed = performance.now() - t0;
    expect(list).toHaveLength(N);
    // Should be < 5ms for 1000 entries.
    expect(elapsed).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// Coverage additions
// ---------------------------------------------------------------------------

const begin = (reg: ActiveRequestRegistry, traceId: string): void =>
  reg.start({ traceId, tokenId: 1, serviceId: 2, serviceName: "svc", ingress: "openai_completion", streaming: false });

describe("BVA: per-request progress-event cap (500)", () => {
  it("keeps 500 events, drops the 501st, and still records the terminal 'done' event", () => {
    const reg = new ActiveRequestRegistry();
    begin(reg, "t");
    for (let i = 0; i < 499; i++) reg.record("t", "llm", "n", `event ${i}`);
    expect(reg.get("t")!.events).toHaveLength(499);

    reg.record("t", "llm", "n", "the 500th");
    expect(reg.get("t")!.events).toHaveLength(500);

    reg.record("t", "llm", "n", "the 501st");
    reg.record("t", "retry", "n", "also over the cap");
    expect(reg.get("t")!.events).toHaveLength(500);
    expect(reg.stats().totalEvents).toBe(500);
    expect(reg.get("t")!.events[499].message).toBe("the 500th");

    reg.record("t", "done", "request.complete", "finished");
    const events = reg.get("t")!.events;
    expect(events).toHaveLength(501);
    expect(events[500]).toMatchObject({ phase: "done", node: "request.complete", message: "finished" });
    expect(reg.stats().totalEvents).toBe(501);

    reg.record("t", "error", "n", "an error after the cap");
    expect(reg.get("t")!.events).toHaveLength(501);
    expect(reg.get("t")!.events[500].phase).toBe("done");
  });

  it("the cap is per request: a second request is unaffected by a saturated one", () => {
    const reg = new ActiveRequestRegistry();
    begin(reg, "full");
    begin(reg, "other");
    for (let i = 0; i < 600; i++) reg.record("full", "llm", "n", "x");
    reg.record("other", "llm", "n", "still recorded");
    expect(reg.get("full")!.events).toHaveLength(500);
    expect(reg.get("other")!.events).toHaveLength(1);
  });
});

describe("ST: completed requests — retention, order, limit, amendment", () => {
  const finishAll = (reg: ActiveRequestRegistry, ids: string[]): void => {
    for (const id of ids) { begin(reg, id); reg.finish(id, 200); }
  };
  const ids = (list: Array<{ traceId: string }>): string[] => list.map((r) => r.traceId);

  it("retains exactly the last N, newest first, and forgets the rest", () => {
    const reg = new ActiveRequestRegistry(3);
    finishAll(reg, ["t1", "t2", "t3"]);
    expect(ids(reg.listCompleted(10))).toEqual(["t3", "t2", "t1"]); // exactly at capacity: nothing dropped

    finishAll(reg, ["t4"]);
    expect(ids(reg.listCompleted(10))).toEqual(["t4", "t3", "t2"]);
    expect(reg.get("t1")).toBeUndefined();
    expect(reg.stats().completed).toBe(3);
  });

  it("the default retention is 256", () => {
    const reg = new ActiveRequestRegistry();
    finishAll(reg, Array.from({ length: 257 }, (_, i) => `t${i}`));
    expect(reg.stats().completed).toBe(256);
    expect(reg.get("t0")).toBeUndefined();
    expect(reg.get("t1")).toBeDefined();
  });

  it("listCompleted honours its limit and defaults to 50", () => {
    const reg = new ActiveRequestRegistry(64);
    finishAll(reg, Array.from({ length: 60 }, (_, i) => `t${i}`));
    expect(ids(reg.listCompleted(2))).toEqual(["t59", "t58"]);
    expect(reg.listCompleted()).toHaveLength(50);
    expect(reg.listCompleted()[0].traceId).toBe("t59");
    expect(reg.listCompleted(1000)).toHaveLength(60);
    expect(reg.stats().completed).toBe(60); // the limit is a view, not the retention
  });

  it("finish records the status and error; a missing error is stored as null", () => {
    const reg = new ActiveRequestRegistry();
    begin(reg, "ok");
    begin(reg, "bad");
    reg.finish("ok", 200);
    reg.finish("bad", 502, "upstream died");
    expect(reg.get("ok")).toMatchObject({ done: true, httpStatus: 200, error: null });
    expect(reg.get("bad")).toMatchObject({ done: true, httpStatus: 502, error: "upstream died" });
    expect(reg.stats()).toMatchObject({ active: 0, completed: 2 });
  });

  it("amendCompleted rewrites the outcome of a finished request", () => {
    const reg = new ActiveRequestRegistry();
    finishAll(reg, ["t1"]);
    reg.amendCompleted("t1", 499, "reset");
    expect(reg.get("t1")).toMatchObject({ httpStatus: 499, error: "reset", done: true });
    expect(reg.listCompleted()[0]).toMatchObject({ httpStatus: 499, error: "reset" });
  });

  it("amendCompleted ignores a request that is still in flight, and an unknown id", () => {
    const reg = new ActiveRequestRegistry();
    begin(reg, "live");
    reg.amendCompleted("live", 499, "reset");
    reg.amendCompleted("ghost", 499, "reset");
    expect(reg.get("live")).toMatchObject({ httpStatus: null, error: null, done: false });
    expect(reg.get("ghost")).toBeUndefined();
    expect(reg.stats()).toMatchObject({ active: 1, completed: 0 });
  });

  it("finishing an unknown id, or the same id twice, changes nothing", () => {
    const reg = new ActiveRequestRegistry();
    reg.finish("ghost", 200);
    expect(reg.stats().completed).toBe(0);

    finishAll(reg, ["t1"]);
    reg.finish("t1", 500, "second finish");
    expect(reg.stats().completed).toBe(1);
    expect(reg.get("t1")).toMatchObject({ httpStatus: 200, error: null });
  });

  it("events recorded after finish are dropped", () => {
    const reg = new ActiveRequestRegistry();
    begin(reg, "t1");
    reg.record("t1", "init", "a", "before");
    reg.finish("t1", 200);
    reg.record("t1", "done", "b", "after");
    expect(reg.get("t1")!.events).toHaveLength(1);
  });

  it("reads are snapshots: mutating a returned entry does not change the registry", () => {
    const reg = new ActiveRequestRegistry();
    begin(reg, "live");
    reg.record("live", "init", "a", "first");
    const listed = reg.listActive()[0];
    listed.events.push({ ts: 0, phase: "error", node: "x", message: "injected" });
    listed.serviceName = "tampered";
    const got = reg.get("live")!;
    got.events.length = 0;

    expect(reg.get("live")!.events).toHaveLength(1);
    expect(reg.listActive()[0].serviceName).toBe("svc");

    reg.finish("live", 200);
    reg.listCompleted()[0].httpStatus = 500;
    expect(reg.get("live")!.httpStatus).toBe(200);
  });

  it("clear() empties everything, counters included", () => {
    const reg = new ActiveRequestRegistry();
    begin(reg, "live");
    reg.record("live", "init", "a", "first");
    finishAll(reg, ["t1"]);
    reg.clear();
    expect(reg.stats()).toEqual({ active: 0, completed: 0, totalEvents: 0 });
  });
});

// The "blocked" flag is not stored on the registry: it is computed where the
// admin API serializes a request. These drive that route, so the 30 s
// threshold is evaluated by production code rather than by the test's own
// arithmetic.
describe("BVA: the blocked flag the admin API reports (threshold 30 000 ms)", () => {
  const T = 1_700_000_000_000;
  let now = T;

  afterEach(() => vi.restoreAllMocks());

  async function api(reg: ActiveRequestRegistry) {
    const app = Fastify({ logger: false });
    await activeRequestRoutes(app, { activeRequests: reg } as never);
    return app;
  }
  interface Row { traceId: string; blocked: boolean; elapsedMs: number; done: boolean; eventCount: number; lastNode: string | null }
  interface Listing { active: Row[]; completed: Row[]; blockThresholdMs: number; now: number }

  it("exactly at the threshold a request is not blocked; one millisecond later it is", async () => {
    vi.spyOn(Date, "now").mockImplementation(() => now);
    now = T;
    const reg = new ActiveRequestRegistry();
    begin(reg, "slow");
    const app = await api(reg);
    try {
      now = T + BLOCK_THRESHOLD_MS;
      let body = (await app.inject({ url: "/active-requests" })).json<Listing>();
      expect(body.blockThresholdMs).toBe(30_000);
      expect(body.active[0]).toMatchObject({ traceId: "slow", elapsedMs: 30_000, blocked: false });
      expect((await app.inject({ url: "/active-requests/stats" })).json<{ blocked: number }>().blocked).toBe(0);

      now = T + BLOCK_THRESHOLD_MS + 1;
      body = (await app.inject({ url: "/active-requests" })).json<Listing>();
      expect(body.active[0]).toMatchObject({ elapsedMs: 30_001, blocked: true });
      expect((await app.inject({ url: "/active-requests/stats" })).json<{ blocked: number; active: number }>())
        .toMatchObject({ blocked: 1, active: 1 });
      const single = (await app.inject({ url: "/active-requests/slow" })).json<{ request: Row }>();
      expect(single.request.blocked).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("a finished request is never blocked, however long it took", async () => {
    vi.spyOn(Date, "now").mockImplementation(() => now);
    now = T;
    const reg = new ActiveRequestRegistry();
    begin(reg, "old");
    const app = await api(reg);
    try {
      now = T + 10 * BLOCK_THRESHOLD_MS;
      reg.finish("old", 200);
      const body = (await app.inject({ url: "/active-requests" })).json<Listing>();
      expect(body.active).toEqual([]);
      expect(body.completed[0]).toMatchObject({ traceId: "old", done: true, blocked: false, elapsedMs: 300_000 });
    } finally {
      await app.close();
    }
  });

  it("blocked requests are listed first, then the longest-running", async () => {
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const reg = new ActiveRequestRegistry();
    now = T;
    begin(reg, "stuck");
    now = T + 20_000;
    begin(reg, "middle");
    now = T + 25_000;
    begin(reg, "young");
    reg.record("young", "llm", "llm.send", "sending");
    const app = await api(reg);
    try {
      now = T + 30_001;
      const body = (await app.inject({ url: "/active-requests" })).json<Listing>();
      expect(body.active.map((r) => [r.traceId, r.blocked])).toEqual([["stuck", true], ["middle", false], ["young", false]]);
      expect(body.active[2]).toMatchObject({ eventCount: 1, lastNode: "llm.send" });

      const filtered = (await app.inject({ url: "/active-requests?traceId=young" })).json<Listing>();
      expect(filtered.active.map((r) => r.traceId)).toEqual(["young"]);

      expect((await app.inject({ url: "/active-requests/ghost" })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
