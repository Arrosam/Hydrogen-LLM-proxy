import { describe, expect, it } from "vitest";
import { runSteps, type AttemptResult } from "../src/core/mub/engine";
import type { MubSteps } from "../src/core/mub/schema";

const noSleep = { sleep: async () => {} };

function steps(partial: Partial<MubSteps> & { steps: MubSteps["steps"] }): MubSteps {
  return { timeoutMs: 60000, ...partial };
}

describe("MUB engine", () => {
  it("retries the same step on a matching code, then succeeds", async () => {
    let n = 0;
    const attempt = async (): Promise<AttemptResult<string>> => {
      n++;
      if (n < 3) return { ok: false, status: 503, kind: "http", message: "unavailable" };
      return { ok: true, value: "done" };
    };
    const out = await runSteps(
      steps({ steps: [{ model: "m", provider: "p", retry: { on: [503], maxAttempts: 5, intervalMs: 10 } }] }),
      attempt,
      noSleep,
    );
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
    const out = await runSteps(
      steps({ steps: [{ model: "m", provider: "p", retry: { on: [503], maxAttempts: 5, intervalMs: 0 } }] }),
      attempt,
      noSleep,
    );
    expect(out.result.ok).toBe(false);
    expect(n).toBe(1);
    expect(out.path).toHaveLength(1);
  });

  it("advances to the next step on failure (default advanceOn = any)", async () => {
    const attempt = async (step: { model: string }): Promise<AttemptResult<string>> => {
      if (step.model === "a") return { ok: false, status: 503, kind: "http", message: "down" };
      return { ok: true, value: "served-by-b" };
    };
    const out = await runSteps(
      steps({ steps: [
        { model: "a", provider: "p1" },
        { model: "b", provider: "p2" },
      ] }),
      attempt,
      noSleep,
    );
    expect(out.result).toMatchObject({ ok: true, value: "served-by-b" });
    expect(out.path.map((p) => p.model)).toEqual(["a", "b"]);
  });

  it("respects advanceOn gating (stops when failure does not match)", async () => {
    const attempt = async (): Promise<AttemptResult<string>> => ({ ok: false, status: 500, kind: "http", message: "err" });
    const out = await runSteps(
      steps({ steps: [
        { model: "a", provider: "p1", advanceOn: [502] }, // 500 does not match -> no advance
        { model: "b", provider: "p2" },
      ] }),
      attempt,
      noSleep,
    );
    expect(out.result.ok).toBe(false);
    expect(out.path.map((p) => p.model)).toEqual(["a"]); // never reached step b
  });

  it("returns the last upstream failure when every step is exhausted", async () => {
    const attempt = async (step: { provider: string }): Promise<AttemptResult<string>> => ({
      ok: false,
      status: step.provider === "p2" ? 502 : 503,
      kind: "http",
      message: `fail-${step.provider}`,
    });
    const out = await runSteps(
      steps({ steps: [
        { model: "a", provider: "p1" },
        { model: "b", provider: "p2" },
      ] }),
      attempt,
      noSleep,
    );
    expect(out.result.ok).toBe(false);
    if (!out.result.ok) expect(out.result.status).toBe(502); // last step's failure
    expect(out.path).toHaveLength(2);
  });

  it("treats thrown errors as failures and classifies timeouts", async () => {
    const attempt = async (): Promise<AttemptResult<string>> => {
      const e = new Error("request timed out");
      e.name = "TimeoutError";
      throw e;
    };
    const out = await runSteps(
      steps({ steps: [{ model: "m", provider: "p", retry: { on: ["timeout"], maxAttempts: 2, intervalMs: 0 } }] }),
      attempt,
      noSleep,
    );
    expect(out.result.ok).toBe(false);
    expect(out.path).toHaveLength(2); // retried once on timeout
    expect(out.path[0].kind).toBe("timeout");
  });
});
