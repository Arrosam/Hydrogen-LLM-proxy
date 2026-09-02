/**
 * Thinking format override — how a service presents the model's thinking to its
 * own client.
 *
 * Two properties carry the whole feature and each has its own section below.
 *
 * The first is that `original` is a STRICT no-op. It is the default, so every
 * service that existed before this feature is running it, and a scan that fired
 * "helpfully" on those would take `<think>` tags away from clients that parse
 * them themselves. Identity is asserted on the rendered body, not on the
 * canonical content, because the body is what the client actually gets.
 *
 * The second is that every other value has to FIND the thinking before it can
 * re-say it — including the case Hydrogen was blind to: a model served through
 * vLLM / Ollama / llama.cpp that writes `<think>…</think>` at the head of its
 * answer text and fills no structured field at all.
 */
import { describe, expect, it } from "vitest";
import {
  applyThinkingFormat,
  liftThinkTags,
  withThinkingFormat,
  type ThinkingFormat,
} from "../src/core/ir/thinkingFormat";
import type { ContentPart } from "../src/core/ir/content";
import type { StreamEvent } from "../src/core/ir/stream";
import { AnthropicResponse, OpenAICompletionResponse, OpenAIResponsesResponse } from "../src/core/format";
import type { ResponseData } from "../src/core/ir/stream";

const THOUGHT = "The user wants the capital. It is Paris.";
const ANSWER = "Paris.";

const data = (content: ContentPart[]): ResponseData => ({
  id: "x",
  model: "m",
  created: 1,
  content,
  stopReason: "stop",
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
});

const textOnly = (text: string): ContentPart[] => [{ type: "text", text }];
const withReasoning: ContentPart[] = [
  { type: "reasoning", text: THOUGHT },
  { type: "text", text: ANSWER },
];

/** Collect a canonical event stream into an array. */
async function drain(events: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

/** A stream of the given events, one at a time. */
async function* stream(...events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const ev of events) yield ev;
}

/** Text deltas from a string, split into `size`-character pieces — the point
 * being that a tag can land across a chunk boundary, which is where a naive
 * scanner breaks. */
function deltas(text: string, size: number): StreamEvent[] {
  const out: StreamEvent[] = [];
  for (let i = 0; i < text.length; i += size) out.push({ type: "text_delta", text: text.slice(i, i + size) });
  return out;
}

const textOf = (events: StreamEvent[]): string =>
  events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
const reasoningOf = (events: StreamEvent[]): string =>
  events.filter((e) => e.type === "reasoning_delta").map((e) => (e as { text: string }).text).join("");

// --- EP: `original` changes nothing ---------------------------------------

describe("EP: `original` is a strict no-op on every wire", () => {
  const FORMATS: Array<ThinkingFormat | undefined> = ["original", undefined];

  for (const fmt of FORMATS) {
    it(`content is returned by identity (${fmt ?? "absent"})`, () => {
      const content = textOnly(`<think>${THOUGHT}</think>\n\n${ANSWER}`);
      // Same reference, not merely a deep-equal copy: the response object is
      // reused rather than rebuilt, and callers rely on that.
      expect(applyThinkingFormat(content, fmt)).toBe(content);
      expect(applyThinkingFormat(withReasoning, fmt)).toBe(withReasoning);
    });
  }

  it("a `<think>` block stays in the answer text, exactly as it arrived", () => {
    const raw = `<think>${THOUGHT}</think>\n\n${ANSWER}`;
    const body = new OpenAICompletionResponse(data(textOnly(raw))).renderSelf("svc");
    const message = (body.choices as Array<{ message: Record<string, unknown> }>)[0].message;
    expect(message.content).toBe(raw);
    expect(message.reasoning).toBeUndefined();
    expect(message.reasoning_content).toBeUndefined();
  });

  it("structured reasoning still goes out under BOTH dialect spellings", () => {
    const body = new OpenAICompletionResponse(data(withReasoning)).renderSelf("svc");
    const message = (body.choices as Array<{ message: Record<string, unknown> }>)[0].message;
    expect(message.reasoning).toBe(THOUGHT);
    expect(message.reasoning_content).toBe(THOUGHT);
  });

  it("a stream is passed through by identity", async () => {
    const events = stream({ type: "text_delta", text: "<think>x</think>hi" });
    expect(withThinkingFormat(events, "original")).toBe(events);
  });
});

