/**
 * Anthropic `redacted_thinking` through the STREAMING path.
 *
 * The block is encrypted bytes the model returns in place of readable thinking.
 * They arrive whole on `content_block_start.data` and are followed by no delta
 * of any kind, so a pipeline that only watches reasoning deltas sees an empty
 * block and drops it. Losing it breaks the next tool-call turn: Anthropic
 * requires the block replayed verbatim, and a client that never received it has
 * nothing to send.
 *
 * The payload is also strictly Anthropic's: it must reach an Anthropic client
 * intact and must never be handed to an OpenAI-family client, in any shape.
 */
import { describe, expect, it } from "vitest";
import { parseStream, serializeStream } from "../src/core/format";
import { collectStream, fabricateStream, withoutReasoning, type ResponseData, type StreamEvent } from "../src/core/ir/stream";
import type { ReasoningPart } from "../src/core/ir/content";

const OPAQUE = "EncRyPtEd//Op4qu3+Byt3s==";

async function* frames(...f: string[]): AsyncGenerator<string> {
  for (const chunk of f) yield chunk;
}

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

async function text(gen: AsyncGenerator<string>): Promise<string> {
  let s = "";
  for await (const chunk of gen) s += chunk;
  return s;
}

async function* replay(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e;
}

const frame = (event: string, data: Record<string, unknown>): string =>
  `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;

/** An Anthropic SSE stream carrying exactly one redacted_thinking block. */
const REDACTED_ONLY = [
  frame("message_start", { message: { id: "msg_1", model: "claude-x", usage: { input_tokens: 5, output_tokens: 0 } } }),
  frame("content_block_start", { index: 0, content_block: { type: "redacted_thinking", data: OPAQUE } }),
  frame("content_block_stop", { index: 0 }),
  frame("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
  frame("content_block_delta", { index: 1, delta: { type: "text_delta", text: "done" } }),
  frame("content_block_stop", { index: 1 }),
  frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }),
  frame("message_stop", {}),
];

/** The same, but the turn ends in a tool call -- the case that actually breaks
 * when the block is lost, since the next turn must replay it. */
const REDACTED_WITH_TOOL = [
  frame("message_start", { message: { id: "msg_2", model: "claude-x", usage: { input_tokens: 5, output_tokens: 0 } } }),
  frame("content_block_start", { index: 0, content_block: { type: "redacted_thinking", data: OPAQUE } }),
  frame("content_block_stop", { index: 0 }),
  frame("content_block_start", { index: 1, content_block: { type: "tool_use", id: "toolu_9", name: "get_weather" } }),
  frame("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"city":"Beijing"}' } }),
  frame("content_block_stop", { index: 1 }),
  frame("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }),
  frame("message_stop", {}),
];

const reasoningOf = (data: ResponseData): ReasoningPart[] =>
  data.content.filter((p): p is ReasoningPart => p.type === "reasoning");

describe("parse + collect", () => {
  it("keeps the opaque data of a lone redacted_thinking block", async () => {
    const { data } = await collectStream(parseStream("anthropic", frames(...REDACTED_ONLY)));
    const reasoning = reasoningOf(data);
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0].redacted).toBe(true);
    expect(reasoning[0].signature).toBe(OPAQUE);
    expect(reasoning[0].text).toBe("");
  });

  it("carries the flag and the payload on both boundary events", async () => {
    const events = await drain(parseStream("anthropic", frames(...REDACTED_ONLY)));
    const start = events.find((e) => e.type === "reasoning_start");
    const stop = events.find((e) => e.type === "reasoning_stop");
    expect(start).toMatchObject({ redacted: true, signature: OPAQUE });
    expect(stop).toMatchObject({ redacted: true, signature: OPAQUE });
    // No text ever streams for this block.
    expect(events.some((e) => e.type === "reasoning_delta")).toBe(false);
  });

  it("survives alongside a tool call", async () => {
    const { data } = await collectStream(parseStream("anthropic", frames(...REDACTED_WITH_TOOL)));
    expect(reasoningOf(data)[0]).toMatchObject({ redacted: true, signature: OPAQUE });
    expect(data.content.some((p) => p.type === "tool_use")).toBe(true);
    expect(data.stopReason).toBe("tool_use");
  });

  it("does not disturb an ordinary thinking block's text and signature", async () => {
    const ordinary = [
      frame("message_start", { message: { id: "m", model: "claude-x", usage: { input_tokens: 1, output_tokens: 0 } } }),
      frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
      frame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "step one" } }),
      frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig_abc" } }),
      frame("content_block_stop", { index: 0 }),
      frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
      frame("message_stop", {}),
    ];
    const { data } = await collectStream(parseStream("anthropic", frames(...ordinary)));
    const r = reasoningOf(data)[0];
    expect(r.text).toBe("step one");
    expect(r.signature).toBe("sig_abc");
    expect(r.redacted).toBeUndefined();
  });
});

describe("Anthropic -> Anthropic", () => {
  it("re-emits the block verbatim on a live relay", async () => {
    const events = parseStream("anthropic", frames(...REDACTED_ONLY));
    const out = await text(serializeStream("anthropic", events, { model: "svc" }));
    expect(out).toContain('"type":"redacted_thinking"');
    expect(out).toContain(`"data":"${OPAQUE}"`);
    // Never dressed up as a thinking block, and never given a fake signature.
    expect(out).not.toContain('"thinking_delta"');
    expect(out).not.toContain('"signature_delta"');
    expect(out).not.toContain('"type":"thinking"');
  });

  it("re-emits it after a buffer + fabricated replay (Reliable Streaming / Micro Agent)", async () => {
    const { data } = await collectStream(parseStream("anthropic", frames(...REDACTED_WITH_TOOL)));
    const out = await text(serializeStream("anthropic", fabricateStream(data, 1e9), { model: "svc" }));
    expect(out).toContain('"type":"redacted_thinking"');
    expect(out).toContain(`"data":"${OPAQUE}"`);
    expect(out).not.toContain('"type":"thinking"');
    // The tool call still rides along.
    expect(out).toContain('"name":"get_weather"');
  });

  it("still emits an ordinary thinking block with its deltas and signature", async () => {
    const data: ResponseData = {
      id: "r", model: "m", created: 1,
      content: [{ type: "reasoning", text: "thinking out loud", signature: "sig_1" }, { type: "text", text: "hi" }],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
    const out = await text(serializeStream("anthropic", fabricateStream(data, 1e9), { model: "svc" }));
    expect(out).toContain('"type":"thinking"');
    expect(out).toContain('"thinking_delta"');
    expect(out).toContain('"signature":"sig_1"');
    expect(out).not.toContain("redacted_thinking");
  });
});

describe("cross-family output never leaks the payload", () => {
  it("drops it on an OpenAI Chat Completions stream", async () => {
    const events = parseStream("anthropic", frames(...REDACTED_WITH_TOOL));
    const out = await text(serializeStream("openai_completion", events, { model: "svc" }));
    expect(out).not.toContain(OPAQUE);
    expect(out).not.toContain("redacted");
    // No invented reasoning text stands in for it.
    expect(out).not.toContain('"reasoning_content":""');
    expect(out).toContain('"name":"get_weather"');
  });

  it("wraps rather than leaks it on an OpenAI Responses stream to the client", async () => {
    const events = parseStream("anthropic", frames(...REDACTED_WITH_TOOL));
    const out = await text(serializeStream("openai_responses", events, { model: "svc" }));
    // The Anthropic bytes never appear verbatim...
    expect(out).not.toContain(OPAQUE);
    // ...they ride inside this proxy's own versioned envelope, which is what
    // lets the next turn hand the block back (see the round-trip suite below).
    expect(out).toContain("hydrogen-redacted-thinking-v1:");
    // No invented reasoning text stands in for it.
    expect(out).not.toContain("reasoning_summary_text.delta");
    expect(out).toContain('"name":"get_weather"');
  });

  it("wraps it in a buffered Responses body, and never sends it to Chat Completions", async () => {
    const { data } = await collectStream(parseStream("anthropic", frames(...REDACTED_ONLY)));
    const { buildResponse } = await import("../src/core/format");
    const canonical = buildResponse("anthropic", data);

    // Chat Completions has no field that survives a replay, so it gets nothing.
    const chat = JSON.stringify(canonical.render("openai_completion", "svc"));
    expect(chat).not.toContain(OPAQUE);
    expect(chat).not.toContain("hydrogen-redacted-thinking-v1:");

    const responses = JSON.stringify(canonical.render("openai_responses", "svc"));
    expect(responses).not.toContain(OPAQUE);
    expect(responses).toContain("hydrogen-redacted-thinking-v1:");

    // ...while its own family still gets the real block back.
    const anthropic = JSON.stringify(canonical.render("anthropic", "svc"));
    expect(anthropic).toContain("redacted_thinking");
    expect(anthropic).toContain(OPAQUE);
  });

  it("is not replayed into an OpenAI-family request body either", async () => {
    const { data } = await collectStream(parseStream("anthropic", frames(...REDACTED_WITH_TOOL)));
    const { AnthropicRequest, OpenAICompletionRequest, OpenAIResponsesRequest } = await import("../src/core/format");
    // A follow-up turn: the assistant's redacted block replayed back upstream.
    const base = AnthropicRequest.parse({
      model: "svc",
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", content: [{ type: "redacted_thinking", data: OPAQUE }, { type: "text", text: "checking" }] },
      ],
    });

    const anthropic = JSON.stringify(AnthropicRequest.construct(base).render({ upstreamModel: "up" }));
    expect(anthropic).toContain(OPAQUE); // same family: replayed

    const chat = JSON.stringify(OpenAICompletionRequest.construct(base).render({ upstreamModel: "up" }));
    expect(chat).not.toContain(OPAQUE);
    expect(chat).not.toContain('"reasoning_content"');

    const responses = JSON.stringify(OpenAIResponsesRequest.construct(base).render({ upstreamModel: "up" }));
    expect(responses).not.toContain(OPAQUE);
    expect(responses).not.toContain("encrypted_content");
    expect(data.content.some((p) => p.type === "reasoning")).toBe(true); // sanity
  });
});

describe("round trip through an OpenAI Responses client", () => {
  /** The whole point of the envelope: an Anthropic upstream requires the turn's
   * thinking blocks back when that turn called tools. With an OpenAI-format
   * client in the middle, the block has to survive a hop it has no native form
   * in -- otherwise the next turn is rejected with "thinking must be passed
   * back", which is exactly the 400 class this exists to prevent. */
  it("restores the original Anthropic block after the client replays it", async () => {
    const { buildResponse, AnthropicRequest, OpenAIResponsesRequest } = await import("../src/core/format");

    // 1. Anthropic upstream answers with a redacted block plus a tool call.
    const { data } = await collectStream(parseStream("anthropic", frames(...REDACTED_WITH_TOOL)));
    // 2. Hydrogen renders that to its Responses client.
    const toClient = buildResponse("anthropic", data).render("openai_responses", "svc") as {
      output: Array<Record<string, unknown>>;
    };
    const reasoningItem = toClient.output.find((o) => o.type === "reasoning");
    expect(reasoningItem).toBeDefined();
    expect(String(reasoningItem!.encrypted_content)).toContain("hydrogen-redacted-thinking-v1:");

    // 3. The client sends the next turn back with that item replayed verbatim.
    const nextTurn = OpenAIResponsesRequest.parse({
      model: "svc",
      input: [
        { role: "user", content: [{ type: "input_text", text: "weather?" }] },
        reasoningItem,
        { type: "function_call", call_id: "toolu_9", name: "get_weather", arguments: '{"city":"Beijing"}' },
        { type: "function_call_output", call_id: "toolu_9", output: "20C" },
      ],
    });

    // 4. Rendered for an Anthropic upstream, the real block is back, byte for byte.
    const upstream = JSON.stringify(AnthropicRequest.construct(nextTurn).render({ upstreamModel: "up" }));
    expect(upstream).toContain('"type":"redacted_thinking"');
    expect(upstream).toContain(OPAQUE);
    // The envelope itself never reaches a provider.
    expect(upstream).not.toContain("hydrogen-redacted-thinking-v1:");
  });

  it("does not forward the envelope to a real Responses upstream", async () => {
    const { OpenAIResponsesRequest } = await import("../src/core/format");
    const { encodeRedacted } = await import("../src/core/format/reasoningBridge");
    const envelope = encodeRedacted({ type: "reasoning", text: "", redacted: true, signature: OPAQUE });
    const req = OpenAIResponsesRequest.parse({
      model: "svc",
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: envelope },
      ],
    });
    // A Responses provider cannot decrypt another vendor's payload, so it is
    // dropped for that egress -- unwrapped first, then discarded as redacted.
    const body = JSON.stringify(OpenAIResponsesRequest.construct(req).render({ upstreamModel: "up" }));
    expect(body).not.toContain("hydrogen-redacted-thinking-v1:");
    expect(body).not.toContain(OPAQUE);
  });

  it("leaves a provider's own encrypted_content alone", async () => {
    const { OpenAIResponsesRequest } = await import("../src/core/format");
    const req = OpenAIResponsesRequest.parse({
      model: "svc",
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thought" }], encrypted_content: "gAAAAAreal-openai-payload" },
      ],
    });
    const body = JSON.stringify(OpenAIResponsesRequest.construct(req).render({ upstreamModel: "up" }));
    expect(body).toContain("gAAAAAreal-openai-payload");
    expect(body).toContain("thought");
  });

  it("degrades to dropping the block when the envelope is unreadable", async () => {
    const { OpenAIResponsesRequest, AnthropicRequest } = await import("../src/core/format");
    const req = OpenAIResponsesRequest.parse({
      model: "svc",
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "hydrogen-redacted-thinking-v1:!!!not-base64-json!!!" },
      ],
    });
    // Treated as an ordinary opaque payload rather than corrupting the request:
    // it round-trips as a normal signature, and nothing throws.
    const body = JSON.stringify(AnthropicRequest.construct(req).render({ upstreamModel: "up" }));
    expect(body).toContain("hi");
  });
});

describe("thinking: disabled", () => {
  it("filters redacted blocks out of a live stream like any other reasoning", async () => {
    const events = await drain(withoutReasoning(parseStream("anthropic", frames(...REDACTED_WITH_TOOL))));
    expect(events.some((e) => e.type.startsWith("reasoning"))).toBe(false);
    const out = await text(serializeStream("anthropic", replay(events), { model: "svc" }));
    expect(out).not.toContain(OPAQUE);
    expect(out).toContain('"name":"get_weather"');
  });

  it("filters them out of a buffered response too", async () => {
    const { data } = await collectStream(parseStream("anthropic", frames(...REDACTED_ONLY)));
    const { buildResponse } = await import("../src/core/format");
    const stripped = buildResponse("anthropic", data).withoutReasoning();
    expect(stripped.content.some((p) => p.type === "reasoning")).toBe(false);
    expect(JSON.stringify(stripped.render("anthropic", "svc"))).not.toContain(OPAQUE);
  });
});
