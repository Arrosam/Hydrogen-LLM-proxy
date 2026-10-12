/**
 * Thinking coverage at the boundaries: the budget-to-effort bands, the `auto`
 * level, which Claude models get a manual budget instead of adaptive effort,
 * and the length limits of the `<think>` tag scanner.
 */
import { describe, expect, it } from "vitest";
import { AnthropicRequest, OpenAICompletionRequest, OpenAIResponsesRequest } from "../src/core/format";
import type { GenerationParams, ThinkingLevel } from "../src/core/ir/params";
import type { ContentPart } from "../src/core/ir/content";
import type { StreamEvent } from "../src/core/ir/stream";
import { applyThinkingFormat, withThinkingFormat } from "../src/core/ir/thinkingFormat";

type Json = Record<string, any>;
const base = (params: GenerationParams) => new OpenAICompletionRequest({
  requestedService: "svc", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], params, stream: false,
});
const openai = (params: GenerationParams): Json => base(params).render({ upstreamModel: "m" });
const responses = (params: GenerationParams): Json => OpenAIResponsesRequest.construct(base(params)).render({ upstreamModel: "m" });
const anthropic = (params: GenerationParams, upstreamModel = "m"): Json => AnthropicRequest.construct(base(params)).render({ upstreamModel });

describe("BVA: a manual budget maps to the nearest effort band", () => {
  it.each([
    [0, "minimal"], [2048, "minimal"], [2049, "low"], [10_000, "low"], [10_001, "medium"], [24_000, "medium"],
    [24_001, "high"], [48_000, "high"], [48_001, "xhigh"], [96_000, "xhigh"], [96_001, "max"],
  ])("a budget of %i becomes %s", (budget, effort) => {
    expect(openai({ thinking: { budget } }).reasoning_effort).toBe(effort);
    expect(responses({ thinking: { budget } }).reasoning.effort).toBe(effort);
  });
});

describe("EP: the `auto` level", () => {
  it("is medium effort on the OpenAI wires", () => {
    expect(openai({ thinking: "auto" }).reasoning_effort).toBe("medium");
    expect(responses({ thinking: "auto" }).reasoning.effort).toBe("medium");
  });
  it("is adaptive thinking at medium effort on Anthropic", () => {
    const body = anthropic({ thinking: "auto" });
    expect(body.thinking).toEqual({ type: "adaptive" }); expect(body.output_config).toEqual({ effort: "medium" });
  });
});

describe("EP: named efforts by Claude model generation", () => {
  it.each(["claude-3-7-sonnet-20250219", "claude-3.5-sonnet", "claude-opus-4-20250514", "claude-opus-4-1", "claude-sonnet-4.5", "claude-sonnet-4-5-20250929"])(
    "%s gets a manual budget and no effort", model => {
      const body = anthropic({ thinking: "medium" }, model);
      expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
      expect(body).not.toHaveProperty("output_config");
    });

  it.each(["claude-opus-4-6", "claude-opus-4-7", "claude-sonnet-5", "vendor-model"])("%s gets adaptive thinking with an effort", model => {
    const body = anthropic({ thinking: "medium" }, model);
    expect(body.thinking).toEqual({ type: "adaptive" }); expect(body.output_config).toEqual({ effort: "medium" });
  });

  it.each<[ThinkingLevel, number]>([
    ["minimal", 1024], ["low", 2048], ["medium", 8192], ["high", 16_384], ["xhigh", 32_768], ["max", 65_536], ["enabled", 8192], ["auto", 8192],
  ])("%s is a budget of %i tokens on a pre-adaptive model", (thinking, budget) => {
    expect(anthropic({ thinking }, "claude-opus-4-1").thinking).toEqual({ type: "enabled", budget_tokens: budget });
  });

  it("keeps thinking off and a manual budget as given on a pre-adaptive model", () => {
    expect(anthropic({ thinking: "disabled" }, "claude-opus-4-1").thinking).toEqual({ type: "disabled" });
    expect(anthropic({ thinking: { budget: 5000 } }, "claude-opus-4-1").thinking).toEqual({ type: "enabled", budget_tokens: 5000 });
  });
});

describe("BVA: `<think>` tag scanner limits", () => {
  const THOUGHT = "It is Paris.", ANSWER = "Paris.";
  const textOnly = (text: string): ContentPart[] => [{ type: "text", text }];
  async function* stream(text: string, size: number): AsyncGenerator<StreamEvent> {
    for (let i = 0; i < text.length; i += size) yield { type: "text_delta", text: text.slice(i, i + size) };
    yield { type: "finish", stopReason: "stop" };
  }
  const streamed = async (text: string, size: number) => {
    let reasoning = "", answer = "";
    for await (const ev of withThinkingFormat(stream(text, size), "reasoning_content")) {
      if (ev.type === "reasoning_delta") reasoning += ev.text;
      if (ev.type === "text_delta") answer += ev.text;
    }
    return { reasoning, answer };
  };
  const block = (name: string) => `<${name}>${THOUGHT}</${name}>\n\n${ANSWER}`;

  it("lifts a block whose tag name is 24 letters long, buffered and streamed", async () => {
    const raw = block("a".repeat(19) + "think");
    expect(applyThinkingFormat(textOnly(raw), "reasoning_content")).toEqual([{ type: "reasoning", text: THOUGHT }, { type: "text", text: ANSWER }]);
    for (const size of [1, 4, 500]) expect(await streamed(raw, size)).toEqual({ reasoning: THOUGHT, answer: ANSWER });
  });

  it("leaves a block whose tag name is 25 letters long as answer text, buffered and streamed", async () => {
    const raw = block("a".repeat(20) + "think");
    expect(applyThinkingFormat(textOnly(raw), "reasoning_content")).toEqual(textOnly(raw));
    for (const size of [1, 4, 500]) expect(await streamed(raw, size)).toEqual({ reasoning: "", answer: raw });
  });

  it("lifts a block behind 512 characters of padding, buffered and streamed", async () => {
    const raw = "\n".repeat(512) + block("think");
    expect(applyThinkingFormat(textOnly(raw), "reasoning_content")).toEqual([{ type: "reasoning", text: THOUGHT }, { type: "text", text: ANSWER }]);
    for (const size of [1, 4, 500]) expect(await streamed(raw, size)).toEqual({ reasoning: THOUGHT, answer: ANSWER });
  });

  it("leaves a block behind more than 512 characters of padding as answer text, buffered and streamed", async () => {
    for (const pad of [513, 2000]) {
      const raw = "\n".repeat(pad) + block("think");
      expect(applyThinkingFormat(textOnly(raw), "reasoning_content")).toEqual(textOnly(raw));
      for (const size of [1, 4, 500, raw.length]) expect(await streamed(raw, size)).toEqual({ reasoning: "", answer: raw });
    }
  });
});
