/**
 * Retry / step-advance policy — test cases designed with ISTQB black-box
 * techniques, exercised against the real engine (`runSteps`) with an injected
 * clock so the decision logic is covered without paying wall-clock time. The
 * long-running, real-socket exhaustion runs live in retryExhaustion.test.ts.
 *
 * Techniques and what each is used for:
 *
 *   EP  Equivalence Partitioning — the retry-trigger classes (matching status,
 *       non-matching status, "timeout", catch-all "error"), and the three
 *       idempotency classes.
 *   BVA Boundary Value Analysis — retry.maxAttempts at 1 / 2 / 19 / 20 and the
 *       invalid 0 / 21; computeRetryDelay at attempt 1 / 2 and at the backoff
 *       cap; jitter at its 0 and near-1 extremes.
 *   DT  Decision Table — the four conditions that decide "retry or not".
 *   ST  State Transition — walking the step chain under `advanceOn`.
 *   EG  Error Guessing — which failure is reported when several differ, and how
 *       a status the proxy has never seen (0, 2xx) maps to a client code.
 */
import { describe, expect, it, vi, afterEach } from "vitest";

import { classifyError, computeRetryDelay, is499Retryable, runSteps, type AttemptFailure, type AttemptResult } from "../src/execution/steps";
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_RETRY_ON, parseServiceSteps, summarizeService, type ServiceStep } from "../src/execution/definition";
import { failureStatus } from "../src/core/proxy/errors";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const httpFail = (status: number): AttemptFailure => ({ ok: false, status, kind: "http", message: `upstream returned ${status}` });
const timeoutFail = (): AttemptFailure => ({ ok: false, status: 0, kind: "timeout", message: "headers timeout" });
/** The connection died: no HTTP status to match on. */
const networkFail = (): AttemptFailure => ({ ok: false, status: 0, kind: "network", message: "other side closed" });
/** A configuration fault, e.g. an unresolvable mapping. Retrying repeats it. */
const configFail = (): AttemptFailure => ({ ok: false, status: 0, kind: "error", message: "mapping m@p: model_not_found" });
const success = (): AttemptResult<string> => ({ ok: true, value: "ANSWER" });

/** Build a validated step chain, so schema defaults are the ones under test. */
function chain(steps: unknown[], timeoutMs = 1_000): ReturnType<typeof parseServiceSteps> {
  return parseServiceSteps({ timeoutMs, steps });
}

interface Recorded {
  /** 1-based step index of every attempt, in order. */
  visited: number[];
  /** Delays the engine asked to sleep, in order. */
  slept: number[];
}

/** Drive runSteps with a scripted sequence of results and a fake clock. */
async function drive(
  def: ReturnType<typeof parseServiceSteps>,
  results: AttemptResult<string>[],
  fallback: AttemptResult<string> = httpFail(500),
): Promise<{ result: AttemptResult<string>; path: Awaited<ReturnType<typeof runSteps<string>>>["path"] } & Recorded> {
  const visited: number[] = [];
  const slept: number[] = [];
  const attempt = async (_step: ServiceStep, stepIndex: number): Promise<AttemptResult<string>> => {
    visited.push(stepIndex + 1);
    return results[visited.length - 1] ?? fallback;
  };
  const out = await runSteps<string>(def, attempt, { sleep: async (ms) => { slept.push(ms); } });
  return { ...out, visited, slept };
}

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// EP — retry trigger classes
// ---------------------------------------------------------------------------

