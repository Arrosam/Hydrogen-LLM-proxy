import { describe, expect, it } from "vitest";
import { buildResponse, parseRequest, parseResponse, parseStream, serializeStream } from "../src/core/format";
import type { ContentPart } from "../src/core/ir/content";
import { collectStream, type StreamEvent } from "../src/core/ir/stream";
import { withThinkingFormat } from "../src/core/ir/thinkingFormat";
import { requireThinkingReplay, thinkingReplayError, ThinkingReplayError, THINKING_REPLAY_ERROR } from "../src/core/ir/thinkingReplay";

const THOUGHT = "private thought, never in a rejection";
const SIGNATURE = "provider-signature-exact-bytes";
const REDACTED = "opaque-redacted-exact-bytes";
const blocks = [
  { type: "thinking", thinking: THOUGHT, signature: SIGNATURE },
  { type: "redacted_thinking", data: REDACTED },
  { type: "tool_use", id: "call1", name: "lookup", input: { city: "Paris" } },
];
const anthropicBody = { id: "up", model: "up", content: blocks, stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 9 } };
const frame = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
async function* source<T>(values: T[]): AsyncGenerator<T> { yield* values; }
async function drain<T>(events: AsyncGenerator<T>): Promise<T[]> { const out: T[] = []; for await (const ev of events) out.push(ev); return out; }

function continuation(content: unknown) {
  return parseRequest("anthropic", { model: "svc", max_tokens: 64, messages: [
    { role: "user", content: "Find Paris" }, { role: "assistant", content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call1", content: "found" }] },
  ] }).render({ upstreamModel: "up" });
}

function anthropicFrames(): string[] {
  return [
    frame("message_start", { message: { id: "up", model: "up", usage: { input_tokens: 5 } } }),
    frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
    frame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: THOUGHT } }),
    frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: SIGNATURE } }),
    frame("content_block_stop", { index: 0 }),
    frame("content_block_start", { index: 1, content_block: blocks[1] }),
    frame("content_block_stop", { index: 1 }),
    frame("content_block_start", { index: 2, content_block: blocks[2] }),
    frame("content_block_stop", { index: 2 }),
    frame("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }),
    frame("message_stop", {}),
  ];
}

