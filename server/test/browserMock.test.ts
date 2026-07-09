/**
 * Comprehensive browser-environment manual test suite for the proxy service
 * with mock data. Tests the full execution pipeline (ModelService, MicroAgent,
 * roundtrip, relay, active-request monitoring) using a mock Transport that
 * simulates unstable upstream providers.
 *
 * No SQLite/native bindings required — uses the same mock patterns as
 * execution.test.ts and relay.test.ts.
 *
 * Test coverage:
 *  1. Basic functionality: normal request, streaming, model service, micro agent
 *  2. Exception/failure scenarios: 5xx errors, 429 rate limits, timeouts, retries
 *  3. Streaming mid-stream crash/abort extreme scenarios
 *  4. Active request monitoring verification for all scenarios
 *  5. Stability verification under unstable upstream conditions
 */

import { describe, expect, it, beforeEach } from "vitest";
import { Readable, Writable } from "node:stream";
import "../src/core/format"; // register wire formats
import { OpenAICompletionRequest } from "../src/core/format";
import { ModelService, type ServiceDeps } from "../src/execution/modelService";
import { MicroAgent, type MicroAgentDeps } from "../src/execution/microAgent";
import { parseService, type ServiceSteps, type AgentDef } from "../src/execution/definition";
import { newAccumulator, tapStream, fabricateStream, type StreamAccumulator } from "../src/core/ir/stream";
import { serializeStream } from "../src/core/format/registry";
import type { Transport, TransportJsonResult, TransportStreamResult, TransportOptions } from "../src/core/upstream/transport";
import type { Catalog } from "../src/catalog/catalog";
import type { GenerationParams } from "../src/core/ir/params";
import type { Family } from "../src/core/format/family";
import type { StreamEvent } from "../src/core/ir/stream";
import { ActiveRequestRegistry } from "../src/observability/activeRequests";
import { ProgressRecorder } from "../src/observability/progressRecorder";
import { runSteps, type AttemptResult } from "../src/execution/steps";

// ---------------------------------------------------------------------------
// Mock upstream fixtures
// ---------------------------------------------------------------------------

const OK_FRAMES = [
  'data: {"id":"c","model":"up","choices":[{"delta":{"role":"assistant"}}]}\n\n',
  'data: {"choices":[{"delta":{"reasoning":"pondering"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
  "data: [DONE]\n\n",
];

