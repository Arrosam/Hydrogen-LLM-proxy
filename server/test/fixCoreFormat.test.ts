/**
 * Regression tests for the CORE-area defect fixes in server/src/core/format and
 * server/src/core/ir (items C1-C7 of the defect list).
 */
import { describe, expect, it } from "vitest";
import { AnthropicRequest, OpenAICompletionRequest, OpenAICompletionResponse, OpenAIResponsesRequest } from "../src/core/format";
import { encodeReasoning } from "../src/core/format/reasoningBridge";
import type { ContentPart } from "../src/core/ir/content";
import type { Request } from "../src/core/ir/request";
import type { StreamEvent } from "../src/core/ir/stream";
import { applyThinkingFormat, withThinkingFormat } from "../src/core/ir/thinkingFormat";

const TARGET = { upstreamModel: "up", url: "http://up.test/v1", headers: {}, timeoutMs: 1000 };

/** What the three wire-family classes share, so a loop can hold them as one type. */
interface WireFamily {
  construct(base: Request): { render(target: typeof TARGET): unknown };
}
const wireFamilies = (...families: WireFamily[]): WireFamily[] => families;

async function drain(events: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

// --- C1: assistant reasoning on a Chat request -------------------------------

describe("C1: a Chat request reads the first NON-EMPTY reasoning field", () => {
  const reasoningOf = (assistant: Record<string, unknown>): string[] => {
    const req = OpenAICompletionRequest.parse({
      model: "svc",
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "answer", ...assistant }, { role: "user", content: "next" }],
    });
    return req.messages[1].content.filter((p) => p.type === "reasoning").map((p) => (p as { text: string }).text);
  };

  const rows: Array<[string, Record<string, unknown>, string[]]> = [
    ["empty reasoning does not mask reasoning_content", { reasoning: "", reasoning_content: "T" }, ["T"]],
    ["empty reasoning and reasoning_content do not mask reasoning_text", { reasoning: "", reasoning_content: "", reasoning_text: "T" }, ["T"]],
    ["null reasoning falls through", { reasoning: null, reasoning_content: "T" }, ["T"]],
    ["the Ollama `thinking` spelling is read", { thinking: "T" }, ["T"]],
    ["empty reasoning does not mask thinking", { reasoning: "", thinking: "T" }, ["T"]],
    ["the first populated field wins", { reasoning: "A", reasoning_content: "B", reasoning_text: "C", thinking: "D" }, ["A"]],
    ["reasoning_content beats reasoning_text", { reasoning_content: "B", reasoning_text: "C" }, ["B"]],
    ["all empty is no reasoning", { reasoning: "", reasoning_content: "", reasoning_text: "", thinking: "" }, []],
    ["no field is no reasoning", {}, []],
  ];
  it.each(rows)("%s", (_name, assistant, expected) => {
    expect(reasoningOf(assistant)).toEqual(expected);
  });

  it("the recovered reasoning is replayed to a Chat upstream", () => {
    const req = OpenAICompletionRequest.parse({
      model: "svc",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: null, reasoning: "", reasoning_content: "T", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "ok" },
      ],
    });
    const body = req.render(TARGET) as { messages: Array<Record<string, unknown>> };
    expect(body.messages[1].reasoning_content).toBe("T");
  });
});

// --- C2: unreadable envelopes never reach an upstream ------------------------

