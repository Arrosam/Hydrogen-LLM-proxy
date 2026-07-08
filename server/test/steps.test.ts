import { describe, expect, it } from "vitest";
import { computeRetryDelay, is499Retryable, runSteps, type AttemptResult } from "../src/execution/steps";
import type { ServiceSteps } from "../src/execution/definition";

const noSleep = { sleep: async () => {} };

function steps(s: ServiceSteps["steps"]): ServiceSteps {
  return { timeoutMs: 60000, steps: s };
}

describe("runSteps (retry / advance engine)", () => {
  it("retries the same step on a matching code, then succeeds", async () => {
    let n = 0;
    const attempt = async (): Promise<AttemptResult<string>> => {
      n++;
      return n < 3 ? { ok: false, status: 503, kind: "http", message: "unavailable" } : { ok: true, value: "done" };
    };
    const out = await runSteps(steps([{ model: "m", provider: "p", retry: { on: [503], maxAttempts: 5, intervalMs: 10 } }]), attempt, noSleep);
    expect(out.result.ok).toBe(true);
    expect(out.path).toHaveLength(3);
    expect(out.path[2].kind).toBe("ok");
  });

  it("does not retry on a non-matching code", async () => {
    let n = 0;
    const attempt = async (): Promise<AttemptResult<string>> => {
      n++;
      return { ok: false, status: 400, kind: "http", message: "bad" };
    };
    const out = await runSteps(steps([{ model: "m", provider: "p", retry: { on: [503], maxAttempts: 5, intervalMs: 0 } }]), attempt, noSleep);
    expect(out.result.ok).toBe(false);
    expect(n).toBe(1);
  });

  it("advances to the next step on failure (default advanceOn = any)", async () => {
    const attempt = async (step: { model: string }): Promise<AttemptResult<string>> =>
      step.model === "a" ? { ok: false, status: 503, kind: "http", message: "down" } : { ok: true, value: "served-by-b" };
    // Explicitly disable retry so the step advances immediately.
    const out = await runSteps(steps([{ model: "a", provider: "p1", retry: { on: [], maxAttempts: 1 } }, { model: "b", provider: "p2" }]), attempt, noSleep);
    expect(out.result).toMatchObject({ ok: true, value: "served-by-b" });
    expect(out.path.map((p) => p.model)).toEqual(["a", "b"]);
  });

  it("respects advanceOn gating (stops when failure does not match)", async () => {
    const attempt = async (): Promise<AttemptResult<string>> => ({ ok: false, status: 500, kind: "http", message: "err" });
    const out = await runSteps(steps([{ model: "a", provider: "p1", retry: { on: [], maxAttempts: 1 }, advanceOn: [502] }, { model: "b", provider: "p2" }]), attempt, noSleep);
    expect(out.result.ok).toBe(false);
    expect(out.path.map((p) => p.model)).toEqual(["a"]);
  });

  it("returns the last upstream failure when every step is exhausted", async () => {
    const attempt = async (step: { provider: string }): Promise<AttemptResult<string>> => ({
      ok: false,
      status: step.provider === "p2" ? 502 : 503,
      kind: "http",
      message: `fail-${step.provider}`,
    });
    const out = await runSteps(steps([{ model: "a", provider: "p1" }, { model: "b", provider: "p2" }]), attempt, noSleep);
    expect(out.result.ok).toBe(false);
    if (!out.result.ok) expect(out.result.status).toBe(502);
  });

  it("treats thrown errors as failures and classifies timeouts", async () => {
    const attempt = async (): Promise<AttemptResult<string>> => {
      const e = new Error("request timed out");
      e.name = "TimeoutError";
      throw e;
    };
    const out = await runSteps(steps([{ model: "m", provider: "p", retry: { on: ["timeout"], maxAttempts: 2, intervalMs: 0 } }]), attempt, noSleep);
    expect(out.result.ok).toBe(false);
    expect(out.path).toHaveLength(2);
    expect(out.path[0].kind).toBe("timeout");
  });
});

