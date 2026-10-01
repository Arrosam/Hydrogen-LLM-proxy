import { describe, expect, it } from "vitest";
import {
  applyThinkingFormat,
  decodeThinking,
  decodeThinkingStream,
  liftThinkTags,
  THINKING_FORMATS,
  THINKING_QUOTE_LOOKAHEAD,
  withThinkingFormat,
  type ThinkingDelimiters,
  type ThinkingParser,
} from "../src/core/ir/thinkingFormat";
import { reasoningOf as contentReasoning, textOf as contentText, type ContentPart } from "../src/core/ir/content";
import { collectStream, type ResponseData, type StreamEvent } from "../src/core/ir/stream";
import { UpstreamStreamError } from "../src/core/ir/toolArguments";
import { requireAnswer } from "../src/core/ir/answer";
import { AnthropicResponse, OpenAICompletionResponse, OpenAIResponsesResponse } from "../src/core/format";

const THOUGHT = "The user wants the capital. It is Paris.";
const ANSWER = "Paris.";
const TAGS: ThinkingParser = { mode: "think_tags" };
const PAIR: ThinkingDelimiters = { open: "[reasoning]", close: "[/reasoning]" };
const USAGE = { promptTokens: 9, completionTokens: 7, totalTokens: 16 };
const START: StreamEvent = { type: "start", id: "x", model: "m", created: 1 };
const FINISH: StreamEvent = { type: "finish", stopReason: "stop", usage: USAGE };
const TOOL: ContentPart = { type: "tool_use", id: "t1", name: "get", input: {} };
const TOOL_START: StreamEvent = { type: "tool_start", index: 0, id: "t1", name: "get" };
const textOnly = (text: string): ContentPart[] => [{ type: "text", text }];
const withReasoning: ContentPart[] = [{ type: "reasoning", text: THOUGHT }, { type: "text", text: ANSWER }];
const data = (content: ContentPart[]): ResponseData => ({ id: "x", model: "m", created: 1, content, stopReason: "stop", usage: USAGE });

async function* stream(...events: StreamEvent[]): AsyncGenerator<StreamEvent> { yield* events; }
async function drain(events: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}
function deltas(text: string, size: number): StreamEvent[] {
  const out: StreamEvent[] = [];
  for (let i = 0; i < text.length; i += size) out.push({ type: "text_delta", text: text.slice(i, i + size) });
  return out;
}
const textOf = (events: StreamEvent[]): string => events.map(e => e.type === "text_delta" ? e.text : "").join("");
const reasoningOf = (events: StreamEvent[]): string => events.map(e => e.type === "reasoning_delta" ? e.text : "").join("");
const finishOf = (events: StreamEvent[]) => events.find(e => e.type === "finish");

/** Compare canonical content, not chunk boundaries: the latter are transport
 * artifacts and may split delimiters, surrogate pairs, or zero-width literals. */
async function checkPartitions(raw: string, thought: string, answer: string, parser = TAGS): Promise<void> {
  const partitions: string[][] = [[raw], ...[1, 2, 3, 7, 19].map(size => deltas(raw, size).map(e => (e as { text: string }).text))];
  for (let at = 0; at <= raw.length; at++) partitions.push([raw.slice(0, at), raw.slice(at)]);
  for (const pieces of partitions) {
    const buffered = decodeThinking(pieces.map(text => ({ type: "text", text })), parser);
    expect(contentReasoning(buffered)).toBe(thought);
    expect(contentText(buffered)).toBe(answer);
    const out = await drain(decodeThinkingStream(stream(START, ...pieces.map(text => ({ type: "text_delta" as const, text })), FINISH), parser));
    expect(reasoningOf(out)).toBe(thought);
    expect(textOf(out)).toBe(answer);
    expect(out[0]).toBe(START);
    expect(finishOf(out)).toBe(FINISH);
  }
}