describe("C2: an unreadable hydrogen envelope is dropped, not forwarded", () => {
  const BROKEN = ["hydrogen-redacted-thinking-v1:!!!not-base64-json!!!", "hydrogen-reasoning-v1:!!!not-base64-json!!!", "hydrogen-reasoning-v1:"];
  const NATIVE = "gAAAAAreal-openai-payload";

  it.each(BROKEN)("Responses ingress, envelope only (%s): the item is lost", (envelope) => {
    const req = OpenAIResponsesRequest.parse({
      model: "svc",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }, { type: "reasoning", id: "rs_1", summary: [], encrypted_content: envelope }],
    });
    expect(req.messages.flatMap((m) => m.content).filter((p) => p.type === "reasoning")).toEqual([]);
    for (const Family of wireFamilies(OpenAIResponsesRequest, AnthropicRequest, OpenAICompletionRequest)) {
      expect(JSON.stringify(Family.construct(req).render(TARGET))).not.toContain("hydrogen-");
    }
  });

  it.each(BROKEN)("Responses ingress, envelope beside readable text (%s): the text survives, the envelope does not", (envelope) => {
    const req = OpenAIResponsesRequest.parse({
      model: "svc",
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thought" }], encrypted_content: envelope },
        { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
    });
    const reasoning = req.messages.flatMap((m) => m.content).filter((p) => p.type === "reasoning");
    expect(reasoning).toEqual([{ type: "reasoning", text: "thought", signature: undefined, origin: "openai_responses", itemId: "rs_1" }]);
    const body = JSON.stringify(OpenAIResponsesRequest.construct(req).render(TARGET));
    expect(body).not.toContain("hydrogen-");
    expect(body).not.toContain("encrypted_content");
    expect(body).toContain("thought");
  });

  it.each(BROKEN)("Anthropic ingress (%s): the thinking text survives unsigned, the envelope does not", (envelope) => {
    const req = AnthropicRequest.parse({
      model: "svc",
      max_tokens: 100,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "thinking", thinking: "thought", signature: envelope }, { type: "text", text: "answer" }] },
        { role: "user", content: "next" },
      ],
    });
    const reasoning = req.messages.flatMap((m) => m.content).filter((p) => p.type === "reasoning");
    expect(reasoning).toEqual([{ type: "reasoning", origin: "anthropic", text: "thought", signature: undefined }]);
    for (const Family of wireFamilies(AnthropicRequest, OpenAIResponsesRequest, OpenAICompletionRequest)) {
      expect(JSON.stringify(Family.construct(req).render(TARGET))).not.toContain("hydrogen-");
    }
  });

  it("a readable envelope is still unwrapped to the native block (unchanged)", () => {
    const part = { type: "reasoning" as const, text: "thought", origin: "anthropic" as const, signature: "sig-native" };
    const req = OpenAIResponsesRequest.parse({
      model: "svc",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }, { type: "reasoning", id: "rs_1", summary: [], encrypted_content: encodeReasoning(part) }],
    });
    const body = JSON.stringify(AnthropicRequest.construct(req).render(TARGET));
    expect(body).toContain("sig-native");
    expect(body).not.toContain("hydrogen-");
  });

  it("a provider's own payload is still forwarded to its own family (unchanged)", () => {
    const responses = OpenAIResponsesRequest.parse({
      model: "svc",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }, { type: "reasoning", id: "rs_1", summary: [], encrypted_content: NATIVE }],
    });
    expect(JSON.stringify(OpenAIResponsesRequest.construct(responses).render(TARGET))).toContain(NATIVE);
    const anthropic = AnthropicRequest.parse({
      model: "svc",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "sig-anthropic" }] }, { role: "user", content: "n" }],
    });
    expect(JSON.stringify(AnthropicRequest.construct(anthropic).render(TARGET))).toContain("sig-anthropic");
  });
});

// --- C3: unknown reasoning_effort -------------------------------------------

describe("C3: an unrecognised reasoning_effort does not turn the output ceiling into a thinking budget", () => {
  const parse = (extra: Record<string, unknown>): OpenAICompletionRequest =>
    OpenAICompletionRequest.parse({ model: "svc", messages: [{ role: "user", content: "hi" }], ...extra });

  it.each(["auto", "bogus", "", 3, true])("reasoning_effort %j + max_completion_tokens sets no thinking level", (effort) => {
    const req = parse({ reasoning_effort: effort, max_completion_tokens: 4000 });
    expect(req.params.thinking).toBeUndefined();
    expect(req.params.maxTokens).toBe(4000);
  });

  it("the ceiling stays a ceiling on every egress", () => {
    const req = parse({ reasoning_effort: "auto", max_completion_tokens: 4000 });
    const chat = req.render(TARGET);
    expect(chat.max_completion_tokens).toBe(4000);
    expect(chat).not.toHaveProperty("reasoning_effort");
    const anthropic = AnthropicRequest.construct(req).render(TARGET);
    expect(anthropic.max_tokens).toBe(4000);
    expect(anthropic).not.toHaveProperty("thinking");
  });

  it("recognised efforts are unchanged", () => {
    expect(parse({ reasoning_effort: "high", max_completion_tokens: 4000 }).params.thinking).toBe("high");
    expect(parse({ reasoning_effort: "none", max_completion_tokens: 4000 }).params.thinking).toBe("disabled");
    expect(parse({ max_completion_tokens: 4000 }).params.thinking).toBeUndefined();
  });
});

// --- C4: tool-call arguments ahead of the call's id/name ---------------------

