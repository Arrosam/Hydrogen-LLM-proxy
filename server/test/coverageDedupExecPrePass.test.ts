import { describe, expect, it } from "vitest";
import { OpenAICompletionRequest } from "../src/core/format/completion";
import { MicroAgent, type ServiceResolver } from "../src/execution/microAgent";
import { ModelService } from "../src/execution/modelService";
import { parseService, type AgentDef } from "../src/execution/definition";
import type { OcrCacheStore } from "../src/execution/ocrCache";
import type { ServiceCall } from "../src/execution/serviceCall";
import type { Catalog } from "../src/catalog/catalog";
import type { Transport, TransportJsonResult } from "../src/core/upstream/transport";
import type { ProgressRecorder } from "../src/observability/progressRecorder";

// Characterization of the OCR and ASR pre-passes of a Micro Agent: the order
// of cache calls, what is stored, the progress rows, the recorded calls, and
// the places where the two passes deliberately differ.

const png = (seed: string) => `data:image/png;base64,${Buffer.from(seed).toString("base64")}`;
const wav = (seed: string) => Buffer.from(seed).toString("base64");

function request(images: string[], audios: string[]) {
  return OpenAICompletionRequest.parse({
    model: "svc",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "look and listen" },
        ...images.map((s) => ({ type: "image_url", image_url: { url: png(s) } })),
        ...audios.map((s) => ({ type: "input_audio", input_audio: { data: wav(s), format: "wav" } })),
      ],
    }],
  });
}

const target = (model: string, provider: string) => ({
  family: "openai_completion", upstreamModel: `up-${model}`, url: "http://upstream", headers: {}, modelName: model, providerName: provider, endpointIndex: 0,
  upstream: { type: "openai_completion", baseUrl: "http://u.test/v1", apiKey: "k", extraHeaders: null },
});
const catalog = {
  resolve: (model: string, provider: string) => ({ ok: true, target: target(model, provider) }),
  resolveWithin: (model: string, provider: string) => ({ ok: true, target: target(model, provider) }),
  exists: () => true,
} as unknown as Catalog;