// --- EP: lifting `<think>` out of the answer text -------------------------

describe("EP: thinking buried in the answer text is found", () => {
  it("a leading <think> block becomes a reasoning part", () => {
    const out = liftThinkTags(textOnly(`<think>${THOUGHT}</think>\n\n${ANSWER}`));
    expect(out).toEqual([
      { type: "reasoning", text: THOUGHT },
      { type: "text", text: ANSWER },
    ]);
  });

  it("the other spellings templates use are recognised too", () => {
    for (const tag of ["think", "thinking", "reasoning"]) {
      const out = liftThinkTags(textOnly(`<${tag}>${THOUGHT}</${tag}>\n${ANSWER}`));
      expect(out[0]).toEqual({ type: "reasoning", text: THOUGHT });
    }
  });

  it("leading whitespace from a chat template does not hide the tag", () => {
    const out = liftThinkTags(textOnly(`\n\n<think>\n${THOUGHT}\n</think>\n\n${ANSWER}`));
    expect(out[0]).toEqual({ type: "reasoning", text: THOUGHT });
    expect(out[1]).toEqual({ type: "text", text: ANSWER });
  });

  it("a thinking-only answer leaves no empty text part behind", () => {
    const out = liftThinkTags(textOnly(`<think>${THOUGHT}</think>`));
    expect(out).toEqual([{ type: "reasoning", text: THOUGHT }]);
  });
});

describe("DT: when NOT to treat a tag as thinking", () => {
  it("an unterminated tag stays text — a truncated answer is not a thought", () => {
    // Turning the whole remaining answer into reasoning would hand the client
    // an empty response, which is worse than the tag showing through.
    const content = textOnly(`<think>${THOUGHT} and then the stream died`);
    expect(liftThinkTags(content)).toBe(content);
  });

  it("a tag part-way down the answer is the model writing ABOUT the tag", () => {
    const content = textOnly(`Wrap your reasoning in <think>like this</think> before answering.`);
    expect(liftThinkTags(content)).toBe(content);
  });

  it("a structured field wins: the upstream already said where its thinking is", () => {
    const content: ContentPart[] = [
      { type: "reasoning", text: THOUGHT },
      { type: "text", text: "<think>not thinking</think> answer" },
    ];
    expect(liftThinkTags(content)).toBe(content);
  });

  it("content with no text part at all is left alone", () => {
    const content: ContentPart[] = [{ type: "tool_use", id: "t1", name: "get", input: {} }];
    expect(liftThinkTags(content)).toBe(content);
  });
});

// --- EP: each output format ------------------------------------------------

describe("EP: the four output formats", () => {
  const raw = textOnly(`<think>${THOUGHT}</think>\n\n${ANSWER}`);

  it("think_tags: structured reasoning is inlined ahead of the answer", () => {
    const out = applyThinkingFormat(withReasoning, "think_tags");
    expect(out).toEqual([{ type: "text", text: `<think>\n${THOUGHT}\n</think>\n\n${ANSWER}` }]);
  });

  it("think_tags: a block that arrived as tags survives the round trip", () => {
    const out = applyThinkingFormat(raw, "think_tags");
    expect(out).toEqual([{ type: "text", text: `<think>\n${THOUGHT}\n</think>\n\n${ANSWER}` }]);
  });

  it("think_tags: a redacted block is dropped, not rendered as an empty one", () => {
    // It has no readable text by definition; `<think></think>` would say
    // something false about what the model did.
    const out = applyThinkingFormat(
      [{ type: "reasoning", text: "", redacted: true, signature: "OPAQUE" }, { type: "text", text: ANSWER }],
      "think_tags",
    );
    expect(out).toEqual([{ type: "text", text: ANSWER }]);
  });

  it("none: thinking is kept from the client, from either source", () => {
    expect(applyThinkingFormat(withReasoning, "none")).toEqual([{ type: "text", text: ANSWER }]);
    expect(applyThinkingFormat(raw, "none")).toEqual([{ type: "text", text: ANSWER }]);
  });

  it("reasoning_content: the Chat Completions client gets that field ONLY", () => {
    const shaped = applyThinkingFormat(raw, "reasoning_content");
    const body = new OpenAICompletionResponse(data(shaped)).renderSelf("svc", { thinkingFormat: "reasoning_content" });
    const message = (body.choices as Array<{ message: Record<string, unknown> }>)[0].message;
    expect(message.reasoning_content).toBe(THOUGHT);
    expect(message.reasoning).toBeUndefined();
    expect(message.content).toBe(ANSWER);
  });

  it("reasoning: the Chat Completions client gets THAT field only", () => {
    const shaped = applyThinkingFormat(raw, "reasoning");
    const body = new OpenAICompletionResponse(data(shaped)).renderSelf("svc", { thinkingFormat: "reasoning" });
    const message = (body.choices as Array<{ message: Record<string, unknown> }>)[0].message;
    expect(message.reasoning).toBe(THOUGHT);
    expect(message.reasoning_content).toBeUndefined();
  });
});