describe("EP: retry.on trigger classes", () => {
  const cases: Array<{ id: string; on: unknown[]; failure: AttemptFailure; retried: boolean }> = [
    { id: "EP1 status inside the trigger set", on: [429, 503], failure: httpFail(429), retried: true },
    { id: "EP2 status outside the trigger set", on: [429, 503], failure: httpFail(500), retried: false },
    { id: "EP3 symbolic 'timeout' matches a timeout", on: ["timeout"], failure: timeoutFail(), retried: true },
    { id: "EP4 symbolic 'timeout' ignores an http failure", on: ["timeout"], failure: httpFail(500), retried: false },
    { id: "EP5 catch-all 'error' matches an http failure", on: ["error"], failure: httpFail(401), retried: true },
    { id: "EP6 catch-all 'error' matches a transport failure", on: ["error"], failure: networkFail(), retried: true },
    { id: "EP7 numeric triggers never match a transport failure (status 0)", on: [429, 503, 502], failure: networkFail(), retried: false },
    { id: "EP8 symbolic 'network' matches a dead connection", on: ["network"], failure: networkFail(), retried: true },
    { id: "EP9 symbolic 'network' ignores an http failure", on: ["network"], failure: httpFail(502), retried: false },
    { id: "EP10 symbolic 'network' ignores a timeout", on: ["network"], failure: timeoutFail(), retried: false },
    { id: "EP11 symbolic 'network' ignores a configuration fault", on: ["network"], failure: configFail(), retried: false },
    { id: "EP12 catch-all 'error' does retry a configuration fault", on: ["error"], failure: configFail(), retried: true },
  ];

  for (const { id, on, failure, retried } of cases) {
    it(`${id} -> ${retried ? "retries" : "does not retry"}`, async () => {
      const def = chain([{ model: "m", provider: "p", retry: { maxAttempts: 3, on, intervalMs: 0 } }]);
      const { visited } = await drive(def, [failure, failure, failure]);
      expect(visited.length).toBe(retried ? 3 : 1);
    });
  }
});

// ---------------------------------------------------------------------------
// BVA — retry.maxAttempts, at and around its schema bounds (min 1, max 20)
// ---------------------------------------------------------------------------

describe("BVA: retry.maxAttempts boundaries", () => {
  for (const maxAttempts of [1, 2, 19, 20]) {
    it(`maxAttempts=${maxAttempts} makes exactly ${maxAttempts} attempt(s)`, async () => {
      const def = chain([{ model: "m", provider: "p", retry: { maxAttempts, on: [503], intervalMs: 0 } }]);
      const { visited, path, result } = await drive(def, Array.from({ length: maxAttempts }, () => httpFail(503)));

      expect(visited.length).toBe(maxAttempts);
      expect(path.length).toBe(maxAttempts);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(503);
    });
  }

  it("maxAttempts=20 stops retrying the moment an attempt succeeds", async () => {
    const def = chain([{ model: "m", provider: "p", retry: { maxAttempts: 20, on: [503], intervalMs: 0 } }]);
    const results = [...Array.from({ length: 6 }, () => httpFail(503)), success()];
    const { visited, result } = await drive(def, results);

    expect(visited.length).toBe(7); // 6 failures + the success
    expect(result.ok).toBe(true);
  });

  for (const maxAttempts of [0, 21]) {
    it(`maxAttempts=${maxAttempts} is rejected by the schema (outside 1..20)`, () => {
      expect(() => chain([{ model: "m", provider: "p", retry: { maxAttempts } }])).toThrow();
    });
  }

  it("omitting retry entirely still retries 3x on a default trigger", async () => {
    // runSteps falls back to maxAttempts=3 and the default trigger set.
    // Note this contradicts summarizeService(), which shows such a step as a
    // single attempt in the dashboard.
    const def = chain([{ model: "m", provider: "p" }]);
    const { visited } = await drive(def, Array.from({ length: 3 }, () => httpFail(503)));
    expect(visited.length).toBe(3);
  });

  it("omitting retry makes one attempt when the failure is off the default triggers", async () => {
    const def = chain([{ model: "m", provider: "p" }]);
    const { visited } = await drive(def, [httpFail(500), httpFail(500)]);
    expect(visited.length).toBe(1); // 500 is not in the default trigger set
  });
});

// ---------------------------------------------------------------------------
// EP — the shipped defaults. Reliable Streaming exists to retry an upstream that
// fails to deliver a whole answer, so those failures must be default triggers.
// ---------------------------------------------------------------------------

