/**
 * Tests for custom error code retry configuration and 499 retry fix.
 *
 * Scenarios:
 *  1. Custom HTTP error code (e.g. 408) in retry.on triggers retry
 *  2. 499 error code in retry.on triggers retry (the core reliable-streaming fix)
 *  3. 499 retry succeeds on second attempt (safe_write idempotency)
 *  4. 499 retry suppressed for "unsafe" idempotency
 *  5. Quick-select preset 499 is equivalent to manually adding it
 *  6. Multiple custom codes in retry.on all trigger retry
 *  7. 499 with reliable streaming: retry succeeds, no flow interruption
 *  8. 499 error is still logged (retained logging capability)
 */

import { describe, expect, it, beforeEach } from "vitest";
import { Readable } from "node:stream";
import "../src/core/format"; // register wire formats
import { OpenAICompletionRequest } from "../src/core/format";
import { ModelService, type ServiceDeps } from "../src/execution/modelService";
import { runSteps, is499Retryable, type AttemptResult } from "../src/execution/steps";
import { newAccumulator, tapStream, fabricateStream } from "../src/core/ir/stream";
import { serializeStream } from "../src/core/format/registry";
import { ActiveRequestRegistry } from "../src/observability/activeRequests";
import { ProgressRecorder } from "../src/observability/progressRecorder";
import type { Transport, TransportJsonResult, TransportStreamResult, TransportOptions } from "../src/core/upstream/transport";
import type { Catalog } from "../src/catalog/catalog";
import type { ServiceSteps } from "../src/execution/definition";
import type { Family } from "../src/core/format/family";
import { Writable } from "node:stream";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OK_FRAMES = [
  'data: {"id":"c","model":"up","choices":[{"delta":{"role":"assistant"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
  "data: [DONE]\n\n",
];

