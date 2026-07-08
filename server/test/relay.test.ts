import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import "../src/core/format"; // register wire formats
import { serializeStream, parseStream } from "../src/core/format/registry";
import {
  collectStream,
  fabricateStream,
  newAccumulator,
  tapStream,
} from "../src/core/ir/stream";
import type { ResponseData, StreamEvent } from "../src/core/ir/stream";
import type { Family } from "../src/core/format/family";

/**
 * A minimal Writable that collects all data written to it, simulating the
 * Fastify reply.raw stream. Supports write(), flush(), destroyed, writableEnded.
 */
class MockRawResponse extends Writable {
  chunks: string[] = [];
  flushed: string[] = [];
  destroyed = false;
  writableEnded = false;
  flushCount = 0;

  _write(chunk: string | Buffer, _enc: string, callback: () => void): void {
    const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.chunks.push(str);
    this.flushed.push(str);
    callback();
  }

  flush(): void {
    this.flushCount++;
  }

  end(cb?: () => void): this {
    this.writableEnded = true;
    if (cb) cb();
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

/**
 * Simulates the ProxyController.relay() flow: serialize the canonical stream
 * through tapStream (for logging accumulation) + serializeStream (for SSE),
 * then write each chunk to the raw response with immediate flush.
 */
async function relayToRaw(
  raw: MockRawResponse,
  family: Family,
  events: AsyncGenerator<StreamEvent>,
  model: string,
): Promise<{ acc: ReturnType<typeof newAccumulator> }> {
  const acc = newAccumulator();
  const outGen = serializeStream(family, tapStream(events, acc), { model });
  for await (const chunk of outGen) {
    if (raw.destroyed || raw.writableEnded) break;
    raw.write(chunk);
    raw.flush();
    if (raw.destroyed) break;
  }
  if (!raw.writableEnded) raw.end();
  return { acc };
}

const COMPLETE_DATA: ResponseData = {
  id: "r",
  model: "m",
  created: 1,
  content: [
    { type: "reasoning", text: "thinking..." },
    { type: "text", text: "The quick brown fox jumps over the lazy dog." },
  ],
  stopReason: "stop",
  usage: { promptTokens: 10, completionTokens: 15, totalTokens: 25 },
};

describe("Stream relay complete delivery (Issue 2)", () => {
  it("delivers ALL serialized SSE chunks to the downstream client", async () => {
    const raw = new MockRawResponse();
    const { acc } = await relayToRaw(raw, "openai_completion", fabricateStream(COMPLETE_DATA), "svc");

    // All chunks were written and flushed.
    expect(raw.chunks.length).toBeGreaterThan(0);
    expect(raw.flushCount).toBe(raw.chunks.length);

    // The concatenated SSE output contains the full text (as SSE-encoded chunks).
    const fullOutput = raw.chunks.join("");
    expect(fullOutput).toContain("[DONE]");

    // The reconstructed client-visible text matches the complete response.
    const clientText = extractTextFromSSE(fullOutput);
    expect(clientText).toBe("The quick brown fox jumps over the lazy dog.");

    // The accumulator (used for logging) has the complete text.
    expect(acc.text).toBe("The quick brown fox jumps over the lazy dog.");
    expect(acc.reasoning).toBe("thinking...");
    expect(acc.usage?.totalTokens).toBe(25);
    expect(acc.stopReason).toBe("stop");

    // The logged content matches what the client received.
    expect(clientText).toBe(acc.text);
  });

  it("logged response body matches the delivered SSE content for OpenAI format", async () => {
    const raw = new MockRawResponse();
    const { acc } = await relayToRaw(raw, "openai_completion", fabricateStream(COMPLETE_DATA), "svc");

    // Reconstruct the client-visible content from the SSE stream.
    const sseText = raw.chunks.join("");
    const clientText = extractTextFromSSE(sseText);

    // The log accumulator must match what the client actually received.
    expect(acc.text).toBe(clientText);
    expect(acc.stopReason).toBe("stop");
    expect(acc.incomplete).toBe(false);
  });

  it("logged response body matches the delivered SSE content for Anthropic format", async () => {
    const raw = new MockRawResponse();
    const { acc } = await relayToRaw(raw, "anthropic", fabricateStream(COMPLETE_DATA), "svc");

    const sseText = raw.chunks.join("");
    // Anthropic SSE uses content_block_delta -> delta -> text.
    const clientText = extractAnthropicTextFromSSE(sseText);
    expect(acc.text).toBe(clientText);
  });

  it("stops writing when the client disconnects mid-stream", async () => {
    const raw = new MockRawResponse();
    // Simulate client disconnect after first chunk.
    const acc = newAccumulator();
    const events = fabricateStream(COMPLETE_DATA);
    const outGen = serializeStream("openai_completion", tapStream(events, acc), { model: "svc" });

    let chunkCount = 0;
    for await (const chunk of outGen) {
      raw.write(chunk);
      raw.flush();
      chunkCount++;
      if (chunkCount === 2) {
        raw.destroy();
      }
      if (raw.destroyed) break;
    }

    // The client only received partial data (fewer chunks than complete).
    expect(raw.chunks.length).toBeLessThan(10);
    // The accumulator may have partial text (whatever was tapped before disconnect).
    expect(acc.text.length).toBeLessThan(COMPLETE_DATA.content.find((p) => p.type === "text")!.text.length);
  });

  it("flushes each chunk immediately (no buffering)", async () => {
    const raw = new MockRawResponse();
    await relayToRaw(raw, "openai_completion", fabricateStream(COMPLETE_DATA), "svc");

    // Every chunk written was immediately flushed.
    expect(raw.flushCount).toBe(raw.chunks.length);
    expect(raw.flushCount).toBeGreaterThan(0);
  });

  it("delivers a complete fabricated stream from a MicroAgent (long text)", async () => {
    const longText = "Lorem ipsum ".repeat(100).trim();
    const data: ResponseData = {
      id: "long",
      model: "m",
      created: 1,
      content: [{ type: "text", text: longText }],
      stopReason: "stop",
      usage: { promptTokens: 5, completionTokens: 200, totalTokens: 205 },
    };

    const raw = new MockRawResponse();
    const { acc } = await relayToRaw(raw, "openai_completion", fabricateStream(data), "svc");

    // The full text is in the SSE output.
    const clientText = extractTextFromSSE(raw.chunks.join(""));
    expect(clientText).toBe(longText);
    // The accumulator matches.
    expect(acc.text).toBe(longText);
    expect(acc.usage?.totalTokens).toBe(205);
  });

  it("round-trips a fabricated stream through collect -> fabricate -> relay without data loss", async () => {
    // Simulate the full MicroAgent path: upstream stream -> collect -> fabricate -> relay to client.
    const upstreamFrames = async function* (): AsyncGenerator<string> {
      yield 'data: {"id":"c","model":"up","choices":[{"delta":{"role":"assistant"}}]}\n\n';
      yield 'data: {"choices":[{"delta":{"content":"Complete response"}}]}\n\n';
      yield 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n';
      yield "data: [DONE]\n\n";
    };

    const collected = await collectStream(parseStream("openai_completion", upstreamFrames()));
    expect(collected.incomplete).toBe(false);

    const raw = new MockRawResponse();
    const { acc } = await relayToRaw(raw, "openai_completion", fabricateStream(collected.data), "svc");

    const clientText = extractTextFromSSE(raw.chunks.join(""));
    expect(clientText).toBe("Complete response");
    expect(acc.text).toBe("Complete response");
  });
});

// --- Regression: relay must flush every chunk and detect disconnects ---
// Guards against the original bug where Readable.from(streamAndLog()) buffered
// chunks internally; when the client disconnected, buffered data was lost but
// the log recorded the full upstream content (mismatch between log and client).

describe("Regression: stream relay flush + disconnect detection (Issue 2)", () => {
  it("every chunk written is immediately flushed (no internal buffering)", async () => {
    const raw = new MockRawResponse();
    await relayToRaw(raw, "openai_completion", fabricateStream(COMPLETE_DATA), "svc");
    // flushCount must equal the number of chunks written -- no chunk is left
    // unflushed in an internal buffer.
    expect(raw.flushCount).toBe(raw.chunks.length);
    expect(raw.flushCount).toBeGreaterThan(0);
  });

  it("writableEnded is set after the stream completes (clean close)", async () => {
    const raw = new MockRawResponse();
    await relayToRaw(raw, "openai_completion", fabricateStream(COMPLETE_DATA), "svc");
    expect(raw.writableEnded).toBe(true);
  });

  it("disconnect mid-stream stops writing and does not throw", async () => {
    const raw = new MockRawResponse();
    const acc = newAccumulator();
    const events = fabricateStream(COMPLETE_DATA);
    const outGen = serializeStream("openai_completion", tapStream(events, acc), { model: "svc" });

    let wrote = 0;
    let threw = false;
    try {
      for await (const chunk of outGen) {
        if (raw.destroyed || raw.writableEnded) break;
        raw.write(chunk);
        raw.flush();
        wrote++;
        // Disconnect after the 3rd chunk.
        if (wrote >= 3) raw.destroy();
        if (raw.destroyed) break;
      }
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(wrote).toBeLessThanOrEqual(3);
    // Partial text was accumulated (whatever the upstream produced before we stopped).
    expect(acc.text.length).toBeLessThanOrEqual(COMPLETE_DATA.content.find((p) => p.type === "text")!.text.length);
  });

  it("the logged accumulator text equals the client-received text for tool-call responses", async () => {
    const data: ResponseData = {
      id: "tool",
      model: "m",
      created: 1,
      content: [
        { type: "text", text: "Calling tool" },
        { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Tokyo" } },
      ],
      stopReason: "tool_use",
      usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
    };
    const raw = new MockRawResponse();
    const { acc } = await relayToRaw(raw, "openai_completion", fabricateStream(data), "svc");

    const clientText = extractTextFromSSE(raw.chunks.join(""));
    expect(acc.text).toBe("Calling tool");
    expect(clientText).toBe("Calling tool");
    expect(acc.toolCalls.length).toBe(1);
    expect(acc.toolCalls[0].name).toBe("get_weather");
    expect(acc.stopReason).toBe("tool_use");
  });

  it("multiple sequential relays each deliver complete content (no cross-talk)", async () => {
    const data1: ResponseData = {
      id: "r1", model: "m", created: 1,
      content: [{ type: "text", text: "first response" }],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    };
    const data2: ResponseData = {
      id: "r2", model: "m", created: 2,
      content: [{ type: "text", text: "second response" }],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    };

    const raw1 = new MockRawResponse();
    const { acc: acc1 } = await relayToRaw(raw1, "openai_completion", fabricateStream(data1), "svc");
    const raw2 = new MockRawResponse();
    const { acc: acc2 } = await relayToRaw(raw2, "openai_completion", fabricateStream(data2), "svc");

    expect(extractTextFromSSE(raw1.chunks.join(""))).toBe("first response");
    expect(extractTextFromSSE(raw2.chunks.join(""))).toBe("second response");
    expect(acc1.text).toBe("first response");
    expect(acc2.text).toBe("second response");
  });
});

// --- helpers ---

function extractTextFromSSE(sse: string): string {
  let text = "";
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const json = line.slice(6);
    if (json === "[DONE]") break;
    try {
      const obj = JSON.parse(json);
      const delta = obj.choices?.[0]?.delta;
      if (delta?.content) text += delta.content;
    } catch {
      /* skip */
    }
  }
  return text;
}

function extractAnthropicTextFromSSE(sse: string): string {
  let text = "";
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const json = line.slice(6);
    try {
      const obj = JSON.parse(json);
      if (obj.type === "content_block_delta" && obj.delta?.text) {
        text += obj.delta.text;
      }
    } catch {
      /* skip */
    }
  }
  return text;
}
