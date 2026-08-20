import { describe, expect, it } from "vitest";
import { orderReasoningFirst, stripStaleReasoning, type Message } from "../src/core/ir/content";
import { AnthropicRequest, AnthropicResponse, OpenAICompletionRequest, OpenAICompletionResponse, OpenAIResponsesRequest } from "../src/core/format";
import type { RenderTarget } from "../src/core/ir/request";
import type { StreamContext, StreamEvent } from "../src/core/ir/stream";

const hasReasoning = (m: Message | undefined): boolean => !!m && m.content.some((p) => p.type === "reasoning");

describe("stripStaleReasoning", () => {
  it("removes reasoning from tool-less assistant turns before the latest user turn", () => {
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

  it("keeps prior-turn reasoning on assistant turns that called tools (DeepSeek passback rule)", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "q1" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "keep me" },
          { type: "tool_use", id: "c1", name: "f", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "c1", content: [{ type: "text", text: "ok" }] }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "q2" }] },
    ];
    const out = stripStaleReasoning(msgs);
    expect(hasReasoning(out[1])).toBe(true);
  });

  it("strips prior-turn tool-call reasoning in strict mode (Anthropic egress)", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "q1" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "unsigned" },
          { type: "tool_use", id: "c1", name: "f", input: {} },
        ],
      },
      { role: "user", content: [{ type: "text", text: "q2" }] },
    ];
    const out = stripStaleReasoning(msgs, { keepToolTurns: false });
    expect(hasReasoning(out[1])).toBe(false);
  });
});

describe("DeepSeek reasoning dialects (openai_completion)", () => {
  const parse = (assistant: Record<string, unknown>) =>
    OpenAICompletionRequest.parse({
      model: "svc",
      messages: [
        { role: "user", content: "q" },
        assistant,
        { role: "tool", tool_call_id: "c1", content: "ok" },
      ],
    });
  const toolAssistant = (extra: Record<string, unknown>) => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
    ...extra,
  });

  it.each(["reasoning", "reasoning_content", "reasoning_text"])("parses assistant %s into a reasoning part", (field) => {
    const req = parse(toolAssistant({ [field]: "why" }));
    const assistant = req.messages.find((m) => m.role === "assistant");
    expect(assistant?.content.some((p) => p.type === "reasoning" && p.text === "why")).toBe(true);
  });

  it("renders assistant reasoning under all three field names", () => {
    const req = parse(toolAssistant({ reasoning_content: "why" }));
    const body = req.render({ upstreamModel: "m" });
    const assistant = (body.messages as Record<string, unknown>[]).find((m) => m.role === "assistant")!;
    expect(assistant.reasoning_content).toBe("why");
    expect(assistant.reasoning).toBe("why");
    expect(assistant.reasoning_text).toBe("why");
  });

  it("keeps the tool-call turn's reasoning through a full multi-turn round trip", () => {
    const req = OpenAICompletionRequest.parse({
      model: "svc",
      messages: [
        { role: "user", content: "q1" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "tool why",
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "ok" },
        { role: "assistant", content: "a1", reasoning_content: "prose why" },
        { role: "user", content: "q2" },
      ],
    });
    const body = req.render({ upstreamModel: "m" });
    const assistants = (body.messages as Record<string, unknown>[]).filter((m) => m.role === "assistant");
    // The tool-calling turn keeps its reasoning (DeepSeek 400s without it) ...
    expect(assistants[0].reasoning_content).toBe("tool why");
    // ... while the completed tool-less turn sheds its stale reasoning.
    expect(assistants[1].reasoning_content).toBeUndefined();
  });
});

