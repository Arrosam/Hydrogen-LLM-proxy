import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IRContentPart, IRRequest } from "../src/core/ir";
import { textOf } from "../src/core/ir";
import type { ChainDef, ChainStage } from "../src/core/mub/schema";

// Mock the per-stage runner so chain orchestration can be tested without HTTP.
// The fake echoes `${model}(${lastUserText})` so output feed-forward is visible.
vi.mock("../src/core/proxy/run", () => {
  const lastUserText = (ir: IRRequest): string => {
    for (let i = ir.messages.length - 1; i >= 0; i--) {
      const m = ir.messages[i];
      if (m.role === "user") {
        return m.content
          .filter((p) => p.type === "text")
          .map((p) => (p as { text: string }).text)
          .join("");
      }
    }
    return "";
  };
  return {
    runMubJson: vi.fn(
      async (ir: IRRequest, steps: { timeoutMs: number; steps: { model: string; provider: string }[] }) => {
        const { model, provider } = steps.steps[0];
        const rec = {
          step: 1,
          attempt: 1,
          model,
          provider,
          status: model === "BOOM" ? 500 : 200,
          kind: model === "BOOM" ? "http" : "ok",
          latencyMs: 1,
        };
        if (model === "BOOM") {
          return { result: { ok: false, status: 500, kind: "http", message: "boom" }, path: [rec] };
        }
        const value = {
          ir: {
            id: "x",
            model,
            created: 0,
            content: [{ type: "text", text: `${model}(${lastUserText(ir)})` }],
            stopReason: "stop",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          },
          family: "openai",
          upstreamModel: model,
          providerName: provider,
          modelName: model,
        };
        return { result: { ok: true, value }, path: [rec] };
      },
    ),
    runMubStream: vi.fn(async () => ({
      result: { ok: false, status: 0, kind: "error", message: "no stream in test" },
      path: [],
    })),
  };
});

import { runMubJson } from "../src/core/proxy/run";
import { buildStageIR, runMubChain } from "../src/core/mub/chain";

const runJsonMock = vi.mocked(runMubJson);

function stage(name: string, model: string, input: ChainStage["input"] = []): ChainStage {
  return { name, steps: [{ model, provider: "p" }], input };
}

function chainOf(stages: ChainStage[], output?: string): ChainDef {
  return { kind: "chain", timeoutMs: 60_000, stages, ...(output ? { output } : {}) };
}

const withImage: IRRequest = {
  requestedModel: "m",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "hi" },
        { type: "image", source: { kind: "url", url: "http://img" } },
      ],
    },
  ],
  stream: false,
};

const textOnly: IRRequest = {
  requestedModel: "m",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: false,
};

describe("buildStageIR (structured content builder)", () => {
  it("routes original images into a stage (and includes literal text)", () => {
    const s = stage("ocr", "K", [
      { role: "user", parts: [{ source: "literal", text: "OCR:" }, { source: "original_images" }] },
    ]);
    const out = buildStageIR(withImage, s, {}, false);
    const content = out.messages[0].content;
    expect(content.some((p: IRContentPart) => p.type === "image")).toBe(true);
    expect(textOf(content)).toBe("OCR:");
  });

  it("composes original text + literal + a prior stage's output, dropping images", () => {
    const s = stage("main", "G", [
      {
        role: "user",
        parts: [{ source: "original_text" }, { source: "literal", text: " | " }, { source: "stage", name: "ocr" }],
      },
    ]);
    const out = buildStageIR(withImage, s, { ocr: "HELLO" }, false);
    expect(textOf(out.messages[0].content)).toBe("hi | HELLO");
    expect(out.messages[0].content.some((p: IRContentPart) => p.type === "image")).toBe(false);
  });

  it("empty input passes the original messages through", () => {
    const out = buildStageIR(textOnly, stage("draft", "D"), {}, false);
    expect(textOf(out.messages[0].content)).toBe("hi");
  });

  it("applies per-stage overrides (system/temperature/maxTokens)", () => {
    const s: ChainStage = {
      ...stage("eval", "E"),
      system: [{ source: "literal", text: "You are strict." }],
      temperature: 0.1,
      maxTokens: 50,
    };
    const out = buildStageIR(textOnly, s, {}, false);
    expect(out.system).toBe("You are strict.");
    expect(out.temperature).toBe(0.1);
    expect(out.maxTokens).toBe(50);
  });
});

describe("runMubChain (orchestration)", () => {
  beforeEach(() => {
    runJsonMock.mockClear();
  });

  it("runs stages in order, feeds outputs forward, sums usage, labels the path", async () => {
    const chain = chainOf([
      stage("draft", "D"),
      stage("final", "F", [{ role: "user", parts: [{ source: "stage", name: "draft" }] }]),
    ]);
    const { result, usage, path } = await runMubChain(textOnly, chain);
    expect(result.ok).toBe(true);
    if (result.ok) expect(textOf(result.value.ir.content)).toBe("F(D(hi))");
    expect(usage.totalTokens).toBe(4);
    expect(path.map((p) => p.stage)).toEqual(["draft", "final"]);
  });

  it("aborts on a mid-chain failure and does not run later stages", async () => {
    const chain = chainOf([stage("a", "D"), stage("b", "BOOM"), stage("c", "D")]);
    const { result } = await runMubChain(textOnly, chain);
    expect(result.ok).toBe(false);
    expect(runJsonMock).toHaveBeenCalledTimes(2); // c never runs
  });

  it("returns a non-default output stage and stops there", async () => {
    const chain = chainOf(
      [stage("a", "D"), stage("b", "F", [{ role: "user", parts: [{ source: "stage", name: "a" }] }])],
      "a",
    );
    const { result } = await runMubChain(textOnly, chain);
    expect(result.ok).toBe(true);
    if (result.ok) expect(textOf(result.value.ir.content)).toBe("D(hi)");
    expect(runJsonMock).toHaveBeenCalledTimes(1); // stops at the output stage
  });
});