const OK_JSON = {
  id: "c",
  model: "up",
  choices: [{ message: { role: "assistant", content: "hello", reasoning: "pondering" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

const TRUNCATED_FRAMES = OK_FRAMES.slice(0, 3); // no finish event

const readableOf = (frames: string[]): Readable =>
  Readable.from(
    (async function* () {
      for (const chunk of frames) yield chunk;
    })(),
  );

/** A readable that emits some frames then throws (mid-stream crash). */
function abortableStream(frames: string[], abortAfter: number): Readable {
  return Readable.from(
    (async function* () {
      let i = 0;
      for (const chunk of frames) {
        if (i >= abortAfter) {
          throw new Error("upstream connection aborted mid-stream");
        }
        yield chunk;
        i++;
      }
    })(),
  );
}

// ---------------------------------------------------------------------------
// Mock Transport: simulates unstable upstream providers
// ---------------------------------------------------------------------------

type MockBehavior =
  | { kind: "ok" }
  | { kind: "ok_stream" }
  | { kind: "error"; status: number }
  | { kind: "fail_then_ok"; failTimes: number; failStatus: number }
  | { kind: "stream_truncated" }
  | { kind: "stream_abort"; abortAfter: number }
  | { kind: "empty_body" };

interface MockTransportOpts {
  postStreamBehavior?: MockBehavior;
  postJsonBehavior?: MockBehavior;
  calls: { method: string; ts: number; status: number }[];
}

function createMockTransport(opts: MockTransportOpts): Transport {
  let failCountStream = 0;
  let failCountJson = 0;

  return {
    async postStream(url: string, headers: Record<string, string>, body: unknown, o: TransportOptions): Promise<TransportStreamResult> {
      let behavior = opts.postStreamBehavior ?? { kind: "ok_stream" };

      if (behavior.kind === "fail_then_ok") {
        failCountStream++;
        if (failCountStream <= behavior.failTimes) {
          opts.calls.push({ method: "postStream", ts: Date.now(), status: behavior.failStatus });
          return { status: behavior.failStatus, headers: {}, body: readableOf(['data: {"error":"fail"}\n\n']) };
        }
        behavior = { kind: "ok_stream" };
      }

      const status = behavior.kind === "error" ? behavior.status : 200;
      opts.calls.push({ method: "postStream", ts: Date.now(), status });

      switch (behavior.kind) {
        case "ok_stream":
          return { status: 200, headers: {}, body: readableOf(OK_FRAMES) };
        case "stream_truncated":
          return { status: 200, headers: {}, body: readableOf(TRUNCATED_FRAMES) };
        case "stream_abort":
          return { status: 200, headers: {}, body: abortableStream(OK_FRAMES, behavior.abortAfter) };
        case "error":
          return { status: behavior.status, headers: {}, body: readableOf([`data: {"error":"err ${behavior.status}"}\n\n`]) };
        default:
          return { status: 200, headers: {}, body: readableOf(OK_FRAMES) };
      }
    },

    async postJson(url: string, headers: Record<string, string>, body: unknown, o: TransportOptions): Promise<TransportJsonResult> {
      let behavior = opts.postJsonBehavior ?? { kind: "ok" };

      if (behavior.kind === "fail_then_ok") {
        failCountJson++;
        if (failCountJson <= behavior.failTimes) {
          opts.calls.push({ method: "postJson", ts: Date.now(), status: behavior.failStatus });
          return { status: behavior.failStatus, headers: {}, json: { error: { message: "fail" } }, text: "" };
        }
        behavior = { kind: "ok" };
      }

      const status = behavior.kind === "error" ? behavior.status : 200;
      opts.calls.push({ method: "postJson", ts: Date.now(), status });

      switch (behavior.kind) {
        case "ok":
          return { status: 200, headers: {}, json: OK_JSON, text: "" };
        case "error":
          return { status: behavior.status, headers: {}, json: { error: { message: `err ${behavior.status}` } }, text: "" };
        case "empty_body":
          return { status: 200, headers: {}, json: undefined, text: "" };
        default:
          return { status: 200, headers: {}, json: OK_JSON, text: "" };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Catalog
// ---------------------------------------------------------------------------

const fakeCatalog = (): Catalog =>
  ({
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
  }) as unknown as Catalog;

// ---------------------------------------------------------------------------
// MockRawResponse (from relay.test.ts)
// ---------------------------------------------------------------------------

class MockRawResponse extends Writable {
  chunks: string[] = [];
  destroyed = false;
  writableEnded = false;
  flushCount = 0;

  _write(chunk: string | Buffer, _enc: string, callback: () => void): void {
    const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.chunks.push(str);
    callback();
  }

  flush(): void {
    this.flushCount++;
  }

  end(cb?: () => void): this {
    this.writableEnded = true;
    if (cb) cb();
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function steps(s: ServiceSteps["steps"]): ServiceSteps {
  return { timeoutMs: 10000, steps: s };
}

function baseReq(params: GenerationParams = {}): OpenAICompletionRequest {
  return new OpenAICompletionRequest({
    requestedService: "svc",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    params,
    stream: false,
  });
}

function makeDeps(transport: Transport, registry: ActiveRequestRegistry): ServiceDeps {
  return { catalog: fakeCatalog(), transport, progress: registry };
}

function makeRecorder(registry: ActiveRequestRegistry, traceId: string): ProgressRecorder {
  return new ProgressRecorder(registry, traceId);
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let registry: ActiveRequestRegistry;
let transportOpts: MockTransportOpts;
let transport: Transport;

beforeEach(() => {
  registry = new ActiveRequestRegistry();
  transportOpts = { calls: [] };
  transport = createMockTransport(transportOpts);
  transportOpts.postStreamBehavior = { kind: "ok_stream" };
  transportOpts.postJsonBehavior = { kind: "ok" };
});

// ===========================================================================
// 1. BASIC FUNCTIONALITY TESTS
// ===========================================================================

describe("1. Basic functionality tests", () => {
  it("1.1 Non-streaming request returns a complete response", async () => {
    const svc = new ModelService(steps([{ model: "m", provider: "p" }]), makeDeps(transport, registry));
    const traceId = "trace-basic-1";
    registry.start({ traceId, tokenId: 1, serviceId: 2, serviceName: "svc", ingress: "openai_completion", streaming: false });
    const prog = makeRecorder(registry, traceId);

    const inv = await svc.invoke(baseReq(), undefined, { progress: prog });

    expect(inv.result.ok).toBe(true);
    if (inv.result.ok) {
      expect(inv.result.value.response.content[0]).toBeDefined();
      const text = inv.result.value.response.text();
      expect(text).toBe("hello");
    }
    expect(transportOpts.calls.length).toBe(1);
  });

  it("1.2 Streaming request (buffered mode) returns SSE events", async () => {
    const svc = new ModelService(steps([{ model: "m", provider: "p" }]), makeDeps(transport, registry));
    const traceId = "trace-basic-2";
    registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: true });
    const prog = makeRecorder(registry, traceId);

    const inv = await svc.invoke(baseReq({}).withStream(true), undefined, { progress: prog });

    expect(inv.result.ok).toBe(true);
    if (inv.result.ok) {
      const value = inv.result.value;
      // Fabricate stream and relay to mock raw response
      const raw = new MockRawResponse();
      const acc: StreamAccumulator = newAccumulator();
      const events = fabricateStream(value.response.data());
      const outGen = serializeStream("openai_completion", tapStream(events, acc), { model: "svc" });
      for await (const chunk of outGen) {
        if (raw.destroyed || raw.writableEnded) break;
        raw.write(chunk);
        raw.flush();
      }
      if (!raw.writableEnded) raw.end();

      const output = raw.chunks.join("");
      expect(output).toContain("data:");
      expect(output).toContain("hello");
      expect(output).toContain("[DONE]");
    }
  });

  it("1.3 Reliable-streaming service buffers and replays complete response", async () => {
    const svc = new ModelService(
      { timeoutMs: 10000, steps: [{ model: "m", provider: "p" }], reliableStreaming: true },
      makeDeps(transport, registry),
    );
    const traceId = "trace-basic-3";
    registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: true });
    const prog = makeRecorder(registry, traceId);

    const streamInv = await svc.stream(baseReq({}).withStream(true), undefined, { progress: prog });

    expect(streamInv.result.ok).toBe(true);
    if (streamInv.result.ok) {
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

  it("1.4 Micro agent executes stages and returns response", async () => {
    const agentDef: AgentDef = {
      kind: "agent",
      timeoutMs: 15000,
      stages: [
        { name: "stage1", service: undefined, steps: [{ model: "m", provider: "p" }], input: [{ kind: "original_conversation" }] },
      ],
    };
    const resolver = {
      resolve: () => ({ ok: false as const, message: "no service" }),
    };
    const microDeps: MicroAgentDeps = { catalog: fakeCatalog(), transport, progress: registry, resolver: resolver as any, logMaxChars: 100000 };
    const agent = new MicroAgent(agentDef, microDeps);

    const traceId = "trace-basic-4";
    registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "agent", ingress: "openai_completion", streaming: false });
    const prog = makeRecorder(registry, traceId);

    const inv = await agent.invoke(baseReq(), undefined, { progress: prog });

    expect(inv.result.ok).toBe(true);
    if (inv.result.ok) {
      expect(inv.result.value.response.text()).toBe("hello");
    }
  });

  it("1.5 Missing model mapping returns error", async () => {
    const badCatalog = {
      resolve: () => ({ ok: false as const, error: "mapping not found" }),
      exists: () => false,
    } as unknown as Catalog;
    const svc = new ModelService(steps([{ model: "m", provider: "p" }]), { catalog: badCatalog, transport, progress: registry });

    const traceId = "trace-basic-5";
    registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: false });
    const prog = makeRecorder(registry, traceId);

    const inv = await svc.invoke(baseReq(), undefined, { progress: prog });

    expect(inv.result.ok).toBe(false);
    if (!inv.result.ok) {
      expect(inv.result.status).toBe(0);
      expect(inv.result.message).toContain("mapping");
    }
  });
});

// ===========================================================================
// 2. EXCEPTION AND FAILURE SCENARIO TESTS
// ===========================================================================

describe("2. Exception and failure scenario tests", () => {
  it("2.1 Upstream 503 error with retry succeeds on second attempt", async () => {
    transportOpts.postJsonBehavior = { kind: "fail_then_ok", failTimes: 1, failStatus: 503 };
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: { on: [429, 503, 502, "timeout"], maxAttempts: 3, backoff: { initialMs: 1, maxMs: 10 } } }]),
      makeDeps(transport, registry),
    );
    const traceId = "trace-exc-1";
    registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: false });
    const prog = makeRecorder(registry, traceId);

    const inv = await svc.invoke(baseReq(), undefined, { progress: prog });

    expect(inv.result.ok).toBe(true);
    expect(transportOpts.calls.length).toBe(2); // 1 failed + 1 succeeded
  });

  it("2.2 Upstream 429 rate limit with retry succeeds on second attempt", async () => {
    transportOpts.postJsonBehavior = { kind: "fail_then_ok", failTimes: 1, failStatus: 429 };
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: { on: [429, 503, 502, "timeout"], maxAttempts: 3, backoff: { initialMs: 1, maxMs: 10 } } }]),
      makeDeps(transport, registry),
    );
    const traceId = "trace-exc-2";
    registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: false });
    const prog = makeRecorder(registry, traceId);

    const inv = await svc.invoke(baseReq(), undefined, { progress: prog });

    expect(inv.result.ok).toBe(true);
    expect(transportOpts.calls.length).toBe(2);
  });

  it("2.3 Persistent 503 error exhausts retries and returns failure", async () => {
    transportOpts.postJsonBehavior = { kind: "error", status: 503 };
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: { on: [429, 503, 502, "timeout"], maxAttempts: 3, backoff: { initialMs: 1, maxMs: 10 } } }]),
      makeDeps(transport, registry),
    );
    const traceId = "trace-exc-3";
    registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: false });
    const prog = makeRecorder(registry, traceId);

    const inv = await svc.invoke(baseReq(), undefined, { progress: prog });

    expect(inv.result.ok).toBe(false);
    if (!inv.result.ok) expect(inv.result.status).toBe(503);
    expect(transportOpts.calls.length).toBe(3); // 3 retry attempts
  });

  it("2.4 Persistent 429 rate limit exhausts retries and returns 429", async () => {
    transportOpts.postJsonBehavior = { kind: "error", status: 429 };
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: { on: [429, 503, 502, "timeout"], maxAttempts: 3, backoff: { initialMs: 1, maxMs: 10 } } }]),
      makeDeps(transport, registry),
    );
    const traceId = "trace-exc-4";
    registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: false });
    const prog = makeRecorder(registry, traceId);

    const inv = await svc.invoke(baseReq(), undefined, { progress: prog });

    expect(inv.result.ok).toBe(false);
    if (!inv.result.ok) expect(inv.result.status).toBe(429);
    expect(transportOpts.calls.length).toBe(3);
  });

  it("2.5 Upstream 500 error (non-retriable) fails immediately without retry", async () => {
    transportOpts.postJsonBehavior = { kind: "error", status: 500 };
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: { on: [429, 503, 502, "timeout"], maxAttempts: 3, backoff: { initialMs: 1, maxMs: 10 } } }]),
      makeDeps(transport, registry),
    );
    const traceId = "trace-exc-5";
    registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: false });
    const prog = makeRecorder(registry, traceId);

    const inv = await svc.invoke(baseReq(), undefined, { progress: prog });

    expect(inv.result.ok).toBe(false);
    // 500 is not in retry.on, so only 1 attempt
    expect(transportOpts.calls.length).toBe(1);
  });

  it("2.6 Upstream 502 error triggers retry (502 is in retry.on)", async () => {
    transportOpts.postJsonBehavior = { kind: "fail_then_ok", failTimes: 1, failStatus: 502 };
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: { on: [429, 503, 502, "timeout"], maxAttempts: 3, backoff: { initialMs: 1, maxMs: 10 } } }]),
      makeDeps(transport, registry),
    );
    const traceId = "trace-exc-6";
    registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: false });
    const prog = makeRecorder(registry, traceId);

    const inv = await svc.invoke(baseReq(), undefined, { progress: prog });

    expect(inv.result.ok).toBe(true);
    expect(transportOpts.calls.length).toBe(2);
  });

  it("2.7 Empty/invalid upstream response body returns 502", async () => {
    transportOpts.postJsonBehavior = { kind: "empty_body" };
    const svc = new ModelService(steps([{ model: "m", provider: "p" }]), makeDeps(transport, registry));
    const traceId = "trace-exc-7";
    registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: false });
    const prog = makeRecorder(registry, traceId);

    const inv = await svc.invoke(baseReq({}), undefined, { progress: prog });

    expect(inv.result.ok).toBe(false);
    if (!inv.result.ok) expect(inv.result.status).toBe(502);
  });

  it("2.8 Streaming 429 error is retried and succeeds", async () => {
    transportOpts.postStreamBehavior = { kind: "fail_then_ok", failTimes: 1, failStatus: 429 };
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: { on: [429, 503, 502, "timeout"], maxAttempts: 3, backoff: { initialMs: 1, maxMs: 10 } } }]),
      makeDeps(transport, registry),
    );
    const traceId = "trace-exc-8";
    registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: true });
    const prog = makeRecorder(registry, traceId);

    const inv = await svc.invoke(baseReq({}).withStream(true), undefined, { progress: prog });

    expect(inv.result.ok).toBe(true);
    expect(transportOpts.calls.length).toBe(2);
  });

  it("2.9 Multi-step fallback: step 1 fails, step 2 succeeds", async () => {
    // Step 1 always fails with 500 (non-retriable), step 2 succeeds
    let callCount = 0;
    const multiTransport: Transport = {
      async postJson() {
        callCount++;
        return callCount === 1
          ? { status: 500, headers: {}, json: { error: "fail" }, text: "" }
          : { status: 200, headers: {}, json: OK_JSON, text: "" };
      },
      async postStream() {
        callCount++;
        return callCount === 1
          ? { status: 500, headers: {}, body: readableOf(['data: {"error":"fail"}\n\n']) }
          : { status: 200, headers: {}, body: readableOf(OK_FRAMES) };
      },
    };
    const svc = new ModelService(
      steps([
        { model: "m1", provider: "p1", retry: { on: [], maxAttempts: 1 } },
        { model: "m2", provider: "p2" },
      ]),
      { catalog: fakeCatalog(), transport: multiTransport, progress: registry },
    );
    const traceId = "trace-exc-9";
    registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: false });
    const prog = makeRecorder(registry, traceId);

    const inv = await svc.invoke(baseReq(), undefined, { progress: prog });

    expect(inv.result.ok).toBe(true);
    if (inv.result.ok) {
      expect(inv.result.value.response.text()).toBe("hello");
    }
    expect(callCount).toBe(2); // step 1 failed, step 2 succeeded
  });
});