describe("DT: the field-name choice belongs to one wire only", () => {
  const shaped = applyThinkingFormat(textOnly(`<think>${THOUGHT}</think>${ANSWER}`), "reasoning_content");

  it("Anthropic keeps its native thinking block rather than inventing a field", () => {
    const body = new AnthropicResponse(data(shaped)).renderSelf("svc", { thinkingFormat: "reasoning_content" });
    const blocks = body.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({ type: "thinking", thinking: THOUGHT });
    expect(JSON.stringify(body)).not.toContain("reasoning_content");
  });

  it("Responses keeps its native reasoning item", () => {
    const body = new OpenAIResponsesResponse(data(shaped)).renderSelf("svc", { thinkingFormat: "reasoning" });
    const output = body.output as Array<Record<string, unknown>>;
    expect(output.some((o) => o.type === "reasoning")).toBe(true);
  });

  it("...but the content-level formats DO apply to those wires", () => {
    const inlined = applyThinkingFormat(withReasoning, "think_tags");
    const body = new AnthropicResponse(data(inlined)).renderSelf("svc", { thinkingFormat: "think_tags" });
    const blocks = body.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(String(blocks[0].text)).toContain("<think>");
  });
});

// --- ST: the streaming half ------------------------------------------------

describe("ST: a tag split across deltas is still recognised", () => {
  const RAW = `<think>${THOUGHT}</think>\n\n${ANSWER}`;

  // One character at a time is the worst case: every tag lands across a
  // boundary. Larger sizes cover the ordinary ones.
  for (const size of [1, 2, 3, 7, 500]) {
    it(`chunked ${size} char(s) at a time`, async () => {
      const out = await drain(withThinkingFormat(stream(...deltas(RAW, size), { type: "finish", stopReason: "stop" }), "reasoning"));
      expect(reasoningOf(out)).toBe(THOUGHT);
      expect(textOf(out)).toBe(ANSWER);
      expect(out.some((e) => e.type === "reasoning_start")).toBe(true);
      expect(out.some((e) => e.type === "reasoning_stop")).toBe(true);
    });
  }

  it("the `start` event every stream opens with does not end the scan", async () => {
    // It is metadata, and it is always first: treating it as the beginning of
    // the answer disabled the scanner on every real stream while every unit
    // case that omitted it kept passing.
    const out = await drain(
      withThinkingFormat(
        stream({ type: "start", id: "x", model: "m", created: 1 }, ...deltas(RAW, 3), { type: "finish", stopReason: "stop" }),
        "reasoning",
      ),
    );
    expect(reasoningOf(out)).toBe(THOUGHT);
    expect(textOf(out)).toBe(ANSWER);
  });

  it("an answer with no tag reaches the client whole and unchanged", async () => {
    const plain = "There is no thinking here, just an answer.";
    const out = await drain(withThinkingFormat(stream(...deltas(plain, 3), { type: "finish", stopReason: "stop" }), "reasoning"));
    expect(textOf(out)).toBe(plain);
    expect(out.some((e) => e.type === "reasoning_start")).toBe(false);
  });

  it("a short answer that never fills the scan buffer is still delivered", async () => {
    // The scan holds text back until it can decide; a two-word answer must not
    // be swallowed by that hold when the stream simply ends.
    const out = await drain(withThinkingFormat(stream({ type: "text_delta", text: "ok" }, { type: "finish", stopReason: "stop" }), "reasoning"));
    expect(textOf(out)).toBe("ok");
  });

  it("an upstream that used a structured field is passed straight through", async () => {
    const out = await drain(
      withThinkingFormat(
        stream(
          { type: "reasoning_start" },
          { type: "reasoning_delta", text: THOUGHT },
          { type: "reasoning_stop" },
          { type: "text_delta", text: ANSWER },
          { type: "finish", stopReason: "stop" },
        ),
        "reasoning",
      ),
    );
    expect(reasoningOf(out)).toBe(THOUGHT);
    expect(textOf(out)).toBe(ANSWER);
  });

  it("a tool call before any text ends the scan without eating the buffer", async () => {
    const out = await drain(
      withThinkingFormat(
        stream(
          { type: "text_delta", text: "<th" },
          { type: "tool_start", index: 0, id: "t1", name: "get" },
          { type: "finish", stopReason: "tool_use" },
        ),
        "reasoning",
      ),
    );
    expect(textOf(out)).toBe("<th");
    expect(out.some((e) => e.type === "tool_start")).toBe(true);
  });
});

