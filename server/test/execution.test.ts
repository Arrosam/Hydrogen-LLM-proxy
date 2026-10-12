import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { OpenAICompletionRequest } from "../src/core/format";
import { ModelService } from "../src/execution/modelService";
import { MicroAgent, type ServiceResolver } from "../src/execution/microAgent";
import { parseService, type AgentDef, type ServiceSteps } from "../src/execution/definition";
import type { GenerationParams } from "../src/core/ir/params";
import { newAccumulator, tapStream } from "../src/core/ir/stream";
import type { Transport } from "../src/core/upstream/transport";
import type { Catalog } from "../src/catalog/catalog";
import { retryConfig } from "./retryFixture";

const OK_FRAMES = [
  'data: {"id":"c","model":"up","choices":[{"delta":{"role":"assistant"}}]}\n\n',
  'data: {"choices":[{"delta":{"reasoning":"pondering"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
  "data: [DONE]\n\n",
];
const TRUNCATED = OK_FRAMES.slice(0, 3); // no finish, no [DONE]

/** Non-streaming JSON response equivalent to OK_FRAMES (same text/usage/reasoning). */
const OK_JSON = {
  id: "c",
  model: "up",
  choices: [{ message: { role: "assistant", content: "hello", reasoning: "pondering" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

const readableOf = (f: string[]): Readable =>
  Readable.from(
    (async function* () {
      for (const chunk of f) yield chunk;
    })(),
  );

interface FakeOpts {
  status?: number;
  frames?: string[];
  /** JSON body returned for non-streaming (postJson) calls. */
  json?: Record<string, unknown>;
  onBody?: (body: Record<string, unknown>) => void;
}

function fakeTransport(opts: FakeOpts = {}): Transport {
  return {
    async postStream(_url, _headers, body) {
      opts.onBody?.(body as Record<string, unknown>);
      return { status: opts.status ?? 200, headers: {}, body: readableOf(opts.frames ?? OK_FRAMES) };
    },
    async postJson(_url, _headers, body) {
      opts.onBody?.(body as Record<string, unknown>);
      if (opts.status && opts.status >= 400) {
        return { status: opts.status, headers: {}, json: { error: "upstream error" }, text: "" };
      }
      return { status: 200, headers: {}, json: opts.json ?? OK_JSON, text: "" };
    },
  };
}

const fakeCatalog = (): Catalog =>
  ({
    resolve: (model: string, provider: string) => ({
      ok: true,
      target: { family: "openai_completion", upstreamModel: `up-${model}`, url: "http://upstream", headers: {}, modelName: model, providerName: provider, upstream: {} },
    }),
    exists: () => true,
  }) as unknown as Catalog;

const baseReq = (params: GenerationParams = {}) =>
  new OpenAICompletionRequest({ requestedService: "svc", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], params, stream: false });

const steps = (s: ServiceSteps["steps"]): ServiceSteps => ({ timeoutMs: 1000, steps: s });

describe("ModelService.invoke", () => {
  it("buffers the upstream response into a complete response (non-streaming upstream when stream=false)", async () => {
    const svc = new ModelService(steps([{ model: "m", provider: "p" }]), { catalog: fakeCatalog(), transport: fakeTransport() });
    const inv = await svc.invoke(baseReq());
    expect(inv.result.ok).toBe(true);
    if (inv.result.ok) {
      expect(inv.result.value.response.text()).toBe("hello");
      expect(inv.result.value.modelName).toBe("m");
      expect(inv.result.value.providerName).toBe("p");
      expect(inv.result.value.response.usage.totalTokens).toBe(5);
    }
    expect(inv.attempts).toBe(1);
  });

  it("retries a step on a matching HTTP failure then gives up", async () => {
    const svc = new ModelService(steps([{ model: "m", provider: "p", retry: retryConfig({ on: [500], maxAttempts: 2, intervalMs: 0 }) }]), {
      catalog: fakeCatalog(),
      transport: fakeTransport({ status: 500 }),
    });
    const inv = await svc.invoke(baseReq());
    expect(inv.result.ok).toBe(false);
    if (!inv.result.ok) expect(inv.result.status).toBe(500);
    expect(inv.attempts).toBe(2);
  });

  it("treats a truncated upstream stream as a retryable 502", async () => {
    // stream=true so the upstream is streamed and truncation can be detected.
    const svc = new ModelService(steps([{ model: "m", provider: "p" }]), { catalog: fakeCatalog(), transport: fakeTransport({ frames: TRUNCATED }) });
    const req = new OpenAICompletionRequest({ requestedService: "svc", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], params: {}, stream: true });
    const inv = await svc.invoke(req);
    expect(inv.result.ok).toBe(false);
    if (!inv.result.ok) expect(inv.result.status).toBe(502);
  });

  it("applies override precedence: caller > step config > client", async () => {
    let sent: Record<string, unknown> = {};
    const transport = fakeTransport({ onBody: (b) => (sent = b) });
    const svc = new ModelService(steps([{ model: "m", provider: "p", overrides: { temperature: 0.1 } }]), { catalog: fakeCatalog(), transport });

    await svc.invoke(baseReq({ temperature: 0.5 })); // step config beats client
    expect(sent.temperature).toBe(0.1);

    await svc.invoke(baseReq({ temperature: 0.5 }), { temperature: 0.9 }); // caller beats step
    expect(sent.temperature).toBe(0.9);
  });

  it("strips reasoning end-to-end when the effective thinking level is disabled", async () => {
    const svc = new ModelService(steps([{ model: "m", provider: "p", overrides: { thinking: "disabled" } }]), { catalog: fakeCatalog(), transport: fakeTransport() });
    const inv = await svc.invoke(baseReq());
    expect(inv.result.ok).toBe(true);
    if (inv.result.ok) expect(inv.result.value.response.content.some((c) => c.type === "reasoning")).toBe(false);
  });
});

describe("MicroAgent.invoke", () => {
  const noResolver: ServiceResolver = { resolve: () => ({ ok: false, message: "not used" }), sttDef: () => ({ ok: false, message: "not used" }) };
  const deps = (transport: Transport) => ({ catalog: fakeCatalog(), transport, resolver: noResolver, logMaxChars: 2000 });

  const agentDef = (raw: unknown): AgentDef => parseService(raw) as AgentDef;

  it("runs multiple stages and returns the terminal output", async () => {
    const def = agentDef({
      kind: "micro_agent",
      timeoutMs: 1000,
      stages: [
        { name: "a", input: [], steps: [{ model: "m", provider: "p" }] },
        { name: "b", input: [{ kind: "stage_output", stage: "a", role: "user" }], steps: [{ model: "m", provider: "p" }] },
      ],
    });
    const agent = new MicroAgent(def, deps(fakeTransport()));
    const inv = await agent.invoke(baseReq());
    expect(inv.result.ok).toBe(true);
    if (inv.result.ok) expect(inv.result.value.response.text()).toBe("hello");
    expect((inv.attemptPath as unknown[]).length).toBe(2);
  });

  it("follows a routing transition to end (skips later stages)", async () => {
    const def = agentDef({
      kind: "micro_agent",
      timeoutMs: 1000,
      stages: [
        { name: "a", input: [], steps: [{ model: "m", provider: "p" }], transitions: [{ when: { type: "always" }, goto: "end" }] },
        { name: "b", input: [], steps: [{ model: "m", provider: "p" }] },
      ],
    });
    const agent = new MicroAgent(def, deps(fakeTransport()));
    const inv = await agent.invoke(baseReq());
    expect(inv.result.ok).toBe(true);
    expect((inv.attemptPath as unknown[]).length).toBe(1); // stage b never ran
  });

  it("folds an outer override over a stage's config (outer wins)", async () => {
    let sent: Record<string, unknown> = {};
    const def = agentDef({
      kind: "micro_agent",
      timeoutMs: 1000,
      stages: [{ name: "a", input: [], steps: [{ model: "m", provider: "p" }], temperature: 0.2 }],
    });
    const agent = new MicroAgent(def, deps(fakeTransport({ onBody: (b) => (sent = b) })));
    await agent.invoke(baseReq({ temperature: 0.5 }), { temperature: 0.8 });
    expect(sent.temperature).toBe(0.8);
  });
});

// --- Issue 1: Reliable Streaming should disable upstream request streaming ---

describe("Reliable Streaming / upstream stream config (Issue 1)", () => {
  const noResolver: ServiceResolver = { resolve: () => ({ ok: false, message: "not used" }), sttDef: () => ({ ok: false, message: "not used" }) };
  const deps = (transport: Transport) => ({ catalog: fakeCatalog(), transport, resolver: noResolver, logMaxChars: 2000 });
  const agentDef = (raw: unknown): AgentDef => parseService(raw) as AgentDef;

  it("does NOT set stream=true in the upstream body when request stream=false (non-streaming path)", async () => {
    let sent: Record<string, unknown> = {};
    const transport = fakeTransport({ onBody: (b) => (sent = b) });
    const svc = new ModelService(steps([{ model: "m", provider: "p" }]), { catalog: fakeCatalog(), transport });
    await svc.invoke(baseReq());
    expect(sent.stream).toBeUndefined();
    expect(sent.stream_options).toBeUndefined();
  });

  it("sets stream=true in the upstream body when request stream=true (streaming buffered path)", async () => {
    let sent: Record<string, unknown> = {};
    const transport = fakeTransport({ onBody: (b) => (sent = b) });
    const svc = new ModelService(steps([{ model: "m", provider: "p" }]), { catalog: fakeCatalog(), transport });
    const req = new OpenAICompletionRequest({ requestedService: "svc", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], params: {}, stream: true });
    await svc.invoke(req);
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toEqual({ include_usage: true });
  });

  it("MicroAgent internal calls inherit a NON-streaming client's wire mode", async () => {
    const sentBodies: Record<string, unknown>[] = [];
    const transport = fakeTransport({ onBody: (b) => sentBodies.push(b as Record<string, unknown>) });
    const def = agentDef({
      kind: "micro_agent",
      timeoutMs: 1000,
      stages: [{ name: "a", input: [], steps: [{ model: "m", provider: "p" }] }],
    });
    const agent = new MicroAgent(def, deps(transport));
    // A non-streaming client -> plain JSON upstream calls.
    await agent.invoke(baseReq());
    expect(sentBodies.length).toBeGreaterThanOrEqual(1);
    for (const b of sentBodies) {
      expect(b.stream).toBeUndefined();
      expect(b.stream_options).toBeUndefined();
    }
  });

  it("MicroAgent.stream() streams upstream, buffers locally, then replays complete", async () => {
    const sentBodies: Record<string, unknown>[] = [];
    const transport = fakeTransport({ onBody: (b) => sentBodies.push(b as Record<string, unknown>) });
    const def = agentDef({
      kind: "micro_agent",
      timeoutMs: 1000,
      stages: [{ name: "a", input: [], steps: [{ model: "m", provider: "p" }] }],
      reliableStreaming: true,
    });
    const agent = new MicroAgent(def, deps(transport));
    const req = new OpenAICompletionRequest({ requestedService: "svc", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], params: {}, stream: true });
    const outcome = await agent.stream(req);
    expect(outcome.result.ok).toBe(true);
    expect(sentBodies.length).toBeGreaterThanOrEqual(1);
    // A streaming client -> the stage requests a stream upstream; the stage
    // output is still collected in full before anything reaches the client.
    for (const b of sentBodies) {
      expect(b.stream).toBe(true);
    }
    // The fabricated stream replays the complete text, only after full receipt.
    if (outcome.result.ok) {
      const acc = newAccumulator();
      for await (const _ev of tapStream(outcome.result.value.events, acc)) { void _ev; }
      expect(acc.text).toBe("hello");
    }
  });

  it("ModelService reliableStreaming preserves client stream=true, buffers upstream, then fabricates a paced stream", async () => {
    let sent: Record<string, unknown> = {};
    const transport = fakeTransport({ onBody: (b) => (sent = b) });
    const svc = new ModelService({ timeoutMs: 1000, steps: [{ model: "m", provider: "p" }], reliableStreaming: true }, { catalog: fakeCatalog(), transport });
    const req = new OpenAICompletionRequest({ requestedService: "svc", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], params: {}, stream: true });
    const outcome = await svc.stream(req);
    expect(outcome.result.ok).toBe(true);
    // Reliable streaming no longer overrides stream=false: the client's
    // stream=true is preserved, so the upstream receives a streaming request.
    // The proxy buffers the full upstream stream (via collectStream), then
    // fabricates a paced simulated stream for the client.
    expect(sent.stream).toBe(true);
    // The fabricated stream replays the complete response.
    if (outcome.result.ok) {
      const acc = newAccumulator();
      for await (const _ev of tapStream(outcome.result.value.events, acc)) { void _ev; }
      expect(acc.text).toBe("hello");
    }
  });
});

