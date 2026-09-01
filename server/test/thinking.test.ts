import { describe, expect, it } from "vitest";
import { AnthropicRequest, OpenAICompletionRequest } from "../src/core/format";
import type { GenerationParams } from "../src/core/ir/params";
import { DEFAULT_ANTHROPIC_MAX_TOKENS } from "../src/core/ir/thinking";

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

describe("Anthropic thinking is omitted unless a level was set", () => {
  it("a client that said nothing about thinking gets no thinking field", () => {
    // Absent stays absent, so the provider's own default decides. Pinning
    // {"type":"disabled"} here used to hide DeepSeek's 4028 ("content[].thinking
    // in the thinking mode must be passed back") -- at the price of disabling
    // thinking for every caller who never asked to have it off, and of failing
    // outright on an upstream that rejects the field instead of honouring it.
    // The 4028 belongs to the replay path (assistant turns must carry their
    // thinking blocks), not to this renderer.
    expect(anthropic({}).thinking).toBeUndefined();
    expect(anthropic({ maxTokens: 32768 }).thinking).toBeUndefined();
  });

  it("omitting thinking leaves max_tokens exactly as it was", () => {
    expect(anthropic({ maxTokens: 32768 }).max_tokens).toBe(32768);
    // No client budget: still prefer the provider's cap over the built-in default.
    expect(anthropic({}, 8192).max_tokens).toBe(8192);
    expect(anthropic({ maxTokens: 99999 }, 8192).max_tokens).toBe(8192);
    expect(anthropic({}).max_tokens).toBe(DEFAULT_ANTHROPIC_MAX_TOKENS);
  });

  it("a real Anthropic request that omits thinking carries no thinking field", () => {
    // The production shape behind the 4028: POST /v1/messages with no `thinking`,
    // and a history whose assistant turns hold plain text and no thinking blocks.
    // The field stays absent here; the missing blocks are the replay path's bug.
    const out = AnthropicRequest.parse({
      model: "svc",
      max_tokens: 32768,
      stream: true,
      messages: [
        { role: "user", content: "check the logs" },
        { role: "assistant", content: [{ type: "text", text: "on it" }] },
        { role: "user", content: "and then?" },
      ],
    }).render({ upstreamModel: "deepseek-v4-flash" });
    expect(out.thinking).toBeUndefined();
    expect(out.max_tokens).toBe(32768);
  });

  it("still lets a client that does ask for thinking have it", () => {
    const out = AnthropicRequest.parse({
      model: "svc",
      max_tokens: 32768,
      thinking: { type: "enabled", budget_tokens: 8000 },
      messages: [{ role: "user", content: "hi" }],
    }).render({ upstreamModel: "m" });
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
  });

  it("keeps the thinking blocks a thinking client does send back", () => {
    // The other half of 4028: when thinking IS on, the history's blocks must
    // survive the round trip, signature and all.
    const out = AnthropicRequest.parse({
      model: "svc",
      max_tokens: 32768,
      thinking: { type: "enabled", budget_tokens: 8000 },
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [
          { type: "thinking", thinking: "let me see", signature: "sig-abc" },
          { type: "text", text: "hello" },
        ] },
        { role: "user", content: "again" },
      ],
    }).render({ upstreamModel: "m" });
    const assistant = (out.messages as Array<{ role: string; content: unknown[] }>)[1];
    expect(assistant.content[0]).toEqual({ type: "thinking", thinking: "let me see", signature: "sig-abc" });
  });
});