describe("EP: the default retry.on trigger set", () => {
  const withDefaults = (failure: AttemptFailure, attempts = 3): Promise<{ visited: number[] }> => {
    const def = chain([{ model: "m", provider: "p", retry: { intervalMs: 0 } }]);
    return drive(def, Array.from({ length: attempts }, () => failure));
  };

  it("exposes exactly the documented default set", () => {
    const def = chain([{ model: "m", provider: "p", retry: {} }]);
    expect(def.steps[0].retry?.on).toEqual([429, 499, 502, 503, "timeout", "network"]);
    expect(DEFAULT_RETRY_ON).toEqual([429, 499, 502, 503, "timeout", "network"]);
  });

  it("a step with no retry block behaves identically to one with an empty retry block", async () => {
    // zod only applies RetrySchema's defaults when `retry` exists; runSteps has
    // its own fallback for when it does not. They must not drift apart.
    const bare = chain([{ model: "m", provider: "p" }]);
    const explicit = chain([{ model: "m", provider: "p", retry: {} }]);

    for (const failure of [httpFail(502), networkFail(), httpFail(499)]) {
      const a = await drive(bare, Array.from({ length: 3 }, () => failure));
      const b = await drive(explicit, Array.from({ length: 3 }, () => failure));
      expect(a.visited.length).toBe(b.visited.length);
      expect(a.visited.length).toBe(DEFAULT_MAX_ATTEMPTS);
    }
    for (const failure of [httpFail(500), configFail()]) {
      const a = await drive(bare, [failure, failure, failure]);
      expect(a.visited.length).toBe(1);
    }
  });

  const retriedByDefault: Array<[string, AttemptFailure]> = [
    ["429 rate limit", httpFail(429)],
    ["499 client closed", httpFail(499)],
    ["502 truncated or unusable upstream stream", httpFail(502)],
    ["503 unavailable", httpFail(503)],
    ["a timeout", timeoutFail()],
    ["a dead connection", networkFail()],
  ];

  for (const [name, failure] of retriedByDefault) {
    it(`retries ${name} out of the box`, async () => {
      const { visited } = await withDefaults(failure);
      expect(visited.length).toBe(3);
    });
  }

  const notRetriedByDefault: Array<[string, AttemptFailure]> = [
    ["400 bad request", httpFail(400)],
    ["401 unauthorized — never burn quota on an auth failure", httpFail(401)],
    ["404 not found", httpFail(404)],
    ["500 server error", httpFail(500)],
    ["a configuration fault (bad mapping)", configFail()],
  ];

  for (const [name, failure] of notRetriedByDefault) {
    it(`does not retry ${name}`, async () => {
      const { visited } = await withDefaults(failure);
      expect(visited.length).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// DT — the retry decision
//
//   C1 attempt < maxAttempts        C3 failure is a 499
//   C2 failure matches retry.on     C4 idempotency == "unsafe"
//
//   rule | C1 | C2 | C3 | C4 | action
//   -----+----+----+----+----+---------------------
//   R1   | T  | T  | F  | -  | retry
//   R2   | T  | T  | T  | F  | retry
//   R3   | T  | T  | T  | T  | suppressed (no retry)
//   R4   | T  | F  | -  | -  | no retry
//   R5   | F  | T  | -  | -  | no retry (exhausted)
// ---------------------------------------------------------------------------

describe("DT: the retry decision table", () => {
  const step = (retry: Record<string, unknown>): unknown => ({ model: "m", provider: "p", retry: { intervalMs: 0, ...retry } });

  it("R1 retryable status, attempts remain -> retries", async () => {
    const def = chain([step({ maxAttempts: 3, on: [503] })]);
    const { visited, path } = await drive(def, [httpFail(503), httpFail(503), httpFail(503)]);
    expect(visited.length).toBe(3);
    expect(path[0].retry?.suppressed).toBe(false);
  });

  it("R2 a 499 under safe_write -> retries", async () => {
    const def = chain([step({ maxAttempts: 3, on: [499], idempotency: "safe_write" })]);
    const { visited } = await drive(def, [httpFail(499), httpFail(499), httpFail(499)]);
    expect(visited.length).toBe(3);
  });

  it("R2' a 499 under read -> retries", async () => {
    const def = chain([step({ maxAttempts: 3, on: [499], idempotency: "read" })]);
    const { visited } = await drive(def, [httpFail(499), httpFail(499), httpFail(499)]);
    expect(visited.length).toBe(3);
  });

  it("R3 a 499 under unsafe -> suppressed, and the log says why", async () => {
    const def = chain([step({ maxAttempts: 3, on: [499], idempotency: "unsafe" })]);
    const { visited, path } = await drive(def, [httpFail(499), httpFail(499)]);

    expect(visited.length).toBe(1);
    expect(path[0].retry?.suppressed).toBe(true);
    expect(path[0].retry?.reason).toContain("499 suppressed");
  });

  it("R3' the unsafe guard applies only to 499, not to other statuses", async () => {
    const def = chain([step({ maxAttempts: 3, on: [503, 499], idempotency: "unsafe" })]);
    const { visited } = await drive(def, [httpFail(503), httpFail(503), httpFail(503)]);
    expect(visited.length).toBe(3);
  });

  it("R4 non-matching trigger on the first attempt -> no retry, and the log says why", async () => {
    const def = chain([step({ maxAttempts: 5, on: [429] })]);
    const { visited, path } = await drive(def, [httpFail(500)]);

    expect(visited.length).toBe(1);
    expect(path[0].retry?.suppressed).toBe(true);
    expect(path[0].retry?.reason).toContain("trigger not in retry.on");
    expect(path[0].retry?.reason).toContain("429");
  });

  it("R4' a retry that then hits a non-matching failure -> log names the trigger set", async () => {
    const def = chain([step({ maxAttempts: 5, on: [503] })]);
    const { visited, path } = await drive(def, [httpFail(503), httpFail(500)]);

    expect(visited.length).toBe(2); // 503 retried, then 500 stops the step
    expect(path[1].retry?.suppressed).toBe(true);
    expect(path[1].retry?.reason).toContain("trigger not in retry.on");
  });

  it("R5 attempts exhausted -> stops, and the log says max attempts reached", async () => {
    const def = chain([step({ maxAttempts: 2, on: [503] })]);
    const { visited, path } = await drive(def, [httpFail(503), httpFail(503)]);

    expect(visited.length).toBe(2);
    expect(path[1].retry?.suppressed).toBe(true);
    expect(path[1].retry?.reason).toContain("max attempts (2) reached");
  });
});

// ---------------------------------------------------------------------------
// EP — classifyError, the only place a thrown failure gets its kind
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The dashboard summary has to describe what the engine will actually do.
// ---------------------------------------------------------------------------

describe("summarizeService reflects the engine's real retry behaviour", () => {
  it("a step with no retry block is shown with the default retry count, not as a single attempt", () => {
    const def = chain([{ model: "gpt", provider: "openai" }]);
    // Regression: this used to read 'gpt@openai' while runSteps retried it 3x.
    expect(summarizeService(def)).toBe(`try gpt@openai (retry ${DEFAULT_MAX_ATTEMPTS}x); else fail`);
  });

  it("an explicit maxAttempts=1 really is a single attempt, and says nothing about retries", () => {
    const def = chain([{ model: "gpt", provider: "openai", retry: { maxAttempts: 1 } }]);
    expect(summarizeService(def)).toBe("try gpt@openai; else fail");
  });

  it("an explicit policy is shown verbatim, interval included", () => {
    const def = chain([{ model: "gpt", provider: "openai", retry: { maxAttempts: 5, intervalMs: 250 } }]);
    expect(summarizeService(def)).toBe("try gpt@openai (retry 5x 250ms); else fail");
  });

  it("a chain shows every step, and the reliable-streaming marker", () => {
    const def = parseServiceSteps({
      timeoutMs: 1_000,
      reliableStreaming: true,
      steps: [{ model: "a", provider: "p1" }, { model: "b", provider: "p2", retry: { maxAttempts: 1 } }],
    });
    expect(summarizeService(def)).toBe(`try a@p1 (retry ${DEFAULT_MAX_ATTEMPTS}x); else b@p2; else fail [reliable streaming]`);
  });
});

describe("EP: classifyError partitions", () => {
  const named = (name: string, message: string): Error => Object.assign(new Error(message), { name });

  it("an AbortSignal timeout is a timeout", () => {
    expect(classifyError(named("TimeoutError", "The operation was aborted")).kind).toBe("timeout");
    expect(classifyError(named("AbortError", "aborted")).kind).toBe("timeout");
  });

  it("undici's header/body timeouts are timeouts, by message", () => {
    expect(classifyError(named("HeadersTimeoutError", "Headers Timeout Error")).kind).toBe("timeout");
    expect(classifyError(named("BodyTimeoutError", "Body Timeout Error")).kind).toBe("timeout");
  });

  it("a dead socket is a network failure", () => {
    expect(classifyError(named("SocketError", "other side closed")).kind).toBe("network");
    expect(classifyError(named("Error", "read ECONNRESET")).kind).toBe("network");
  });

  it("a rejected upstream URL is a configuration fault, not a network failure", () => {
    const e = named("UpstreamUrlError", 'upstream host "x" resolves to a disallowed address');
    expect(classifyError(e).kind).toBe("error");
  });

  it("a non-Error throw still classifies", () => {
    expect(classifyError("boom").kind).toBe("network");
  });
});

// ---------------------------------------------------------------------------
// The retry context written to attempt_path_json. A failed request's first
// question is "why did this not retry?", so every failed attempt must answer it.
// ---------------------------------------------------------------------------

describe("retry context recorded on every attempt", () => {
  const step = (retry: Record<string, unknown>): unknown => ({ model: "m", provider: "p", retry: { intervalMs: 0, ...retry } });

  it("names the actual trigger when a non-499 failure is retried", async () => {
    const def = chain([step({ maxAttempts: 3, on: [503] })]);
    const { path } = await drive(def, [httpFail(503), httpFail(503), httpFail(503)]);

    // Regression: this used to read '499 retried (idempotency="safe_write")'
    // for every retried failure, whatever the status actually was.
    expect(path[0].retry?.reason).toBe("retrying on 503");
    expect(path[0].retry?.suppressed).toBe(false);
  });

  it("names a timeout and a dead connection by kind, not by status", async () => {
    const t = chain([step({ maxAttempts: 2, on: ["timeout"] })]);
    expect((await drive(t, [timeoutFail(), timeoutFail()])).path[0].retry?.reason).toBe("retrying on timeout");

    const n = chain([step({ maxAttempts: 2, on: ["network"] })]);
    expect((await drive(n, [networkFail(), networkFail()])).path[0].retry?.reason).toBe("retrying on network");
  });

  it("keeps the 499 wording only for an actual 499", async () => {
    const def = chain([step({ maxAttempts: 3, on: [499], idempotency: "safe_write" })]);
    const { path } = await drive(def, [httpFail(499), httpFail(499), httpFail(499)]);
    expect(path[0].retry?.reason).toContain("499 retried");
  });

  it("records the delay that was actually slept before the attempt", async () => {
    const def = chain([{ model: "m", provider: "p", retry: { maxAttempts: 3, on: [503], intervalMs: 250 } }]);
    const { path } = await drive(def, [httpFail(503), httpFail(503), httpFail(503)]);

    expect(path.map((p) => p.retry?.delayMs)).toEqual([0, 250, 250]);
    expect(path.map((p) => p.retry?.retryIndex)).toEqual([0, 1, 2]);
  });

  it("the final exhausted attempt says max attempts reached", async () => {
    const def = chain([step({ maxAttempts: 2, on: [503] })]);
    const { path } = await drive(def, [httpFail(503), httpFail(503)]);

    expect(path[0].retry?.reason).toBe("retrying on 503");
    expect(path[1].retry?.reason).toBe("max attempts (2) reached");
    expect(path[1].retry?.suppressed).toBe(true);
  });

  it("a successful first attempt carries no retry context", async () => {
    const def = chain([step({ maxAttempts: 3, on: [503] })]);
    const { path } = await drive(def, [success()]);
    expect(path[0].retry).toBeUndefined();
    expect(path[0].kind).toBe("ok");
  });

  it("a success after retries records which retry won", async () => {
    const def = chain([step({ maxAttempts: 3, on: [503] })]);
    const { path } = await drive(def, [httpFail(503), success()]);
    expect(path[1].retry?.reason).toBe("succeeded on retry #1");
  });

  it("every attempt of a fully exhausted multi-step chain explains itself", async () => {
    const def = chain([step({ maxAttempts: 2, on: [503] }), { model: "m2", provider: "p", retry: { maxAttempts: 1, on: [], intervalMs: 0 } }]);
    const { path } = await drive(def, [httpFail(503), httpFail(503), httpFail(500)]);

    expect(path).toHaveLength(3);
    for (const record of path) expect(record.retry?.reason).toBeTruthy();
    expect(path[2].retry?.reason).toContain("trigger not in retry.on");
  });
});

describe("EP: is499Retryable partitions", () => {
  it("read and safe_write allow a 499 retry; unsafe forbids it", () => {
    expect(is499Retryable("read")).toBe(true);
    expect(is499Retryable("safe_write")).toBe(true);
    expect(is499Retryable("unsafe")).toBe(false);
    expect(is499Retryable(undefined)).toBe(true); // defaults to safe_write
  });
});

// ---------------------------------------------------------------------------
// ST — walking the step chain
//
//   [step 1 attempting] --exhausted--> advanceOn? --yes--> [step 2 attempting]
//                                                 --no --> [failed]
//   last step exhausted -----------------------------------> [failed]
// ---------------------------------------------------------------------------

describe("ST: step-chain state transitions", () => {
  const s = (retry: Record<string, unknown>, advanceOn?: unknown[]): unknown => ({
    model: "m", provider: "p", retry: { intervalMs: 0, ...retry }, ...(advanceOn ? { advanceOn } : {}),
  });

  it("ST1 single step, exhausted -> failed (no transition available)", async () => {
    const def = chain([s({ maxAttempts: 2, on: [503] })]);
    const { visited, result } = await drive(def, [httpFail(503), httpFail(503)]);
    expect(visited).toEqual([1, 1]);
    expect(result.ok).toBe(false);
  });

  it("ST2 advanceOn omitted -> advances on any failure", async () => {
    const def = chain([s({ maxAttempts: 1, on: [] }), s({ maxAttempts: 1, on: [] })]);
    const { visited } = await drive(def, [httpFail(500), httpFail(500)]);
    expect(visited).toEqual([1, 2]);
  });

  it("ST3 advanceOn matches -> transitions to the next step", async () => {
    const def = chain([s({ maxAttempts: 1, on: [] }, [503]), s({ maxAttempts: 1, on: [] })]);
    const { visited } = await drive(def, [httpFail(503), httpFail(500)]);
    expect(visited).toEqual([1, 2]);
  });

  it("ST4 advanceOn does not match -> chain stops, later steps never run", async () => {
    const def = chain([s({ maxAttempts: 1, on: [] }, [503]), s({ maxAttempts: 1, on: [] })]);
    const { visited, result } = await drive(def, [httpFail(500), success()]);

    expect(visited).toEqual([1]); // step 2 is never reached
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(500);
  });

  it("ST5 advanceOn 'exhausted' -> always transitions once retries are spent", async () => {
    const def = chain([s({ maxAttempts: 2, on: [503] }, ["exhausted"]), s({ maxAttempts: 1, on: [] })]);
    const { visited } = await drive(def, [httpFail(503), httpFail(503), success()]);
    expect(visited).toEqual([1, 1, 2]);
  });

  it("ST6 a later step succeeds -> the chain reports success and stops there", async () => {
    const def = chain([s({ maxAttempts: 1, on: [] }), s({ maxAttempts: 1, on: [] }), s({ maxAttempts: 1, on: [] })]);
    const { visited, result, path } = await drive(def, [httpFail(500), success()]);

    expect(visited).toEqual([1, 2]);
    expect(result.ok).toBe(true);
    expect(path[1].kind).toBe("ok");
  });

  it("ST7 every step exhausted -> the LAST failure is the one reported", async () => {
    const def = chain([s({ maxAttempts: 2, on: [503] }), s({ maxAttempts: 2, on: [429] })]);
    const { visited, result } = await drive(def, [httpFail(503), httpFail(503), httpFail(429), httpFail(429)]);

    expect(visited).toEqual([1, 1, 2, 2]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(429); // not 503
  });
});

// ---------------------------------------------------------------------------
// BVA — computeRetryDelay
// ---------------------------------------------------------------------------

describe("BVA: computeRetryDelay", () => {
  const backoff = { initialMs: 100, maxMs: 1_000 };
  const withRandom = (v: number): void => { vi.spyOn(Math, "random").mockReturnValue(v); };

  it("no retry config -> no delay", () => {
    expect(computeRetryDelay(2, undefined)).toBe(0);
  });

  it("attempt 1 is the first call, never a retry -> no delay", () => {
    expect(computeRetryDelay(1, { on: [], maxAttempts: 3, intervalMs: 500, idempotency: "read" })).toBe(0);
  });

  it("fixed interval is used verbatim from attempt 2 onward", () => {
    const cfg = { on: [], maxAttempts: 3, intervalMs: 500, idempotency: "read" as const };
    expect(computeRetryDelay(2, cfg)).toBe(500);
    expect(computeRetryDelay(3, cfg)).toBe(500);
  });

  it("intervalMs=0 (lower bound) -> immediate retry", () => {
    expect(computeRetryDelay(2, { on: [], maxAttempts: 3, intervalMs: 0, idempotency: "read" })).toBe(0);
  });

  it("backoff doubles per attempt, with full jitter in [0, base)", () => {
    const cfg = { on: [], maxAttempts: 20, intervalMs: 0, idempotency: "read" as const, backoff };

    withRandom(0); // lower jitter bound
    expect(computeRetryDelay(2, cfg)).toBe(0);
    expect(computeRetryDelay(5, cfg)).toBe(0);

    withRandom(0.999999); // upper jitter bound
    expect(computeRetryDelay(2, cfg)).toBe(99);  // base 100
    expect(computeRetryDelay(3, cfg)).toBe(199); // base 200
    expect(computeRetryDelay(4, cfg)).toBe(399); // base 400
    expect(computeRetryDelay(5, cfg)).toBe(799); // base 800
  });

  it("backoff is clamped at maxMs, and stays clamped for every later attempt", () => {
    const cfg = { on: [], maxAttempts: 20, intervalMs: 0, idempotency: "read" as const, backoff };
    vi.spyOn(Math, "random").mockReturnValue(0.999999);

    expect(computeRetryDelay(6, cfg)).toBe(999);  // base would be 1600 -> clamped to 1000
    expect(computeRetryDelay(20, cfg)).toBe(999); // still clamped, no overflow
  });

  it("backoff overrides intervalMs when both are present", () => {
    const cfg = { on: [], maxAttempts: 3, intervalMs: 5_000, idempotency: "read" as const, backoff };
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(computeRetryDelay(2, cfg)).toBe(0); // not 5000
  });

  it("the engine actually sleeps the computed delay before each retry", async () => {
    const def = chain([{ model: "m", provider: "p", retry: { maxAttempts: 3, on: [503], intervalMs: 250 } }]);
    const { slept, visited } = await drive(def, [httpFail(503), httpFail(503), httpFail(503)]);

    expect(visited.length).toBe(3);
    expect(slept).toEqual([250, 250]); // before attempt 2 and attempt 3, not before attempt 1
  });
});

// ---------------------------------------------------------------------------
// EG — error guessing
// ---------------------------------------------------------------------------

describe("EG: failure reporting the client sees", () => {
  it("a transport failure (status 0) is reported to the client as 502", () => {
    expect(failureStatus(networkFail())).toBe(502);
  });

  it("a timeout (status 0) is reported to the client as 502", () => {
    expect(failureStatus(timeoutFail())).toBe(502);
  });

  it("an upstream 4xx/5xx passes through unchanged", () => {
    expect(failureStatus(httpFail(429))).toBe(429);
    expect(failureStatus(httpFail(401))).toBe(401);
    expect(failureStatus(httpFail(500))).toBe(500);
    expect(failureStatus(httpFail(503))).toBe(503);
  });

  it("boundary: 399 becomes 502, 400 passes through", () => {
    expect(failureStatus(httpFail(399))).toBe(502);
    expect(failureStatus(httpFail(400))).toBe(400);
  });

  it("a nonsense upstream status below 400 never leaks to the client", () => {
    expect(failureStatus(httpFail(0))).toBe(502);
    expect(failureStatus(httpFail(204))).toBe(502);
  });

  it("when several attempts fail with different statuses, the last one wins", async () => {
    const def = chain([{ model: "m", provider: "p", retry: { maxAttempts: 3, on: ["error"], intervalMs: 0 } }]);
    const { result } = await drive(def, [httpFail(429), httpFail(503), httpFail(500)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(failureStatus(result)).toBe(500);
  });

  it("'error' as a trigger also retries auth failures — the quota-burning footgun", async () => {
    const def = chain([{ model: "m", provider: "p", retry: { maxAttempts: 4, on: ["error"], intervalMs: 0 } }]);
    const { visited } = await drive(def, Array.from({ length: 4 }, () => httpFail(401)));
    expect(visited.length).toBe(4); // a 401 will never succeed; it is retried anyway
  });

  it("a step with no retry config still advances to the next step on failure", async () => {
    const def = chain([{ model: "m", provider: "p" }, { model: "m2", provider: "p2" }]);
    const { visited, result } = await drive(def, [httpFail(500), success()]);
    expect(visited).toEqual([1, 2]);
    expect(result.ok).toBe(true);
  });
});
