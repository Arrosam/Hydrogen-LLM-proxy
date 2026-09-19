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
  type ThinkingDelimiters,
  type ThinkingFormat,
} from "../src/core/ir/thinkingFormat";
import type { ContentPart } from "../src/core/ir/content";
import type { StreamEvent } from "../src/core/ir/stream";
import { AnthropicResponse, OpenAICompletionResponse, OpenAIResponsesResponse } from "../src/core/format";
import type { ResponseData } from "../src/core/ir/stream";
import { requireAnswer } from "../src/core/ir/answer";

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

describe("EG: a stream that dies inside a candidate thinking block", () => {
  it("the held run goes out as text, matching the buffered path", async () => {
    const out = await drain(
      withThinkingFormat(stream(...deltas(`<think>${THOUGHT}`, 4)), "reasoning"),
    );
    // A block that never closed is the answer text, not a thought -- the same
    // contract `liftThinkTags` documents. Nothing was emitted as reasoning.
    expect(reasoningOf(out)).toBe("");
    expect(textOf(out).endsWith(THOUGHT)).toBe(true);
    expect(out.some((e) => e.type === "reasoning_stop")).toBe(false);
  });

  it("a finish arriving mid-block releases the held run before the finish", async () => {
    const out = await drain(
      withThinkingFormat(stream({ type: "text_delta", text: "<think>half a thought" }, { type: "finish", stopReason: "length" }), "reasoning"),
    );
    const textAt = out.findIndex((e) => e.type === "text_delta");
    const finishAt = out.findIndex((e) => e.type === "finish");
    expect(textAt).toBeGreaterThanOrEqual(0);
    expect(textAt).toBeLessThan(finishAt);
    expect(out.some((e) => e.type === "reasoning_delta")).toBe(false);
  });

  it("a truncated tag block is not reported as thinking-with-no-answer", async () => {
    // The exact regression: the relay validates the RAW stream, shapes it, then
    // validates the SHAPED stream again. When shaping reclassified an
    // unterminated block as reasoning, the second pass rejected an answer that
    // was really there, and the client saw a thinking block with no content.
    const raw = String.fromCharCode(60) + "think" + String.fromCharCode(62) + THOUGHT + " and then the stream died";
    const shaped = withThinkingFormat(stream(...deltas(raw, 3), { type: "finish", stopReason: "stop" }), "reasoning_content");
    const out = await drain(requireAnswer(shaped));
    expect(out.find((e) => e.type === "finish")).not.toHaveProperty("error");
    expect(textOf(out)).toBe(raw);
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

// --- EG: the spellings a model actually emits ------------------------------

/** A tag spelled with `name`, so a case can pair any two spellings. */
const openTag = (name: string): string => `<${name}>`;
const closeTag = (name: string): string => `</${name}>`;

/**
 * Every one of these must be FOUND, and the buffered and streaming scans must
 * agree on it: the same response has to reach a client the same way whether or
 * not it streamed.
 *
 * The failure they pin was silent and looked like a client bug. When the scan
 * did not recognise a tag, the block was never lifted and the raw tags went out
 * as the ANSWER text -- which the client parses again, opening a thinking block
 * that swallows the answer, so the user saw thinking and no output at all.
 *
 * Each of these is a real spelling: a template pads a tag (`<think >`), a model
 * mixes the synonyms it opens and closes with, and a model occasionally emits a
 * zero-width character inside a token. The close name used to be built from the
 * OPENING tag's name, so a mixed pair matched nothing and nothing was lifted.
 */
describe("EG: the tag spellings a model actually emits", () => {
  const SPELLINGS: Array<[string, string]> = [
    ["a matched pair", `${openTag("think")}${THOUGHT}${closeTag("think")}`],
    ["a close in another spelling", `${openTag("thinking")}${THOUGHT}${closeTag("reasoning")}`],
    ["a close in the shortest spelling", `${openTag("thinking")}${THOUGHT}${closeTag("think")}`],
    ["a space before the closing bracket", `${openTag("think ")}${THOUGHT}${closeTag("think ")}`],
    ["a newline before the closing bracket", `${openTag("think\n")}${THOUGHT}${closeTag("think\n")}`],
    ["a non-breaking space inside the tag", `${openTag("think\u00a0")}${THOUGHT}${closeTag("think\u00a0")}`],
    ["a zero-width space inside the name", `${openTag("thi\u200bnk")}${THOUGHT}${closeTag("thi\u200bnk")}`],
    ["leading newlines from a template", `${"\n".repeat(30)}${openTag("think")}${THOUGHT}${closeTag("think")}`],
    ["a wide indent before the tag", `${" ".repeat(40)}${openTag("think")}${THOUGHT}${closeTag("think")}`],
    // The name is recognised by its stem, so a template that wraps it still
    // works -- and these are the cases a fixed three-name list missed, which
    // delivered the whole block to the client as the ANSWER.
    ["the thought spelling", `${openTag("thought")}${THOUGHT}${closeTag("thought")}`],
    ["a wrapped name", `${openTag("chain_of_thought")}${THOUGHT}${closeTag("chain_of_thought")}`],
    ["a prefixed name", `${openTag("thinking_process")}${THOUGHT}${closeTag("thinking_process")}`],
    ["a stem in the middle of the name", `${openTag("deep_think")}${THOUGHT}${closeTag("deep_think")}`],
    ["a wrapped name closed with a plain one", `${openTag("chain_of_thought")}${THOUGHT}${closeTag("reasoning")}`],
  ];

  for (const [name, head] of SPELLINGS) {
    it(`${name} is found, buffered and streamed alike`, async () => {
      const raw = `${head}\n\n${ANSWER}`;
      const buffered = applyThinkingFormat(textOnly(raw), "reasoning_content");
      expect(buffered).toEqual([
        { type: "reasoning", text: THOUGHT },
        { type: "text", text: ANSWER },
      ]);

      // One character at a time is the worst case: every tag lands across a
      // chunk boundary, which is where an unsettled prefix has to be held.
      for (const size of [1, 2, 3, 7, 500]) {
        const out = await drain(
          withThinkingFormat(stream(...deltas(raw, size), { type: "finish", stopReason: "stop" }), "reasoning_content"),
        );
        expect(reasoningOf(out)).toBe(THOUGHT);
        expect(textOf(out)).toBe(ANSWER);
      }
    });
  }

  it("an unterminated block is still text, however its tags were spelled", async () => {
    // The contract this scanner has always had: a block that never closed is
    // the answer text, not a thought. Recognising more spellings must not turn
    // a truncated answer into an empty response.
    const raw = `${openTag("thinking")}${THOUGHT}`;
    expect(liftThinkTags(textOnly(raw))).toEqual(textOnly(raw));
    const out = await drain(withThinkingFormat(stream(...deltas(raw, 2)), "reasoning_content"));
    expect(reasoningOf(out)).toBe("");
    expect(textOf(out)).toBe(raw);
  });

  it("padding alone never settles the scan", async () => {
    // A run of leading newlines is a chat template, not the answer beginning.
    // Ending the scan on it left the tag in the answer text on the streaming
    // path while the buffered path lifted it.
    const out = await drain(
      withThinkingFormat(
        stream(...deltas(`${"\n".repeat(200)}${openTag("think")}${THOUGHT}${closeTag("think")}\n${ANSWER}`, 4), { type: "finish", stopReason: "stop" }),
        "reasoning_content",
      ),
    );
    expect(reasoningOf(out)).toBe(THOUGHT);
    expect(textOf(out)).toBe(ANSWER);
  });
});

/**
 * The reasoning of a model that is thinking ABOUT these tags quotes them, and a
 * quotation is not the end of the thought.
 *
 * This is the failure that reaches a user as "that is still the thinking, but
 * my client showed it as the answer". The scanner took the FIRST close tag --
 * the one the model had just written down inside a code span or a fence -- as
 * the end of the block, so everything after it, the rest of the reasoning and
 * the answer itself, was delivered as ordinary answer text.
 */
describe("EG: a close tag the model only quoted", () => {
  const TICK = String.fromCharCode(96);
  const FENCE = TICK.repeat(3);

  /** The real-world shape: a quotation mid-reasoning, then a real end. */
  const QUOTED: Array<[string, string]> = [
    ["quoted in a code span", `The block ends at ${TICK}${closeTag("think")}${TICK}, normally.\nKeep going.`],
    ["quoted in a code span, other spelling", `The block ends at ${TICK}${closeTag("reasoning")}${TICK}, normally.\nKeep going.`],
    ["quoted in a fenced example", `Example:\n${FENCE}\n${closeTag("think")}\n${FENCE}\nAfter the example.`],
  ];

  for (const [name, body] of QUOTED) {
    it(`${name} does not end the thought`, async () => {
      const raw = `${openTag("think")}${body}${closeTag("think")}\n\n${ANSWER}`;
      const buffered = applyThinkingFormat(textOnly(raw), "reasoning_content");
      expect(buffered).toEqual([
        { type: "reasoning", text: body },
        { type: "text", text: ANSWER },
      ]);
      for (const size of [1, 2, 3, 7, 500]) {
        const out = await drain(
          withThinkingFormat(stream(...deltas(raw, size), { type: "finish", stopReason: "stop" }), "reasoning_content"),
        );
        expect(reasoningOf(out)).toBe(body);
        expect(textOf(out)).toBe(ANSWER);
      }
    });
  }

  it("a block whose only close tags are quotations stays answer text", async () => {
    // The safe direction, and the same contract as an unterminated block: a
    // thought that never really ended is not worth losing the answer over.
    const raw = `${openTag("think")}Only a quotation here: ${TICK}${closeTag("think")}${TICK} and no real end.`;
    expect(liftThinkTags(textOnly(raw))).toEqual(textOnly(raw));
    const out = await drain(withThinkingFormat(stream(...deltas(raw, 3)), "reasoning_content"));
    expect(reasoningOf(out)).toBe("");
    expect(textOf(out)).toBe(raw);
  });
});

describe("DT: a tag at the head that is NOT thinking", () => {
  // Recognising a name by its stem must not turn a real answer's own markup into
  // thinking: these are wrappers models are asked to answer in, and `analysis`
  // in particular is a structured-answer tag, not a trace.
  const NOT_THINKING = [
    `${openTag("div")}markup${closeTag("div")}`,
    `${openTag("analysis")}a structured answer${closeTag("analysis")}`,
    `${openTag("div class=\"box\"")}attributes${closeTag("div")}`,
    `${openTag("result")}a structured answer${closeTag("result")}`,
  ];

  for (const [i, raw] of NOT_THINKING.entries()) {
    it(`case ${i + 1} stays answer text`, async () => {
      expect(liftThinkTags(textOnly(`${raw}\n\n${ANSWER}`))).toEqual(textOnly(`${raw}\n\n${ANSWER}`));
      const out = await drain(withThinkingFormat(stream(...deltas(raw, 2), { type: "finish", stopReason: "stop" }), "reasoning_content"));
      expect(reasoningOf(out)).toBe("");
      expect(textOf(out)).toBe(raw);
    });
  }
});

/**
 * The escape hatch every serious implementation of this ships: the operator
 * states the boundaries outright. Scanning by tag SHAPE cannot cover a model
 * that does not delimit its trace that way -- GPT-OSS's harmony channels are
 * the standard example -- so a declared pair is matched literally instead.
 * vLLM exposes the same thing as `--reasoning-config`, Open WebUI as a
 * configurable reasoning tag pair.
 */
describe("EP: operator-declared boundaries", () => {
  const CASES: Array<[string, ThinkingDelimiters]> = [
    ["harmony channels", { open: "<|channel|>analysis<|message|>", close: "<|channel|>final<|message|>" }],
    ["a bracket pair no name rule could guess", { open: "[reasoning]", close: "[/reasoning]" }],
    ["a plain tag pair", { open: "<thinking>", close: "</thinking>" }],
  ];

  for (const [name, pair] of CASES) {
    it(`${name}: lifted, buffered and streamed alike`, async () => {
      const raw = `${pair.open}${THOUGHT}${pair.close}${ANSWER}`;
      expect(applyThinkingFormat(textOnly(raw), "reasoning_content", pair)).toEqual([
        { type: "reasoning", text: THOUGHT },
        { type: "text", text: ANSWER },
      ]);
      // One character at a time: the declaration has to survive every chunk
      // boundary, including one that lands inside the marker itself.
      for (const size of [1, 2, 3, 7, 500]) {
        const out = await drain(
          withThinkingFormat(stream(...deltas(raw, size), { type: "finish", stopReason: "stop" }), "reasoning_content", pair),
        );
        expect(reasoningOf(out)).toBe(THOUGHT);
        expect(textOf(out)).toBe(ANSWER);
      }
    });
  }

  it("declaring the boundaries is enough, even while the format is `original`", async () => {
    // A pair is a statement about the UPSTREAM, so it has to work on its own:
    // the format only decides how the thinking is presented afterwards.
    const pair: ThinkingDelimiters = { open: "<|channel|>analysis<|message|>", close: "<|channel|>final<|message|>" };
    const raw = `${pair.open}${THOUGHT}${pair.close}${ANSWER}`;
    const out = await drain(withThinkingFormat(stream(...deltas(raw, 4), { type: "finish", stopReason: "stop" }), "original", pair));
    expect(reasoningOf(out)).toBe(THOUGHT);
    expect(textOf(out)).toBe(ANSWER);
  });

  it("an unterminated declared block is still the answer", async () => {
    const pair: ThinkingDelimiters = { open: "[reasoning]", close: "[/reasoning]" };
    const raw = `${pair.open}${THOUGHT}`;
    expect(applyThinkingFormat(textOnly(raw), "reasoning_content", pair)).toEqual(textOnly(raw));
    const out = await drain(withThinkingFormat(stream(...deltas(raw, 2)), "reasoning_content", pair));
    expect(reasoningOf(out)).toBe("");
    expect(textOf(out)).toBe(raw);
  });

  it("a service with no pair is untouched by the feature", () => {
    const raw = `[reasoning]${THOUGHT}[/reasoning]${ANSWER}`;
    expect(applyThinkingFormat(textOnly(raw), "reasoning_content")).toEqual(textOnly(raw));
  });
});

describe("EG: a tag quoted in prose, not only in code", () => {
  // The reasoning of a model that is thinking ABOUT these tags writes them down
  // in passing: `…` and then keeps thinking. Missing that quotation ends the
  // block early, and everything after it -- the rest of the reasoning and the
  // answer -- is delivered as the answer.
  const QUOTED_INLINE = `${openTag("think")}To close it you write ${"`"}${closeTag("think")}${"`"} like that.\nKeep thinking.${closeTag("think")}\n\n${ANSWER}`;

  it("a backtick-wrapped quotation is not the end", async () => {
    const want = `To close it you write ${"`"}${closeTag("think")}${"`"} like that.\nKeep thinking.`;
    expect(applyThinkingFormat(textOnly(QUOTED_INLINE), "reasoning_content")).toEqual([
      { type: "reasoning", text: want },
      { type: "text", text: ANSWER },
    ]);
    for (const size of [1, 3, 9, 500]) {
      const out = await drain(
        withThinkingFormat(stream(...deltas(QUOTED_INLINE, size), { type: "finish", stopReason: "stop" }), "reasoning_content"),
      );
      expect(reasoningOf(out)).toBe(want);
      expect(textOf(out)).toBe(ANSWER);
    }
  });

  it("a real end followed by a code fence still ends the block", async () => {
    // Only ONE side is a backtick here, so it is a terminator rather than a
    // quotation -- requiring both sides is what keeps this case working.
    const raw = `${openTag("think")}Reasoning.${closeTag("think")}${"```"}js\ncode\n${"```"}`;
    const out = await drain(withThinkingFormat(stream(...deltas(raw, 3), { type: "finish", stopReason: "stop" }), "reasoning_content"));
    expect(reasoningOf(out)).toBe("Reasoning.");
    expect(textOf(out)).toBe(`${"```"}js\ncode\n${"```"}`);
  });
});