describe("explicit decoding is independent from presentation", () => {
  it("absent/off parser is strict identity, even with declared delimiters", () => {
    for (const parser of [undefined, { mode: "off" as const }, { mode: "off" as const, delimiters: PAIR }]) {
      const content = textOnly(`<think>${THOUGHT}</think>${ANSWER}`);
      expect(decodeThinking(content, parser)).toBe(content);
      const events = stream(START, { type: "text_delta", text: contentText(content) }, FINISH);
      expect(decodeThinkingStream(events, parser)).toBe(events);
    }
  });

  for (const format of [...THINKING_FORMATS, undefined]) {
    it(`${format ?? "absent"} presentation never scans`, async () => {
      for (const raw of [`<think>${THOUGHT}</think>${ANSWER}`, `${PAIR.open}${THOUGHT}${PAIR.close}${ANSWER}`, "<think>private truncated body"]) {
        expect(applyThinkingFormat(textOnly(raw), format)).toEqual(textOnly(raw));
        const events: StreamEvent[] = [START, { type: "text_delta", text: raw }, FINISH];
        expect(await drain(withThinkingFormat(stream(...events), format))).toEqual(events);
      }
    });
  }

  it("native-field and original presentation are identity", () => {
    for (const format of [undefined, "original", "reasoning", "reasoning_content"] as const) {
      expect(applyThinkingFormat(withReasoning, format)).toBe(withReasoning);
      const events = stream();
      expect(withThinkingFormat(events, format)).toBe(events);
    }
  });

  it("the compatibility helper is an explicit decode request", () => {
    expect(liftThinkTags(textOnly(`<think>${THOUGHT}</think>${ANSWER}`))).toEqual(withReasoning);
    expect(liftThinkTags(textOnly(`${PAIR.open}${THOUGHT}${PAIR.close}${ANSWER}`), PAIR)).toEqual(withReasoning);
  });

  it("custom mode requires nonempty declared delimiters even for direct callers", () => {
    for (const delimiters of [undefined, { open: "", close: "x" }, { open: "x", close: "" }]) {
      expect(() => decodeThinking([], { mode: "custom", delimiters })).toThrow(TypeError);
      expect(() => decodeThinkingStream(stream(), { mode: "custom", delimiters })).toThrow(TypeError);
    }
  });
});