// --- Regression: sendBuffered must honor the request's stream flag ---
// Guards against the original bug where sendBuffered unconditionally called
// req.withStream(true), forcing every upstream call to be streamed even when
// the request explicitly set stream=false (MicroAgent internal calls, reliable
// streaming). If this breaks, the upstream provider receives stream=true when
// it should be stream=false, defeating reliable streaming.

describe("Regression: sendBuffered honors stream flag (Issue 1)", () => {
  it("non-streaming request uses postJson (not postStream)", async () => {
    let usedStream = false;
    let usedJson = false;
    const transport: Transport = {
      async postStream() { usedStream = true; return { status: 200, headers: {}, body: readableOf(OK_FRAMES) }; },
      async postJson() { usedJson = true; return { status: 200, headers: {}, json: OK_JSON, text: "" }; },
    };
    const svc = new ModelService(steps([{ model: "m", provider: "p" }]), { catalog: fakeCatalog(), transport });
    await svc.invoke(baseReq());
    expect(usedJson).toBe(true);
    expect(usedStream).toBe(false);
  });

  it("streaming request uses postStream (not postJson)", async () => {
    let usedStream = false;
    let usedJson = false;
    const transport: Transport = {
      async postStream() { usedStream = true; return { status: 200, headers: {}, body: readableOf(OK_FRAMES) }; },
      async postJson() { usedJson = true; return { status: 200, headers: {}, json: OK_JSON, text: "" }; },
    };
    const svc = new ModelService(steps([{ model: "m", provider: "p" }]), { catalog: fakeCatalog(), transport });
    const req = new OpenAICompletionRequest({ requestedService: "svc", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], params: {}, stream: true });
    await svc.invoke(req);
    expect(usedStream).toBe(true);
    expect(usedJson).toBe(false);
  });

  it("relayStream always forces stream=true regardless of request stream flag", async () => {
    let sent: Record<string, unknown> = {};
    const transport: Transport = {
      async postStream(_url, _headers, body) { sent = body as Record<string, unknown>; return { status: 200, headers: {}, body: readableOf(OK_FRAMES) }; },
      async postJson() { return { status: 200, headers: {}, json: OK_JSON, text: "" }; },
    };
    const svc = new ModelService(steps([{ model: "m", provider: "p" }]), { catalog: fakeCatalog(), transport });
    // Even with stream=false on the request, relay forces stream=true upstream.
    const req = baseReq();
    const outcome = await svc.stream(req);
    expect(outcome.result.ok).toBe(true);
    expect(sent.stream).toBe(true);
  });

  it("MicroAgent stages follow the client's wire mode: streaming client -> streaming stages", async () => {
    const sentBodies: Record<string, unknown>[] = [];
    let jsonCallCount = 0;
    let streamCallCount = 0;
    const transport: Transport = {
      async postStream(_url, _headers, body) { streamCallCount++; sentBodies.push(body as Record<string, unknown>); return { status: 200, headers: {}, body: readableOf(OK_FRAMES) }; },
      async postJson(_url, _headers, body) { jsonCallCount++; sentBodies.push(body as Record<string, unknown>); return { status: 200, headers: {}, json: OK_JSON, text: "" }; },
    };
    const def = parseService({
      kind: "micro_agent",
      timeoutMs: 1000,
      reliableStreaming: true,
      stages: [
        { name: "a", input: [], steps: [{ model: "m", provider: "p" }] },
        { name: "b", input: [{ kind: "stage_output", stage: "a", role: "user" }], steps: [{ model: "m", provider: "p" }] },
      ],
    }) as AgentDef;
    const resolver: ServiceResolver = { resolve: () => ({ ok: false, message: "not used" }), sttDef: () => ({ ok: false, message: "not used" }) };
    const agent = new MicroAgent(def, { catalog: fakeCatalog(), transport, resolver, logMaxChars: 2000 });

    // Streaming client: every stage streams upstream (collected locally).
    const req = new OpenAICompletionRequest({ requestedService: "svc", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], params: {}, stream: true });
    await agent.stream(req);
    expect(streamCallCount).toBe(2);
    expect(jsonCallCount).toBe(0);
    for (const b of sentBodies) expect(b.stream).toBe(true);

    // Non-streaming client: every stage stays plain JSON.
    sentBodies.length = 0;
    streamCallCount = 0;
    await agent.invoke(baseReq());
    expect(jsonCallCount).toBe(2);
    expect(streamCallCount).toBe(0);
    for (const b of sentBodies) expect(b.stream).toBeUndefined();
  });
});