// --- 499 retry mechanism ----------------------------------------------------

describe("499 retry mechanism", () => {
  it("retries 499 by default (idempotency=safe_write) and succeeds on retry", async () => {
    let n = 0;
    const attempt = async (): Promise<AttemptResult<string>> => {
      n++;
      return n < 2 ? { ok: false, status: 499, kind: "http", message: "client closed" } : { ok: true, value: "ok" };
    };
    const out = await runSteps(
      steps([{ model: "m", provider: "p", retry: { maxAttempts: 3, backoff: { initialMs: 1, maxMs: 10 } } }]),
      attempt,
      noSleep,
    );
    expect(out.result.ok).toBe(true);
    expect(n).toBe(2);
    expect(out.path).toHaveLength(2);
    // The retried attempt (index 1) should carry retry context.
    expect(out.path[1].retry).toBeDefined();
    expect(out.path[1].retry!.retryIndex).toBe(1);
    expect(out.path[1].retry!.suppressed).toBe(false);
  });

  it("retries 499 up to maxAttempts=3 then fails with the last 499", async () => {
    let n = 0;
    const attempt = async (): Promise<AttemptResult<string>> => {
      n++;
      return { ok: false, status: 499, kind: "http", message: "client closed" };
    };
    const out = await runSteps(
      steps([{ model: "m", provider: "p", retry: { maxAttempts: 3, backoff: { initialMs: 1, maxMs: 10 } } }]),
      attempt,
      noSleep,
    );
    expect(out.result.ok).toBe(false);
    if (!out.result.ok) expect(out.result.status).toBe(499);
    expect(n).toBe(3); // 3 total attempts (1 original + 2 retries)
    expect(out.path).toHaveLength(3);
    // The last attempt should log that max attempts was reached.
    const last = out.path[2];
    expect(last.retry).toBeDefined();
    expect(last.retry!.suppressed).toBe(true);
    expect(last.retry!.reason).toContain("max attempts");
  });

  it("does NOT retry 499 when idempotency=unsafe (non-idempotent)", async () => {
    let n = 0;
    const attempt = async (): Promise<AttemptResult<string>> => {
      n++;
      return { ok: false, status: 499, kind: "http", message: "client closed" };
    };
    const out = await runSteps(
      steps([{ model: "m", provider: "p", retry: { maxAttempts: 3, idempotency: "unsafe", backoff: { initialMs: 1, maxMs: 10 } } }]),
      attempt,
      noSleep,
    );
    expect(out.result.ok).toBe(false);
    if (!out.result.ok) expect(out.result.status).toBe(499);
    expect(n).toBe(1); // no retry happened
    expect(out.path).toHaveLength(1);
    // The log should record the suppression reason.
    expect(out.path[0].retry).toBeDefined();
    expect(out.path[0].retry!.suppressed).toBe(true);
    expect(out.path[0].retry!.reason).toContain("idempotency");
    expect(out.path[0].retry!.reason).toContain("unsafe");
  });

  it("retries 499 when idempotency=read (idempotent GET-style)", async () => {
    let n = 0;
    const attempt = async (): Promise<AttemptResult<string>> => {
      n++;
      return n < 3 ? { ok: false, status: 499, kind: "http", message: "client closed" } : { ok: true, value: "ok" };
    };
    const out = await runSteps(
      steps([{ model: "m", provider: "p", retry: { maxAttempts: 3, idempotency: "read", backoff: { initialMs: 1, maxMs: 10 } } }]),
      attempt,
      noSleep,
    );
    expect(out.result.ok).toBe(true);
    expect(n).toBe(3);
  });

  it("does not retry non-499 codes not in retry.on (even with default config)", async () => {
    let n = 0;
    const attempt = async (): Promise<AttemptResult<string>> => {
      n++;
      return { ok: false, status: 500, kind: "http", message: "server error" };
    };
    // Default retry.on is [499], so 500 should not retry.
    const out = await runSteps(
      steps([{ model: "m", provider: "p", retry: { maxAttempts: 3, backoff: { initialMs: 1, maxMs: 10 } } }]),
      attempt,
      noSleep,
    );
    expect(out.result.ok).toBe(false);
    expect(n).toBe(1);
  });

  it("records retry context (retryIndex, delayMs, reason) on each retried attempt", async () => {
    const delays: number[] = [];
    const sleep = async (ms: number): Promise<void> => { delays.push(ms); };
    let n = 0;
    const attempt = async (): Promise<AttemptResult<string>> => {
      n++;
      return n < 3 ? { ok: false, status: 499, kind: "http", message: "closed" } : { ok: true, value: "ok" };
    };
    const out = await runSteps(
      steps([{ model: "m", provider: "p", retry: { maxAttempts: 3, backoff: { initialMs: 100, maxMs: 1000 } } }]),
      attempt,
      { sleep },
    );
    expect(out.result.ok).toBe(true);
    expect(delays).toHaveLength(2); // 2 sleeps before 2 retries
    // With full jitter, delay is in [0, base). Base for attempt 2 = 100, for attempt 3 = 200.
    expect(delays[0]).toBeGreaterThanOrEqual(0);
    expect(delays[0]).toBeLessThan(100);
    expect(delays[1]).toBeGreaterThanOrEqual(0);
    expect(delays[1]).toBeLessThan(200);
    // The retried attempts should carry the delay in their retry context.
    expect(out.path[1].retry!.delayMs).toBe(delays[0]);
    expect(out.path[2].retry!.delayMs).toBe(delays[1]);
  });
});

