import { describe, expect, it } from "vitest";
import { sendBuffered } from "@areelai/model-services";
import { AnthropicRequest, OpenAICompletionRequest, OpenAIResponsesRequest, parseStream } from "@areelai/wire-format";
import { collectStream, type StreamEvent } from "@areelai/wire-format";
import { applyThinkingFormat, withThinkingFormat } from "@areelai/wire-format";
import type { Transport } from "../src/upstream/transport.js";
import { missingAnswerReason, requireAnswer } from "@areelai/wire-format";

async function* source<T>(values: T[]) { yield* values; }
const wire = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const message = (text: string, type = "output_text", id = "msg1") => ({ type: "message", id, role: "assistant", content: [{ type, ...(type === "refusal" ? { refusal: text } : { text }) }] });
const complete = (output: unknown[]) => ({ type: "response.completed", response: { id: "r1", status: "completed", model: "m", output } });
const read = async (frames: unknown[]) => (await collectStream(parseStream("openai_responses", source(frames.map(wire))))).data;

describe("Responses terminal content recovery", () => {
  it("restores tool calls and thinking carried only by response.completed", async () => {
    const data = await read([complete([
      { type: "reasoning", id: "rs1", summary: [{ type: "summary_text", text: "thought" }], encrypted_content: "sig" },
      { type: "function_call", id: "fc1", call_id: "c1", name: "lookup", arguments: '{"q":"hello"}' },
    ])]);
    expect(data.stopReason).toBe("tool_use");
    expect(data.content).toEqual([
      { type: "reasoning", origin: "openai_responses", itemId: "rs1", text: "thought", signature: "sig" },
      { type: "tool_use", id: "c1", name: "lookup", input: { q: "hello" } },
    ]);
  });
  it("fills missing tool arguments and does not replay the terminal tool call", async () => {
    const tool = { type: "function_call", id: "fc1", call_id: "c1", name: "lookup", arguments: '{"q":"hello"}' };
    const data = await read([
      { type: "response.output_item.added", item: { ...tool, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc1", delta: '{"q":' },
      { type: "response.output_item.done", item: tool }, complete([tool]),
    ]);
    expect(data.content).toEqual([{ type: "tool_use", id: "c1", name: "lookup", input: { q: "hello" } }]);
  });
  it.each(["text.done", "item.done", "completed"])("recovers an answer carried only by %s", async location => {
    const text = "The answer is here.";
    const frames = location === "text.done" ? [{ type: "response.output_text.done", item_id: "msg1", content_index: 0, text }]
      : location === "item.done" ? [{ type: "response.output_item.done", output_index: 0, item: message(text) }] : [];
    const data = await read([...frames, complete([message(text)])]);
    expect(data.content).toEqual([{ type: "text", text }]);
  });
  it("fills a missing suffix exactly once across all snapshots", async () => {
    const data = await read([
      { type: "response.output_text.delta", item_id: "msg1", output_index: 0, content_index: 0, delta: "Hello " },
      { type: "response.output_text.done", item_id: "msg1", output_index: 0, content_index: 0, text: "Hello world" },
      { type: "response.output_item.done", output_index: 0, item: message("Hello world") },
      complete([message("Hello world")]),
    ]);
    expect(data.content).toEqual([{ type: "text", text: "Hello world" }]);
  });
  it("preserves every content part when only one streamed deltas", async () => {
    const item = message("first");
    item.content.push({ type: "output_text", text: "second" });
    const data = await read([{ type: "response.output_text.delta", item_id: "msg1", content_index: 0, delta: "first" }, complete([item, message("third", "output_text", "msg2")])]);
    expect(data.content).toEqual([{ type: "text", text: "firstsecondthird" }]);
  });
  it.each([true, false])("preserves refusal text (deltas: %s)", async deltas => {
    const refusal = "I cannot help with that request.";
    const data = await read([
      ...(deltas ? [{ type: "response.refusal.delta", item_id: "msg1", content_index: 0, delta: refusal }] : []),
      { type: "response.refusal.done", item_id: "msg1", content_index: 0, refusal },
      complete([message(refusal, "refusal")]),
    ]);
    expect(data.content).toEqual([{ type: "text", text: refusal }]);
  });
});

it("preserves Chat refusal deltas", async () => {
  const { data } = await collectStream(parseStream("openai_completion", source([
    wire({ choices: [{ delta: { refusal: "Cannot help." }, finish_reason: "stop" }] }), "data: [DONE]\n\n",
  ])));
  expect(data.content).toEqual([{ type: "text", text: "Cannot help." }]);
});

it("retains text and thinking delivered in Anthropic block_start", async () => {
  const frames = [
    { type: "message_start", message: { id: "m", model: "m" } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "thought", signature: "sig" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "Hello" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: " world" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" },
  ];
  const { data } = await collectStream(parseStream("anthropic", source(frames.map(wire))));
  expect(data.content).toEqual([{ type: "reasoning", text: "thought", signature: "sig", origin: "anthropic", itemId: undefined }, { type: "text", text: "Hello world" }]);
});

describe("thinking format must not swallow the answer", () => {
  for (const tag of ["think", "thinking", "reasoning"]) {
    it.each([1, 4, 100])(`recognizes whitespace in </${tag} > across %s-character deltas`, async size => {
      const raw = `<${tag}>thought</${tag} \n >\n\nanswer`;
      const chunks: StreamEvent[] = [];
      for (let i = 0; i < raw.length; i += size) chunks.push({ type: "text_delta", text: raw.slice(i, i + size) });
      chunks.push({ type: "finish", stopReason: "stop" });
      const { data } = await collectStream(withThinkingFormat(source(chunks), "none"));
      expect(data.content).toEqual(applyThinkingFormat([{ type: "text", text: raw }], "none"));
      expect(data.content).toEqual([{ type: "text", text: "answer" }]);
    });
  }
  it("usage snapshots do not close a thinking block", async () => {
    const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
    const events: StreamEvent[] = [
      { type: "text_delta", text: "<think>first" }, { type: "usage", usage },
      { type: "text_delta", text: " second</think>answer" }, { type: "finish", stopReason: "stop", usage },
    ];
    const { data } = await collectStream(withThinkingFormat(source(events), "none"));
    expect(data.content).toEqual([{ type: "text", text: "answer" }]);
    expect(data.usage).toEqual(usage);
  });
  it("usage snapshots do not split inlined thinking tags", async () => {
    const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
    const events: StreamEvent[] = [
      { type: "reasoning_delta", text: "first" }, { type: "usage", usage },
      { type: "reasoning_delta", text: " second" }, { type: "reasoning_stop" },
      { type: "text_delta", text: "answer" }, { type: "finish", stopReason: "stop", usage },
    ];
    const { data } = await collectStream(withThinkingFormat(source(events), "think_tags"));
    expect(data.content).toEqual([{ type: "text", text: "<think>\nfirst second\n</think>\n\nanswer" }]);
  });
});

describe("HTTP 200 with invalid JSON response shape", () => {
  for (const Req of [OpenAICompletionRequest, AnthropicRequest, OpenAIResponsesRequest]) {
    it.each([{}, [], { error: { message: "provider unavailable" } }])(`${Req.name} rejects %j instead of returning empty success`, async json => {
      const transport: Transport = {
        async postJson() { return { status: 200, headers: {}, json, text: JSON.stringify(json) }; },
        async postStream() { throw Error("unexpected stream"); },
      };
      const result = await sendBuffered(Req.parse({ messages: [], input: [] }), transport, { url: "http://unused", upstreamModel: "m", headers: {}, timeoutMs: 1000 });
      expect(result).toMatchObject({ ok: false, status: 502 });
    });
  }
});

describe("empty answer diagnostics", () => {
  it("distinguishes an empty response, thinking alone, and output exhaustion", () => {
    expect(missingAnswerReason([], "stop")).toContain("no answer");
    expect(missingAnswerReason([{ type: "reasoning", text: "thought" }], "stop")).toContain("thinking but no answer");
    expect(missingAnswerReason([{ type: "reasoning", text: "thought" }], "length")).toContain("output token limit");
    expect(missingAnswerReason([{ type: "tool_use", id: "c", name: "f", input: {} }], "tool_use")).toBeUndefined();
    expect(missingAnswerReason([], "content_filter")).toBeUndefined();
  });
  it("preserves accounting when the stream finishes without an answer", async () => {
    const usage = { promptTokens: 100, completionTokens: 20, totalTokens: 120, reasoningTokens: 20, cachedInputTokens: 80 };
    const events: StreamEvent[] = [{ type: "reasoning_delta", text: "thought" }, { type: "finish", stopReason: "length", usage }];
    const result: StreamEvent[] = [];
    for await (const e of requireAnswer(source(events))) result.push(e);
    expect(result.at(-1)).toEqual({ type: "finish", stopReason: "length", usage, error: "upstream exhausted the output token limit before producing an answer or tool call" });
  });
});