// --- Issue: 499 retry integration (ModelService end-to-end) -----------------

describe("499 retry integration (ModelService end-to-end)", () => {
  /**
   * Fake transport that returns 499 N times then succeeds. Tracks call count
   * so we can assert the retry actually happened at the transport layer.
   */
  function fake499Transport(failNTimes: number): { transport: Transport; calls: number } {
    let calls = 0;
    const transport: Transport = {
      async postStream() { calls++; return { status: calls <= failNTimes ? 499 : 200, headers: {}, body: readableOf(OK_FRAMES) }; },
      async postJson() { calls++; return { status: calls <= failNTimes ? 499 : 200, headers: {}, json: calls <= failNTimes ? { error: "client closed" } : OK_JSON, text: "" }; },
    };
    return { transport, calls: 0 };
  };

  it("retries 499 via the step chain and succeeds on the 2nd attempt (safe_write)", async () => {
    const { transport, calls: _c } = fake499Transport(1);
    // Access calls via the closure — we re-read from the transport object.
    let actualCalls = 0;
    const wrappedTransport: Transport = {
      postJson: async (url, h, b, o) => { actualCalls++; return transport.postJson(url, h, b, o); },
      postStream: async (url, h, b, o) => { actualCalls++; return transport.postStream(url, h, b, o); },
    };
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: retryConfig({ maxAttempts: 3, backoff: { initialMs: 1, maxMs: 10 } }) }]),
      { catalog: fakeCatalog(), transport: wrappedTransport },
    );
    const inv = await svc.invoke(baseReq());
    expect(inv.result.ok).toBe(true);
    expect(actualCalls).toBe(2); // 1 failed + 1 succeeded
    expect(inv.attempts).toBe(2);
    // The attempt path should have a retry block on the 2nd entry.
    const path = inv.attemptPath as Array<{ retry?: { retryIndex: number; suppressed: boolean } }>;
    expect(path[1].retry).toBeDefined();
    expect(path[1].retry!.retryIndex).toBe(1);
  });

  it("fails after exhausting maxAttempts=3 on persistent 499 (safe_write)", async () => {
    const { transport } = fake499Transport(99); // always 499
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: retryConfig({ maxAttempts: 3, backoff: { initialMs: 1, maxMs: 10 } }) }]),
      { catalog: fakeCatalog(), transport },
    );
    const inv = await svc.invoke(baseReq());
    expect(inv.result.ok).toBe(false);
    if (!inv.result.ok) expect(inv.result.status).toBe(499);
    expect(inv.attempts).toBe(3);
    const path = inv.attemptPath as Array<{ retry?: { reason: string; suppressed: boolean } }>;
    expect(path[2].retry).toBeDefined();
    expect(path[2].retry!.reason).toContain("max attempts");
  });

  it("does NOT retry 499 when idempotency=unsafe (non-idempotent guard)", async () => {
    const { transport } = fake499Transport(99); // always 499
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: retryConfig({ maxAttempts: 3, idempotency: "unsafe", backoff: { initialMs: 1, maxMs: 10 } }) }]),
      { catalog: fakeCatalog(), transport },
    );
    const inv = await svc.invoke(baseReq());
    expect(inv.result.ok).toBe(false);
    if (!inv.result.ok) expect(inv.result.status).toBe(499);
    expect(inv.attempts).toBe(1); // no retry — single attempt
    const path = inv.attemptPath as Array<{ retry?: { reason: string; suppressed: boolean } }>;
    expect(path[0].retry).toBeDefined();
    expect(path[0].retry!.suppressed).toBe(true);
    expect(path[0].retry!.reason).toContain("unsafe");
  });

  it("retries 499 when idempotency=read (idempotent GET-style)", async () => {
    const { transport } = fake499Transport(2); // fail twice, then succeed
    const svc = new ModelService(
      steps([{ model: "m", provider: "p", retry: retryConfig({ maxAttempts: 3, idempotency: "read", backoff: { initialMs: 1, maxMs: 10 } }) }]),
      { catalog: fakeCatalog(), transport },
    );
    const inv = await svc.invoke(baseReq());
    expect(inv.result.ok).toBe(true);
    expect(inv.attempts).toBe(3);
  });
});