describe("stateless reasoning replay safety", () => {
  it.each(["none", "think_tags"] as const)("rejects %s before signed/redacted tool output is formatted", format => {
    const response = parseResponse("anthropic", anthropicBody);
    expect(thinkingReplayError(response.content, format, "anthropic")).toBe(THINKING_REPLAY_ERROR);
    expect(THINKING_REPLAY_ERROR).toContain("requires original/native reasoning format or stateful");
    expect(THINKING_REPLAY_ERROR).not.toContain(THOUGHT);
    expect(response.content[0]).toMatchObject({ signature: SIGNATURE, text: THOUGHT });
  });

  it.each(["original", "reasoning", "reasoning_content"] as const)("%s preserves signed/redacted parse → format → request roundtrip", format => {
    const response = parseResponse("anthropic", anthropicBody);
    expect(thinkingReplayError(response.content, format, "anthropic")).toBeUndefined();
    const delivered = response.withThinkingFormat(format).render("anthropic", "svc", { thinkingFormat: format });
    const request = continuation(delivered.content) as { messages: Array<{ content: unknown }> };
    expect(request.messages[1].content).toEqual(blocks);
  });

  it.each(["original", "reasoning", "reasoning_content"] as const)("%s preserves real streamed signatures and redacted bytes on replay", async format => {
    const guarded = requireThinkingReplay(parseStream("anthropic", source(anthropicFrames())), format, "anthropic");
    const wire = serializeStream("anthropic", withThinkingFormat(guarded, format), { model: "svc", thinkingFormat: format });
    const replay = await collectStream(parseStream("anthropic", wire));
    expect(replay.incomplete).toBe(false);
    expect(replay.data.content).toContainEqual({ type: "reasoning", text: THOUGHT, origin: "anthropic", signature: SIGNATURE, itemId: undefined });
    // The collected client stream is turned back into a normal assistant
    // message exactly as an SDK would do before sending the tool result.
    const content = buildResponse("anthropic", replay.data).render("anthropic", "svc").content;
    expect((continuation(content) as { messages: Array<{ content: unknown }> }).messages[1].content).toEqual(blocks);
  });

  it.each(["none", "think_tags"] as const)("streamed %s cancels at the first native block, before late signatures or tool calls", async format => {
    let reads = 0, closed = false;
    async function* upstream() { try { for (const f of anthropicFrames()) { reads++; yield f; } } finally { closed = true; } }
    const received: StreamEvent[] = [];
    await expect((async () => { for await (const ev of withThinkingFormat(requireThinkingReplay(parseStream("anthropic", upstream()), format, "anthropic"), format)) received.push(ev); })()).rejects.toBeInstanceOf(ThinkingReplayError);
    expect(received.map(ev => ev.type)).toEqual(["start"]);
    expect(reads).toBe(2);
    expect(closed).toBe(true);
  });

  it("rejects unsigned Anthropic ordinary turns, including missing-origin canonical responses", async () => {
    const response = parseResponse("anthropic", { ...anthropicBody, content: [{ type: "thinking", thinking: THOUGHT }, { type: "text", text: "answer" }], stop_reason: "end_turn" });
    expect(thinkingReplayError(response.content, "none", "anthropic")).toBe(THINKING_REPLAY_ERROR);
    expect(thinkingReplayError([{ type: "reasoning", text: THOUGHT }], "think_tags", "anthropic")).toBe(THINKING_REPLAY_ERROR);
    await expect(drain(requireThinkingReplay(source([{ type: "reasoning_delta", text: THOUGHT }]), "none", "anthropic"))).rejects.toMatchObject({ statusCode: 400 });
  });

  it("protects Responses encrypted items, including metadata-only reasoning", () => {
    const response = parseResponse("openai_responses", { id: "r", status: "completed", output: [
      { type: "reasoning", id: "rs_original", encrypted_content: "encrypted-original", summary: [] },
      { type: "function_call", id: "fc1", call_id: "call1", name: "lookup", arguments: "{}" },
    ] });
    for (const format of ["none", "think_tags"] as const) expect(thinkingReplayError(response.content, format, "openai_responses")).toBe(THINKING_REPLAY_ERROR);
    const native = response.withThinkingFormat("original").render("openai_responses", "svc");
    const replay = parseRequest("openai_responses", { model: "svc", input: [...native.output as unknown[], { type: "function_call_output", call_id: "call1", output: "ok" }] }).render({ upstreamModel: "up" });
    expect(replay.input).toContainEqual({ type: "reasoning", id: "rs_original", encrypted_content: "encrypted-original", summary: [] });
  });

  it.each([
    { type: "reasoning", text: THOUGHT, signature: SIGNATURE },
    { type: "reasoning", text: "", redacted: true },
    { type: "reasoning", text: "", itemId: "rs_replay" },
    { type: "reasoning", text: THOUGHT, origin: "anthropic" },
  ] satisfies ContentPart[])("protects replay metadata even on Chat upstreams: %j", part => {
    expect(thinkingReplayError([part], "none", "openai_completion")).toBe(THINKING_REPLAY_ERROR);
  });

  it.each(["none", "think_tags"] as const)("%s rejects late Chat replay metadata before the following tool and keeps usage snapshots", async format => {
    const observed: StreamEvent[] = [];
    const events: StreamEvent[] = [
      { type: "start", id: "up", model: "up", created: 1 },
      { type: "reasoning_delta", text: THOUGHT },
      { type: "usage", usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } },
      { type: "reasoning_stop", signature: SIGNATURE },
      { type: "tool_start", index: 0, id: "call1", name: "lookup" },
    ];
    await expect((async () => { for await (const event of withThinkingFormat(requireThinkingReplay(source(events), format, "openai_completion"), format)) observed.push(event); })()).rejects.toMatchObject({ statusCode: 400 });
    expect(observed.some(event => event.type === "tool_start")).toBe(false);
    expect(observed).toContainEqual(events[2]);
    if (format === "none") expect(JSON.stringify(observed)).not.toContain(THOUGHT);
    expect(JSON.stringify(observed)).not.toContain(SIGNATURE);
  });

  it("permits lossy native textual Chat thinking, not just responses without reasoning", async () => {
    const body = parseResponse("openai_completion", { choices: [{ message: { content: "answer", reasoning_content: THOUGHT }, finish_reason: "stop" }] });
    for (const format of ["none", "think_tags"] as const) {
      expect(thinkingReplayError(body.content, format, "openai_completion")).toBeUndefined();
      const events: StreamEvent[] = [{ type: "reasoning_delta", text: THOUGHT }, { type: "text_delta", text: "answer" }, { type: "finish", stopReason: "stop" }];
      const result = await drain(withThinkingFormat(requireThinkingReplay(source(events), format, "openai_completion"), format));
      expect(result.some(ev => ev.type === "text_delta" && ev.text === "answer")).toBe(true);
    }
    // An explicit textual Chat origin wins over the fallback upstream family.
    expect(thinkingReplayError([{ type: "reasoning", origin: "openai_completion", text: THOUGHT }], "none", "anthropic")).toBeUndefined();
    const explicitChat: StreamEvent[] = [
      { type: "reasoning_start", origin: "openai_completion" }, { type: "reasoning_delta", text: THOUGHT }, { type: "reasoning_stop" },
    ];
    expect(await drain(requireThinkingReplay(source(explicitChat), "none", "anthropic"))).toEqual(explicitChat);
  });
});