describe("literal, partition-invariant initial block grammar", () => {
  it("recognizes the exact think pair and normalizes only surrounding separators", async () => {
    const body = `\n ${THOUGHT}\t\n`;
    await checkPartitions(`\n\t<think>${body}</think>\r\n\t ${ANSWER}`, body, ANSWER);
    expect(decodeThinking(textOnly(`<think>${THOUGHT}</think>`), TAGS)).toEqual([{ type: "reasoning", text: THOUGHT }]);
    expect(decodeThinking(textOnly("<think></think>  answer"), TAGS)).toEqual(textOnly("answer"));
  });

  const NOT_TAGS = [
    "<reason>contract reason</reason>", "<reasoning>xml</reasoning>", "<thinking>xml</thinking>",
    "<thought>xml</thought>", "<chain_of_thought>xml</chain_of_thought>", "<deep_think>xml</deep_think>",
    "<think >space</think >", "< think>space</ think>", "<THINK>case</THINK>", "<thi\u200bnk>invisible</thi\u200bnk>",
    "<analysis>xml</analysis>", "<result>xml</result>", "<div class=\"box\">html</div>",
    "Explain <think>this</think>", "`<think>quoted</think>`", "<thinker>word</thinker>",
  ];
  for (const raw of NOT_TAGS) {
    it(`does not guess at ${JSON.stringify(raw)}`, async () => {
      const content = textOnly(raw);
      expect(decodeThinking(content, TAGS)).toBe(content);
      const out = await drain(withThinkingFormat(decodeThinkingStream(stream(...deltas(raw, 1), FINISH), TAGS), "none"));
      expect(textOf(out)).toBe(raw);
      expect(reasoningOf(out)).toBe("");
      expect(finishOf(out)).toBe(FINISH);
    });
  }

  const CUSTOM: ThinkingDelimiters[] = [
    PAIR,
    { open: "<|channel|>analysis<|message|>", close: "<|channel|>final<|message|>" },
    { open: "<thinking>", close: "</thinking>" },
    { open: "\u200b[thi\u200cnk]", close: "[/thi\u200dnk]\u2060" },
    { open: "🙂a", close: "🔚z" },
    { open: "  [[ ", close: " ]] " },
    { open: "x", close: "y" },
    { open: "<", close: "aaaaab" },
    { open: "[", close: "ababaca" },
    { open: "|", close: "|" },
  ];
  for (const pair of CUSTOM) {
    it(`custom literal offsets survive every split: ${JSON.stringify(pair)}`, async () => {
      const body = pair.close === "y" ? "alpha" : "aaabaaaabaababababb partial delimiter";
      await checkPartitions(`${pair.open}${body}${pair.close}\n\n${ANSWER}`, body, ANSWER, { mode: "custom", delimiters: pair });
    });
  }

  it("overlapping custom closes agree with a literal indexOf oracle", async () => {
    // Deterministic finite fuzzing: exercise KMP fallback chains without timing
    // assertions or a probabilistic test. Non-matching suffixes must never vanish.
    let seed = 0x12345678;
    const random = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let n = 0; n < 200; n++) {
      const close = Array.from({ length: 1 + random() % 15 }, () => "abc"[random() % 3]).join("");
      const body = Array.from({ length: 80 }, () => "abc"[random() % 3]).join("");
      const rest = body + close + "answer";
      const at = rest.indexOf(close);
      const parser: ThinkingParser = { mode: "custom", delimiters: { open: "[", close } };
      const out = await drain(decodeThinkingStream(stream(...deltas("[" + rest, 1), FINISH), parser));
      expect(reasoningOf(out)).toBe(rest.slice(0, at));
      expect(textOf(out)).toBe(rest.slice(at + close.length));
      const buffered = decodeThinking(textOnly("[" + rest), parser);
      expect(contentReasoning(buffered)).toBe(reasoningOf(out));
      expect(contentText(buffered)).toBe(textOf(out));
    }
  });

  it("custom zero-width characters are not erased from either markers or offsets", async () => {
    const pair = { open: "[\u200bR]", close: "[/R]" };
    const parser: ThinkingParser = { mode: "custom", delimiters: pair };
    await checkPartitions("[\u200bR]first[/R]answer", "first", "answer", parser);
    const raw = "[R]first[/R]answer";
    expect(decodeThinking(textOnly(raw), parser)).toEqual(textOnly(raw));
  });

  it("only decodes the initial block, not later prose", async () => {
    await checkPartitions("<think>first</think>answer <think>example</think>", "first", "answer <think>example</think>");
  });

  for (const body of ["a dangling `", "a dangling ```\n", "a dangling ~~~\n", "example: `", 'a quote "']) {
    it(`literal close remains authoritative after ${JSON.stringify(body)}`, async () => {
      await checkPartitions(`<think>${body}</think>answer`, body, "answer");
    });
  }

  for (const body of [
    "write `</think>` in prose. Still thinking.",
    "write ``a ` and </think>`` in prose.",
    'write "</think>" in prose.',
    "write '</think>' in prose.",
    "write “</think>” in prose.",
    "Example:\n```xml\n</think>\n```\nStill thinking.",
    "Example:\n~~~xml\n</think>\n~~~\nStill thinking.",
    "Example:\n````xml\n```\n</think>\n````\nStill thinking.",
    "Example:\n  ```xml\n</think>\n  ```  \nStill thinking.",
    "Example:\n```xml\n</think> and </think>\n```\nStill thinking.",
    "The model's response doesn't stop until `</think>` is emitted.",
    "write 'don't emit </think> yet' in prose. Still reasoning.",
    "write ‘don’t emit </think> yet’ in prose. Still reasoning.",
  ]) {
    it(`quoted examples stay reasoning across every split: ${JSON.stringify(body)}`, async () => {
      await checkPartitions(`<think>${body}</think>answer`, body, "answer");
    });
  }

  it("does not consume the proof character starting the true terminator", async () => {
    await checkPartitions("<think>say `</think>`</think>answer", "say `</think>`", "answer");
  });

  it("does not mistake the answer's bare opening fence for proof of a quoted close", async () => {
    await checkPartitions("<think>Example:\n```\nreasoning</think>\n```\nanswer\n```", "Example:\n```\nreasoning", "```\nanswer\n```");
  });

  it("recovers dangling inline quotation at a newline without waiting for EOF", async () => {
    await checkPartitions("<think>dangling `sample</think>\nanswer", "dangling `sample", "answer");
  });

  it("escaped backticks do not poison real boundaries", async () => {
    const body = "a literal \\` character";
    await checkPartitions(`<think>${body}</think>answer`, body, "answer");
  });

  it("custom exact protocol pairs stay literal even inside a quotation", async () => {
    await checkPartitions("<think>write `</think>` in prose</think>answer", "write `", "` in prose</think>answer",
      { mode: "custom", delimiters: { open: "<think>", close: "</think>" } });
  });

  it("normalizes separator whitespace spanning parts but not later answer whitespace", async () => {
    await checkPartitions("<think>x</think>\r\n \t\u00a0answer\n  tail", "x", "answer\n  tail");
  });
});

