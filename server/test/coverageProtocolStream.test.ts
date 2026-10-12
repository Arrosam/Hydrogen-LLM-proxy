/**
 * Stream coverage: SSE framing variants, the collector and tap state machines
 * at their edges, Chat tool-call deltas, and usage that arrives late or does
 * not add up.
 */
import { describe, expect, it } from "vitest";
import { buildResponse, parseResponse, parseStream } from "../src/core/format";
import { collectStream, newAccumulator, parseSSE, tapStream, type SSEFrame, type StreamEvent } from "../src/core/ir/stream";
import { addUsage, uncachedPromptTokens, type Usage } from "../src/core/ir/usage";
import { openAiCachedTokens } from "../src/core/format/wire";

type Json = Record<string, any>;
async function* chunks(...parts: string[]): AsyncGenerator<string> { for (const part of parts) yield part; }
async function* events(...list: StreamEvent[]): AsyncGenerator<StreamEvent> { for (const ev of list) yield ev; }
const framesOf = async (...parts: string[]): Promise<SSEFrame[]> => { const out: SSEFrame[] = []; for await (const f of parseSSE(chunks(...parts))) out.push(f); return out; };
const collect = (...list: StreamEvent[]) => collectStream(events(...list));
const textOf = (data: { content: Array<{ type: string }> }): string => data.content.filter(p => p.type === "text").map(p => (p as unknown as { text: string }).text).join("");
const start: StreamEvent = { type: "start", id: "r", model: "up", created: 1 };
const finish: StreamEvent = { type: "finish", stopReason: "stop" };
const USAGE: Usage = { promptTokens: 3, completionTokens: 2, totalTokens: 5 };

const OK_FRAMES = [
  'data: {"id":"c","model":"up","choices":[{"delta":{"role":"assistant"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
  "data: [DONE]\n\n",
];
const chat = (...parts: string[]) => collectStream(parseStream("openai_completion", chunks(...parts)));

describe("EP: SSE framing variants", () => {
  it("reads CRLF-framed events", async () => {
    const { data, incomplete } = await chat(...OK_FRAMES.map(f => f.replace(/\n/g, "\r\n")));
    expect(incomplete).toBe(false); expect(textOf(data)).toBe("hello"); expect(data.stopReason).toBe("stop"); expect(data.usage).toEqual(USAGE);
  });

  it("reads CRLF-framed events that carry an event line", async () => {
    const { data, incomplete } = await chat(...OK_FRAMES.map(f => `event: message\r\n${f.replace(/\n/g, "\r\n")}`));
    expect(incomplete).toBe(false); expect(textOf(data)).toBe("hello");
    expect(await framesOf('event: thing\r\ndata: {"a":1}\r\n\r\n')).toEqual([{ event: "thing", data: '{"a":1}' }]);
  });

  it("reads CRLF frames split at any byte, including inside the separator", async () => {
    const wire = OK_FRAMES.map(f => f.replace(/\n/g, "\r\n")).join("");
    for (const size of [1, 2, 3, 5]) {
      const parts: string[] = []; for (let i = 0; i < wire.length; i += size) parts.push(wire.slice(i, i + size));
      const { data, incomplete } = await chat(...parts);
      expect(incomplete).toBe(false); expect(textOf(data)).toBe("hello");
    }
  });

  it("skips comment-only keep-alive frames", async () => {
    const withPings = OK_FRAMES.flatMap(f => [": ping\n\n", f]);
    const { data, incomplete } = await chat(...withPings);
    expect(incomplete).toBe(false); expect(textOf(data)).toBe("hello"); expect(data.usage).toEqual(USAGE);
    expect(await framesOf(': keep-alive\ndata: {"a":1}\n\n')).toEqual([{ event: undefined, data: '{"a":1}' }]);
  });

  it("reads a data line with no space after the colon", async () => {
    expect(await framesOf('data:{"a":1}\n\n')).toEqual([{ event: undefined, data: '{"a":1}' }]);
    const { data } = await chat(...OK_FRAMES.map(f => f.replace("data: ", "data:")));
    expect(textOf(data)).toBe("hello");
  });

  it("strips only one leading space from a data line", async () => {
    expect((await framesOf("data:  two\n\n"))[0]!.data).toBe(" two");
  });

  it("joins several data lines of one frame with a newline", async () => {
    expect(await framesOf("event: e\ndata: one\ndata: two\n\n")).toEqual([{ event: "e", data: "one\ntwo" }]);
  });

  it("yields a final frame that has no trailing blank line", async () => {
    expect(await framesOf('data: {"a":1}\n\ndata: {"b":2}')).toEqual([{ event: undefined, data: '{"a":1}' }, { event: undefined, data: '{"b":2}' }]);
    const { data, incomplete } = await chat(...OK_FRAMES.slice(0, 4), "data: [DONE]");
    expect(incomplete).toBe(false); expect(textOf(data)).toBe("hello");
  });

  it("yields nothing for an empty or blank body", async () => {
    expect(await framesOf()).toEqual([]);
    expect(await framesOf("\n\n\n\n", "  \n\n")).toEqual([]);
  });
});

