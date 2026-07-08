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
    const svc = new ModelService(steps([{ model: "m", provider: "p", retry: { on: [500], maxAttempts: 2, intervalMs: 0 } }]), {
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
  const noResolver: ServiceResolver = { resolve: () => ({ ok: false, message: "not used" }) };
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
  const noResolver: ServiceResolver = { resolve: () => ({ ok: false, message: "not used" }) };
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

  it("MicroAgent internal calls disable upstream streaming (stream not in body)", async () => {
    const sentBodies: Record<string, unknown>[] = [];
    const transport = fakeTransport({ onBody: (b) => sentBodies.push(b as Record<string, unknown>) });
    const def = agentDef({
      kind: "micro_agent",
      timeoutMs: 1000,
      stages: [{ name: "a", input: [], steps: [{ model: "m", provider: "p" }] }],
    });
    const agent = new MicroAgent(def, deps(transport));
    // Even a streaming client request should have stream=false upstream for internal calls.
    const req = new OpenAICompletionRequest({ requestedService: "svc", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], params: {}, stream: true });
    await agent.invoke(req);
    expect(sentBodies.length).toBeGreaterThanOrEqual(1);
    for (const b of sentBodies) {
      expect(b.stream).toBeUndefined();
      expect(b.stream_options).toBeUndefined();
    }
  });

  it("MicroAgent.stream() buffers then replays; upstream call has stream disabled", async () => {
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
    for (const b of sentBodies) {
      expect(b.stream).toBeUndefined();
    }
    // The fabricated stream should produce the complete text.
    if (outcome.result.ok) {
      const acc = newAccumulator();
      for await (const _ev of tapStream(outcome.result.value.events, acc)) { void _ev; }
      expect(acc.text).toBe("hello");
    }
  });

  it("ModelService reliableStreaming buffers upstream (stream=true) then fabricates a stream for the client", async () => {
    let sent: Record<string, unknown> = {};
    const transport = fakeTransport({ onBody: (b) => (sent = b) });
    const svc = new ModelService({ timeoutMs: 1000, steps: [{ model: "m", provider: "p" }], reliableStreaming: true }, { catalog: fakeCatalog(), transport });
    const req = new OpenAICompletionRequest({ requestedService: "svc", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], params: {}, stream: true });
    const outcome = await svc.stream(req);
    expect(outcome.result.ok).toBe(true);
    // Reliable streaming on ModelService still streams upstream (for truncation detection).
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

  it("MicroAgent with reliableStreaming=true sends non-streaming upstream for all stages", async () => {
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
    const resolver: ServiceResolver = { resolve: () => ({ ok: false, message: "not used" }) };
    const agent = new MicroAgent(def, { catalog: fakeCatalog(), transport, resolver, logMaxChars: 2000 });
    const req = new OpenAICompletionRequest({ requestedService: "svc", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], params: {}, stream: true });
    await agent.stream(req);
    // All internal calls should be non-streaming (postJson).
    expect(jsonCallCount).toBe(2);
    expect(streamCallCount).toBe(0);
    // No sent body should contain stream=true.
    for (const b of sentBodies) {
      expect(b.stream).toBeUndefined();
    }
  });
});