describe("fail-closed malformed blocks and safe terminal metadata", () => {
  const MALFORMED = ["<think>SECRET", "<think>SECRET</thi", "<think>SECRET</reason>", "<th", "<think"];
  for (const raw of MALFORMED) {
    it(`never releases ${JSON.stringify(raw)} into none presentation`, async () => {
      expect(() => applyThinkingFormat(decodeThinking(textOnly(raw), TAGS), "none")).toThrow(UpstreamStreamError);
      try { decodeThinking(textOnly(raw), TAGS); } catch (e) { expect(String(e)).not.toContain("SECRET"); }
      for (const size of [1, 3, 999]) {
        const out = await drain(requireAnswer(withThinkingFormat(decodeThinkingStream(stream(START, ...deltas(raw, size), { type: "usage", usage: USAGE }, FINISH), TAGS), "none")));
        expect(textOf(out)).toBe("");
        expect(reasoningOf(out)).toBe("");
        expect(out).toContainEqual({ type: "usage", usage: USAGE });
        expect(finishOf(out)).toMatchObject({ type: "finish", stopReason: "stop", usage: USAGE, error: expect.any(String) });
        expect(JSON.stringify(out)).not.toContain("SECRET");
      }
    });
  }

  it("synthetic error finish covers EOF without a terminal event", async () => {
    const out = await drain(decodeThinkingStream(stream({ type: "text_delta", text: "<think>secret</thi" }, { type: "usage", usage: USAGE }), TAGS));
    expect(textOf(out)).toBe("");
    expect(reasoningOf(out)).toBe("secret</thi");
    expect(out.at(-1)).toMatchObject({ type: "finish", stopReason: null, incomplete: true, error: expect.any(String) });
    expect(out).toContainEqual({ type: "usage", usage: USAGE });
  });

  it("never recovers an ambiguous tail as answer on an upstream error or truncation", async () => {
    const raw = "<think>example `</think>PRIVATE_TAIL";
    for (const finish of [
      { type: "finish", stopReason: "stop", incomplete: true, usage: USAGE },
      { type: "finish", stopReason: "stop", error: "upstream failed", usage: USAGE },
      ...(["length", "content_filter", "pause_turn", "tool_use", null] as const).map(stopReason => ({ type: "finish" as const, stopReason, usage: USAGE })),
    ] as StreamEvent[]) {
      const out = await drain(withThinkingFormat(decodeThinkingStream(stream(...deltas(raw, 3), finish), TAGS), "none"));
      expect(textOf(out)).toBe("");
      expect(JSON.stringify(out)).not.toContain("PRIVATE_TAIL");
      expect(finishOf(out)).toHaveProperty("error");
    }
    async function* broken(): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", text: raw };
      throw Error("private transport content");
    }
    const out = await drain(withThinkingFormat(decodeThinkingStream(broken(), TAGS), "none"));
    expect(textOf(out)).toBe("");
    expect(finishOf(out)).toHaveProperty("error");
  });

  it("requires a normal buffered stop to recover an uncertain quoted boundary", () => {
    const raw = "<think>example `</think>PRIVATE_TAIL";
    for (const stop of ["length", "content_filter", "pause_turn", "tool_use", null] as const) {
      expect(() => decodeThinking(textOnly(raw), TAGS, stop)).toThrow("thinking block was interrupted");
    }
    expect(contentText(decodeThinking(textOnly(raw), TAGS, "stop"))).toBe("PRIVATE_TAIL");
    expect(contentText(decodeThinking(textOnly("<think>private</think>partial answer"), TAGS, "length"))).toBe("partial answer");
  });

  it("does not recover an ambiguous tail at iterator EOF without a finish event", async () => {
    const out = await drain(withThinkingFormat(decodeThinkingStream(stream(...deltas("<think>example `</think>PRIVATE_TAIL", 3)), TAGS), "none"));
    expect(textOf(out)).toBe("");
    expect(JSON.stringify(out)).not.toContain("PRIVATE_TAIL");
    expect(finishOf(out)).toMatchObject({ incomplete: true, error: "Upstream thinking block was interrupted" });
  });

  it("retains original terminal fields and an already present upstream error", async () => {
    const finish: StreamEvent = { type: "finish", stopReason: "length", usage: USAGE, incomplete: true, error: "safe upstream error" };
    const out = await drain(decodeThinkingStream(stream({ type: "text_delta", text: "<think>secret" }, finish), TAGS));
    expect(finishOf(out)).toEqual(finish);
    expect(textOf(out)).toBe("");
  });

  it("reasoning policy retains the whole unterminated body including partial close", async () => {
    const parser: ThinkingParser = { ...TAGS, unterminated: "reasoning" };
    const raw = "<think> secret\n</thi";
    expect(decodeThinking(textOnly(raw), parser)).toEqual([{ type: "reasoning", text: " secret\n</thi" }]);
    await checkPartitions(raw, " secret\n</thi", "", parser);
    const hidden = await drain(withThinkingFormat(decodeThinkingStream(stream(...deltas(raw, 1), FINISH), parser), "none"));
    expect(textOf(hidden)).toBe("");
    expect(reasoningOf(hidden)).toBe("");
    expect(finishOf(hidden)).toBe(FINISH);
    expect(() => decodeThinking(textOnly("<thi"), parser)).toThrow(UpstreamStreamError);
  });

  for (const interrupted of [TOOL_START, { type: "reasoning_start", signature: "OPAQUE" }, { type: "reasoning_delta", text: "NATIVE" }, { type: "reasoning_stop", signature: "OPAQUE" }] as StreamEvent[]) {
    it(`${interrupted.type} interrupts a candidate without leaking subsequent payload`, async () => {
      for (const raw of ["<th", "<think>SECRET"]) {
        for (const unterminated of ["error", "reasoning"] as const) {
          const out = await drain(decodeThinkingStream(stream({ type: "text_delta", text: raw }, interrupted, { type: "text_delta", text: "DO_NOT_LEAK" }, { type: "usage", usage: USAGE }, FINISH), { ...TAGS, unterminated }));
          expect(textOf(out)).toBe("");
          expect(out).not.toContain(interrupted);
          expect(finishOf(out)).toMatchObject({ error: "Upstream thinking block was interrupted", usage: USAGE });
          expect(JSON.stringify(out)).not.toContain("DO_NOT_LEAK");
        }
      }
    });
  }

  it("buffered structural interruptions fail just like streamed ones", () => {
    for (const interrupt of [TOOL, { type: "reasoning", text: "native", signature: "SIGNED" }] as ContentPart[]) {
      for (const raw of ["<th", "<think>secret"]) {
        expect(() => decodeThinking([...textOnly(raw), interrupt, ...textOnly("unsafe")], TAGS)).toThrow("Upstream thinking block was interrupted");
      }
    }
  });

  it("upstream exceptions mid-block become safe errors without exposing exception contents", async () => {
    async function* broken(): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", text: "<think>secret" };
      yield { type: "usage", usage: USAGE };
      throw new Error("SECRET_FROM_TRANSPORT");
    }
    const out = await drain(withThinkingFormat(decodeThinkingStream(broken(), TAGS), "none"));
    expect(textOf(out)).toBe("");
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(finishOf(out)).toHaveProperty("error");
    expect(out).toContainEqual({ type: "usage", usage: USAGE });
  });
});