describe("ST: collectStream edge transitions", () => {
  it("creates a reasoning part from a delta that had no start", async () => {
    const { data } = await collect(start, { type: "reasoning_delta", text: "hm" }, { type: "reasoning_delta", text: "m" }, finish);
    expect(data.content).toEqual([{ type: "reasoning", text: "hmm" }]);
  });

  it("keeps a signature-only reasoning block and drops an empty one", async () => {
    const kept = await collect(start, { type: "reasoning_stop", id: "rs_1", signature: "sig", origin: "anthropic" }, finish);
    expect(kept.data.content).toEqual([{ type: "reasoning", text: "", itemId: "rs_1", origin: "anthropic", signature: "sig" }]);
    const dropped = await collect(start, { type: "reasoning_start" }, { type: "reasoning_stop" }, { type: "text_delta", text: "a" }, finish);
    expect(dropped.data.content).toEqual([{ type: "text", text: "a" }]);
  });

  it("starts a new reasoning part after a stop", async () => {
    const { data } = await collect(start, { type: "reasoning_start" }, { type: "reasoning_delta", text: "one" }, { type: "reasoning_stop" },
      { type: "reasoning_start" }, { type: "reasoning_delta", text: "two" }, { type: "reasoning_stop" }, finish);
    expect(data.content.map(p => (p as { text: string }).text)).toEqual(["one", "two"]);
  });

  it("ignores tool arguments for an index that never started", async () => {
    const { data } = await collect(start, { type: "tool_args_delta", index: 3, delta: '{"a":1}' }, { type: "text_delta", text: "a" }, finish);
    expect(data.content).toEqual([{ type: "text", text: "a" }]);
  });

  it("keeps unparsable tool arguments as the raw string and reads none as an empty object", async () => {
    const { data } = await collect(start,
      { type: "tool_start", index: 0, id: "c0", name: "broken" }, { type: "tool_args_delta", index: 0, delta: '{"a":' },
      { type: "tool_start", index: 1, id: "c1", name: "bare" },
      { type: "tool_start", index: 2, id: "c2", name: "split" }, { type: "tool_args_delta", index: 2, delta: '{"a"' }, { type: "tool_args_delta", index: 2, delta: ":1}" },
      { type: "finish", stopReason: "tool_use" });
    expect(data.content).toEqual([
      { type: "tool_use", id: "c0", name: "broken", input: '{"a":' },
      { type: "tool_use", id: "c1", name: "bare", input: {} },
      { type: "tool_use", id: "c2", name: "split", input: { a: 1 } },
    ]);
  });

  it("orders content as reasoning, text, then tool calls, whatever order they arrived in", async () => {
    const { data } = await collect(start,
      { type: "tool_start", index: 0, id: "c0", name: "f" }, { type: "tool_args_delta", index: 0, delta: "{}" },
      { type: "text_delta", text: "after" }, { type: "reasoning_delta", text: "late" }, { type: "finish", stopReason: "tool_use" });
    expect(data.content.map(p => p.type)).toEqual(["reasoning", "text", "tool_use"]);
    expect(textOf(data)).toBe("after");
  });

  it("keeps an earlier usage event when the finish carries none", async () => {
    const { data, incomplete } = await collect(start, { type: "usage", usage: USAGE }, { type: "text_delta", text: "a" }, finish);
    expect(incomplete).toBe(false); expect(data.usage).toEqual(USAGE);
  });

  it("prefers the finish event's usage over an earlier one", async () => {
    const final: Usage = { promptTokens: 9, completionTokens: 9, totalTokens: 18 };
    expect((await collect(start, { type: "usage", usage: USAGE }, { type: "finish", stopReason: "stop", usage: final })).data.usage).toEqual(final);
  });

  it("reports zero usage and incomplete for a stream with no finish", async () => {
    const { data, incomplete } = await collect(start, { type: "text_delta", text: "a" });
    expect(incomplete).toBe(true); expect(data.stopReason).toBeNull();
    expect(data.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0, incomplete: true });
  });
});

