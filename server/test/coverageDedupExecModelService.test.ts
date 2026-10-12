import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { OpenAICompletionRequest } from "../src/core/format";
import { ModelService } from "../src/execution/modelService";
import type { ServiceSteps } from "../src/execution/definition";
import type { Transport } from "../src/core/upstream/transport";
import type { Catalog } from "../src/catalog/catalog";
import type { ProgressRecorder } from "../src/observability/progressRecorder";

// Characterization of the progress feed and value shape of the two attempt
// bodies (buffered invoke / relayed stream), which share their setup.

const FRAMES = [
  'data: {"id":"c","model":"up","choices":[{"delta":{"role":"assistant"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
  "data: [DONE]\n\n",
];
const JSON_BODY = {
  id: "c",
  model: "up",
  choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

function transport(status = 200): Transport {
  return {
    async postStream() {
      return { status, headers: {}, body: Readable.from(status >= 400 ? ['{"error":"nope"}'] : FRAMES) };
    },
    async postJson() {
      if (status >= 400) return { status, headers: {}, json: { error: "nope" }, text: "" };
      return { status: 200, headers: {}, json: JSON_BODY, text: "" };
    },
  };
}

const catalog = (ok = true): Catalog =>
  ({
    resolve: (model: string, provider: string) =>
      ok
        ? {
            ok: true,
            target: { family: "openai_completion", upstreamModel: `up-${model}`, url: "http://upstream", headers: {}, modelName: model, providerName: provider, upstream: {} },
          }
        : { ok: false, error: "mapping_not_found" },
    exists: () => true,
  }) as unknown as Catalog;

const req = () =>
  new OpenAICompletionRequest({ requestedService: "svc", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], params: {}, stream: false });

const def: ServiceSteps = { timeoutMs: 1000, steps: [{ model: "m", provider: "p", retry: { maxAttempts: 1 } }] } as ServiceSteps;

type Row = [string, string, string, Record<string, unknown> | undefined];
function recorder(): { rows: Row[]; prog: ProgressRecorder } {
  const rows: Row[] = [];
  const prog = { record: (phase: string, node: string, message: string, detail?: Record<string, unknown>) => void rows.push([phase, node, message, detail]) } as unknown as ProgressRecorder;
  return { rows, prog };
}
const own = (rows: Row[]) => rows.filter(([, node]) => node.startsWith("step.") || node.startsWith("llm."));

describe("ModelService attempt progress and value shape", () => {
  it("invoke: records the buffered wording and returns the identity fields in order", async () => {
    const { rows, prog } = recorder();
    const inv = await new ModelService(def, { catalog: catalog(), transport: transport() }).invoke(req(), undefined, { progress: prog });
    expect(own(rows)).toEqual([
      ["llm", "step.start", "step 1: m@p attempt starting", undefined],
      ["llm", "llm.serialize", "parameters serialized for openai_completion -> up-m", { family: "openai_completion", model: "up-m" }],
      ["llm", "llm.send", "request initiated to up-m (p)", { model: "up-m", provider: "p", url: "http://upstream" }],
      ["llm", "llm.receive", "response generated and received from up-m", { status: 200 }],
      ["llm", "llm.result", "result parsed and ready for return", { model: "up-m" }],
    ]);
    expect(inv.result.ok).toBe(true);
    if (inv.result.ok) expect(Object.keys(inv.result.value)).toEqual(["response", "family", "upstreamModel", "providerName", "modelName", "upstreamRequest"]);
    expect(inv.attempts).toBe(1);
  });

  it("stream: records the streaming wording and returns the identity fields in order", async () => {
    const { rows, prog } = recorder();
    const inv = await new ModelService(def, { catalog: catalog(), transport: transport() }).stream(req(), undefined, { progress: prog });
    expect(own(rows)).toEqual([
      ["llm", "step.start", "stream step 1: m@p attempt starting", undefined],
      ["llm", "llm.serialize", "parameters serialized for openai_completion -> up-m (streaming)", { family: "openai_completion", model: "up-m" }],
      ["llm", "llm.send", "stream request initiated to up-m (p)", { model: "up-m", provider: "p", url: "http://upstream" }],
      ["llm", "llm.receive", "stream committed from up-m (headers received)", { status: 200 }],
      ["llm", "llm.result", "stream events ready for relay", { model: "up-m" }],
    ]);
    expect(inv.result.ok).toBe(true);
    if (inv.result.ok) {
      expect(Object.keys(inv.result.value)).toEqual(["events", "family", "upstreamModel", "providerName", "modelName", "upstreamRequest", "dropReasoning"]);
      expect(inv.result.value.dropReasoning).toBe(false);
      const events = inv.result.value.events;
      if ("destroy" in events && typeof events.destroy === "function") events.destroy();
    }
  });

  it("reliable streaming: the fabricated value keeps the same key order", async () => {
    const svc = new ModelService({ ...def, reliableStreaming: true } as ServiceSteps, { catalog: catalog(), transport: transport() });
    const inv = await svc.stream(req());
    expect(inv.result.ok).toBe(true);
    if (inv.result.ok) {
      expect(Object.keys(inv.result.value)).toEqual(["events", "family", "upstreamModel", "providerName", "modelName", "upstreamRequest", "dropReasoning"]);
      expect(inv.result.value).toMatchObject({ family: "openai_completion", upstreamModel: "up-m", providerName: "p", modelName: "m", dropReasoning: false });
    }
  });

  for (const mode of ["invoke", "stream"] as const) {
    it(`${mode}: an unresolved mapping is a status-0 error recorded once`, async () => {
      const { rows, prog } = recorder();
      const inv = await new ModelService(def, { catalog: catalog(false), transport: transport() })[mode](req(), undefined, { progress: prog });
      expect(inv.result).toEqual({ ok: false, status: 0, kind: "error", message: "mapping m@p: mapping_not_found" });
      expect(own(rows)).toEqual([
        ["llm", "step.start", `${mode === "stream" ? "stream step" : "step"} 1: m@p attempt starting`, undefined],
        ["error", "step.resolve", "mapping m@p: mapping_not_found", undefined],
      ]);
    });

    it(`${mode}: an upstream error is recorded with its status`, async () => {
      const { rows, prog } = recorder();
      const inv = await new ModelService(def, { catalog: catalog(), transport: transport(500) })[mode](req(), undefined, { progress: prog });
      expect(inv.result.ok).toBe(false);
      if (!inv.result.ok) {
        expect(inv.result.status).toBe(500);
        expect(inv.result.kind).toBe("http");
        const receive = own(rows).filter(([, node]) => node === "llm.receive");
        expect(receive).toEqual([["llm", "llm.receive", `upstream returned 500: ${inv.result.message}`, { status: 500 }]]);
      }
    });
  }
});
