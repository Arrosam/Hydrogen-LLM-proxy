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
/** `output_config.effort` off a rendered body, or undefined when none was set. */
const effortOf = (body: Record<string, unknown>): string | undefined =>
  (body.output_config as { effort?: string } | undefined)?.effort;

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

describe("Anthropic effort (output_config.effort, not budget_tokens)", () => {
  // `thinking: {type:"enabled", budget_tokens: N}` is rejected with a 400 on every
  // current Anthropic model and deprecated on the two before them. `thinking` now
  // says WHETHER to think, `output_config.effort` says HOW MUCH -- and its scale is
  // the one this proxy already speaks, so a named effort crosses over by name.
  it("a named effort crosses to Anthropic by name, thinking turned on adaptively", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      const out = anthropic({ thinking: level });
      expect(out.thinking).toEqual({ type: "adaptive" });
      expect(effortOf(out)).toBe(level);
    }
  });

  it("`minimal` has no Anthropic rung and folds onto low", () => {
    expect(effortOf(anthropic({ thinking: "minimal" }))).toBe("low");
  });

  it("an explicit token budget maps to the nearest effort", () => {
    // The budget itself cannot be sent any more, so it is read as an intensity.
    expect(effortOf(anthropic({ thinking: { budget: 2048 } }))).toBe("low");
    expect(effortOf(anthropic({ thinking: { budget: 16000 } }))).toBe("medium");
    expect(effortOf(anthropic({ thinking: { budget: 128000 } }))).toBe("max");
  });

  it("never emits budget_tokens", () => {
    for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(anthropic({ thinking: level }).thinking).not.toHaveProperty("budget_tokens");
    }
    expect(anthropic({ thinking: { budget: 32768 } }).thinking).not.toHaveProperty("budget_tokens");
  });

  it("disabled turns thinking off and carries no effort", () => {
    const out = anthropic({ thinking: "disabled" });
    expect(out.thinking).toEqual({ type: "disabled" });
    expect(effortOf(out)).toBeUndefined();
  });
});

describe("Anthropic max_tokens fit-under-cap (the 0.6.3 fix)", () => {
  it("never inflates the client's max_tokens past what they asked", () => {
    const out = anthropic({ thinking: "max", maxTokens: 3000 });
    expect(out.max_tokens).toBe(3000);
  });

  it("keeps the requested effort when the client's max_tokens leaves room", () => {
    const out = anthropic({ thinking: { budget: 32768 }, maxTokens: 64000 });
    expect(out.max_tokens).toBe(64000);
    expect(effortOf(out)).toBe("high");
  });

  it("a client's own effort survives a tight max_tokens untouched", () => {
    // 32768 reads as `high`, and 20000 could never have held that as a token
    // budget -- but effort is a hint the model paces itself against, not a
    // reservation, so the level the caller asked for goes out as asked.
    const out = anthropic({ thinking: { budget: 32768 }, maxTokens: 20000 });
    expect(out.max_tokens).toBe(20000);
    expect(effortOf(out)).toBe("high");
  });

  it("even a ceiling far below the effort's old budget does not lower it", () => {
    // The old policy turned thinking OFF here (Anthropic required
    // max_tokens > budget_tokens >= 1024). There is no budget any more, and no
    // reason to answer at a level below the one requested.
    const out = anthropic({ thinking: "max", maxTokens: 800 });
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(effortOf(out)).toBe("max");
    expect(out.max_tokens).toBe(800);
  });

  it("a provider's hard cap bounds max_tokens, not the effort", () => {
    const out = anthropic({ thinking: "max" }, 5000);
    expect(out.max_tokens as number).toBeLessThanOrEqual(5000);
    expect(effortOf(out)).toBe("max");
  });
});

describe("Anthropic: an IMPOSED effort reserves answer room, never lowers itself", () => {
  // A step or stage adding thinking the client never asked for is the one case
  // that still changes max_tokens: the client's max is the answer's room and the
  // reasoning budget is added on top of it. Nothing lowers the level -- not a
  // tight ceiling, not a hard provider cap.
  const imposed = (params: GenerationParams, providerCap?: number) =>
    AnthropicRequest.construct(base({}).withOverrides(params)).render({ upstreamModel: "m", providerMaxOutputTokens: providerCap });

  it("adds the reasoning budget on top of the client's max", () => {
    const out = imposed({ thinking: "high", maxTokens: 1024 }, 131072);
    expect(out.max_tokens).toBe(1024 + 32000);
    expect(effortOf(out)).toBe("high");
  });

  it("a cap too tight to hold the reservation bounds it, and only it", () => {
    const out = imposed({ thinking: "max", maxTokens: 1024 }, 2048);
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.max_tokens).toBe(2048);
    expect(effortOf(out)).toBe("max");
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
    // The budget it asked in cannot be sent on; it is read as an intensity and
    // re-expressed as the effort nearest to it.
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.output_config).toEqual({ effort: "low" });
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