describe("EG: a stream that dies inside a thinking block", () => {
  it("the block is closed rather than left open forever", async () => {
    const out = await drain(
      withThinkingFormat(stream(...deltas(`<think>${THOUGHT}`, 4)), "reasoning"),
    );
    // Everything it managed to think is delivered, and the block is terminated.
    expect(reasoningOf(out)).toBe(THOUGHT);
    expect(out.filter((e) => e.type === "reasoning_stop")).toHaveLength(1);
  });

  it("a finish arriving mid-block closes it before the finish goes out", async () => {
    const out = await drain(
      withThinkingFormat(stream({ type: "text_delta", text: "<think>half a thought" }, { type: "finish", stopReason: "length" }), "reasoning"),
    );
    const stopAt = out.findIndex((e) => e.type === "reasoning_stop");
    const finishAt = out.findIndex((e) => e.type === "finish");
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(stopAt).toBeLessThan(finishAt);
  });
});

describe("ST: streaming think_tags and none", () => {
  it("think_tags wraps streamed reasoning back into the answer text", async () => {
    const out = await drain(
      withThinkingFormat(
        stream(
          { type: "reasoning_start" },
          { type: "reasoning_delta", text: "half " },
          { type: "reasoning_delta", text: "a thought" },
          { type: "reasoning_stop" },
          { type: "text_delta", text: ANSWER },
          { type: "finish", stopReason: "stop" },
        ),
        "think_tags",
      ),
    );
    expect(textOf(out)).toBe(`<think>\nhalf a thought\n</think>\n\n${ANSWER}`);
    expect(out.some((e) => e.type === "reasoning_delta")).toBe(false);
  });

  it("think_tags closes the block before a tool call, never straddling it", async () => {
    const out = await drain(
      withThinkingFormat(
        stream(
          { type: "reasoning_delta", text: "thinking" },
          { type: "tool_start", index: 0, id: "t1", name: "get" },
          { type: "finish", stopReason: "tool_use" },
        ),
        "think_tags",
      ),
    );
    const text = textOf(out);
    expect(text).toBe("<think>\nthinking\n</think>\n\n");
    const closeAt = out.findIndex((e) => e.type === "text_delta" && (e as { text: string }).text.includes("</think>"));
    const toolAt = out.findIndex((e) => e.type === "tool_start");
    expect(closeAt).toBeLessThan(toolAt);
  });

  it("none removes streamed reasoning from both sources", async () => {
    const fromField = await drain(
      withThinkingFormat(
        stream({ type: "reasoning_delta", text: THOUGHT }, { type: "text_delta", text: ANSWER }, { type: "finish", stopReason: "stop" }),
        "none",
      ),
    );
    expect(reasoningOf(fromField)).toBe("");
    expect(textOf(fromField)).toBe(ANSWER);

    const fromTags = await drain(
      withThinkingFormat(stream(...deltas(`<think>${THOUGHT}</think>${ANSWER}`, 5), { type: "finish", stopReason: "stop" }), "none"),
    );
    expect(reasoningOf(fromTags)).toBe("");
    expect(textOf(fromTags)).toBe(ANSWER);
  });
});
