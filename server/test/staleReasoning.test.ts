import { describe, expect, it } from "vitest";
import { orderReasoningFirst, stripStaleReasoning, type Message } from "../src/core/ir/content";
import { AnthropicRequest, OpenAICompletionRequest, OpenAIResponsesRequest } from "../src/core/format";
import type { RenderTarget } from "../src/core/ir/request";

const hasReasoning = (m: Message | undefined): boolean => !!m && m.content.some((p) => p.type === "reasoning");

describe("stripStaleReasoning", () => {
  it("removes reasoning from assistant turns before the latest user turn", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "q1" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "secret" }, { type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "q2" }] },
    ];
    const out = stripStaleReasoning(msgs);
    const assistant = out.find((m) => m.role === "assistant");
    expect(hasReasoning(assistant)).toBe(false);
    expect(assistant?.content.some((p) => p.type === "text")).toBe(true);
  });

  it("keeps reasoning when there is no later user turn (current turn)", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "q1" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "keep" }, { type: "text", text: "a1" }] },
    ];
    const out = stripStaleReasoning(msgs);
    expect(hasReasoning(out.find((m) => m.role === "assistant"))).toBe(true);
  });
});

describe("orderReasoningFirst", () => {
  it("moves reasoning ahead of text in an assistant message", () => {
    const out = orderReasoningFirst([
      { role: "assistant", content: [{ type: "text", text: "a" }, { type: "reasoning", text: "r" }] },
    ]);
    expect(out[0].content.map((p) => p.type)).toEqual(["reasoning", "text"]);
  });

  it("leaves already-ordered content and user messages untouched", () => {
    const ordered: Message[] = [
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "r" }, { type: "text", text: "a" }] },
    ];
    expect(orderReasoningFirst(ordered)).toEqual(ordered);
  });

  it("is idempotent", () => {
    const once = orderReasoningFirst([
      { role: "assistant", content: [{ type: "text", text: "a" }, { type: "reasoning", text: "r" }] },
    ]);
    expect(orderReasoningFirst(once)).toEqual(once);
  });
});

// --- the egress-family rule -------------------------------------------------

const target = (): RenderTarget => ({ upstreamModel: "up-model" }) as RenderTarget;

/** An OpenAI-format multi-turn body whose completed assistant turn carries
 * reasoning — the shape a thinking-aware client (or this proxy's own Anthropic
 * ingress) replays on the next turn. */
const openAiBody = () => ({
  model: "svc",
  messages: [
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1", reasoning_content: "thought about q1" },
    { role: "user", content: "q2" },
  ],
  reasoning_effort: "medium",
});

type AnthropicBlock = { type: string; thinking?: string; text?: string; signature?: string };
type AnthropicMsg = { role: string; content: AnthropicBlock[] };

describe("resent reasoning is decided by the EGRESS family, not the ingress", () => {
  it("Anthropic egress keeps a completed turn's thinking and puts it first", () => {
    const req = OpenAICompletionRequest.parse(openAiBody());
    const out = AnthropicRequest.construct(req).render(target());

    const assistant = (out.messages as AnthropicMsg[]).find((m) => m.role === "assistant")!;
    // This is the block DeepSeek's 4028 complains about being absent.
    expect(assistant.content[0]).toEqual({ type: "thinking", thinking: "thought about q1" });
    expect(assistant.content.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(out.thinking).toMatchObject({ type: "enabled" });
  });

  it("Anthropic egress preserves the signature when the history carries one", () => {
    const req = AnthropicRequest.parse({
      model: "svc",
      max_tokens: 1024,
      thinking: { type: "enabled", budget_tokens: 2048 },
      messages: [
        { role: "user", content: [{ type: "text", text: "q1" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "thought", signature: "sig-abc" },
            { type: "text", text: "a1" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "q2" }] },
      ],
    });
    const out = AnthropicRequest.construct(req).render(target());

    const assistant = (out.messages as AnthropicMsg[]).find((m) => m.role === "assistant")!;
    expect(assistant.content[0]).toEqual({ type: "thinking", thinking: "thought", signature: "sig-abc" });
  });

  it("OpenAI completion egress still drops it — that endpoint rejects it back", () => {
    const req = OpenAICompletionRequest.parse(openAiBody());
    const out = OpenAICompletionRequest.construct(req).render(target());

    const assistant = (out.messages as Array<Record<string, unknown>>).find((m) => m.role === "assistant")!;
    expect(assistant.reasoning).toBeUndefined();
    expect(assistant.content).toBe("a1");
  });

  it("OpenAI completion egress keeps the CURRENT turn's reasoning (tool loop)", () => {
    const req = OpenAICompletionRequest.parse({
      model: "svc",
      messages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: null, reasoning_content: "deciding", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "42" },
      ],
    });
    const out = OpenAICompletionRequest.construct(req).render(target());

    const assistant = (out.messages as Array<Record<string, unknown>>).find((m) => m.role === "assistant")!;
    expect(assistant.reasoning).toBe("deciding");
  });

  it("OpenAI Responses egress never replays reasoning", () => {
    const req = OpenAICompletionRequest.parse(openAiBody());
    const out = OpenAIResponsesRequest.construct(req).render(target());

    const json = JSON.stringify(out.input);
    expect(json).not.toContain("thought about q1");
  });

  it("an Anthropic-ingress request routed to an OpenAI provider is still stripped", () => {
    const req = AnthropicRequest.parse({
      model: "svc",
      max_tokens: 1024,
      messages: [
        { role: "user", content: [{ type: "text", text: "q1" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "stale", signature: "s" }, { type: "text", text: "a1" }] },
        { role: "user", content: [{ type: "text", text: "q2" }] },
      ],
    });
    const out = OpenAICompletionRequest.construct(req).render(target());

    const assistant = (out.messages as Array<Record<string, unknown>>).find((m) => m.role === "assistant")!;
    expect(assistant.reasoning).toBeUndefined();
  });
});