describe("bounded incremental decoding, not whole-block buffering", () => {
  it("unresolved quotations stop at the fixed bound, not EOF or an unbounded answer", async () => {
    for (const quote of ["`", "\"", "\n```xml\n"]) {
      const prefix = `<think>example ${quote}</think>`;
      const raw = prefix + "SECRET" + "x".repeat(THINKING_QUOTE_LOOKAHEAD) + "</think>answer";
      expect(() => decodeThinking(textOnly(raw), TAGS)).toThrow("thinking boundary is ambiguous");
      for (const size of [1, 7, 99999]) {
        let ended = false;
        let closed = false;
        async function* input(): AsyncGenerator<StreamEvent> {
          try {
            yield* deltas(raw, size);
            ended = true;
            yield FINISH;
          } finally { closed = true; }
        }
        const out = await drain(withThinkingFormat(decodeThinkingStream(input(), TAGS), "none"));
        expect(textOf(out)).toBe("");
        expect(JSON.stringify(out)).not.toContain("SECRET");
        expect(finishOf(out)).toMatchObject({ error: expect.stringContaining("thinking boundary is ambiguous"), incomplete: true });
        expect(ended).toBe(false);
        expect(closed).toBe(true);
      }
    }
  });

  it("additional markers do not reset the ambiguous quotation budget", async () => {
    const raw = "<think>```xml\n</think>" + "</think>".repeat(600);
    const out = await drain(withThinkingFormat(decodeThinkingStream(stream(...deltas(raw, 3), FINISH), TAGS), "none"));
    expect(textOf(out)).toBe("");
    expect(finishOf(out)).toHaveProperty("error", expect.stringContaining("thinking boundary is ambiguous"));
  });

  it("emits reasoning before pulling the closing chunk", async () => {
    let pulls = 0;
    async function* source(): AsyncGenerator<StreamEvent> {
      pulls++; yield { type: "text_delta", text: "<think>first" };
      pulls++; yield { type: "text_delta", text: " next" };
      pulls++; yield { type: "text_delta", text: "</think>answer" };
      pulls++; yield FINISH;
    }
    const out = decodeThinkingStream(source(), TAGS);
    expect((await out.next()).value).toEqual({ type: "reasoning_start" });
    expect((await out.next()).value).toEqual({ type: "reasoning_delta", text: "first" });
    expect(pulls).toBe(1);
    expect((await out.next()).value).toEqual({ type: "reasoning_delta", text: " next" });
    expect(pulls).toBe(2);
    const tail = await drain(out);
    expect(tail[0]).toEqual({ type: "reasoning_stop" });
    expect(textOf(tail)).toBe("answer");
  });

  it("retains only possible closing suffix across a large number of small chunks", async () => {
    const count = 20_000;
    const chunk = "a".repeat(31) + "x";
    const close = "aaaaab";
    let produced = 0;
    let consumed = 0;
    async function* source(): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", text: "[" };
      for (let i = 0; i < count; i++) { produced += chunk.length; yield { type: "text_delta", text: chunk }; }
      yield { type: "text_delta", text: close + ANSWER };
      yield FINISH;
    }
    for await (const event of decodeThinkingStream(source(), { mode: "custom", delimiters: { open: "[", close } })) {
      if (event.type === "reasoning_delta") {
        consumed += event.text.length;
        expect(produced - consumed).toBeLessThan(close.length);
      }
      if (event.type === "text_delta") expect(event.text).toBe(ANSWER);
    }
    expect(consumed).toBe(count * chunk.length);
  });

  it("padding bound is the same for buffered, single-chunk and split input", async () => {
    await checkPartitions(" ".repeat(512) + "<think>x</think>answer", "x", "answer");
    for (const raw of [" ".repeat(513), " ".repeat(513) + "<think>secret</think>answer"]) {
      expect(() => decodeThinking(textOnly(raw), TAGS)).toThrow("512-character padding limit");
      for (const size of [1, 512, 9999]) {
        const out = await drain(withThinkingFormat(decodeThinkingStream(stream(...deltas(raw, size), FINISH), TAGS), "none"));
        expect(textOf(out)).toBe("");
        expect(finishOf(out)).toMatchObject({ error: "Upstream thinking prefix exceeds the 512-character padding limit" });
      }
    }
  });

  it("releases ordinary short answers and whitespace-only prefixes without loss", async () => {
    for (const raw of ["", "ok", " \n\t", "<other>", " ".repeat(512)]) {
      await checkPartitions(raw, "", raw);
    }
  });
});

