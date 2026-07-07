import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { OpenAICompletionRequest } from "../src/core/format";
import { ModelService } from "../src/execution/modelService";
import { MicroAgent, type ServiceResolver } from "../src/execution/microAgent";
import { parseService, type AgentDef, type ServiceSteps } from "../src/execution/definition";
import type { GenerationParams } from "../src/core/ir/params";
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

const readableOf = (f: string[]): Readable =>
  Readable.from(
    (async function* () {
      for (const chunk of f) yield chunk;
    })(),
  );

interface FakeOpts {
  status?: number;
  frames?: string[];
  onBody?: (body: Record<string, unknown>) => void;
}

function fakeTransport(opts: FakeOpts = {}): Transport {
  return {
    async postStream(_url, _headers, body) {
      opts.onBody?.(body as Record<string, unknown>);
      return { status: opts.status ?? 200, headers: {}, body: readableOf(opts.frames ?? OK_FRAMES) };
    },
    async postJson() {
      return { status: 200, headers: {}, json: {}, text: "" };
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
  it("buffers the upstream stream into a complete response", async () => {
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
    const svc = new ModelService(steps([{ model: "m", provider: "p" }]), { catalog: fakeCatalog(), transport: fakeTransport({ frames: TRUNCATED }) });
    const inv = await svc.invoke(baseReq());
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
