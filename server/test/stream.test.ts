import { describe, expect, it } from "vitest";
import { parseUpstreamStream, serializeClientStream, streamFromIRResponse } from "../src/core/formats/stream";
import type { EgressFamily, Family, IRResponse } from "../src/core/ir";

/** Yield a string in small chunks to exercise cross-chunk SSE buffering. */
async function* chunked(s: string): AsyncGenerator<string> {
  for (let i = 0; i < s.length; i += 7) yield s.slice(i, i + 7);
}

async function translate(from: EgressFamily, to: Family, input: string): Promise<string> {
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

// GLM / 智谱-style: input_tokens is 0 at message_start and only reported in the
// final message_delta usage. The prompt count must still surface to the client.
const ANTHROPIC_STREAM_LATE_USAGE = [
  `event: message_start\ndata: {"type":"message_start","message":{"id":"m2","model":"glm","usage":{"input_tokens":0,"output_tokens":1}}}`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":37,"output_tokens":320}}`,
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

  it("captures prompt tokens reported only in the final message_delta", async () => {
    const out = await translate("anthropic", "openai", ANTHROPIC_STREAM_LATE_USAGE);
    expect(out).toContain('"prompt_tokens":37');
    expect(out).toContain('"completion_tokens":320');
    expect(out).toContain('"total_tokens":357');
  });

  it("same-family passthrough stays well-formed", async () => {
    const out = await translate("openai", "openai", OPENAI_STREAM);
    expect(out).toContain('"content":"Hello"');
    expect(out).toContain('"finish_reason":"stop"');
    expect(out).toContain("data: [DONE]");
  });
});

describe("streamFromIRResponse (paced fake stream)", () => {
  const irOf = (text: string): IRResponse => ({
    id: "x", model: "m", created: 0, content: [{ type: "text", text }],
    stopReason: "stop", usage: { promptTokens: 5, completionTokens: 20, totalTokens: 25 },
  });

  it("splits a buffered response into multiple deltas and reconstructs it exactly", async () => {
    const text = "The quick brown fox jumps over the lazy dog, then does it all over again twice more.";
    let out = "";
    for await (const c of streamFromIRResponse("openai", irOf(text), { model: "mub" })) out += c;

    let content = "", deltas = 0;
    for (const line of out.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const d = JSON.parse(data).choices?.[0]?.delta?.content;
        if (d) { content += d; deltas++; }
      } catch { /* non-content chunk */ }
    }
    expect(content).toBe(text);
    expect(deltas).toBeGreaterThan(1); // chunked into a progressive stream, not one lump
  });

  it("actually paces the output (not an instant dump)", async () => {
    const text = "x".repeat(2400); // ~600 tokens → ~120ms at 5000 tok/s
    const start = Date.now();
    let n = 0;
    for await (const c of streamFromIRResponse("openai", irOf(text), { model: "mub" })) n += c.length;
    const elapsed = Date.now() - start;
    expect(n).toBeGreaterThan(0);
    expect(elapsed).toBeGreaterThanOrEqual(5); // paced, not instantaneous
    expect(elapsed).toBeLessThan(3000); // but fast
  });
});

describe("reasoning/thinking passthrough", () => {
  const OPENAI_REASONING_STREAM = [
    `data: {"id":"c2","model":"glm","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}`,
    `data: {"id":"c2","model":"glm","choices":[{"index":0,"delta":{"reasoning_content":"Let me think"},"finish_reason":null}]}`,
    `data: {"id":"c2","model":"glm","choices":[{"index":0,"delta":{"content":"Answer"},"finish_reason":null}]}`,
    `data: {"id":"c2","model":"glm","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
    `data: [DONE]`,
    ``,
  ].join("\n\n");

  const ANTHROPIC_THINKING_STREAM = [
    `event: message_start\ndata: {"type":"message_start","message":{"id":"m3","model":"claude","usage":{"input_tokens":4}}}`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think"}}`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Answer"}}`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
    ``,
  ].join("\n\n");

  it("OpenAI reasoning_content deltas reach an OpenAI client as reasoning", async () => {
    const out = await translate("openai", "openai", OPENAI_REASONING_STREAM);
    expect(out).toContain('"reasoning":"Let me think"');
    expect(out).toContain('"content":"Answer"');
  });

  it("OpenAI reasoning_content deltas become Anthropic thinking blocks", async () => {
    const out = await translate("openai", "anthropic", OPENAI_REASONING_STREAM);
    expect(out).toContain('"type":"thinking"');
    expect(out).toContain('"thinking":"Let me think"');
    expect(out).toContain('"text":"Answer"');
  });

  it("Anthropic thinking deltas reach an OpenAI client as reasoning", async () => {
    const out = await translate("anthropic", "openai", ANTHROPIC_THINKING_STREAM);
    expect(out).toContain('"reasoning":"Let me think"');
    expect(out).toContain('"content":"Answer"');
  });

  it("fake stream replays reasoning parts as thinking/reasoning deltas", async () => {
    const ir: IRResponse = {
      id: "x", model: "m", created: 0,
      content: [
        { type: "reasoning", text: "Pondering deeply" },
        { type: "text", text: "Done" },
      ],
      stopReason: "stop", usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    };
    let openaiOut = "";
    for await (const c of streamFromIRResponse("openai", ir, { model: "mub" })) openaiOut += c;
    expect(openaiOut).toContain('"reasoning":"Pondering deeply"');
    expect(openaiOut).toContain('"content":"Done"');

    let anthOut = "";
    for await (const c of streamFromIRResponse("anthropic", ir, { model: "mub" })) anthOut += c;
    expect(anthOut).toContain('"thinking":"Pondering deeply"');
    expect(anthOut).toContain('"text":"Done"');
  });
});