describe("ST: tapStream accounting", () => {
  const tap = async (...list: StreamEvent[]) => {
    const acc = newAccumulator(); const seen: StreamEvent[] = [];
    for await (const ev of tapStream(events(...list), acc)) seen.push(ev);
    return { acc, seen };
  };

  it("marks usage incomplete from a usage event until the finish confirms it", async () => {
    const acc = newAccumulator();
    const tapped = tapStream(events(start, { type: "usage", usage: USAGE }, { type: "finish", stopReason: "stop", usage: USAGE }), acc);
    await tapped.next(); await tapped.next();
    expect(acc.usage).toEqual({ ...USAGE, incomplete: true }); expect(acc.incomplete).toBe(false);
    await tapped.next();
    expect(acc.usage).toEqual({ ...USAGE, incomplete: false }); expect(acc.stopReason).toBe("stop");
  });

  it("keeps the usage event's numbers when the finish carries none", async () => {
    const { acc } = await tap(start, { type: "usage", usage: USAGE }, finish);
    expect(acc.usage).toEqual({ ...USAGE, incomplete: true }); expect(acc.incomplete).toBe(false);
  });

  it("records a finish error as an incomplete run", async () => {
    const { acc } = await tap(start, { type: "text_delta", text: "a" }, { type: "finish", stopReason: "stop", usage: USAGE, error: "empty answer" });
    expect(acc.incomplete).toBe(true); expect(acc.error).toBe("empty answer"); expect(acc.usage).toEqual({ ...USAGE, incomplete: false });
  });

  it("records a truncated finish as incomplete, usage included", async () => {
    const { acc } = await tap(start, { type: "finish", stopReason: null, usage: USAGE, incomplete: true });
    expect(acc.incomplete).toBe(true); expect(acc.error).toBeUndefined(); expect(acc.usage).toEqual({ ...USAGE, incomplete: true });
  });

  it("passes every event through untouched while accumulating text, reasoning and tool arguments", async () => {
    const list: StreamEvent[] = [start, { type: "reasoning_delta", text: "hm" }, { type: "text_delta", text: "a" }, { type: "text_delta", text: "b" },
      { type: "tool_start", index: 0, id: "c0", name: "f" }, { type: "tool_args_delta", index: 0, delta: '{"a"' }, { type: "tool_args_delta", index: 0, delta: ":1}" },
      { type: "tool_args_delta", index: 9, delta: "ignored" }, { type: "finish", stopReason: "tool_use" }];
    const { acc, seen } = await tap(...list);
    expect(seen).toEqual(list);
    expect(acc).toMatchObject({ text: "ab", reasoning: "hm", upstreamModel: "up", stopReason: "tool_use", toolCalls: [{ name: "f", args: '{"a":1}' }] });
  });
});

describe("ST: Chat stream tool-call deltas", () => {
  const chunk = (delta: Json, extra: Json = {}): string => `data: ${JSON.stringify({ choices: [{ index: 0, delta, ...extra }] })}\n\n`;
  const call = (index: number | undefined, id: string | undefined, name: string | undefined, args?: string): Json =>
    ({ ...(index === undefined ? {} : { index }), ...(id ? { id, type: "function" } : {}), function: { ...(name ? { name } : {}), ...(args === undefined ? {} : { arguments: args }) } });
  const done = [chunk({}, { finish_reason: "tool_calls" }), "data: [DONE]\n\n"];
  const tools = (data: { content: Array<{ type: string }> }) => data.content.filter(p => p.type === "tool_use");

  it("assembles two parallel calls from interleaved argument chunks", async () => {
    const { data, incomplete } = await chat(
      chunk({ tool_calls: [call(0, "call_a", "first", ""), call(1, "call_b", "second", "")] }),
      chunk({ tool_calls: [call(0, undefined, undefined, '{"x"')] }),
      chunk({ tool_calls: [call(1, undefined, undefined, '{"y"')] }),
      chunk({ tool_calls: [call(0, undefined, undefined, ":1}")] }),
      chunk({ tool_calls: [call(1, undefined, undefined, ":2}")] }),
      ...done);
    expect(incomplete).toBe(false); expect(data.stopReason).toBe("tool_use");
    expect(tools(data)).toEqual([
      { type: "tool_use", id: "call_a", name: "first", input: { x: 1 } },
      { type: "tool_use", id: "call_b", name: "second", input: { y: 2 } },
    ]);
  });

  it("treats a tool-call delta with no index as index 0", async () => {
    const { data } = await chat(chunk({ tool_calls: [call(undefined, "call_a", "first", '{"x":')] }), chunk({ tool_calls: [call(undefined, undefined, undefined, "1}")] }), ...done);
    expect(tools(data)).toEqual([{ type: "tool_use", id: "call_a", name: "first", input: { x: 1 } }]);
  });

  it("ends complete on [DONE] with no finish_reason, and on a finish_reason with no [DONE]", async () => {
    const noReason = await chat(chunk({ content: "hi" }), "data: [DONE]\n\n");
    expect(noReason.incomplete).toBe(false); expect(noReason.data.stopReason).toBeNull(); expect(textOf(noReason.data)).toBe("hi");
    const noDone = await chat(chunk({ content: "hi" }), chunk({}, { finish_reason: "stop" }));
    expect(noDone.incomplete).toBe(false); expect(noDone.data.stopReason).toBe("stop");
    const neither = await chat(chunk({ content: "hi" }));
    expect(neither.incomplete).toBe(true);
  });
});