describe("DeepSeek reasoning passback (openai_responses)", () => {
  it("round-trips a replayed reasoning item (reasoning_text + encrypted_content + id)", () => {
    const req = OpenAIResponsesRequest.parse({
      model: "svc",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "time?" }] },
        { type: "reasoning", id: "rs_abc", summary: [{ type: "summary_text", text: "sum" }], content: [{ type: "reasoning_text", text: "full why" }], encrypted_content: "enc123" },
        { type: "function_call", call_id: "call_1", name: "get_time", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "noon" },
      ],
    });
    const body = req.render({ upstreamModel: "m" });
    const input = body.input as Record<string, unknown>[];
    const reasoning = input.find((i) => i.type === "reasoning")!;
    expect(reasoning.id).toBe("rs_abc");
    expect(reasoning.content).toEqual([{ type: "reasoning_text", text: "full why" }]);
    expect(reasoning.encrypted_content).toBe("enc123");
    // Reasoning must precede the function_call it informed.
    expect(input.findIndex((i) => i.type === "reasoning")).toBeLessThan(input.findIndex((i) => i.type === "function_call"));
  });

  it("falls back to summary text when the client echoed a summary-only item", () => {
    const req = OpenAIResponsesRequest.parse({
      model: "svc",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "q" }] },
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "summarized why" }] },
        { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
    });
    const input = req.render({ upstreamModel: "m" }).input as Record<string, unknown>[];
    const reasoning = input.find((i) => i.type === "reasoning")!;
    expect(reasoning.content).toEqual([{ type: "reasoning_text", text: "summarized why" }]);
  });

  it("carries an Anthropic thinking block into a Responses upstream as reasoning_text", () => {
    // The observed failing path: dsh talks /v1/messages, upstream is a
    // DeepSeek-family Responses provider (opencode2 / official).
    const req = AnthropicRequest.parse({
      model: "svc",
      max_tokens: 2048,
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [
        { role: "user", content: [{ type: "text", text: "time?" }] },
        { role: "assistant", content: [
          { type: "thinking", thinking: "call the tool" },
          { type: "tool_use", id: "toolu_1", name: "get_time", input: {} },
        ] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "noon" }] }] },
      ],
    });
    const input = OpenAIResponsesRequest.construct(req).render({ upstreamModel: "m" }).input as Record<string, unknown>[];
    const reasoning = input.find((i) => i.type === "reasoning")!;
    expect(reasoning.content).toEqual([{ type: "reasoning_text", text: "call the tool" }]);
    expect(input.findIndex((i) => i.type === "reasoning")).toBeLessThan(input.findIndex((i) => i.type === "function_call"));
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
    expect(assistant.reasoning_content).toBeUndefined();
    expect(assistant.content).toBe("a1");
  });

  it("OpenAI completion egress keeps the CURRENT turn's reasoning (tool loop), in both dialect spellings", () => {
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
    // DeepSeek's spelling — its v3.2 tool loop requires the round's reasoning back.
    expect(assistant.reasoning_content).toBe("deciding");
  });

  it("OpenAI Responses egress sheds a completed tool-less turn's reasoning (tool turns replay — see the passback suite)", () => {
    const req = OpenAICompletionRequest.parse(openAiBody());
    const out = OpenAIResponsesRequest.construct(req).render(target());

    const json = JSON.stringify(out.input);
    expect(json).not.toContain("thought about q1");
  });

  it("a Responses-ingress reasoning item (raw reasoning_text) reaches an Anthropic target as a thinking block", () => {
    // The Codex replay shape: the reasoning item precedes its turn's message.
    const req = OpenAIResponsesRequest.parse({
      model: "svc",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "q1" }] },
        { type: "reasoning", id: "rs_1", summary: [], content: [{ type: "reasoning_text", text: "raw thought" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "a1" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "q2" }] },
      ],
    });
    const out = AnthropicRequest.construct(req).render(target());

    const assistant = (out.messages as AnthropicMsg[]).find((m) => m.role === "assistant")!;
    expect(assistant.content.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(assistant.content[0].thinking).toBe("raw thought");

    // Its own family still drops it on the way out.
    const selfOut = OpenAIResponsesRequest.construct(req).render(target());
    expect(JSON.stringify(selfOut.input)).not.toContain("raw thought");
  });

  it("a summary-only reasoning item is parsed too, and a tool-loop one leads the tool call", () => {
    const req = OpenAIResponsesRequest.parse({
      model: "svc",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "q1" }] },
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "summarized thought" }] },
        { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "42" },
      ],
    });
    const out = AnthropicRequest.construct(req).render(target());

    const assistant = (out.messages as AnthropicMsg[]).find((m) => m.role === "assistant")!;
    expect(assistant.content.map((b) => b.type)).toEqual(["thinking", "tool_use"]);
    expect(assistant.content[0].thinking).toBe("summarized thought");
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
    expect(assistant.reasoning_content).toBeUndefined();
  });
});