describe("structured authority, content order, signatures and usage", () => {
  it("native reasoning first disables the textual scan and preserves opaque fields", async () => {
    const native: ContentPart = { type: "reasoning", text: "", signature: "SIGNED", origin: "anthropic", redacted: true, itemId: "r1" };
    const content = [native, ...textOnly("<think>literal answer markup</think>"), TOOL];
    expect(decodeThinking(content, TAGS)).toBe(content);
    for (const format of ["original", "reasoning", "reasoning_content"] as const) expect(applyThinkingFormat(decodeThinking(content, TAGS), format)).toBe(content);
    const events: StreamEvent[] = [START, { type: "reasoning_start", id: "r1", signature: "SIGNED", origin: "anthropic", redacted: true }, { type: "reasoning_stop", id: "r1", signature: "SIGNED", origin: "anthropic", redacted: true }, { type: "text_delta", text: "<think>literal answer markup</think>" }, FINISH];
    expect(await drain(decodeThinkingStream(stream(...events), TAGS))).toEqual(events);
  });

  it("tool-first responses disable scanning; nothing is hoisted across the tool", async () => {
    const content = [TOOL, ...textOnly("<think>literal</think>")];
    expect(decodeThinking(content, TAGS)).toBe(content);
    const out = await drain(decodeThinkingStream(stream(TOOL_START, { type: "text_delta", text: "<think>literal</think>" }, FINISH), TAGS));
    expect(out[0]).toBe(TOOL_START);
    expect(textOf(out)).toBe("<think>literal</think>");
  });

  it("unrelated buffered content and text metadata survive in order", () => {
    const image: ContentPart = { type: "image", source: { kind: "url", url: "https://example.com/image.png" } };
    const native: ContentPart = { type: "reasoning", text: "later", signature: "SIGNED", origin: "openai_responses", itemId: "r" };
    const tail: ContentPart = { type: "text", text: "\n\nanswer", cacheControl: { type: "ephemeral" } };
    const content: ContentPart[] = [...textOnly("<thi"), ...textOnly("nk>body</th"), ...textOnly("ink>"), tail, image, TOOL, native, ...textOnly("after")];
    const out = decodeThinking(content, TAGS);
    expect(out).toEqual([{ type: "reasoning", text: "body" }, { ...tail, text: "answer" }, image, TOOL, native, { type: "text", text: "after" }]);
    expect(out[2]).toBe(image);
    expect(out[3]).toBe(TOOL);
    expect(out[4]).toBe(native);
  });

  it("start and usage between delimiter fragments are transparent", async () => {
    const usage: StreamEvent = { type: "usage", usage: USAGE };
    const out = await drain(decodeThinkingStream(stream(START, { type: "text_delta", text: "<th" }, usage, { type: "text_delta", text: "ink>body</th" }, usage, { type: "text_delta", text: "ink>answer" }, FINISH), TAGS));
    expect(out.filter(e => e.type === "usage")).toEqual([usage, usage]);
    expect(out[0]).toBe(START);
    expect(finishOf(out)).toBe(FINISH);
    expect(reasoningOf(out)).toBe("body");
    expect(textOf(out)).toBe("answer");
  });

  it("drops raw logprobs before the opener and mid-block without ending the scan", async () => {
    const privateLogprobs: StreamEvent = { type: "logprobs", value: { content: [{ token: "PRIVATE_TOKEN", logprob: -0.1 }] } };
    const events: StreamEvent[] = [START, privateLogprobs, { type: "text_delta", text: "<th" }, privateLogprobs,
      { type: "text_delta", text: "ink>private thought" }, privateLogprobs,
      { type: "text_delta", text: "</think>answer" }, privateLogprobs, FINISH];
    const decoded = await drain(decodeThinkingStream(stream(...events), TAGS));
    expect(reasoningOf(decoded)).toBe("private thought");
    expect(textOf(decoded)).toBe("answer");
    expect(decoded.some(e => e.type === "logprobs")).toBe(false);
    expect(finishOf(decoded)).toBe(FINISH);
    const hidden = await drain(withThinkingFormat(decodeThinkingStream(stream(...events), TAGS), "none"));
    expect(JSON.stringify(hidden)).not.toContain("private thought");
    expect(JSON.stringify(hidden)).not.toContain("PRIVATE_TOKEN");
    expect(textOf(hidden)).toBe("answer");
    for (const parser of [undefined, { mode: "off" as const }]) {
      expect(await drain(decodeThinkingStream(stream(...events), parser))).toEqual(events);
    }
  });

  it("a collector retains accounting on malformed none decoding", async () => {
    const result = await collectStream(withThinkingFormat(decodeThinkingStream(stream(START, { type: "text_delta", text: "<think>private" }, FINISH), TAGS), "none"));
    expect(result.data.content).toEqual([]);
    expect(result.data.usage).toMatchObject(USAGE);
    expect(result.error).toBe("Upstream thinking block is unterminated");
    expect(result.incomplete).toBe(true);
  });
});