// --- computeRetryDelay unit tests ------------------------------------------

describe("computeRetryDelay (exponential backoff with full jitter)", () => {
  const cfg = { on: [499], maxAttempts: 3, intervalMs: 0, backoff: { initialMs: 100, maxMs: 1000 } };

  it("returns 0 for attempt 1 (first call, no retry)", () => {
    expect(computeRetryDelay(1, cfg)).toBe(0);
  });

  it("returns a jittered value in [0, 100) for attempt 2 (base = initialMs)", () => {
    for (let i = 0; i < 50; i++) {
      const d = computeRetryDelay(2, cfg);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(100);
    }
  });

  it("returns a jittered value in [0, 200) for attempt 3 (base = 2 * initialMs)", () => {
    for (let i = 0; i < 50; i++) {
      const d = computeRetryDelay(3, cfg);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(200);
    }
  });

  it("caps the base at maxMs (1000ms) even for high attempt numbers", () => {
    const highCfg = { on: [499], maxAttempts: 20, intervalMs: 0, backoff: { initialMs: 100, maxMs: 1000 } };
    for (let i = 0; i < 50; i++) {
      // attempt 20 -> 2^18 = huge, but capped at 1000
      const d = computeRetryDelay(20, highCfg);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(1000);
    }
  });

  it("falls back to fixed intervalMs when no backoff config", () => {
    const fixedCfg = { on: [499], maxAttempts: 3, intervalMs: 250 };
    expect(computeRetryDelay(1, fixedCfg)).toBe(0);
    expect(computeRetryDelay(2, fixedCfg)).toBe(250);
    expect(computeRetryDelay(3, fixedCfg)).toBe(250);
  });

  it("returns 0 when no retry config at all", () => {
    expect(computeRetryDelay(2, undefined)).toBe(0);
  });
});

// --- is499Retryable unit tests ---------------------------------------------

describe("is499Retryable (idempotency guard)", () => {
  it("returns true for 'read'", () => {
    expect(is499Retryable("read")).toBe(true);
  });
  it("returns true for 'safe_write'", () => {
    expect(is499Retryable("safe_write")).toBe(true);
  });
  it("returns true for undefined (defaults to safe_write)", () => {
    expect(is499Retryable(undefined)).toBe(true);
  });
  it("returns false for 'unsafe'", () => {
    expect(is499Retryable("unsafe")).toBe(false);
  });
});