const OK_JSON = {
  id: "c",
  model: "up",
  choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

const readableOf = (frames: string[]): Readable =>
  Readable.from((async function* () { for (const c of frames) yield c; })());

function fakeCatalog(): Catalog {
  return {
    resolve: (model: string, provider: string) => ({
      ok: true,
      target: {
        family: "openai_completion" as Family,
        upstreamModel: `up-${model}`,
        url: "http://upstream",
        headers: {},
        modelName: model,
        providerName: provider,
        upstream: {},
      },
    }),
    exists: () => true,
  } as unknown as Catalog;
}

function makeDeps(transport: Transport, registry?: ActiveRequestRegistry): ServiceDeps {
  return { catalog: fakeCatalog(), transport, progress: registry ?? null };
}

const noSleep = { sleep: async () => {} };

function steps(s: ServiceSteps["steps"]): ServiceSteps {
  return { timeoutMs: 10000, steps: s };
}

function baseReq(stream = false): OpenAICompletionRequest {
  return new OpenAICompletionRequest({
    requestedService: "svc",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    params: {},
    stream,
  });
}

class MockRawResponse extends Writable {
  chunks: string[] = [];
  destroyed = false;
  writableEnded = false;
  _write(chunk: string | Buffer, _enc: string, cb: () => void): void {
    this.chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    cb();
  }
  flush(): void {}
  end(cb?: () => void): this { this.writableEnded = true; if (cb) cb(); return this; }
  destroy(): this { this.destroyed = true; return this; }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Custom error code retry configuration", () => {
  // --- 1. Custom HTTP error code triggers retry ---

  it("1.1 custom code 408 in retry.on triggers retry and succeeds", async () => {
    let calls = 0;
    const transport: Transport = {
      async postJson() {
        calls++;
        return calls === 1
          ? { status: 408, headers: {}, json: { error: "timeout" }, text: "" }
          : { status: 200, headers: {}, json: OK_JSON, text: "" };
      },
      async postStream() {
        calls++;
        return { status: 200, headers: {}, body: readableOf(OK_FRAMES) };
      },
    };
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: { on: [408], maxAttempts: 3, intervalMs: 1, idempotency: "safe_write" } }]),
      makeDeps(transport),
    );
    const inv = await svc.invoke(baseReq());
    expect(inv.result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("1.2 custom code 504 in retry.on triggers retry", async () => {
    let calls = 0;
    const transport: Transport = {
      async postJson() {
        calls++;
        return calls <= 1
          ? { status: 504, headers: {}, json: { error: "gateway timeout" }, text: "" }
          : { status: 200, headers: {}, json: OK_JSON, text: "" };
      },
      async postStream() {
        calls++;
        return { status: 200, headers: {}, body: readableOf(OK_FRAMES) };
      },
    };
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: { on: [504], maxAttempts: 3, intervalMs: 1, idempotency: "safe_write" } }]),
      makeDeps(transport),
    );
    const inv = await svc.invoke(baseReq());
    expect(inv.result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  // --- 2. 499 error code triggers retry (the core fix) ---

  it("2.1 499 in retry.on triggers retry and succeeds (safe_write)", async () => {
    let calls = 0;
    const transport: Transport = {
      async postJson() {
        calls++;
        return calls === 1
          ? { status: 499, headers: {}, json: { error: "client closed" }, text: "" }
          : { status: 200, headers: {}, json: OK_JSON, text: "" };
      },
      async postStream() {
        calls++;
        return calls === 1
          ? { status: 499, headers: {}, body: readableOf(['data: {"error":"closed"}\n\n']) }
          : { status: 200, headers: {}, body: readableOf(OK_FRAMES) };
      },
    };
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: { on: [499], maxAttempts: 3, intervalMs: 1, idempotency: "safe_write" } }]),
      makeDeps(transport),
    );
    const inv = await svc.invoke(baseReq());
    expect(inv.result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("2.2 499 is in the default retryOn set (429, 503, 499, timeout)", async () => {
    // When retry.on is not explicitly set, the default includes 499.
    let calls = 0;
    const transport: Transport = {
      async postJson() {
        calls++;
        return calls === 1
          ? { status: 499, headers: {}, json: { error: "client closed" }, text: "" }
          : { status: 200, headers: {}, json: OK_JSON, text: "" };
      },
      async postStream() {
        calls++;
        return calls === 1
          ? { status: 499, headers: {}, body: readableOf(['data: {"error":"closed"}\n\n']) }
          : { status: 200, headers: {}, body: readableOf(OK_FRAMES) };
      },
    };
    // No explicit retry.on — uses default [429, 503, 499, "timeout"]
    const svc = new ModelService(
      steps([{ model: "m", provider: "p" }]),
      makeDeps(transport),
    );
    const inv = await svc.invoke(baseReq());
    expect(inv.result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  // --- 3. 499 retry with safe_write idempotency ---

  it("3.1 is499Retryable returns true for safe_write (default)", () => {
    expect(is499Retryable("safe_write")).toBe(true);
    expect(is499Retryable(undefined)).toBe(true); // defaults to safe_write
  });

  it("3.2 is499Retryable returns true for read", () => {
    expect(is499Retryable("read")).toBe(true);
  });

  it("3.3 is499Retryable returns false for unsafe", () => {
    expect(is499Retryable("unsafe")).toBe(false);
  });

  it("3.4 499 not retried for unsafe idempotency (flows through)", async () => {
    let calls = 0;
    const transport: Transport = {
      async postJson() {
        calls++;
        return { status: 499, headers: {}, json: { error: "client closed" }, text: "" };
      },
      async postStream() {
        calls++;
        return { status: 499, headers: {}, body: readableOf(['data: {"error":"closed"}\n\n']) };
      },
    };
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: { on: [499], maxAttempts: 3, intervalMs: 1, idempotency: "unsafe" } }]),
      makeDeps(transport),
    );
    const inv = await svc.invoke(baseReq());
    expect(inv.result.ok).toBe(false);
    if (!inv.result.ok) expect(inv.result.status).toBe(499);
    expect(calls).toBe(1); // not retried — unsafe
  });

  // --- 4. 499 with reliable streaming: no flow interruption ---

  it("4.1 499 during reliable streaming is retried, stream completes successfully", async () => {
    let calls = 0;
    const transport: Transport = {
      async postJson() {
        calls++;
        return { status: 200, headers: {}, json: OK_JSON, text: "" };
      },
      async postStream() {
        calls++;
        if (calls === 1) {
          return { status: 499, headers: {}, body: readableOf(['data: {"error":"closed"}\n\n']) };
        }
        return { status: 200, headers: {}, body: readableOf(OK_FRAMES) };
      },
    };
    const svc = new ModelService(
      {
        timeoutMs: 10000,
        steps: [{ model: "m", provider: "p", retry: { on: [499, 503, 429, "timeout"], maxAttempts: 3, intervalMs: 1, idempotency: "safe_write" } }],
        reliableStreaming: true,
      },
      makeDeps(transport),
    );

    const streamInv = await svc.stream(baseReq(true));
    expect(streamInv.result.ok).toBe(true);
    expect(calls).toBe(2); // 1 failed (499) + 1 succeeded

    if (streamInv.result.ok) {
      // Relay the fabricated stream — must complete without interruption
      const raw = new MockRawResponse();
      const outGen = serializeStream("openai_completion", streamInv.result.value.events, { model: "svc" });
      for await (const chunk of outGen) {
        if (raw.destroyed || raw.writableEnded) break;
        raw.write(chunk);
        raw.flush();
      }
      if (!raw.writableEnded) raw.end();
      const output = raw.chunks.join("");
      expect(output).toContain("hello");
      expect(output).toContain("[DONE]");
    }
  });

  it("4.2 persistent 499 in reliable streaming exhausts retries, returns error (no crash/hang)", async () => {
    const transport: Transport = {
      async postJson() { return { status: 499, headers: {}, json: { error: "closed" }, text: "" }; },
      async postStream() { return { status: 499, headers: {}, body: readableOf(['data: {"error":"closed"}\n\n']) }; },
    };
    const svc = new ModelService(
      {
        timeoutMs: 10000,
        steps: [{ model: "m", provider: "p", retry: { on: [499], maxAttempts: 3, intervalMs: 1, idempotency: "safe_write" } }],
        reliableStreaming: true,
      },
      makeDeps(transport),
    );

    const streamInv = await svc.stream(baseReq(true));
    expect(streamInv.result.ok).toBe(false);
    if (!streamInv.result.ok) expect(streamInv.result.status).toBe(499);
    // The error is returned, not thrown — no crash or hang
  });

  // --- 5. Multiple custom codes ---

  it("5.1 multiple custom codes (408, 504, 419) all trigger retry", async () => {
    const failCodes = [408, 504, 419];
    let callIndex = 0;
    const codes = [...failCodes, 200, 200, 200]; // fail 3 times, then succeed
    const transport: Transport = {
      async postJson() {
        const code = codes[callIndex++] ?? 200;
        return code < 400
          ? { status: 200, headers: {}, json: OK_JSON, text: "" }
          : { status: code, headers: {}, json: { error: "fail" }, text: "" };
      },
      async postStream() {
        return { status: 200, headers: {}, body: readableOf(OK_FRAMES) };
      },
    };
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: { on: [408, 504, 419], maxAttempts: 5, intervalMs: 1, idempotency: "safe_write" } }]),
      makeDeps(transport),
    );
    const inv = await svc.invoke(baseReq());
    expect(inv.result.ok).toBe(true);
    expect(callIndex).toBe(4); // 3 failed + 1 succeeded
  });

  // --- 6. 499 error logging retained ---

  it("6.1 499 error is recorded in attempt path (logging retained)", async () => {
    const transport: Transport = {
      async postJson() { return { status: 499, headers: {}, json: { error: "client closed" }, text: "" }; },
      async postStream() { return { status: 499, headers: {}, body: readableOf(['data: {"error":"closed"}\n\n']) }; },
    };
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: { on: [499], maxAttempts: 2, intervalMs: 1, idempotency: "safe_write" } }]),
      makeDeps(transport),
    );
    const inv = await svc.invoke(baseReq());

    expect(inv.result.ok).toBe(false);
    // The attempt path should have 2 entries (both 499), each with status 499
    const path = inv.attemptPath as Array<{ status: number; kind: string; retry?: { reason: string } }>;
    expect(path.length).toBe(2);
    expect(path[0].status).toBe(499);
    expect(path[1].status).toBe(499);
    // The last attempt should have a retry context explaining exhaustion
    expect(path[1].retry).toBeDefined();
    expect(path[1].retry!.reason).toContain("max attempts");
  });

  // --- 7. Active request monitoring captures 499 retry events ---

  it("7.1 499 retry events are captured in active request monitoring", async () => {
    const registry = new ActiveRequestRegistry();
    let calls = 0;
    const transport: Transport = {
      async postJson() {
        calls++;
        return calls === 1
          ? { status: 499, headers: {}, json: { error: "closed" }, text: "" }
          : { status: 200, headers: {}, json: OK_JSON, text: "" };
      },
      async postStream() {
        calls++;
        return { status: 200, headers: {}, body: readableOf(OK_FRAMES) };
      },
    };
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: { on: [499], maxAttempts: 3, intervalMs: 1, idempotency: "safe_write" } }]),
      makeDeps(transport, registry),
    );

    const traceId = "trace-499-retry";
    registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: false });
    const prog = new ProgressRecorder(registry, traceId);

    const inv = await svc.invoke(baseReq(), undefined, { progress: prog });
    registry.finish(traceId, inv.result.ok ? 200 : inv.result.status);

    expect(inv.result.ok).toBe(true);

    const entry = registry.get(traceId)!;
    // Should have retry.trigger event with status 499
    const triggers = entry.events.filter((e) => e.node === "retry.trigger");
    expect(triggers.length).toBeGreaterThanOrEqual(1);
    expect(triggers[0].detail?.status).toBe(499);
  });

  // --- 8. Preset 499 vs manually-added 499 are equivalent ---

  it("8.1 preset 499 and manually-added 499 behave identically in retry logic", async () => {
    // Test using runSteps directly to verify the retry engine
    let calls = 0;
    const attempt = async (): Promise<AttemptResult<string>> => {
      calls++;
      return calls === 1
        ? { ok: false, status: 499, kind: "http", message: "client closed" }
        : { ok: true, value: "ok" };
    };

    // With explicit [499] in retry.on
    const out1 = await runSteps(
      steps([{ model: "m", provider: "p", retry: { on: [499], maxAttempts: 3, intervalMs: 1, idempotency: "safe_write" } }]),
      attempt,
      noSleep,
    );
    expect(out1.result.ok).toBe(true);
    expect(out1.path.length).toBe(2); // 1 failed + 1 succeeded

    // Reset and test with default retry.on (includes 499)
    calls = 0;
    const attempt2 = async (): Promise<AttemptResult<string>> => {
      calls++;
      return calls === 1
        ? { ok: false, status: 499, kind: "http", message: "client closed" }
        : { ok: true, value: "ok" };
    };
    const out2 = await runSteps(
      steps([{ model: "m", provider: "p" }]), // no explicit retry → default [429, 503, 499, "timeout"]
      attempt2,
      noSleep,
    );
    expect(out2.result.ok).toBe(true);
    expect(out2.path.length).toBe(2);
  });

  // --- 9. Non-standard custom codes also work ---

  it("9.1 custom code 418 (I'm a teapot) triggers retry when in retry.on", async () => {
    let calls = 0;
    const transport: Transport = {
      async postJson() {
        calls++;
        return calls === 1
          ? { status: 418, headers: {}, json: { error: "teapot" }, text: "" }
          : { status: 200, headers: {}, json: OK_JSON, text: "" };
      },
      async postStream() { return { status: 200, headers: {}, body: readableOf(OK_FRAMES) }; },
    };
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: { on: [418], maxAttempts: 3, intervalMs: 1, idempotency: "safe_write" } }]),
      makeDeps(transport),
    );
    const inv = await svc.invoke(baseReq());
    expect(inv.result.ok).toBe(true);
    expect(calls).toBe(2);
  });
});
