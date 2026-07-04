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

describe("buildStageIR (context blocks)", () => {
  it("original_conversation keeps images; text_conversation strips them", () => {
    const full = buildStageIR(withImage, stage("s", "M", { input: [{ kind: "original_conversation" }] }), {}, false);
    expect(full.messages[0].content.some((p: IRContentPart) => p.type === "image")).toBe(true);
    const textConv = buildStageIR(withImage, stage("s", "M", { input: [{ kind: "text_conversation" }] }), {}, false);
    expect(textConv.messages.every((m) => m.content.every((p: IRContentPart) => p.type !== "image"))).toBe(true);
    expect(textOf(textConv.messages[0].content)).toBe("hi");
  });

  it("last_user picks the last user turn", () => {
    const multi: IRRequest = {
      requestedModel: "m",
      stream: false,
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        { role: "user", content: [{ type: "text", text: "second" }] },
      ],
    };
    const out = buildStageIR(multi, stage("s", "M", { input: [{ kind: "last_user" }] }), {}, false);
    expect(out.messages).toHaveLength(1);
    expect(textOf(out.messages[0].content)).toBe("second");
  });

  it("last_user_text and last_user_images split the last user turn", () => {
    const txt = buildStageIR(withImage, stage("s", "M", { input: [{ kind: "last_user_text" }] }), {}, false);
    expect(txt.messages).toHaveLength(1);
    expect(textOf(txt.messages[0].content)).toBe("hi");
    expect(txt.messages[0].content.some((p: IRContentPart) => p.type === "image")).toBe(false);

    const imgs = buildStageIR(withImage, stage("s", "M", { input: [{ kind: "last_user_images" }] }), {}, false);
    expect(imgs.messages).toHaveLength(1);
    expect(imgs.messages[0].content.every((p: IRContentPart) => p.type === "image")).toBe(true);
    expect(textOf(imgs.messages[0].content)).toBe("");
  });

  it("adjacent same-role message + stage_output merge into one turn", () => {
    const s = stage("s", "M", {
      input: [
        { kind: "message", role: "user", text: "Evaluate: " },
        { kind: "stage_output", stage: "draft", role: "user" },
      ],
    });
    const out = buildStageIR(textOnly, s, { draft: "DRAFT" }, false);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].role).toBe("user");
    expect(textOf(out.messages[0].content)).toBe("Evaluate: DRAFT");
  });

  it("tool_turn emits a linked assistant tool_use + user tool_result", () => {
    const s = stage("s", "M", { input: [{ kind: "tool_turn", name: "get_weather", input: '{"city":"SF"}', result: "72F" }] });
    const out = buildStageIR(textOnly, s, {}, false);
    expect(out.messages.map((m) => m.role)).toEqual(["assistant", "user"]);
    const tu = out.messages[0].content[0] as { type: string; id: string; name: string; input: unknown };
    expect(tu.type).toBe("tool_use");
    expect(tu.name).toBe("get_weather");
    expect(tu.input).toEqual({ city: "SF" });
    const tr = out.messages[1].content[0] as { type: string; toolUseId: string; content: IRContentPart[] };
    expect(tr.type).toBe("tool_result");
    expect(tr.toolUseId).toBe(tu.id);
    expect(textOf(tr.content)).toBe("72F");
  });

  it("empty input passes the original conversation through", () => {
    const out = buildStageIR(textOnly, stage("s", "M"), {}, false);
    expect(textOf(out.messages[0].content)).toBe("hi");
  });
});

describe("runMubChain (decision tree)", () => {
  beforeEach(() => {
    runJsonMock.mockClear();
  });

  it("runs linearly via explicit transitions, feeds outputs forward, sums usage", async () => {
    const chain = chainOf([
      stage("draft", "D", { transitions: [t(always, "final")] }),
      stage("final", "F", { input: [{ kind: "stage_output", stage: "draft", role: "user" }] }),
    ]);
    const { result, usage, path } = await runMubChain(textOnly, chain, noResolver);
    expect(result.ok).toBe(true);
    if (result.ok) expect(textOf(result.value.ir.content)).toBe("F(D(hi))");
    expect(usage.totalTokens).toBe(4);
    expect(path.map((p) => p.stage)).toEqual(["draft", "final"]);
  });

  it("stops and returns when a stage has no matching transition (no auto-advance)", async () => {
    const chain = chainOf([stage("a", "A"), stage("b", "B")]);
    const { result, path } = await runMubChain(textOnly, chain, noResolver);
    expect(result.ok).toBe(true);
    if (result.ok) expect(textOf(result.value.ir.content)).toBe("A(hi)");
    expect(path.map((p) => p.stage)).toEqual(["a"]); // b never runs
    expect(runJsonMock).toHaveBeenCalledTimes(1);
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
        stage("decide", `OUT:{decision: ${decision}}`, {
          transitions: [t({ type: "output_contains", value: "{decision: pass}" }, "pass"), t(always, "fail")],
        }),
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
    const { result, path } = await runMubChain(textOnly, chain, resolver);
    expect(result.ok).toBe(true);
    if (result.ok) expect(textOf(result.value.ir.content)).toBe("R(hi)");
    expect(path[0].stage).toBe("s");
    expect(path[0].mub).toBe("resmub"); // the resilience MUB the stage ran is recorded
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