// --- Micro Agent routing, nesting and output selection ----------------------

describe("MicroAgent routing and nesting", () => {
  const agentDef = (raw: unknown): AgentDef => parseService(raw) as AgentDef;
  const unresolved: ServiceResolver = {
    resolve: () => ({ ok: false, message: "not used" }),
    sttDef: () => ({ ok: false, message: "not used" }),
  };
  /** Answers each call with `out-<upstream model>`, and records which models were asked. */
  function echoTransport(): { transport: Transport; models: string[] } {
    const models: string[] = [];
    const transport: Transport = {
      async postStream() { throw new Error("unused"); },
      async postJson(_url, _headers, body) {
        const model = String((body as { model?: unknown }).model);
        models.push(model);
        return { status: 200, headers: {}, text: "", json: { ...OK_JSON, choices: [{ message: { role: "assistant", content: `out-${model}` }, finish_reason: "stop" }] } };
      },
    };
    return { transport, models };
  }
  const agentOn = (raw: unknown, transport: Transport, resolver: ServiceResolver = unresolved) =>
    new MicroAgent(agentDef(raw), { catalog: fakeCatalog(), transport, resolver, logMaxChars: 2000 });
  const stage = (name: string, extra: Record<string, unknown> = {}) => ({ name, input: [], steps: [{ model: name, provider: "p" }], ...extra });
  const request = (text: string, withImage = false) =>
    new OpenAICompletionRequest({
      requestedService: "svc", params: {}, stream: false,
      messages: [{ role: "user", content: [{ type: "text", text }, ...(withImage ? [{ type: "image" as const, source: { kind: "url" as const, url: "https://img.example.com/cat.png" } }] : [])] }],
    });
  const textOf = (inv: Awaited<ReturnType<MicroAgent["invoke"]>>) => (inv.result.ok ? inv.result.value.response.text() : `failed: ${inv.result.message}`);

  it("skips a stage when an input condition routes past it, and runs it otherwise", async () => {
    const def = {
      kind: "micro_agent", timeoutMs: 1000,
      stages: [stage("a", { transitions: [{ when: { type: "input_contains", value: "skip" }, goto: "c" }] }), stage("b"), stage("c")],
    };
    const skipping = echoTransport();
    expect(textOf(await agentOn(def, skipping.transport).invoke(request("please skip ahead")))).toBe("out-up-c");
    expect(skipping.models).toEqual(["up-a", "up-c"]);

    const full = echoTransport();
    expect(textOf(await agentOn(def, full.transport).invoke(request("carry on")))).toBe("out-up-c");
    expect(full.models).toEqual(["up-a", "up-b", "up-c"]);
  });

  it("a router stage picks the next stage without calling a model", async () => {
    const def = {
      kind: "micro_agent", timeoutMs: 1000,
      stages: [{ name: "r", input: [], transitions: [{ when: { type: "input_has_image" }, goto: "vision" }] }, stage("text"), stage("vision")],
    };
    const image = echoTransport();
    const routed = await agentOn(def, image.transport).invoke(request("what is this?", true));
    expect(textOf(routed)).toBe("out-up-vision");
    expect(image.models).toEqual(["up-vision"]);
    expect((routed.attemptPath as unknown[])[0]).toMatchObject({ stage: "r", kind: "router", service: "(router)", status: 200 });

    const plain = echoTransport();
    expect(textOf(await agentOn(def, plain.transport).invoke(request("hello")))).toBe("out-up-vision");
    expect(plain.models).toEqual(["up-text", "up-vision"]);
  });

  it("fails when no stage produced model output", async () => {
    const { transport, models } = echoTransport();
    const inv = await agentOn({ kind: "micro_agent", timeoutMs: 1000, stages: [{ name: "r", input: [] }] }, transport).invoke(request("hello"));
    expect(inv.result).toMatchObject({ ok: false, status: 0, kind: "error", message: "agent produced no model output" });
    expect(models).toEqual([]);
  });

  it("returns the stage named by `output` while reporting every stage's usage", async () => {
    const { transport, models } = echoTransport();
    const inv = await agentOn({ kind: "micro_agent", timeoutMs: 1000, output: "a", stages: [stage("a"), stage("b")] }, transport).invoke(request("hello"));
    expect(textOf(inv)).toBe("out-up-a");
    expect(models).toEqual(["up-a", "up-b"]);
    if (inv.result.ok) expect(inv.result.value.response.usage.totalTokens).toBe(10);
  });

  describe("nested agents", () => {
    const outer = { kind: "micro_agent", timeoutMs: 1000, stages: [{ name: "s", service: "A", input: [] }] };
    /** Resolves "A" to a one-stage agent that calls the model once. */
    function nesting(): { agent: MicroAgent; models: string[] } {
      const { transport, models } = echoTransport();
      const inner = agentOn({ kind: "micro_agent", timeoutMs: 1000, stages: [stage("inner")] }, transport);
      const resolver: ServiceResolver = { ...unresolved, resolve: () => ({ ok: true, executor: inner, isAgent: true }) };
      return { agent: agentOn(outer, transport, resolver), models };
    }
    const names = (n: number) => Array.from({ length: n }, (_, i) => `agent-${i}`);

    it("refuses to re-enter an agent that is already running", async () => {
      const { agent, models } = nesting();
      const inv = await agent.invoke(request("hello"), undefined, { stack: ["A"] });
      expect(inv.result).toMatchObject({ ok: false, status: 0, kind: "error", message: 'micro-agent cycle detected: "A" is already running' });
      expect(models).toEqual([]);
    });

    it("runs a nested agent with seven agents already on the stack", async () => {
      const { agent, models } = nesting();
      const inv = await agent.invoke(request("hello"), undefined, { stack: names(7) });
      expect(textOf(inv)).toBe("out-up-inner");
      expect(models).toEqual(["up-inner"]);
      expect((inv.attemptPath as unknown[])[0]).toMatchObject({ stage: "s", service: "A", kind: "agent", status: 200 });
    });

    it("refuses to nest past eight agents", async () => {
      const { agent, models } = nesting();
      const inv = await agent.invoke(request("hello"), undefined, { stack: names(8) });
      expect(inv.result).toMatchObject({ ok: false, status: 0, kind: "error", message: "micro-agent nesting too deep (>8)" });
      expect(models).toEqual([]);
    });
  });
});