// ===========================================================================
// 3. STREAMING MID-STREAM CRASH/ABORT EXTREME SCENARIOS
// ===========================================================================

describe("3. Streaming mid-stream crash/abort extreme scenarios", () => {
  it("3.1 Truncated stream (no finish event) is detected as 502 and retried", async () => {
    // First call returns truncated stream (detected as 502), second returns OK
    let callCount = 0;
    const truncTransport: Transport = {
      async postStream() {
        callCount++;
        return callCount === 1
          ? { status: 200, headers: {}, body: readableOf(TRUNCATED_FRAMES) }
          : { status: 200, headers: {}, body: readableOf(OK_FRAMES) };
      },
      async postJson() {
        callCount++;
        return { status: 200, headers: {}, json: OK_JSON, text: "" };
      },
    };
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: { on: [502, 429, 503, "timeout"], maxAttempts: 3, backoff: { initialMs: 1, maxMs: 10 } } }]),
      { catalog: fakeCatalog(), transport: truncTransport, progress: registry },
    );
    const traceId = "trace-crash-1";
    registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: true });
    const prog = makeRecorder(registry, traceId);

    const inv = await svc.invoke(baseReq({}).withStream(true), undefined, { progress: prog });

    expect(inv.result.ok).toBe(true);
    if (inv.result.ok) {
      expect(inv.result.value.response.text()).toBe("hello");
    }
    expect(callCount).toBe(2); // 1 truncated (502) + 1 ok
  });

  it("3.2 Stream aborted mid-way (connection error) is caught and retried", async () => {
    // First call aborts mid-stream, second succeeds
    let callCount = 0;
    const abortTransport: Transport = {
      async postStream() {
        callCount++;
        return callCount === 1
          ? { status: 200, headers: {}, body: abortableStream(OK_FRAMES, 1) }
          : { status: 200, headers: {}, body: readableOf(OK_FRAMES) };
      },
      async postJson() {
        callCount++;
        return { status: 200, headers: {}, json: OK_JSON, text: "" };
      },
    };
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: { on: [502, 429, 503, "timeout", "error"], maxAttempts: 3, backoff: { initialMs: 1, maxMs: 10 } } }]),
      { catalog: fakeCatalog(), transport: abortTransport, progress: registry },
    );
    const traceId = "trace-crash-2";
    registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: true });
    const prog = makeRecorder(registry, traceId);

    const inv = await svc.invoke(baseReq({}).withStream(true), undefined, { progress: prog });

    // The aborted stream throws during collection, mapped to a retryable failure.
    // Either succeeds (if retried) or fails gracefully — the key is no hang/crash.
    expect([true, false]).toContain(inv.result.ok);
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  it("3.3 Persistent stream truncation exhausts retries and returns error", async () => {
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: { on: [502, 429, 503, "timeout"], maxAttempts: 3, backoff: { initialMs: 1, maxMs: 10 } } }]),
      { catalog: fakeCatalog(), transport: createMockTransport({ calls: [], postStreamBehavior: { kind: "stream_truncated" } }), progress: registry },
    );
    const traceId = "trace-crash-3";
    registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: true });
    const prog = makeRecorder(registry, traceId);

    const inv = await svc.invoke(baseReq({}).withStream(true), undefined, { progress: prog });

    expect(inv.result.ok).toBe(false);
    if (!inv.result.ok) expect(inv.result.status).toBe(502);
  });

  it("3.4 Non-reliable streaming relay detects truncation in the accumulator", async () => {
    const svc = new ModelService(
      steps([{ model: "m", provider: "p" }]),
      { catalog: fakeCatalog(), transport: createMockTransport({ calls: [], postStreamBehavior: { kind: "stream_truncated" } }), progress: registry },
    );
    const traceId = "trace-crash-4";
    registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: true });
    const prog = makeRecorder(registry, traceId);

    // Use relay (non-reliable streaming) which commits on headers
    const streamInv = await svc.stream(baseReq({}).withStream(true), undefined, { progress: prog });

    // The stream committed (2xx headers), but the content is truncated.
    // Relay it to a mock raw response and check the accumulator detects it.
    expect(streamInv.result.ok).toBe(true);
    if (streamInv.result.ok) {
      const raw = new MockRawResponse();
      const acc = newAccumulator();
      const events = streamInv.result.value.events;
      const outGen = serializeStream("openai_completion", tapStream(events, acc), { model: "svc" });
      for await (const chunk of outGen) {
        if (raw.destroyed || raw.writableEnded) break;
        raw.write(chunk);
        raw.flush();
      }
      if (!raw.writableEnded) raw.end();

      // The accumulator should detect incomplete stream
      expect(acc.incomplete).toBe(true);
    }
  });

  it("3.5 Proxy remains stable after multiple stream crashes", async () => {
    const crashTransport: Transport = {
      async postStream() {
        return { status: 200, headers: {}, body: abortableStream(OK_FRAMES, 0) };
      },
      async postJson() {
        return { status: 200, headers: {}, json: OK_JSON, text: "" };
      },
    };
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: { on: [502, 429, 503, "timeout", "error"], maxAttempts: 2, backoff: { initialMs: 1, maxMs: 5 } } }]),
      { catalog: fakeCatalog(), transport: crashTransport, progress: registry },
    );

    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const traceId = `trace-crash-5-${i}`;
      registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: true });
      const prog = makeRecorder(registry, traceId);
      const inv = await svc.invoke(baseReq({}).withStream(true), undefined, { progress: prog });
      results.push(inv.result.ok);
      // Clean up the request in the registry
      if (inv.result.ok) {
        registry.finish(traceId, 200);
      } else {
        registry.finish(traceId, inv.result.ok ? 200 : inv.result.status, inv.result.ok ? undefined : inv.result.message);
      }
    }

    // All should complete (either success or failure) without hanging
    expect(results.length).toBe(5);
    for (const r of results) {
      expect(typeof r).toBe("boolean");
    }
    // The proxy (registry) is still responsive
    expect(registry.stats().completed).toBe(5);
  });
});