describe("C4: Chat stream tool-call arguments that arrive before the call starts are kept", () => {
  const frame = (payload: Record<string, unknown>): string => `data: ${JSON.stringify(payload)}\n\n`;
  const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
    frame({ id: "c1", object: "chat.completion.chunk", created: 1, model: "up", choices: [{ index: 0, delta, finish_reason: finish }] });
  async function* sse(frames: string[]): AsyncGenerator<string> {
    for (const f of frames) yield f;
  }
  const toolEvents = async (frames: string[]): Promise<StreamEvent[]> =>
    (await drain(OpenAICompletionResponse.parseStream(sse([...frames, "data: [DONE]\n\n"])))).filter((e) => e.type.startsWith("tool_"));

  it("early argument chunks are emitted, in order, right after the start", async () => {
    const events = await toolEvents([
      chunk({ role: "assistant" }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'ty":' } }] }),
      chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "weather", arguments: '"Par' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'is"}' } }] }),
      chunk({}, "tool_calls"),
    ]);
    expect(events[0]).toEqual({ type: "tool_start", index: 0, id: "call_1", name: "weather" });
    const args = events.filter((e) => e.type === "tool_args_delta").map((e) => (e as { delta: string }).delta).join("");
    expect(args).toBe('{"city":"Paris"}');
    expect(events.findIndex((e) => e.type === "tool_args_delta")).toBe(1);
  });

  it("interleaved calls keep their own early arguments", async () => {
    const events = await toolEvents([
      chunk({ tool_calls: [{ index: 1, function: { arguments: '{"b"' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"a"' } }] }),
      chunk({ tool_calls: [{ index: 0, id: "call_a", function: { name: "fa", arguments: ":1}" } }] }),
      chunk({ tool_calls: [{ index: 1, id: "call_b", function: { name: "fb", arguments: ":2}" } }] }),
      chunk({}, "tool_calls"),
    ]);
    const argsOf = (index: number): string =>
      events.filter((e) => e.type === "tool_args_delta" && (e as { index: number }).index === index).map((e) => (e as { delta: string }).delta).join("");
    expect(argsOf(0)).toBe('{"a":1}');
    expect(argsOf(1)).toBe('{"b":2}');
    // no argument delta precedes its own start
    for (const index of [0, 1]) {
      const start = events.findIndex((e) => e.type === "tool_start" && (e as { index: number }).index === index);
      const firstArgs = events.findIndex((e) => e.type === "tool_args_delta" && (e as { index: number }).index === index);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(firstArgs).toBeGreaterThan(start);
    }
  });

  it("the ordinary order is unchanged", async () => {
    const events = await toolEvents([
      chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "weather", arguments: "" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
      chunk({}, "tool_calls"),
    ]);
    expect(events.slice(0, 3)).toEqual([
      { type: "tool_start", index: 0, id: "call_1", name: "weather" },
      { type: "tool_args_delta", index: 0, delta: '{"city":' },
      { type: "tool_args_delta", index: 0, delta: '"Paris"}' },
    ]);
  });

  it("arguments for a call that never starts are still not emitted", async () => {
    const events = await toolEvents([chunk({ tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }] }), chunk({}, "stop")]);
    expect(events).toEqual([]);
  });
});

// --- C5: <think> lifting, buffered vs streamed --------------------------------

describe("C5: buffered and streamed <think> lifting agree on leading padding", () => {
  const THOUGHT = "It is Paris.";
  const ANSWER = "Paris.";
  const MAX_PAD = 512;
  const textOnly = (text: string): ContentPart[] => [{ type: "text", text }];

  async function* stream(text: string, size: number): AsyncGenerator<StreamEvent> {
    yield { type: "start", id: "r1", model: "up", created: 1 };
    for (let i = 0; i < text.length; i += size) yield { type: "text_delta", text: text.slice(i, i + size) };
    yield { type: "finish", stopReason: "stop" };
  }
  const joined = (events: StreamEvent[], type: "text_delta" | "reasoning_delta"): string =>
    events.filter((e) => e.type === type).map((e) => (e as { text: string }).text).join("");

  const DELIMITERS = { open: "[[T]]", close: "[[/T]]" };
  const cases: Array<[string, (pad: string) => string, typeof DELIMITERS | undefined]> = [
    ["built-in tags", (pad) => `${pad}<think>${THOUGHT}</think>\n\n${ANSWER}`, undefined],
    ["declared delimiters", (pad) => `${pad}[[T]]${THOUGHT}[[/T]]\n\n${ANSWER}`, DELIMITERS],
  ];

  for (const [name, build, delimiters] of cases) {
    for (const padLength of [0, 30, MAX_PAD - 1, MAX_PAD]) {
      it(`${name}: ${padLength} padding characters -- the block is lifted on both paths`, async () => {
        const raw = build("\n".repeat(padLength));
        expect(applyThinkingFormat(textOnly(raw), "reasoning_content", delimiters)).toEqual([
          { type: "reasoning", text: THOUGHT },
          { type: "text", text: ANSWER },
        ]);
        for (const size of [1, 7, 100, raw.length]) {
          const out = await drain(withThinkingFormat(stream(raw, size), "reasoning_content", delimiters));
          expect(joined(out, "reasoning_delta")).toBe(THOUGHT);
          expect(joined(out, "text_delta")).toBe(ANSWER);
        }
      });
    }

    for (const padLength of [MAX_PAD + 1, MAX_PAD * 2, 5000]) {
      it(`${name}: ${padLength} padding characters -- the text is left alone on both paths`, async () => {
        const raw = build(" ".repeat(padLength));
        expect(applyThinkingFormat(textOnly(raw), "reasoning_content", delimiters)).toEqual(textOnly(raw));
        for (const size of [1, 7, 100, raw.length]) {
          const out = await drain(withThinkingFormat(stream(raw, size), "reasoning_content", delimiters));
          expect(joined(out, "reasoning_delta")).toBe("");
          expect(joined(out, "text_delta")).toBe(raw);
        }
      });
    }
  }
});

// --- C6: unknown response_format, vendor-prefixed model ids -------------------

describe("C6: an unmodelled response_format rides passthrough to its own family", () => {
  const GRAMMAR = { type: "grammar", grammar: "root ::= 'a'" };
  const parse = (response_format: unknown): OpenAICompletionRequest =>
    OpenAICompletionRequest.parse({ model: "svc", messages: [{ role: "user", content: "hi" }], response_format });

  it.each([[GRAMMAR], [{ type: "regex", regex: "a+" }], [{ type: "json" }]])("Chat -> Chat forwards %j verbatim", (format) => {
    expect(parse(format).render(TARGET).response_format).toEqual(format);
  });

  it("it is not carried across families", () => {
    const req = parse(GRAMMAR);
    expect(JSON.stringify(AnthropicRequest.construct(req).render(TARGET))).not.toContain("grammar");
    expect(JSON.stringify(OpenAIResponsesRequest.construct(req).render(TARGET))).not.toContain("grammar");
  });

  it("a modelled response_format is rendered from the canonical value (unchanged)", () => {
    expect(parse({ type: "json_object", extra: 1 }).render(TARGET).response_format).toEqual({ type: "json_object" });
    expect(parse({ type: "text" }).render(TARGET).response_format).toEqual({ type: "text" });
    const schema = parse({ type: "json_schema", json_schema: { name: "n", schema: { type: "object" }, strict: true } });
    expect(schema.render(TARGET).response_format).toEqual({ type: "json_schema", json_schema: { name: "n", schema: { type: "object" }, strict: true } });
    expect(schema.params.passthrough).toBeUndefined();
  });

  it("an absent or null response_format adds nothing", () => {
    expect(parse(undefined).render(TARGET)).not.toHaveProperty("response_format");
    expect(parse(null).render(TARGET)).not.toHaveProperty("response_format");
  });
});

describe("C6: max_completion_tokens models are recognised behind a vendor prefix", () => {
  const ceilingKeys = (upstreamModel: string): string[] => {
    const req = OpenAICompletionRequest.parse({ model: "svc", messages: [{ role: "user", content: "hi" }], max_tokens: 100 });
    const body = req.render({ ...TARGET, upstreamModel });
    return ["max_tokens", "max_completion_tokens"].filter((k) => k in body);
  };

  it.each(["gpt-5", "gpt-5.1", "gpt-5-mini", "o3", "o4-mini", "openai/gpt-5", "openai/gpt-5-mini", "azure/openai/o3-mini", "OpenAI/GPT-5.1", "openrouter/openai/o1"])(
    "%s takes max_completion_tokens",
    (model) => {
      expect(ceilingKeys(model)).toEqual(["max_completion_tokens"]);
    },
  );

  it.each(["gpt-4o", "gpt-50", "o3x", "deepseek-chat", "openai/gpt-4o", "foo-gpt-5", "mygpt-5", "vendor/proto3", "vendor/o3x", "gpt-5x/llama"])(
    "%s keeps max_tokens",
    (model) => {
      expect(ceilingKeys(model)).toEqual(["max_tokens"]);
    },
  );
});

// --- C7: one wording for the tool-result image note ---------------------------

describe("C7: the tool-result image follow-up note is worded the same on both OpenAI wires", () => {
  it("Chat and Responses emit the same note text", () => {
    const req = AnthropicRequest.parse({
      model: "svc",
      max_tokens: 100,
      messages: [
        { role: "user", content: "shoot" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "shot", input: {} }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "done" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }],
        },
      ],
    });
    const chat = OpenAICompletionRequest.construct(req).render(TARGET) as { messages: Array<{ role: string; content: unknown }> };
    const responses = OpenAIResponsesRequest.construct(req).render(TARGET) as { input: Array<{ role?: string; content?: unknown }> };
    const chatNote = (chat.messages[chat.messages.length - 1].content as Array<{ type: string; text?: string }>)[0];
    const responsesNote = (responses.input[responses.input.length - 1].content as Array<{ type: string; text?: string }>)[0];
    expect(chatNote.text).toBe("(images returned by the tool results above)");
    expect(responsesNote.text).toBe(chatNote.text);
  });
});
