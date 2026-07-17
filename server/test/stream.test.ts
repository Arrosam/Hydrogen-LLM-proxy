import { describe, expect, it } from "vitest";
import { parseStream } from "../src/core/format";
import { collectStream, fabricateStream, newAccumulator, tapStream, withoutReasoning, type StreamEvent } from "../src/core/ir/stream";
import type { ResponseData } from "../src/core/ir/stream";

async function* frames(...f: string[]): AsyncGenerator<string> {
  for (const chunk of f) yield chunk;
}

const OK_FRAMES = [
  'data: {"id":"c","model":"up","choices":[{"delta":{"role":"assistant"}}]}\n\n',
  'data: {"choices":[{"delta":{"reasoning":"pondering"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
  "data: [DONE]\n\n",
];

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("OpenAI SSE parse + collect", () => {
  it("collects a complete stream into a canonical response", async () => {
    const { data, incomplete } = await collectStream(parseStream("openai_completion", frames(...OK_FRAMES)));
    expect(incomplete).toBe(false);
    expect(data.stopReason).toBe("stop");
    expect(data.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    const text = data.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
    expect(text).toBe("hello");
    expect(data.content.some((p) => p.type === "reasoning")).toBe(true);
  });

  it("flags a truncated stream (no terminal event) as incomplete", async () => {
    // Drop the finish + [DONE] frames.
    const { incomplete } = await collectStream(parseStream("openai_completion", frames(...OK_FRAMES.slice(0, 4))));
    expect(incomplete).toBe(true);
  });
});

describe("fabricate + tap + withoutReasoning", () => {
  const data: ResponseData = {
    id: "r",
    model: "m",
    created: 1,
    content: [
      { type: "reasoning", text: "hmm" },
      { type: "text", text: "answer" },
    ],
    stopReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };

  it("fabricates a stream from a complete response and round-trips it", async () => {
    const { data: back, incomplete } = await collectStream(fabricateStream(data));
    expect(incomplete).toBe(false);
    expect(back.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("")).toBe("answer");
  });

  it("tapStream accumulates text/reasoning/usage as events pass through", async () => {
    const acc = newAccumulator();
    await drain(tapStream(fabricateStream(data), acc));
    expect(acc.text).toBe("answer");
    expect(acc.reasoning).toBe("hmm");
    expect(acc.usage?.totalTokens).toBe(2);
    expect(acc.stopReason).toBe("stop");
  });

  it("withoutReasoning drops reasoning deltas", async () => {
    const events = await drain(withoutReasoning(fabricateStream(data)));
    expect(events.some((e) => e.type === "reasoning_delta")).toBe(false);
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
  });
});

describe("OpenAI Responses failure vs completion", () => {
  const CREATED = 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5","created_at":1}}\n\n';
  const TEXT = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n';

  it("treats response.failed as an incomplete stream, not a finished answer", async () => {
    const failed = 'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"server error"}}}\n\n';
    const { incomplete } = await collectStream(parseStream("openai_responses", frames(CREATED, TEXT, failed)));
    expect(incomplete).toBe(true);
  });

  it("treats response.completed as a complete answer", async () => {
    const done = 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
    const { incomplete, data } = await collectStream(parseStream("openai_responses", frames(CREATED, TEXT, done)));
    expect(incomplete).toBe(false);
    expect(data.stopReason).toBe("stop");
  });

  it("treats response.incomplete (length) as a normal length stop, not a failure", async () => {
    const inc = 'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n';
    const { incomplete, data } = await collectStream(parseStream("openai_responses", frames(CREATED, TEXT, inc)));
    expect(incomplete).toBe(false);
    expect(data.stopReason).toBe("length");
  });
});