describe("pure presentation across client wires", () => {
  it("none removes only reasoning after an explicit decode", async () => {
    const raw = `<think>${THOUGHT}</think>${ANSWER}`;
    expect(applyThinkingFormat(decodeThinking(textOnly(raw), TAGS), "none")).toEqual(textOnly(ANSWER));
    const out = await drain(withThinkingFormat(decodeThinkingStream(stream(...deltas(raw, 3), FINISH), TAGS), "none"));
    expect(textOf(out)).toBe(ANSWER);
    expect(reasoningOf(out)).toBe("");
  });

  it("think_tags inlines readable reasoning and suppresses redacted blocks", async () => {
    const raw = `<think>\n${THOUGHT}\n</think>\n\n${ANSWER}`;
    expect(applyThinkingFormat(withReasoning, "think_tags")).toEqual(textOnly(raw));
    expect(applyThinkingFormat([{ type: "reasoning", text: "", redacted: true, signature: "OPAQUE" }, ...textOnly(ANSWER)], "think_tags")).toEqual(textOnly(ANSWER));
    const out = await drain(withThinkingFormat(stream({ type: "reasoning_start" }, { type: "reasoning_delta", text: THOUGHT }, { type: "reasoning_stop" }, { type: "text_delta", text: ANSWER }, FINISH), "think_tags"));
    expect(textOf(out)).toBe(raw);
    expect(reasoningOf(out)).toBe("");
  });

  it("inlining preserves the order of separated reasoning/tool/text blocks", async () => {
    const content: ContentPart[] = [...textOnly("first"), { type: "reasoning", text: "one" }, TOOL, { type: "reasoning", text: "two" }, ...textOnly("last")];
    expect(applyThinkingFormat(content, "think_tags")).toEqual([...textOnly("first"), ...textOnly("<think>\none\n</think>\n\n"), TOOL, ...textOnly("<think>\ntwo\n</think>\n\nlast")]);
    const out = await drain(withThinkingFormat(stream({ type: "reasoning_delta", text: "one" }, TOOL_START, FINISH), "think_tags"));
    expect(textOf(out)).toBe("<think>\none\n</think>\n\n");
    expect(out.findIndex(e => e.type === "tool_start")).toBeGreaterThan(out.findIndex(e => e.type === "text_delta" && e.text.includes("</think>")));
  });

  for (const field of ["reasoning", "reasoning_content"] as const) {
    it(`${field} controls only the Chat Completions field name`, () => {
      const shaped = applyThinkingFormat(decodeThinking(textOnly(`<think>${THOUGHT}</think>${ANSWER}`), TAGS), field);
      const body = new OpenAICompletionResponse(data(shaped)).renderSelf("svc", { thinkingFormat: field });
      const message = (body.choices as Array<{ message: Record<string, unknown> }>)[0].message;
      expect(message[field]).toBe(THOUGHT);
      expect(message[field === "reasoning" ? "reasoning_content" : "reasoning"]).toBeUndefined();
      expect(message.content).toBe(ANSWER);
      const anthropic = new AnthropicResponse(data(shaped)).renderSelf("svc", { thinkingFormat: field });
      expect((anthropic.content as unknown[])[0]).toMatchObject({ type: "thinking", thinking: THOUGHT });
      const responses = new OpenAIResponsesResponse(data(shaped)).renderSelf("svc", { thinkingFormat: field });
      expect((responses.output as Array<{ type: string }>).some(p => p.type === "reasoning")).toBe(true);
    });
  }

  it("original output keeps both native Chat Completions dialect spellings", () => {
    const body = new OpenAICompletionResponse(data(withReasoning)).renderSelf("svc");
    const message = (body.choices as Array<{ message: Record<string, unknown> }>)[0].message;
    expect(message.reasoning).toBe(THOUGHT);
    expect(message.reasoning_content).toBe(THOUGHT);
  });
});