describe("EP: usage that arrives late or does not add up", () => {
  const sse = (event: string, data: Json): string => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
  const body = [
    sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }),
    sse("content_block_stop", { index: 0 }),
  ];
  const late = { input_tokens: 120, cache_read_input_tokens: 100, output_tokens: 9 };
  const expected = { promptTokens: 220, cachedInputTokens: 100, completionTokens: 9, totalTokens: 229 };
  const startFrame = sse("message_start", { message: { id: "msg_1", model: "up", usage: { input_tokens: 0, output_tokens: 0 } } });

  it("takes Anthropic prompt and cache counters reported only on message_delta", async () => {
    const { data, incomplete } = await collectStream(parseStream("anthropic", chunks(startFrame, ...body,
      sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: late }), sse("message_stop", {}))));
    expect(incomplete).toBe(false); expect(data.usage).toMatchObject(expected);
  });

  it("takes Anthropic prompt and cache counters reported only on message_stop", async () => {
    const { data, incomplete } = await collectStream(parseStream("anthropic", chunks(startFrame, ...body,
      sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: {} }), sse("message_stop", { usage: late }))));
    expect(incomplete).toBe(false); expect(data.usage).toMatchObject(expected);
  });

  it("floors the uncached prompt count at zero when the cache counters exceed the prompt", () => {
    const usage: Usage = { promptTokens: 10, completionTokens: 1, totalTokens: 11, cachedInputTokens: 30 };
    expect(uncachedPromptTokens(usage)).toBe(0);
    expect(uncachedPromptTokens({ ...usage, cachedInputTokens: 4, cacheCreationInputTokens: 6 })).toBe(0);
    expect(uncachedPromptTokens({ ...usage, cachedInputTokens: 4, cacheCreationInputTokens: 5 })).toBe(1);
    const rendered = buildResponse("anthropic", { id: "r", model: "up", created: 1, content: [{ type: "text", text: "x" }], stopReason: "stop", usage }).renderSelf("svc") as Json;
    expect(rendered.usage.input_tokens).toBe(0); expect(rendered.usage.cache_read_input_tokens).toBe(30);
  });

  it("sums detail counters, keeping a counter absent only when neither side had it", () => {
    const a: Usage = { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedInputTokens: 4, reasoningTokens: 1 };
    const b: Usage = { promptTokens: 5, completionTokens: 1, totalTokens: 6, cachedInputTokens: 3, cacheCreationInputTokens: 2 };
    expect(addUsage(a, b)).toEqual({ promptTokens: 15, completionTokens: 3, totalTokens: 18, cachedInputTokens: 7, cacheCreationInputTokens: 2, reasoningTokens: 1 });
    const plain = addUsage(USAGE, USAGE);
    expect(plain).toEqual({ promptTokens: 6, completionTokens: 4, totalTokens: 10 });
    for (const key of ["cachedInputTokens", "cacheCreationInputTokens", "reasoningTokens", "incomplete"]) expect(plain).not.toHaveProperty(key);
    expect(addUsage(USAGE, { ...USAGE, cachedInputTokens: 0 }).cachedInputTokens).toBe(0);
  });

  it("reads the cache hit from all three OpenAI-compatible spellings, first present wins", () => {
    expect(openAiCachedTokens({ cached_tokens: 5 })).toBe(5);
    expect(openAiCachedTokens({ prompt_cache_hit_tokens: 6, cached_tokens: 5 })).toBe(6);
    expect(openAiCachedTokens({ prompt_tokens_details: { cached_tokens: 7 }, prompt_cache_hit_tokens: 6, cached_tokens: 5 })).toBe(7);
    expect(openAiCachedTokens({ input_tokens_details: { cached_tokens: 8 } })).toBe(8);
    expect(openAiCachedTokens({ prompt_tokens: 10 })).toBeUndefined();
    const parsed = parseResponse("openai_completion", { id: "c", model: "up", choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, cached_tokens: 5 } });
    expect(parsed.usage.cachedInputTokens).toBe(5);
  });
});