interface Upstream {
  ocrStatus?: number;
  asrStatus?: number;
  /** Text the OCR model answers with, per call. */
  ocrText?: (imageCount: number) => string;
  asrText?: string;
}
function harness(up: Upstream = {}) {
  const bodies: Array<Record<string, unknown>> = [];
  let asrCalls = 0;
  const completion = (content: string) => ({
    id: "c", model: "up", choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const transport: Transport = {
    postStream: async () => { throw new Error("unused"); },
    postJson: async (_url, _headers, raw) => {
      const body = raw as Record<string, unknown>;
      bodies.push(body);
      if (body.model === "up-ocr") {
        if (up.ocrStatus) return { status: up.ocrStatus, headers: {}, json: { error: { message: "ocr down" } }, text: "" };
        const n = JSON.stringify(body).split('"image_url":').length - 1;
        const text = up.ocrText ? up.ocrText(n) : JSON.stringify(Array.from({ length: n }, (_, i) => ({ index: i + 1, image: `desc${i + 1}` })));
        return { status: 200, headers: {}, json: completion(text), text: "" };
      }
      return { status: 200, headers: {}, json: completion("final"), text: "" };
    },
    postRaw: async (): Promise<TransportJsonResult> => {
      asrCalls++;
      if (up.asrStatus) return { status: up.asrStatus, headers: {}, json: { error: { message: "asr down" } }, text: "" };
      return { status: 200, headers: {}, json: { text: up.asrText ?? `heard${asrCalls}` }, text: "" };
    },
  };
  return { transport, bodies, asrCount: () => asrCalls };
}

type CacheLog = Array<[string, unknown]>;
function stubCache(known: (hash: string) => string | undefined = () => undefined, withAcquire = true): { cache: OcrCacheStore; log: CacheLog } {
  const log: CacheLog = [];
  const cache: OcrCacheStore = {
    enabled: () => true,
    lookup: (hashes) => {
      log.push(["lookup", hashes.length]);
      const out = new Map<string, string>();
      for (const h of hashes) { const v = known(h); if (v !== undefined) out.set(h, v); }
      return out;
    },
    touch: (hashes) => void log.push(["touch", hashes.length]),
    store: (entries) => void log.push(["store", entries.map((e) => e.description)]),
  };
  if (withAcquire) {
    cache.acquire = async (hashes) => {
      log.push(["acquire", hashes.length]);
      return () => void log.push(["release", null]);
    };
  }
  return { cache, log };
}

type Row = [string, string, string, Record<string, unknown> | undefined];
function recorder() {
  const rows: Row[] = [];
  const prog = { record: (phase: string, node: string, message: string, detail?: Record<string, unknown>) => void rows.push([phase, node, message, detail]) } as unknown as ProgressRecorder;
  return { rows, prog, pre: () => rows.filter(([, node]) => node.startsWith("agent.ocr") || node.startsWith("agent.asr")) };
}

const STEP = { retry: { maxAttempts: 1 } };
const agentDef = (extra: Record<string, unknown>): AgentDef => {
  const base = parseService({ kind: "micro_agent", timeoutMs: 1000, stages: [{ name: "main", steps: [{ model: "m", provider: "p", ...STEP }] }] }) as AgentDef;
  // `extra` is applied raw so a pre-pass block with no model can be expressed.
  return { ...base, ...extra } as unknown as AgentDef;
};
const OCR = { ocr: { steps: [{ model: "ocr", provider: "p", ...STEP }] } };
const ASR = { asr: { steps: [{ model: "stt", provider: "p", ...STEP }] } };

const resolver = (over: Partial<ServiceResolver> = {}): ServiceResolver => ({
  sttDef: (name) => ({ ok: false, message: `no stt ${name}` }),
  resolve: (name) => ({ ok: false, message: `no service ${name}` }),
  ...over,
});

function agent(def: AgentDef, h: ReturnType<typeof harness>, cache: OcrCacheStore | null, res: ServiceResolver = resolver()) {
  return new MicroAgent(def, { catalog, transport: h.transport, resolver: res, logMaxChars: 10_000, ocrCache: cache });
}
const summary = (path: unknown) => (path as ServiceCall[]).map((c) => [c.stage, c.service, c.kind, c.status, c.error]);
const lastBody = (h: ReturnType<typeof harness>) => JSON.stringify(h.bodies[h.bodies.length - 1]);

describe("Micro Agent OCR pre-pass", () => {
  it("cold cache: locks, looks up, transcribes each distinct image once, stores, and never touches", async () => {
    const h = harness();
    const { cache, log } = stubCache();
    const r = recorder();
    const inv = await agent(agentDef(OCR), h, cache).invoke(request(["a", "b", "a"], []), undefined, { progress: r.prog });
    expect(inv.result.ok ? "" : inv.result.message).toBe("");
    expect(log).toEqual([["acquire", 3], ["lookup", 3], ["store", ["desc1", "desc2"]], ["release", null]]);
    expect(r.pre()).toEqual([
      ["agent", "agent.ocr.start", "OCR pre-pass: 3 image(s) detected, 1 from cache, 2 to transcribe", { images: 3, cached: 1, pending: 2 }],
      ["agent", "agent.ocr.done", "OCR pre-pass complete, images translated to text", undefined],
    ]);
    expect(summary(inv.attemptPath)).toEqual([["(ocr)", "(inline)", "service", 200, undefined], ["main", "(inline)", "service", 200, undefined]]);
    const body = lastBody(h);
    expect(body).toContain("[Image 1]\\ndesc1\\n");
    expect(body).toContain("[Image 2]\\ndesc2\\n");
    expect(body).toContain("[Image 3]\\ndesc1\\n");
    // OCR usage (2 tokens) is added to the stage's (2 tokens).
    if (inv.result.ok) expect(inv.result.value.response.usage.totalTokens).toBe(4);
  });

  it("warm cache: no model call, NO store call, hits are touched, cached wording", async () => {
    const h = harness();
    const { cache, log } = stubCache(() => "cached text");
    const r = recorder();
    const inv = await agent(agentDef(OCR), h, cache).invoke(request(["a", "b"], []), undefined, { progress: r.prog });
    expect(inv.result.ok ? "" : inv.result.message).toBe("");
    expect(log).toEqual([["acquire", 2], ["lookup", 2], ["touch", 2], ["release", null]]);
    expect(r.pre()).toEqual([
      ["agent", "agent.ocr.start", "OCR pre-pass: 2 image(s) detected, 2 from cache, 0 to transcribe", { images: 2, cached: 2, pending: 0 }],
      ["agent", "agent.ocr.done", "OCR pre-pass complete, every image served from the cache", undefined],
    ]);
    expect(h.bodies).toHaveLength(1);
    expect(lastBody(h)).toContain("[Image 2]\\ncached text\\n");
  });

  it("a blank description is used verbatim but not stored (store is still called)", async () => {
    const h = harness({ ocrText: () => JSON.stringify([{ index: 1, image: "  " }]) });
    const { cache, log } = stubCache();
    const inv = await agent(agentDef(OCR), h, cache).invoke(request(["a"], []));
    expect(inv.result.ok ? "" : inv.result.message).toBe("");
    expect(log).toEqual([["acquire", 1], ["lookup", 1], ["store", []], ["release", null]]);
    expect(lastBody(h)).toContain("[Image 1]\\n  \\n");
  });

  it("a failed OCR call fails the run, releases the lock, and neither stores nor touches", async () => {
    const h = harness({ ocrStatus: 500 });
    const known = new Set<string>();
    let first = true;
    const { cache, log } = stubCache((hash) => { if (first) { known.add(hash); first = false; } return known.has(hash) ? "hit" : undefined; });
    const r = recorder();
    const inv = await agent(agentDef(OCR), h, cache).invoke(request(["a", "b"], []), undefined, { progress: r.prog });
    expect(inv.result.ok).toBe(false);
    if (!inv.result.ok) expect(inv.result.status).toBe(500);
    expect(log).toEqual([["acquire", 2], ["lookup", 2], ["release", null]]);
    const pre = r.pre();
    expect(pre[1][0]).toBe("error");
    expect(pre[1][1]).toBe("agent.ocr.fail");
    expect(pre[1][2]).toBe(`OCR pre-pass failed: ${inv.result.ok ? "" : inv.result.message}`);
    expect(summary(inv.attemptPath).map((c) => c.slice(0, 4))).toEqual([["(ocr)", "(inline)", "service", 500]]);
  });

  it("works without a cache and with a cache that has no acquire", async () => {
    const h = harness();
    expect((await agent(agentDef(OCR), h, null).invoke(request(["a"], []))).result.ok).toBe(true);
    const { cache, log } = stubCache(undefined, false);
    expect((await agent(agentDef(OCR), harness(), cache).invoke(request(["a"], []))).result.ok).toBe(true);
    expect(log).toEqual([["lookup", 1], ["store", ["desc1"]]]);
  });

  it("reference errors surface before the cache is consulted", async () => {
    const { cache, log } = stubCache();
    const none = await agent(agentDef({ ocr: {} }), harness(), cache).invoke(request(["a"], []));
    expect(none.result).toMatchObject({ ok: false, status: 0, kind: "error", message: "image translation (OCR) is enabled but has no model configured" });
    const missing = await agent(agentDef({ ocr: { service: "gone" } }), harness(), cache).invoke(request(["a"], []));
    expect(missing.result).toMatchObject({ ok: false, message: "no service gone" });
    const nested = resolver({ resolve: () => ({ ok: true, isAgent: true, executor: {} as ModelService }) });
    const isAgent = await agent(agentDef({ ocr: { service: "sub" } }), harness(), cache, nested).invoke(request(["a"], []));
    expect(isAgent.result).toMatchObject({ ok: false, message: 'OCR reference "sub" must be a Model Service, not a Micro Agent' });
    expect(log).toEqual([]);
  });

  it("a referenced OCR service is called and named on the recorded call", async () => {
    const h = harness();
    const svc = new ModelService({ timeoutMs: 1000, steps: [{ model: "ocr", provider: "p", ...STEP }] } as never, { catalog, transport: h.transport });
    const res = resolver({ resolve: () => ({ ok: true, isAgent: false, executor: svc }) });
    const inv = await agent(agentDef({ ocr: { service: "reader" } }), h, null, res).invoke(request(["a"], []));
    expect(summary(inv.attemptPath)[0]).toEqual(["(ocr)", "reader", "service", 200, undefined]);
  });
});

describe("Micro Agent ASR pre-pass", () => {
  it("cold cache: locks, transcribes each distinct audio once, stores", async () => {
    const h = harness();
    const { cache, log } = stubCache();
    const r = recorder();
    const inv = await agent(agentDef(ASR), h, cache).invoke(request([], ["x", "y", "x"]), undefined, { progress: r.prog });
    expect(inv.result.ok ? "" : inv.result.message).toBe("");
    expect(log).toEqual([["acquire", 3], ["lookup", 3], ["store", ["heard1", "heard2"]], ["release", null]]);
    expect(h.asrCount()).toBe(2);
    expect(r.pre()).toEqual([
      ["agent", "agent.asr.start", "ASR pre-pass: 3 audio attachment(s), 1 from cache, 2 to transcribe", { audios: 3, cached: 1, pending: 2 }],
      ["agent", "agent.asr.done", "ASR pre-pass complete, audio transcribed to text", undefined],
    ]);
    const calls = inv.attemptPath as ServiceCall[];
    expect(summary(calls)).toEqual([
      ["(asr)", "(inline)", "service", 200, undefined],
      ["(asr)", "(inline)", "service", 200, undefined],
      ["main", "(inline)", "service", 200, undefined],
    ]);
    expect(Object.keys(calls[0])).toEqual(["stage", "service", "kind", "status", "latencyMs", "attempts", "error"]);
    expect(calls[0].attempts).toHaveLength(1);
    const body = lastBody(h);
    expect(body).toContain("[Audio 1 transcript]\\nheard1\\n");
    expect(body).toContain("[Audio 2 transcript]\\nheard2\\n");
    expect(body).toContain("[Audio 3 transcript]\\nheard1\\n");
    // Transcription reports no usage: only the stage's 2 tokens.
    if (inv.result.ok) expect(inv.result.value.response.usage.totalTokens).toBe(2);
  });

  it("warm cache: no upstream call, an EMPTY store call, hits are touched, cached wording", async () => {
    const h = harness();
    const { cache, log } = stubCache(() => "said");
    const r = recorder();
    const inv = await agent(agentDef(ASR), h, cache).invoke(request([], ["x", "y"]), undefined, { progress: r.prog });
    expect(inv.result.ok ? "" : inv.result.message).toBe("");
    expect(log).toEqual([["acquire", 2], ["lookup", 2], ["store", []], ["touch", 2], ["release", null]]);
    expect(h.asrCount()).toBe(0);
    expect(r.pre()).toEqual([
      ["agent", "agent.asr.start", "ASR pre-pass: 2 audio attachment(s), 2 from cache, 0 to transcribe", { audios: 2, cached: 2, pending: 0 }],
      ["agent", "agent.asr.done", "ASR pre-pass complete, every attachment served from the cache", undefined],
    ]);
    expect(lastBody(h)).toContain("[Audio 2 transcript]\\nsaid\\n");
  });

  it("an empty transcript is not stored", async () => {
    const h = harness({ asrText: "   " });
    const { cache, log } = stubCache();
    const inv = await agent(agentDef(ASR), h, cache).invoke(request([], ["x"]));
    expect(inv.result.ok ? "" : inv.result.message).toBe("");
    expect(log).toEqual([["acquire", 1], ["lookup", 1], ["store", []], ["release", null]]);
    expect(lastBody(h)).toContain("[Audio 1 transcript]\\n\\n");
  });

  it("a failed transcription fails the run and neither stores nor touches", async () => {
    const h = harness({ asrStatus: 503 });
    const { cache, log } = stubCache();
    const r = recorder();
    const inv = await agent(agentDef(ASR), h, cache).invoke(request([], ["x", "y"]), undefined, { progress: r.prog });
    expect(inv.result).toMatchObject({ ok: false, status: 503, message: "asr down" });
    expect(log).toEqual([["acquire", 2], ["lookup", 2], ["release", null]]);
    expect(r.pre()[1]).toEqual(["error", "agent.asr.fail", "ASR pre-pass failed: asr down", undefined]);
    expect(summary(inv.attemptPath)).toEqual([["(asr)", "(inline)", "service", 503, "asr down"]]);
  });

  it("reference handling: missing model, resolver failure, named service", async () => {
    const none = await agent(agentDef({ asr: {} }), harness(), null).invoke(request([], ["x"]));
    expect(none.result).toMatchObject({ ok: false, status: 0, kind: "error", message: "audio transcription (ASR) is enabled but has no model configured" });
    const missing = await agent(agentDef({ asr: { service: "gone" } }), harness(), null).invoke(request([], ["x"]));
    expect(missing.result).toMatchObject({ ok: false, message: "no stt gone" });
    const res = resolver({ sttDef: () => ({ ok: true, def: { timeoutMs: 1000, steps: [{ model: "stt", provider: "p", ...STEP }] } as never }) });
    const named = await agent(agentDef({ asr: { service: "whisper" } }), harness(), null, res).invoke(request([], ["x"]));
    expect(summary(named.attemptPath)[0]).toEqual(["(asr)", "whisper", "service", 200, undefined]);
  });

  it("runs after OCR on the OCR-translated request", async () => {
    const h = harness();
    const { cache, log } = stubCache();
    const inv = await agent(agentDef({ ...OCR, ...ASR }), h, cache).invoke(request(["a"], ["x"]));
    expect(inv.result.ok ? "" : inv.result.message).toBe("");
    expect(log).toEqual([["acquire", 1], ["lookup", 1], ["store", ["desc1"]], ["release", null], ["acquire", 1], ["lookup", 1], ["store", ["heard1"]], ["release", null]]);
    const body = lastBody(h);
    expect(body).toContain("[Image 1]\\ndesc1\\n");
    expect(body).toContain("[Audio 1 transcript]\\nheard1\\n");
  });
});