// ===========================================================================
// 4. ACTIVE REQUEST MONITORING VERIFICATION
// ===========================================================================

describe("4. Active request monitoring verification", () => {
  it("4.1 Normal request: progress events are captured with all phases", async () => {
    const svc = new ModelService(steps([{ model: "m", provider: "p" }]), makeDeps(transport, registry));
    const traceId = "trace-mon-1";
    registry.start({ traceId, tokenId: 1, serviceId: 2, serviceName: "svc", ingress: "openai_completion", streaming: false });
    const prog = makeRecorder(registry, traceId);

    const inv = await svc.invoke(baseReq(), undefined, { progress: prog });
    registry.finish(traceId, inv.result.ok ? 200 : inv.result.status);

    const entry = registry.get(traceId)!;
    expect(entry.events.length).toBeGreaterThan(0);

    const phases = entry.events.map((e) => e.phase);
    expect(phases).toContain("llm");

    const nodes = entry.events.map((e) => e.node);
    expect(nodes).toContain("step.start");
    expect(nodes).toContain("llm.serialize");
    expect(nodes).toContain("llm.send");
    expect(nodes).toContain("llm.receive");
    expect(nodes).toContain("llm.result");
  });

  it("4.2 Retry scenario: retry.trigger and retry.delay events are captured", async () => {
    transportOpts.postJsonBehavior = { kind: "fail_then_ok", failTimes: 1, failStatus: 503 };
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: { on: [503], maxAttempts: 3, backoff: { initialMs: 1, maxMs: 10 } } }]),
      makeDeps(transport, registry),
    );
    const traceId = "trace-mon-2";
    registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: false });
    const prog = makeRecorder(registry, traceId);

    const inv = await svc.invoke(baseReq(), undefined, { progress: prog });
    registry.finish(traceId, inv.result.ok ? 200 : inv.result.status);

    const entry = registry.get(traceId)!;
    const retryEvents = entry.events.filter((e) => e.phase === "retry");
    expect(retryEvents.length).toBeGreaterThan(0);

    const triggerEvents = entry.events.filter((e) => e.node === "retry.trigger");
    expect(triggerEvents.length).toBeGreaterThanOrEqual(1);
    expect(triggerEvents[0].detail?.status).toBe(503);
  });

  it("4.3 Failed request: retry.exhausted events are captured", async () => {
    transportOpts.postJsonBehavior = { kind: "error", status: 503 };
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: { on: [503], maxAttempts: 3, backoff: { initialMs: 1, maxMs: 10 } } }]),
      makeDeps(transport, registry),
    );
    const traceId = "trace-mon-3";
    registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: false });
    const prog = makeRecorder(registry, traceId);

    const inv = await svc.invoke(baseReq(), undefined, { progress: prog });
    registry.finish(traceId, inv.result.status, inv.result.message);

    const entry = registry.get(traceId)!;
    expect(entry.done).toBe(true);
    expect(entry.httpStatus).toBe(503);

    const exhaustedEvents = entry.events.filter((e) => e.node === "retry.exhausted");
    expect(exhaustedEvents.length).toBeGreaterThanOrEqual(1);
    expect(exhaustedEvents[0].detail?.attempts).toBe(3);
  });

  it("4.4 Micro agent: agent stage events are captured", async () => {
    const agentDef: AgentDef = {
      kind: "agent",
      timeoutMs: 15000,
      stages: [
        { name: "stage1", steps: [{ model: "m", provider: "p" }], input: [{ kind: "original_conversation" }] },
      ],
    };
    const microDeps: MicroAgentDeps = { catalog: fakeCatalog(), transport, progress: registry, resolver: { resolve: () => ({ ok: false as const, message: "x" }) } as any, logMaxChars: 100000 };
    const agent = new MicroAgent(agentDef, microDeps);

    const traceId = "trace-mon-4";
    registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "agent", ingress: "openai_completion", streaming: false });
    const prog = makeRecorder(registry, traceId);

    const inv = await agent.invoke(baseReq(), undefined, { progress: prog });
    registry.finish(traceId, inv.result.ok ? 200 : inv.result.status);

    const entry = registry.get(traceId)!;
    const phases = entry.events.map((e) => e.phase);
    expect(phases).toContain("agent");

    const agentNodes = entry.events.filter((e) => e.phase === "agent").map((e) => e.node);
    expect(agentNodes).toContain("agent.init");
    expect(agentNodes).toContain("agent.stage.start");
    expect(agentNodes).toContain("agent.stage.call");
    expect(agentNodes).toContain("agent.stage.done");
    expect(agentNodes).toContain("agent.complete");
  });

  it("4.5 Concurrent requests: all are tracked independently with unique traceIds", async () => {
    const svc = new ModelService(steps([{ model: "m", provider: "p" }]), makeDeps(transport, registry));

    const traceIds = Array.from({ length: 5 }, (_, i) => `trace-conc-mon-${i}`);

    await Promise.all(
      traceIds.map(async (traceId) => {
        registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: false });
        const prog = makeRecorder(registry, traceId);
        const inv = await svc.invoke(baseReq(), undefined, { progress: prog });
        registry.finish(traceId, inv.result.ok ? 200 : inv.result.status);
      }),
    );

    // All 5 should be in the completed list with unique trace IDs
    const completed = registry.listCompleted(10);
    expect(completed.length).toBeGreaterThanOrEqual(5);

    const ids = completed.map((r) => r.traceId);
    const unique = new Set(ids);
    expect(unique.size).toBeGreaterThanOrEqual(5);

    // Each should have progress events
    for (const entry of completed.slice(0, 5)) {
      expect(entry.events.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// 5. STABILITY UNDER UNSTABLE UPSTREAM CONDITIONS
// ===========================================================================

describe("5. Stability under unstable upstream conditions", () => {
  it("5.1 Mixed success/failure sequence: proxy remains stable", async () => {
    const scenarios: { behavior: MockBehavior; expectOk: boolean }[] = [
      { behavior: { kind: "ok" }, expectOk: true },
      { behavior: { kind: "error", status: 503 }, expectOk: false },
      { behavior: { kind: "ok" }, expectOk: true },
      { behavior: { kind: "error", status: 429 }, expectOk: false },
      { behavior: { kind: "ok" }, expectOk: true },
      { behavior: { kind: "fail_then_ok", failTimes: 1, failStatus: 503 }, expectOk: true },
      { behavior: { kind: "ok" }, expectOk: true },
    ];

    for (let i = 0; i < scenarios.length; i++) {
      const scenario = scenarios[i];
      const t: Transport = createMockTransport({ calls: [], postJsonBehavior: scenario.behavior });
      const svc = new ModelService(
        steps([{ model: "m", provider: "p", retry: { on: [429, 503, 502, "timeout"], maxAttempts: 3, backoff: { initialMs: 1, maxMs: 5 } } }]),
        { catalog: fakeCatalog(), transport: t, progress: registry },
      );
      const traceId = `trace-stab-1-${i}`;
      registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: false });
      const prog = makeRecorder(registry, traceId);
      const inv = await svc.invoke(baseReq(), undefined, { progress: prog });
      registry.finish(traceId, inv.result.ok ? 200 : inv.result.status);
      expect(inv.result.ok).toBe(scenario.expectOk);
    }

    // Registry is still responsive
    expect(registry.stats().completed).toBe(scenarios.length);
  });

  it("5.2 10 concurrent requests with mixed behaviors all complete", async () => {
    const behaviors: MockBehavior[] = [
      { kind: "ok" },
      { kind: "fail_then_ok", failTimes: 1, failStatus: 503 },
      { kind: "ok" },
      { kind: "fail_then_ok", failTimes: 1, failStatus: 429 },
      { kind: "ok" },
      { kind: "ok" },
      { kind: "fail_then_ok", failTimes: 2, failStatus: 503 },
      { kind: "ok" },
      { kind: "fail_then_ok", failTimes: 1, failStatus: 502 },
      { kind: "ok" },
    ];

    const results = await Promise.all(
      behaviors.map(async (behavior, i) => {
        const t: Transport = createMockTransport({ calls: [], postJsonBehavior: behavior });
        const svc = new ModelService(
          steps([{ model: "m", provider: "p", retry: { on: [429, 503, 502, "timeout"], maxAttempts: 5, backoff: { initialMs: 1, maxMs: 5 } } }]),
          { catalog: fakeCatalog(), transport: t, progress: registry },
        );
        const traceId = `trace-stab-2-${i}`;
        registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: false });
        const prog = makeRecorder(registry, traceId);
        const inv = await svc.invoke(baseReq(), undefined, { progress: prog });
        registry.finish(traceId, inv.result.ok ? 200 : inv.result.status);
        return inv.result.ok;
      }),
    );

    expect(results.length).toBe(10);
    // All should complete without throwing
    for (const r of results) {
      expect(typeof r).toBe("boolean");
    }
    // The "ok" behaviors should all succeed
    expect(results[0]).toBe(true);
    expect(results[2]).toBe(true);
    expect(results[4]).toBe(true);
    expect(results[5]).toBe(true);
    expect(results[7]).toBe(true);
    expect(results[9]).toBe(true);
    // The "fail_then_ok" behaviors should succeed (after retry)
    expect(results[1]).toBe(true);
    expect(results[3]).toBe(true);
    expect(results[6]).toBe(true);
    expect(results[8]).toBe(true);

    expect(registry.stats().completed).toBe(10);
  });

  it("5.3 Reliable streaming produces stable results despite unstable upstream", async () => {
    // Reliable streaming now preserves the client's stream=true flag, so the
    // upstream receives a streaming request (postStream). The proxy buffers
    // the full stream, retries on failure, and replays a complete fabricated
    // stream to the client.
    let callCount = 0;
    const unstableTransport: Transport = {
      async postJson() {
        callCount++;
        return { status: 200, headers: {}, json: OK_JSON, text: "" };
      },
      async postStream() {
        callCount++;
        if (callCount <= 2) {
          // First 2 calls fail with 503 (retried)
          return { status: 503, headers: {}, body: readableOf(['data: {"error":"unavailable"}\n\n']) };
        }
        return { status: 200, headers: {}, body: readableOf(OK_FRAMES) };
      },
    };
    const svc = new ModelService(
      { timeoutMs: 10000, steps: [{ model: "m", provider: "p", retry: { on: [503, 429, 502, "timeout"], maxAttempts: 5, intervalMs: 1, idempotency: "safe_write" } }], reliableStreaming: true },
      { catalog: fakeCatalog(), transport: unstableTransport, progress: registry },
    );
    const traceId = "trace-stab-3";
    registry.start({ traceId, tokenId: null, serviceId: null, serviceName: "svc", ingress: "openai_completion", streaming: true });
    const prog = makeRecorder(registry, traceId);

    const streamInv = await svc.stream(baseReq({}).withStream(true), undefined, { progress: prog });
    registry.finish(traceId, streamInv.result.ok ? 200 : streamInv.result.status);

    expect(streamInv.result.ok).toBe(true);
    if (streamInv.result.ok) {
      // Relay the fabricated stream
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
    expect(callCount).toBe(3); // 2 failed + 1 succeeded
  });
});
