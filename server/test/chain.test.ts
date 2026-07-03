import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IRContentPart, IRRequest } from "../src/core/ir";
import { textOf } from "../src/core/ir";
import type { ChainCondition, ChainDef, ChainStage, ChainTransition } from "../src/core/mub/schema";

// Mock the per-stage runner. The fake echoes `${model}(${lastUserText})`, unless
// the model name is "OUT:<text>" (returns <text> verbatim, to drive output-based
// routing) or "BOOM" (fails).
vi.mock("../src/core/proxy/run", () => {
  const lastUserText = (ir: IRRequest): string => {
    for (let i = ir.messages.length - 1; i >= 0; i--) {
      const m = ir.messages[i];
      if (m.role === "user") {
        return m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
      }
    }
    return "";
  };
  return {
    runMubJson: vi.fn(
      async (ir: IRRequest, steps: { timeoutMs: number; steps: { model: string; provider: string }[] }) => {
        const { model, provider } = steps.steps[0];
        const rec = { step: 1, attempt: 1, model, provider, status: model === "BOOM" ? 500 : 200, kind: model === "BOOM" ? "http" : "ok", latencyMs: 1 };
        if (model === "BOOM") return { result: { ok: false, status: 500, kind: "http", message: "boom" }, path: [rec] };
        const out = model.startsWith("OUT:") ? model.slice(4) : `${model}(${lastUserText(ir)})`;
        const value = {
          ir: { id: "x", model, created: 0, content: [{ type: "text", text: out }], stopReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
          family: "openai", upstreamModel: model, providerName: provider, modelName: model,
        };
        return { result: { ok: true, value }, path: [rec] };
      },
    ),
  };
});

import { runMubJson } from "../src/core/proxy/run";
import { buildStageIR, runMubChain, type StageResolver } from "../src/core/mub/chain";

const runJsonMock = vi.mocked(runMubJson);
const noResolver: StageResolver = () => ({ ok: false, message: "no resolver" });

// --- builders ---
const t = (when: ChainCondition, goto: string): ChainTransition => ({ when, goto });
const always: ChainCondition = { type: "always" };
function stage(name: string, model: string, extra: Partial<ChainStage> = {}): ChainStage {
  return { name, steps: [{ model, provider: "p" }], input: [], ...extra };
}
function router(name: string, transitions: ChainTransition[]): ChainStage {
  return { name, input: [], transitions };
}
function chainOf(stages: ChainStage[], output?: string): ChainDef {
  return { kind: "chain", timeoutMs: 60_000, stages, ...(output ? { output } : {}) };
}

const withImage: IRRequest = {
  requestedModel: "m",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image", source: { kind: "url", url: "http://img" } }] }],
  stream: false,
};
const textOnly: IRRequest = {
  requestedModel: "m",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: false,
};

describe("buildStageIR (structured content builder)", () => {
  it("routes original images into a stage and drops them elsewhere", () => {
    const ocr = buildStageIR(withImage, stage("ocr", "K", { input: [{ role: "user", parts: [{ source: "literal", text: "OCR:" }, { source: "original_images" }] }] }), {}, false);
    expect(ocr.messages[0].content.some((p: IRContentPart) => p.type === "image")).toBe(true);
    const main = buildStageIR(withImage, stage("main", "G", { input: [{ role: "user", parts: [{ source: "original_text" }, { source: "stage", name: "ocr" }] }] }), { ocr: "HELLO" }, false);
    expect(textOf(main.messages[0].content)).toBe("hiHELLO");
    expect(main.messages[0].content.some((p: IRContentPart) => p.type === "image")).toBe(false);
  });
});

describe("runMubChain (decision tree)", () => {
  beforeEach(() => {
    runJsonMock.mockClear();
  });

  it("runs linearly, feeds outputs forward, sums usage, labels the path", async () => {
    const chain = chainOf([stage("draft", "D"), stage("final", "F", { input: [{ role: "user", parts: [{ source: "stage", name: "draft" }] }] })]);
    const { result, usage, path } = await runMubChain(textOnly, chain, noResolver);
    expect(result.ok).toBe(true);
    if (result.ok) expect(textOf(result.value.ir.content)).toBe("F(D(hi))");
    expect(usage.totalTokens).toBe(4);
    expect(path.map((p) => p.stage)).toEqual(["draft", "final"]);
  });

  it("branches on input_has_image via a router (no model call for the router)", async () => {
    const chain = chainOf([
      router("route", [t({ type: "input_has_image" }, "ocr"), t(always, "text")]),
      stage("ocr", "OCR", { transitions: [t(always, "end")] }),
      stage("text", "TXT"),
    ]);
    const img = await runMubChain(withImage, chain, noResolver);
    expect(img.path.map((p) => p.stage)).toEqual(["route", "ocr"]);
    if (img.result.ok) expect(textOf(img.result.value.ir.content)).toBe("OCR(hi)");

    const txt = await runMubChain(textOnly, chain, noResolver);
    expect(txt.path.map((p) => p.stage)).toEqual(["route", "text"]);
    if (txt.result.ok) expect(textOf(txt.result.value.ir.content)).toBe("TXT(hi)");
  });

  it("branches on a stage's output text (decision: pass/fail)", async () => {
    const build = (decision: string) =>
      chainOf([
        stage("decide", `OUT:{decision: ${decision}}`, { transitions: [t({ type: "output_contains", value: "{decision: pass}" }, "pass")] }),
        stage("fail", "FAILC", { transitions: [t(always, "end")] }),
        stage("pass", "PASSC"),
      ]);
    const p = await runMubChain(textOnly, build("pass"), noResolver);
    expect(p.path.map((x) => x.stage)).toEqual(["decide", "pass"]);
    const f = await runMubChain(textOnly, build("fail"), noResolver);
    expect(f.path.map((x) => x.stage)).toEqual(["decide", "fail"]);
  });

  it("resolves a stage's referenced resilience MUB via the resolver", async () => {
    const resolver: StageResolver = (name) =>
      name === "resmub" ? { ok: true, steps: { timeoutMs: 60_000, steps: [{ model: "R", provider: "p" }] } } : { ok: false, message: "unknown" };
    const chain = chainOf([{ name: "s", mub: "resmub", input: [] }]);
    const { result } = await runMubChain(textOnly, chain, resolver);
    expect(result.ok).toBe(true);
    if (result.ok) expect(textOf(result.value.ir.content)).toBe("R(hi)");
  });

  it("fails the chain when a referenced MUB can't be resolved", async () => {
    const chain = chainOf([{ name: "s", mub: "missing", input: [] }]);
    const { result } = await runMubChain(textOnly, chain, () => ({ ok: false, message: "unknown MUB" }));
    expect(result.ok).toBe(false);
    expect(runJsonMock).not.toHaveBeenCalled();
  });

  it("aborts on a mid-chain stage failure", async () => {
    const chain = chainOf([stage("a", "BOOM"), stage("b", "D")]);
    const { result } = await runMubChain(textOnly, chain, noResolver);
    expect(result.ok).toBe(false);
    expect(runJsonMock).toHaveBeenCalledTimes(1);
  });
});
