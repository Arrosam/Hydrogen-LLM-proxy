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
