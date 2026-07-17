import { describe, expect, it } from "vitest";
import { AnthropicRequest, OpenAICompletionRequest } from "../src/core/format";
import type { GenerationParams } from "../src/core/ir/params";

function base(params: GenerationParams): OpenAICompletionRequest {
  return new OpenAICompletionRequest({
    requestedService: "svc",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    params,
    stream: false,
  });
}

const openai = (params: GenerationParams) => base(params).render({ upstreamModel: "m" });
const anthropic = (params: GenerationParams, providerCap?: number) =>
  AnthropicRequest.construct(base(params)).render({ upstreamModel: "m", providerMaxOutputTokens: providerCap });

describe("OpenAI reasoning_effort", () => {
  it("named effort levels pass through", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(openai({ thinking: level }).reasoning_effort).toBe(level);
    }
    expect(openai({ thinking: "disabled" }).reasoning_effort).toBe("none");
    expect(openai({ thinking: "enabled" }).reasoning_effort).toBe("medium");
  });

  it("parses reasoning_effort into the canonical thinking level", () => {
    const parse = (reasoning_effort: string) =>
      OpenAICompletionRequest.parse({ model: "m", messages: [{ role: "user", content: "hi" }], reasoning_effort }).params.thinking;
    expect(parse("low")).toBe("low");
    expect(parse("xhigh")).toBe("xhigh");
    expect(parse("max")).toBe("max");
    expect(parse("minimal")).toBe("minimal");
    expect(parse("none")).toBe("disabled");
  });

  it("maps an explicit budget to the nearest effort level", () => {
    expect(openai({ thinking: { budget: 4096 } }).reasoning_effort).toBe("low");
    expect(openai({ thinking: { budget: 16000 } }).reasoning_effort).toBe("medium");
    expect(openai({ thinking: { budget: 32768 } }).reasoning_effort).toBe("high");
    expect(openai({ thinking: { budget: 64000 } }).reasoning_effort).toBe("xhigh");
    expect(openai({ thinking: { budget: 128000 } }).reasoning_effort).toBe("max");
  });
});

describe("Anthropic thinking budgets", () => {
  it("named effort levels map to budgets, max_tokens exceeds the budget", () => {
    expect(anthropic({ thinking: "low" }).thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    const max = anthropic({ thinking: "max" });
    expect(max.thinking).toEqual({ type: "enabled", budget_tokens: 128000 });
    expect(max.max_tokens as number).toBeGreaterThan(128000);
    expect(anthropic({ thinking: { budget: 2048 } }).thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
  });

  it("disabled turns thinking off", () => {
    expect(anthropic({ thinking: "disabled" }).thinking).toEqual({ type: "disabled" });
  });
});

describe("Anthropic max_tokens fit-under-cap (the 0.6.3 fix)", () => {
  it("never inflates the client's max_tokens past what they asked (large budget)", () => {
    const out = anthropic({ thinking: "max", maxTokens: 3000 });
    expect(out.max_tokens).toBe(3000);
    const t = out.thinking as { budget_tokens: number };
    expect(t.budget_tokens).toBeLessThan(3000);
    expect(t.budget_tokens).toBeGreaterThanOrEqual(1024);
  });

  it("keeps the full budget when the client's max_tokens leaves room", () => {
    const out = anthropic({ thinking: { budget: 32768 }, maxTokens: 64000 });
    expect(out.max_tokens).toBe(64000);
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 32768 });
  });

  it("shrinks the budget to fit a tight client max_tokens, leaving response room", () => {
    const out = anthropic({ thinking: { budget: 32768 }, maxTokens: 20000 });
    expect(out.max_tokens).toBe(20000);
    expect((out.thinking as { budget_tokens: number }).budget_tokens).toBe(20000 - 4096);
  });

  it("drops thinking rather than exceed a tiny client ceiling", () => {
    // A ceiling that cannot hold even the minimum thinking budget must not be
    // inflated past what the client asked (the old code emitted max_tokens 1025
    // for maxTokens 800); thinking is turned off and the answer gets the 800.
    const out = anthropic({ thinking: "max", maxTokens: 800 });
    expect(out.thinking).toEqual({ type: "disabled" });
    expect(out.max_tokens).toBe(800);
  });

  it("fits the budget under the provider's hard output cap", () => {
    // No client max, but the provider caps output at 5000: budget must fit under it.
    const out = anthropic({ thinking: "max" }, 5000);
    expect(out.max_tokens as number).toBeLessThanOrEqual(5000);
    expect(out.max_tokens as number).toBeGreaterThan((out.thinking as { budget_tokens: number }).budget_tokens);
  });
});