// --- the response side of the round trip -------------------------------------
//
// A chat-completion client can only replay reasoning it was GIVEN. Hydrogen used
// to emit it as `reasoning` alone, which a DeepSeek-convention client (reading
// `reasoning_content`) never saw and so never sent back — and the next request,
// translated to an Anthropic-family upstream, had no thinking block to resend
// (DeepSeek 4028). The response render must speak both dialect spellings.

describe("reasoning survives the chat-completion response render", () => {
  const anthropicUpstreamBody = {
    id: "msg_1",
    model: "up",
    content: [
      { type: "thinking", thinking: "deep thought" },
      { type: "text", text: "answer" },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 2 },
  };

  it("an Anthropic upstream's thinking reaches an OpenAI client in both spellings", () => {
    const res = AnthropicResponse.parse(anthropicUpstreamBody);
    const out = res.render("openai_completion", "svc");
    const message = ((out.choices as Array<Record<string, unknown>>)[0].message ?? {}) as Record<string, unknown>;
    expect(message.reasoning).toBe("deep thought");
    expect(message.reasoning_content).toBe("deep thought");
    expect(message.content).toBe("answer");
  });

  it("what the client replays from that response round-trips into a thinking block", () => {
    const res = AnthropicResponse.parse(anthropicUpstreamBody);
    const message = ((res.render("openai_completion", "svc").choices as Array<Record<string, unknown>>)[0]
      .message ?? {}) as Record<string, unknown>;

    // The client appends the assistant message it received and asks again.
    const req = OpenAICompletionRequest.parse({
      model: "svc",
      messages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: message.content, reasoning_content: message.reasoning_content },
        { role: "user", content: "q2" },
      ],
    });
    const out = AnthropicRequest.construct(req).render(target());
    const assistant = (out.messages as AnthropicMsg[]).find((m) => m.role === "assistant")!;
    expect(assistant.content[0]).toEqual({ type: "thinking", thinking: "deep thought" });
  });

  it("streaming deltas carry both spellings too", async () => {
    async function* events(): AsyncGenerator<StreamEvent> {
      yield { type: "start", id: "c1", model: "up", created: 1 };
      yield { type: "reasoning_delta", text: "hmm" };
      yield { type: "text_delta", text: "hi" };
      yield { type: "finish", stopReason: "stop", usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }, incomplete: false };
    }
    let sse = "";
    for await (const frame of OpenAICompletionResponse.serializeStream(events(), { model: "svc" } as StreamContext)) sse += frame;
    const reasoningChunk = sse
      .split("\n\n")
      .map((l) => l.replace(/^data: /, ""))
      .filter((l) => l && l !== "[DONE]")
      .map((l) => JSON.parse(l) as { choices?: Array<{ delta?: Record<string, unknown> }> })
      .find((c) => c.choices?.[0]?.delta?.reasoning != null);
    expect(reasoningChunk?.choices?.[0]?.delta?.reasoning).toBe("hmm");
    expect(reasoningChunk?.choices?.[0]?.delta?.reasoning_content).toBe("hmm");
  });
});
