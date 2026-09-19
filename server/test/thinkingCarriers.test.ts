/**
 * Every way a model server hands back its thinking on a Chat Completions body.
 *
 * Hydrogen sits in front of whatever the operator runs, and they do not agree on
 * the name of the field -- DeepSeek's own endpoint says `reasoning_content`,
 * OpenRouter says `reasoning`, some servers say `reasoning_text`, and Ollama's
 * native API calls the trace `thinking` (its OpenAI-compatible endpoint renames
 * it to `reasoning`). A carrier Hydrogen does not read is thinking the client
 * never sees, or -- when the trace is inline in the answer -- thinking the
 * client sees AS the answer, which is the bug this file exists to keep closed.
 *
 * The other half is shape rather than name: `content` is a plain string almost
 * everywhere, but it is typed `any` in several wire definitions and a delta that
 * carries parts (including a reasoning part) must not be dropped wholesale.
 */
import { describe, expect, it } from "vitest";
import { OpenAICompletionResponse } from "../src/core/format";
import type { StreamEvent } from "../src/core/ir/stream";

const THOUGHT = "The user asked for the capital. It is Paris.";
const ANSWER = "Paris.";

/** One SSE frame, blank-line terminated the way the wire requires. */
const frame = (payload: Record<string, unknown>): string => `data: ${JSON.stringify(payload)}\n\n`;
const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
  frame({
    id: "c1", object: "chat.completion.chunk", created: 1, model: "up",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
const DONE = "data: [DONE]\n\n";

async function* sse(frames: string[]): AsyncGenerator<string> {
  for (const f of frames) yield f;
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const textOf = (events: StreamEvent[]): string =>
  events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
const reasoningOf = (events: StreamEvent[]): string =>
  events.filter((e) => e.type === "reasoning_delta").map((e) => (e as { text: string }).text).join("");

/** One buffered body carrying the trace under `field`. */
const bufferedBody = (field: string): Record<string, unknown> => ({
  id: "c1",
  object: "chat.completion",
  created: 1,
  model: "up",
  choices: [{ index: 0, message: { role: "assistant", content: ANSWER, [field]: THOUGHT }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

/** A stream whose deltas carry the trace under `field`. */
const carrierFrames = (field: string, answer: unknown = ANSWER): string[] => [
  chunk({ role: "assistant" }),
  chunk({ [field]: THOUGHT }),
  chunk({ content: answer }),
  chunk({}, "stop"),
  DONE,
];

/** The field name each server uses, and where it comes from. */
const CARRIERS = [
  "reasoning_content", // DeepSeek's own endpoint, vLLM, llama.cpp
  "reasoning", // OpenRouter, and Ollama's OpenAI-compatible endpoint
  "reasoning_text", // compatible-server variants
  "thinking", // Ollama's native API field name
];

describe("EP: the field a server puts its thinking in", () => {
  for (const field of CARRIERS) {
    it(`buffered: \`${field}\` becomes reasoning, not answer text`, () => {
      const body = OpenAICompletionResponse.parse(bufferedBody(field));
      expect(body.reasoning()).toBe(THOUGHT);
      expect(body.text()).toBe(ANSWER);
    });

    it(`streaming: \`${field}\` becomes reasoning, not answer text`, async () => {
      const out = await collect(OpenAICompletionResponse.parseStream(sse(carrierFrames(field))));
      expect(reasoningOf(out)).toBe(THOUGHT);
      expect(textOf(out)).toBe(ANSWER);
    });
  }

  it("an EMPTY field does not mask a populated one", async () => {
    // Servers do send more than one spelling at once, and one of them empty:
    // taking the first field that is merely PRESENT threw the thinking away.
    const buffered = OpenAICompletionResponse.parse({
      id: "c1", object: "chat.completion", created: 1, model: "up",
      choices: [{
        index: 0,
        message: { role: "assistant", content: ANSWER, reasoning: "", reasoning_content: THOUGHT },
        finish_reason: "stop",
      }],
    });
    expect(buffered.reasoning()).toBe(THOUGHT);

    const frames = [
      chunk({ reasoning: "", reasoning_content: THOUGHT }),
      chunk({ content: ANSWER }),
      chunk({}, "stop"),
      DONE,
    ];
    const out = await collect(OpenAICompletionResponse.parseStream(sse(frames)));
    expect(reasoningOf(out)).toBe(THOUGHT);
    expect(textOf(out)).toBe(ANSWER);
  });
});

describe("EP: thinking carried in reasoning_details", () => {
  const details = (item: Record<string, unknown>): Record<string, unknown> => ({
    id: "c1", object: "chat.completion", created: 1, model: "up",
    choices: [{ index: 0, message: { role: "assistant", content: ANSWER, reasoning_details: [item] }, finish_reason: "stop" }],
  });

  it("buffered: OpenRouter's reasoning.text item is read, not dropped", () => {
    const body = OpenAICompletionResponse.parse(details({ type: "reasoning.text", text: THOUGHT, index: 0 }));
    expect(body.reasoning()).toBe(THOUGHT);
    expect(body.text()).toBe(ANSWER);
  });

  it("buffered: a summary item is read too", () => {
    const body = OpenAICompletionResponse.parse(details({ type: "reasoning.summary", summary: THOUGHT }));
    expect(body.reasoning()).toBe(THOUGHT);
  });

  it("streaming: details-only reasoning reaches the client", async () => {
    const frames = [
      chunk({ role: "assistant" }),
      chunk({ reasoning_details: [{ type: "reasoning.text", text: THOUGHT, index: 0 }] }),
      chunk({ content: ANSWER }),
      chunk({}, "stop"),
      DONE,
    ];
    const out = await collect(OpenAICompletionResponse.parseStream(sse(frames)));
    expect(reasoningOf(out)).toBe(THOUGHT);
    expect(textOf(out)).toBe(ANSWER);
  });

  it("a non-reasoning item in the array is not invented into reasoning", () => {
    const body = OpenAICompletionResponse.parse(details({ type: "text", text: "not reasoning" }));
    expect(body.reasoning()).toBe("");
    expect(body.text()).toBe(ANSWER);
  });
});

describe("EP: thinking that arrives as content PARTS", () => {
  it("buffered: a thinking part is reasoning, a text part is the answer", () => {
    const body = OpenAICompletionResponse.parse({
      id: "c1", object: "chat.completion", created: 1, model: "up",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: THOUGHT }, { type: "text", text: ANSWER }],
        },
        finish_reason: "stop",
      }],
    });
    expect(body.reasoning()).toBe(THOUGHT);
    expect(body.text()).toBe(ANSWER);
  });

  it("streaming: a delta carrying parts is not dropped", async () => {
    // The failure this pins: the delta's content was an array, the parser only
    // read strings, and the client got a reasoning block with no answer at all.
    const out = await collect(
      OpenAICompletionResponse.parseStream(sse(carrierFrames("reasoning", [{ type: "text", text: ANSWER }]))),
    );
    expect(reasoningOf(out)).toBe(THOUGHT);
    expect(textOf(out)).toBe(ANSWER);
  });
});

describe("ST: the shape Ollama's own stream arrives in", () => {
  it("a reasoning-only chunk followed by a content chunk keeps both, in order", async () => {
    // Ollama splits a chunk that carried both into two chunks, so the trace and
    // the answer arrive on separate deltas -- the common case for its /v1 API.
    const out = await collect(OpenAICompletionResponse.parseStream(sse(carrierFrames("reasoning"))));
    const kinds = out.filter((e) => e.type === "reasoning_delta" || e.type === "text_delta").map((e) => e.type);
    expect(kinds[0]).toBe("reasoning_delta");
    expect(kinds[kinds.length - 1]).toBe("text_delta");
  });

  it("an empty reasoning string on the answer chunk is not reasoning", async () => {
    const frames = [
      chunk({ reasoning: THOUGHT, content: null }),
      chunk({ reasoning: "", content: ANSWER }),
      chunk({}, "stop"),
      DONE,
    ];
    const out = await collect(OpenAICompletionResponse.parseStream(sse(frames)));
    expect(reasoningOf(out)).toBe(THOUGHT);
    expect(textOf(out)).toBe(ANSWER);
  });
});