// --- Prompt-cache lifetime default ------------------------------------------

describe("prompt-cache lifetime default", () => {
  // The Anthropic wire states the lifetime only as "the 5-minute default" (no
  // ttl field) or "1h", so that is the resolution these cases can observe.
  const anthropicCatalog = (): Catalog =>
    ({
      resolve: (model: string, provider: string) => ({
        ok: true,
        target: { family: "anthropic", upstreamModel: `up-${model}`, url: "http://upstream", headers: {}, modelName: model, providerName: provider, upstream: {} },
      }),
      exists: () => true,
    }) as unknown as Catalog;
  const ANTHROPIC_JSON = {
    id: "msg", type: "message", role: "assistant", model: "up", content: [{ type: "text", text: "hello" }],
    stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 },
  };
  type Setting = number | (() => number) | undefined;
  /** The cache_control the upstream received on the last block, or undefined. */
  async function sentCacheControl(setting: Setting, opts: { hint?: boolean; ttl?: number } = {}): Promise<unknown> {
    let sent: Record<string, unknown> = {};
    const svc = new ModelService(steps([{ model: "m", provider: "p" }]), {
      catalog: anthropicCatalog(), transport: fakeTransport({ json: ANTHROPIC_JSON, onBody: (b) => (sent = b) }), promptCacheTtlMinutes: setting,
    });
    const req = OpenAICompletionRequest.parse({ model: "svc", ...(opts.hint === false ? {} : { prompt_cache_key: "session" }), messages: [{ role: "user", content: "q" }] });
    if (opts.ttl != null) req.params.cacheTtlMinutes = opts.ttl;
    const inv = await svc.invoke(req);
    expect(inv.result.ok).toBe(true);
    expect(JSON.stringify(sent)).toContain('"q"');
    const messages = sent.messages as Array<{ content: Array<Record<string, unknown>> }>;
    return messages.at(-1)?.content.at(-1)?.cache_control;
  }

  it("uses the configured lifetime, as a value or a live getter", async () => {
    expect(await sentCacheControl(() => 45)).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(await sentCacheControl(45)).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(await sentCacheControl(() => 3)).toEqual({ type: "ephemeral" });
    expect(await sentCacheControl(3)).toEqual({ type: "ephemeral" });
  });

  it("defaults to 30 minutes when nothing is configured", async () => {
    expect(await sentCacheControl(undefined)).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("leaves a lifetime the request already carries alone", async () => {
    expect(await sentCacheControl(() => 45, { ttl: 5 })).toEqual({ type: "ephemeral" });
    expect(await sentCacheControl(() => 3, { ttl: 60 })).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("adds no cache breakpoint when the client gave no caching hint", async () => {
    expect(await sentCacheControl(() => 45, { hint: false })).toBeUndefined();
  });
});
