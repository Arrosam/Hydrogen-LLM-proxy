import { describe, expect, it } from "vitest";
import { parseUpstreamStream, serializeClientStream } from "../src/core/formats/stream";
import type { Family } from "../src/core/ir";

/** Yield a string in small chunks to exercise cross-chunk SSE buffering. */
async function* chunked(s: string): AsyncGenerator<string> {
  for (let i = 0; i < s.length; i += 7) yield s.slice(i, i + 7);
}

async function translate(from: Family, to: Family, input: string): Promise<string> {
  const events = parseUpstreamStream(from, chunked(input));
  let out = "";
  for await (const c of serializeClientStream(to, events, { model: "mub" })) out += c;
  return out;
}

const OPENAI_STREAM = [
  `data: {"id":"c1","model":"gpt","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}`,
  `data: {"id":"c1","model":"gpt","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}`,
  `data: {"id":"c1","model":"gpt","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}`,
  `data: {"id":"c1","model":"gpt","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
  `data: {"id":"c1","model":"gpt","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}`,
  `data: [DONE]`,
  ``,
].join("\n\n");

const ANTHROPIC_STREAM = [
  `event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"claude","usage":{"input_tokens":4}}}`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}`,
  `event: message_stop\ndata: {"type":"message_stop"}`,
  ``,
].join("\n\n");

describe("streaming translation", () => {
  it("OpenAI upstream -> Anthropic client SSE", async () => {
    const out = await translate("openai", "anthropic", OPENAI_STREAM);
    expect(out).toContain("event: message_start");
    expect(out).toContain('"type":"content_block_start"');
    expect(out).toContain('"text":"Hello"');
    expect(out).toContain('"text":" world"');
    expect(out).toContain("event: message_delta");
    expect(out).toContain('"output_tokens":3');
    expect(out).toContain("event: message_stop");
  });

  it("Anthropic upstream -> OpenAI client SSE", async () => {
    const out = await translate("anthropic", "openai", ANTHROPIC_STREAM);
    expect(out).toContain('"object":"chat.completion.chunk"');
    expect(out).toContain('"content":"Hi"');
    expect(out).toContain('"finish_reason":"stop"');
    expect(out).toContain('"prompt_tokens":4');
    expect(out).toContain('"completion_tokens":2');
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("same-family passthrough stays well-formed", async () => {
    const out = await translate("openai", "openai", OPENAI_STREAM);
    expect(out).toContain('"content":"Hello"');
    expect(out).toContain('"finish_reason":"stop"');
    expect(out).toContain("data: [DONE]");
  });
});
