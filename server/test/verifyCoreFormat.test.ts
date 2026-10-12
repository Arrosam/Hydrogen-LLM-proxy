/**
 * Independent verification, CORE items C1-C7 (wire-format conversion).
 *
 * Written from the verification spec only. Every expected value below is
 * derived from the spec's wording; the entry points (parse / construct /
 * render, parseStream / collectStream, liftThinkTags / withThinkingFormat) are
 * the public ones the existing conversion suites already drive.
 *
 * Techniques: equivalence partitions (ingress carrier field x egress family),
 * decision tables (envelope kind x ingress x egress), boundary values (the
 * 511 / 512 / 513 leading-whitespace limit), and for every corrected behaviour
 * a neighbouring case that has to be unchanged.
 */
import { describe, expect, it } from "vitest";
import {
  AnthropicRequest,
  OpenAICompletionRequest,
  OpenAIResponsesRequest,
  parseStream,
} from "../src/core/format";
import type { Request, RenderTarget } from "../src/core/ir/request";
import type { ContentPart } from "../src/core/ir/content";
import { collectStream, type StreamEvent } from "../src/core/ir/stream";
import { applyThinkingFormat, liftThinkTags, withThinkingFormat } from "../src/core/ir/thinkingFormat";

type Family = "openai_completion" | "anthropic" | "openai_responses";
const FAMILIES: Family[] = ["openai_completion", "anthropic", "openai_responses"];

const target = (upstreamModel = "up"): RenderTarget => ({ upstreamModel });

/** Render a parsed request for one egress family, as the wire body sent upstream. */
function renderFor(family: Family, req: Request, upstreamModel = "up"): Record<string, unknown> {
  const built =
    family === "openai_completion" ? OpenAICompletionRequest.construct(req)
      : family === "anthropic" ? AnthropicRequest.construct(req)
        : OpenAIResponsesRequest.construct(req);
  return built.render(target(upstreamModel));
}

// ---------------------------------------------------------------------------
// C1 — an empty reasoning field must not mask a populated one (request side)
// ---------------------------------------------------------------------------

describe("C1: Chat history reasoning survives conversion whichever field carries it", () => {
  const MARK = "REASONING-MARK-7f3a";

  /**
   * The assistant turn is the CURRENT tool round (it called a tool and the
   * result follows), which is the shape every egress family replays reasoning
   * for -- so a missing marker is a lost carrier, not stale-turn shedding.
   */
  const chatRequest = (assistantExtra: Record<string, unknown>): Request =>
    OpenAICompletionRequest.parse({
      model: "svc",
      messages: [
        { role: "user", content: "q1" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
          ...assistantExtra,
        },
        { role: "tool", tool_call_id: "c1", content: "42" },
      ],
    });

  const CARRIERS: Array<[string, Record<string, unknown>]> = [
    ['reasoning: "" beside reasoning_content', { reasoning: "", reasoning_content: MARK }],
    ["only reasoning_text", { reasoning_text: MARK }],
    ["only thinking", { thinking: MARK }],
    ['reasoning: "" beside reasoning_text', { reasoning: "", reasoning_text: MARK }],
    ['reasoning: "" and reasoning_content: "" beside thinking', { reasoning: "", reasoning_content: "", thinking: MARK }],
  ];

  for (const [name, extra] of CARRIERS) {
    for (const family of FAMILIES) {
      it(`${name} -> ${family} upstream request still carries the reasoning`, () => {
        const body = renderFor(family, chatRequest(extra));
        expect(JSON.stringify(body)).toContain(MARK);
      });
    }
  }

  // Neighbours that must be unchanged.
  for (const family of FAMILIES) {
    it(`unchanged: a populated \`reasoning\` alone reaches ${family}`, () => {
      expect(JSON.stringify(renderFor(family, chatRequest({ reasoning: MARK })))).toContain(MARK);
    });

    it(`unchanged: a populated \`reasoning_content\` alone reaches ${family}`, () => {
      expect(JSON.stringify(renderFor(family, chatRequest({ reasoning_content: MARK })))).toContain(MARK);
    });

    it(`unchanged: no reasoning field at all invents none for ${family}`, () => {
      const json = JSON.stringify(renderFor(family, chatRequest({})));
      expect(json).not.toContain(MARK);
      expect(json).not.toContain('"thinking":"');
      expect(json).not.toContain('"reasoning_content"');
    });
  }

  it("the Chat egress carries the preserved text in the reasoning fields of that assistant message", () => {
    const body = renderFor("openai_completion", chatRequest({ reasoning: "", reasoning_content: MARK }));
    const assistant = (body.messages as Array<Record<string, unknown>>).find((m) => m.role === "assistant")!;
    expect(assistant.reasoning_content).toBe(MARK);
  });

  it("the Anthropic egress carries the preserved text as a thinking block", () => {
    const body = renderFor("anthropic", chatRequest({ reasoning: "", reasoning_content: MARK }));
    const assistant = (body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>).find((m) => m.role === "assistant")!;
    expect(assistant.content.some((b) => b.type === "thinking" && b.thinking === MARK)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C2 — an undecodable hydrogen envelope is never sent upstream as a signature
// ---------------------------------------------------------------------------

describe("C2: an undecodable hydrogen-...-v1: envelope never goes upstream as a signature", () => {
  const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
  const READABLE = "visible-thought-text";

  /** Envelopes this proxy cannot decode. Each is unique so it can be searched for. */
  const UNDECODABLE: Array<[string, string]> = [
    ["reasoning envelope, payload not base64", "hydrogen-reasoning-v1:!!!not-base64-A!!!"],
    ["redacted-thinking envelope, payload not base64", "hydrogen-redacted-thinking-v1:!!!not-base64-B!!!"],
    ["reasoning envelope, base64 of non-JSON", `hydrogen-reasoning-v1:${b64("this is not json C")}`],
    ["redacted-thinking envelope, base64 of non-JSON", `hydrogen-redacted-thinking-v1:${b64("this is not json D")}`],
    ["reasoning envelope, JSON of the wrong shape", `hydrogen-reasoning-v1:${b64(JSON.stringify({ type: "text", text: "E" }))}`],
    ["redacted-thinking envelope, JSON of the wrong shape", `hydrogen-redacted-thinking-v1:${b64(JSON.stringify({ nope: "F" }))}`],
    ["reasoning envelope, empty payload", "hydrogen-reasoning-v1:"],
  ];

  /** Tool-round shape, so the reasoning item is one every egress would replay. */
  const responsesIngress = (encrypted: string): Request =>
    OpenAIResponsesRequest.parse({
      model: "svc",
      input: [
        { role: "user", content: [{ type: "input_text", text: "weather?" }] },
        {
          type: "reasoning", id: "rs_1",
          summary: [{ type: "summary_text", text: READABLE }],
          content: [{ type: "reasoning_text", text: READABLE }],
          encrypted_content: encrypted,
        },
        { type: "function_call", call_id: "call_9", name: "get_weather", arguments: '{"city":"Beijing"}' },
        { type: "function_call_output", call_id: "call_9", output: "20C" },
      ],
    });

  const anthropicIngress = (signature: string): Request =>
    AnthropicRequest.parse({
      model: "svc",
      max_tokens: 1024,
      thinking: { type: "enabled", budget_tokens: 2048 },
      messages: [
        { role: "user", content: [{ type: "text", text: "weather?" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: READABLE, signature },
            { type: "tool_use", id: "toolu_9", name: "get_weather", input: { city: "Beijing" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: [{ type: "text", text: "20C" }] }] },
      ],
    });

  /** Every `signature` / `encrypted_content` value anywhere in a rendered body. */
  function signatureValues(node: unknown, out: unknown[] = []): unknown[] {
    if (Array.isArray(node)) {
      for (const v of node) signatureValues(v, out);
    } else if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === "signature" || k === "encrypted_content") out.push(v);
        signatureValues(v, out);
      }
    }
    return out;
  }

  const INGRESS: Array<[string, (envelope: string) => Request]> = [
    ["Responses encrypted_content", responsesIngress],
    ["Anthropic signature", anthropicIngress],
  ];

  for (const [ingressName, build] of INGRESS) {
    for (const [envName, envelope] of UNDECODABLE) {
      for (const family of FAMILIES) {
        it(`${ingressName} = ${envName} -> ${family}: not forwarded`, () => {
          const body = renderFor(family, build(envelope));
          // Not as a signature / encrypted content ...
          for (const value of signatureValues(body)) expect(value).not.toBe(envelope);
          // ... and not anywhere else in the body either.
          if (envelope.length > "hydrogen-reasoning-v1:".length) {
            expect(JSON.stringify(body)).not.toContain(envelope);
          }
          // No hydrogen envelope of any kind stands in a signature slot.
          for (const value of signatureValues(body)) {
            expect(String(value)).not.toMatch(/^hydrogen-[a-z-]+-v1:/);
          }
        });
      }
    }
  }

  it("the request around the dropped signature is still rendered (the tool round survives)", () => {
    for (const family of FAMILIES) {
      const json = JSON.stringify(renderFor(family, responsesIngress("hydrogen-reasoning-v1:!!!not-base64-A!!!")));
      expect(json).toContain("get_weather");
      expect(json).toContain("20C");
    }
  });

  // Neighbours that must be unchanged: a provider's own signature, same family.
  it("unchanged: a native Responses encrypted_content is forwarded to a Responses upstream", () => {
    const body = renderFor("openai_responses", responsesIngress("gAAAAA-native-openai-payload"));
    expect(signatureValues(body)).toContain("gAAAAA-native-openai-payload");
    const item = (body.input as Array<Record<string, unknown>>).find((i) => i.type === "reasoning")!;
    expect(item.encrypted_content).toBe("gAAAAA-native-openai-payload");
  });

  it("unchanged: a native Anthropic signature is forwarded to an Anthropic upstream", () => {
    const body = renderFor("anthropic", anthropicIngress("EqQBCgIYAhIM-native-anthropic-sig"));
    const assistant = (body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>).find((m) => m.role === "assistant")!;
    expect(assistant.content[0]).toEqual({ type: "thinking", thinking: READABLE, signature: "EqQBCgIYAhIM-native-anthropic-sig" });
  });

  it("unchanged: a native signature that merely mentions hydrogen is still forwarded", () => {
    const sig = "native-hydrogen-v1-lookalike";
    const body = renderFor("anthropic", anthropicIngress(sig));
    expect(signatureValues(body)).toContain(sig);
  });
});

// ---------------------------------------------------------------------------
// C3 — an unknown reasoning_effort invents nothing
// ---------------------------------------------------------------------------

describe("C3: an unknown reasoning_effort carries no budget, no invented effort, and keeps the ceiling", () => {
  const KNOWN_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "enabled", "disabled"];

  const chat = (reasoning_effort: unknown): Request =>
    OpenAICompletionRequest.parse({
      model: "svc",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort,
      max_completion_tokens: 2000,
    });

  /** The output ceiling of a Chat body, under whichever of its two names. */
  const chatCeiling = (body: Record<string, unknown>): unknown => body.max_completion_tokens ?? body.max_tokens;

  for (const bogus of ["bogus", "ultra", "HIGH ", "0", ""]) {
    it(`"${bogus}" -> Chat: no invented effort, ceiling 2000`, () => {
      const body = renderFor("openai_completion", chat(bogus));
      expect(KNOWN_EFFORTS).not.toContain(body.reasoning_effort);
      expect(body).not.toHaveProperty("thinking");
      expect(chatCeiling(body)).toBe(2000);
    });

    it(`"${bogus}" -> Anthropic: no thinking budget, no effort, max_tokens 2000`, () => {
      const body = renderFor("anthropic", chat(bogus));
      const thinking = body.thinking as Record<string, unknown> | undefined;
      expect(thinking?.budget_tokens).toBeUndefined();
      expect(thinking?.type).not.toBe("enabled");
      expect((body.output_config as { effort?: unknown } | undefined)?.effort).toBeUndefined();
      expect(body.max_tokens).toBe(2000);
    });

    it(`"${bogus}" -> Responses: no invented effort, max_output_tokens 2000`, () => {
      const body = renderFor("openai_responses", chat(bogus));
      const reasoning = body.reasoning as { effort?: unknown } | undefined;
      expect(KNOWN_EFFORTS).not.toContain(reasoning?.effort);
      expect(body.max_output_tokens).toBe(2000);
    });
  }

  it("a non-string effort (a number) is treated the same way", () => {
    const body = renderFor("anthropic", chat(5));
    expect((body.thinking as Record<string, unknown> | undefined)?.budget_tokens).toBeUndefined();
    expect((body.output_config as { effort?: unknown } | undefined)?.effort).toBeUndefined();
    expect(body.max_tokens).toBe(2000);
  });

  // Neighbours that must be unchanged: a known effort.
  for (const level of ["low", "medium", "high"]) {
    it(`unchanged: "${level}" still reaches every family, ceiling still 2000`, () => {
      const toChat = renderFor("openai_completion", chat(level));
      expect(toChat.reasoning_effort).toBe(level);
      expect(chatCeiling(toChat)).toBe(2000);

      const toAnthropic = renderFor("anthropic", chat(level));
      expect(toAnthropic.thinking).toEqual({ type: "adaptive" });
      expect((toAnthropic.output_config as { effort?: unknown }).effort).toBe(level);
      expect(toAnthropic.max_tokens).toBe(2000);

      const toResponses = renderFor("openai_responses", chat(level));
      expect((toResponses.reasoning as { effort?: unknown }).effort).toBe(level);
      expect(toResponses.max_output_tokens).toBe(2000);
    });
  }

  it("unchanged: no reasoning_effort at all sets no thinking and keeps the ceiling", () => {
    const req = OpenAICompletionRequest.parse({ model: "svc", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 2000 });
    const toAnthropic = renderFor("anthropic", req);
    expect(toAnthropic).not.toHaveProperty("thinking");
    expect(toAnthropic.max_tokens).toBe(2000);
    expect(renderFor("openai_completion", req)).not.toHaveProperty("reasoning_effort");
  });
});

// ---------------------------------------------------------------------------
// C4 — tool-call argument fragments that arrive before the id/name chunk
// ---------------------------------------------------------------------------

describe("C4: Chat stream tool-call arguments that arrive before the id/name are not lost", () => {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "up", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const DONE = "data: [DONE]\n\n";
  const call = (index: number, fields: Record<string, unknown>): Record<string, unknown> => ({ tool_calls: [{ index, ...fields }] });
  const args = (index: number, fragment: string): Record<string, unknown> => call(index, { function: { arguments: fragment } });

  async function* frames(list: string[]): AsyncGenerator<string> {
    for (const f of list) yield f;
  }

  async function collectTools(list: string[]): Promise<{ tools: Array<{ id: string; name: string; input: unknown }>; incomplete: boolean; stopReason: unknown }> {
    const { data, incomplete } = await collectStream(parseStream("openai_completion", frames(list)));
    const tools = data.content
      .filter((p): p is Extract<ContentPart, { type: "tool_use" }> => p.type === "tool_use")
      .map((p) => ({ id: p.id, name: p.name, input: p.input }));
    return { tools, incomplete, stopReason: data.stopReason };
  }

  const EXPECTED = { city: "Beijing", unit: "celsius" };
  const FULL = JSON.stringify(EXPECTED); // {"city":"Beijing","unit":"celsius"}
  const A = FULL.slice(0, 9);
  const B = FULL.slice(9, 21);
  const C = FULL.slice(21);

  it("all fragments before the id/name chunk", async () => {
    const got = await collectTools([
      chunk({ role: "assistant" }),
      chunk(args(0, A)),
      chunk(args(0, B)),
      chunk(args(0, C)),
      chunk(call(0, { id: "call_1", type: "function", function: { name: "get_weather" } })),
      chunk({}, "tool_calls"),
      DONE,
    ]);
    expect(got.incomplete).toBe(false);
    expect(got.stopReason).toBe("tool_use");
    expect(got.tools).toEqual([{ id: "call_1", name: "get_weather", input: EXPECTED }]);
  });

  it("fragments before, one riding the id/name chunk itself", async () => {
    const got = await collectTools([
      chunk({ role: "assistant" }),
      chunk(args(0, A)),
      chunk(args(0, B)),
      chunk(call(0, { id: "call_1", type: "function", function: { name: "get_weather", arguments: C } })),
      chunk({}, "tool_calls"),
      DONE,
    ]);
    expect(got.tools).toEqual([{ id: "call_1", name: "get_weather", input: EXPECTED }]);
  });

  it("fragments before AND after the id/name chunk keep their order", async () => {
    const got = await collectTools([
      chunk({ role: "assistant" }),
      chunk(args(0, A)),
      chunk(call(0, { id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } })),
      chunk(args(0, B)),
      chunk(args(0, C)),
      chunk({}, "tool_calls"),
      DONE,
    ]);
    expect(got.tools).toEqual([{ id: "call_1", name: "get_weather", input: EXPECTED }]);
  });

  it("two calls, both with early fragments, interleaved by index, stay separate", async () => {
    const second = JSON.stringify({ q: "tea" });
    const got = await collectTools([
      chunk({ role: "assistant" }),
      chunk(args(0, A)),
      chunk(args(1, second.slice(0, 4))),
      chunk(args(0, B)),
      chunk(args(1, second.slice(4))),
      chunk(args(0, C)),
      chunk(call(0, { id: "call_1", type: "function", function: { name: "get_weather" } })),
      chunk(call(1, { id: "call_2", type: "function", function: { name: "search" } })),
      chunk({}, "tool_calls"),
      DONE,
    ]);
    expect(got.tools).toEqual([
      { id: "call_1", name: "get_weather", input: EXPECTED },
      { id: "call_2", name: "search", input: { q: "tea" } },
    ]);
  });

  // Neighbours that must be unchanged.
  it("unchanged: the normal order (id/name first, then fragments)", async () => {
    const got = await collectTools([
      chunk({ role: "assistant" }),
      chunk(call(0, { id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } })),
      chunk(args(0, A)),
      chunk(args(0, B)),
      chunk(args(0, C)),
      chunk({}, "tool_calls"),
      DONE,
    ]);
    expect(got.incomplete).toBe(false);
    expect(got.tools).toEqual([{ id: "call_1", name: "get_weather", input: EXPECTED }]);
  });

  it("unchanged: a whole call in one chunk", async () => {
    const got = await collectTools([
      chunk({ role: "assistant" }),
      chunk(call(0, { id: "call_1", type: "function", function: { name: "get_weather", arguments: FULL } })),
      chunk({}, "tool_calls"),
      DONE,
    ]);
    expect(got.tools).toEqual([{ id: "call_1", name: "get_weather", input: EXPECTED }]);
  });

  it("unchanged: text before a normally ordered call is still collected", async () => {
    const { data } = await collectStream(parseStream("openai_completion", frames([
      chunk({ role: "assistant" }),
      chunk({ content: "checking" }),
      chunk(call(0, { id: "call_1", type: "function", function: { name: "get_weather", arguments: FULL } })),
      chunk({}, "tool_calls"),
      DONE,
    ])));
    expect(data.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("")).toBe("checking");
    expect(data.content.some((p) => p.type === "tool_use")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C5 — <think> lifting: buffered == streamed, limit of 512 leading whitespace
// ---------------------------------------------------------------------------

describe("C5: <think> lifting is the same buffered and streamed, with a 512-character whitespace limit", () => {
  const THOUGHT = "The user wants the capital. It is Paris.";
  const ANSWER = "Paris.";
  const BLOCK = `<think>${THOUGHT}</think>\n\n${ANSWER}`;

  const textOnly = (text: string): ContentPart[] => [{ type: "text", text }];
  const textOfParts = (parts: ContentPart[]): string => parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
  const reasoningOfParts = (parts: ContentPart[]): string => parts.filter((p) => p.type === "reasoning").map((p) => (p as { text: string }).text).join("");

  async function* stream(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
    for (const ev of events) yield ev;
  }
  function deltas(text: string, size: number): StreamEvent[] {
    const out: StreamEvent[] = [];
    for (let i = 0; i < text.length; i += size) out.push({ type: "text_delta", text: text.slice(i, i + size) });
    return out;
  }
  async function streamed(raw: string, size: number): Promise<{ text: string; reasoning: string }> {
    const out: StreamEvent[] = [];
    for await (const ev of withThinkingFormat(stream([...deltas(raw, size), { type: "finish", stopReason: "stop" }]), "reasoning")) out.push(ev);
    return {
      text: out.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join(""),
      reasoning: out.filter((e) => e.type === "reasoning_delta").map((e) => (e as { text: string }).text).join(""),
    };
  }
  function buffered(raw: string): { text: string; reasoning: string } {
    const parts = applyThinkingFormat(textOnly(raw), "reasoning");
    return { text: textOfParts(parts), reasoning: reasoningOfParts(parts) };
  }

  /** `n` characters of whitespace in the given style. */
  const WHITESPACE: Array<[string, (n: number) => string]> = [
    ["spaces", (n) => " ".repeat(n)],
    ["newlines", (n) => "\n".repeat(n)],
    ["mixed space/newline/tab", (n) => " \n\t".repeat(Math.ceil(n / 3)).slice(0, n)],
  ];

  // Chunk sizes chosen so the 512 boundary lands inside a delta, on a delta
  // edge, and in a single-delta stream.
  const CHUNK_SIZES = [1, 2, 7, 64, 256, 511, 512, 513, 1024, 100_000];

  const LIFTED = { text: ANSWER, reasoning: THOUGHT };

  for (const [style, ws] of WHITESPACE) {
    for (const n of [0, 1, 511, 512]) {
      const raw = ws(n) + BLOCK;

      it(`buffered: ${n} ${style} before the tag -> lifted`, () => {
        expect(ws(n)).toHaveLength(n);
        expect(buffered(raw)).toEqual(LIFTED);
        expect(liftThinkTags(textOnly(raw))).toEqual([
          { type: "reasoning", text: THOUGHT },
          { type: "text", text: ANSWER },
        ]);
      });

      for (const size of CHUNK_SIZES) {
        it(`streamed in ${size}-char deltas: ${n} ${style} before the tag -> lifted, same as buffered`, async () => {
          const got = await streamed(raw, size);
          expect(got).toEqual(LIFTED);
          expect(got).toEqual(buffered(raw));
        });
      }
    }

    for (const n of [513, 514, 1024, 5000]) {
      const raw = ws(n) + BLOCK;

      it(`buffered: ${n} ${style} before the tag -> NOT lifted, stays answer text`, () => {
        expect(ws(n)).toHaveLength(n);
        const content = textOnly(raw);
        const out = liftThinkTags(content);
        expect(out.some((p) => p.type === "reasoning")).toBe(false);
        expect(textOfParts(out)).toBe(raw);
        expect(buffered(raw)).toEqual({ text: raw, reasoning: "" });
      });

      for (const size of CHUNK_SIZES) {
        it(`streamed in ${size}-char deltas: ${n} ${style} before the tag -> NOT lifted, same as buffered`, async () => {
          const got = await streamed(raw, size);
          expect(got).toEqual({ text: raw, reasoning: "" });
          expect(got).toEqual(buffered(raw));
        });
      }
    }
  }

  // Neighbours that must be unchanged.
  it("unchanged: a tag part-way down the answer is not thinking, buffered or streamed", async () => {
    const raw = "Wrap your reasoning in <think>like this</think> before answering.";
    expect(buffered(raw)).toEqual({ text: raw, reasoning: "" });
    for (const size of [1, 7, 500]) expect(await streamed(raw, size)).toEqual({ text: raw, reasoning: "" });
  });

  it("unchanged: an answer with no tag at all passes through whole, buffered or streamed", async () => {
    const raw = `${" ".repeat(600)}Just an answer.`;
    expect(buffered(raw)).toEqual({ text: raw, reasoning: "" });
    for (const size of [1, 64, 5000]) expect(await streamed(raw, size)).toEqual({ text: raw, reasoning: "" });
  });
});

// ---------------------------------------------------------------------------
// C6 — response_format pass-through and the max_completion_tokens model rule
// ---------------------------------------------------------------------------

describe("C6(a): a response_format the proxy does not model", () => {
  const UNMODELLED: Array<Record<string, unknown>> = [
    { type: "grammar", grammar: "root ::= \"yes-MARK-GRAMMAR\" | \"no\"" },
    { type: "regex", pattern: "MARK-REGEX-[a-z]+", flags: { strict: true, depth: [1, 2] } },
    { type: "vendor_xyz" },
  ];

  const chat = (response_format: unknown): Request =>
    OpenAICompletionRequest.parse({ model: "svc", response_format, messages: [{ role: "user", content: "q" }] });

  for (const format of UNMODELLED) {
    it(`type "${String(format.type)}": Chat -> Chat forwards it unchanged`, () => {
      const body = renderFor("openai_completion", chat(format));
      expect(body.response_format).toEqual(format);
    });

    it(`type "${String(format.type)}": not forwarded to Anthropic`, () => {
      const body = renderFor("anthropic", chat(format));
      expect(body).not.toHaveProperty("response_format");
      expect(JSON.stringify(body)).not.toContain(String(format.type));
    });

    it(`type "${String(format.type)}": not forwarded to Responses`, () => {
      const body = renderFor("openai_responses", chat(format));
      expect(body).not.toHaveProperty("response_format");
      expect((body.text as { format?: unknown } | undefined)?.format).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(String(format.type));
    });
  }

  it("a Chat -> Chat hop does not mutate the client's object", () => {
    const format = { type: "grammar", grammar: "root ::= \"a\"" };
    const snapshot = JSON.parse(JSON.stringify(format)) as unknown;
    renderFor("openai_completion", chat(format));
    expect(format).toEqual(snapshot);
  });

  // Neighbours that must be unchanged: the types the proxy does model.
  it("unchanged: json_object still crosses Chat -> Chat", () => {
    expect(renderFor("openai_completion", chat({ type: "json_object" })).response_format).toEqual({ type: "json_object" });
  });

  it("unchanged: json_schema still crosses Chat -> Chat with its schema", () => {
    const format = { type: "json_schema", json_schema: { name: "answer", schema: { type: "object", properties: { a: { type: "string" } } } } };
    const out = renderFor("openai_completion", chat(format)).response_format as { type: string; json_schema: { name: string; schema: unknown } };
    expect(out.type).toBe("json_schema");
    expect(out.json_schema.name).toBe("answer");
    expect(out.json_schema.schema).toEqual(format.json_schema.schema);
  });

  it("unchanged: json_object toward Anthropic is still an explicit JSON instruction", () => {
    expect(String(renderFor("anthropic", chat({ type: "json_object" })).system)).toContain("JSON");
  });

  it("unchanged: no response_format at all adds none", () => {
    const req = OpenAICompletionRequest.parse({ model: "svc", messages: [{ role: "user", content: "q" }] });
    expect(renderFor("openai_completion", req)).not.toHaveProperty("response_format");
  });
});

describe("C6(b): provider-prefixed model ids pick the output-ceiling field like their bare ids", () => {
  const withMaxTokens = (): Request => OpenAICompletionRequest.parse({ model: "svc", max_tokens: 777, messages: [{ role: "user", content: "q" }] });
  const withMaxCompletionTokens = (): Request =>
    OpenAICompletionRequest.parse({ model: "svc", max_completion_tokens: 777, messages: [{ role: "user", content: "q" }] });

  const COMPLETION_TOKEN_MODELS = ["gpt-5", "o3-mini", "openai/gpt-5", "azure/openai/o3-mini"];
  const MAX_TOKEN_MODELS = ["gpt-4o"];

  for (const model of COMPLETION_TOKEN_MODELS) {
    for (const [inputName, build] of [["max_tokens", withMaxTokens], ["max_completion_tokens", withMaxCompletionTokens]] as const) {
      it(`${model} (client sent ${inputName}) -> max_completion_tokens, never max_tokens`, () => {
        const body = renderFor("openai_completion", build(), model);
        expect(body.model).toBe(model);
        expect(body.max_completion_tokens).toBe(777);
        expect(body).not.toHaveProperty("max_tokens");
      });
    }
  }

  for (const model of MAX_TOKEN_MODELS) {
    it(`unchanged: ${model} -> max_tokens, never max_completion_tokens`, () => {
      const body = renderFor("openai_completion", withMaxTokens(), model);
      expect(body.model).toBe(model);
      expect(body.max_tokens).toBe(777);
      expect(body).not.toHaveProperty("max_completion_tokens");
    });
  }

  it("unchanged: a provider-prefixed gpt-4o is still a max_tokens model", () => {
    const body = renderFor("openai_completion", withMaxTokens(), "openai/gpt-4o");
    expect(body.max_tokens).toBe(777);
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("the same Anthropic-ingress request picks the field by model too", () => {
    const req = AnthropicRequest.parse({ model: "svc", max_tokens: 777, messages: [{ role: "user", content: "q" }] });
    const prefixed = renderFor("openai_completion", req, "openai/gpt-5");
    expect(prefixed.max_completion_tokens).toBe(777);
    expect(prefixed).not.toHaveProperty("max_tokens");
    const plain = renderFor("openai_completion", req, "gpt-4o");
    expect(plain.max_tokens).toBe(777);
    expect(plain).not.toHaveProperty("max_completion_tokens");
  });
});

// ---------------------------------------------------------------------------
// C7 — the image follow-up note is worded the same on both OpenAI wires
// ---------------------------------------------------------------------------

describe("C7: the follow-up note after image-bearing tool results is worded identically on Chat and Responses", () => {
  const image = (data: string): Record<string, unknown> => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });

  /** An Anthropic tool loop whose tool results carry `results[i]` content blocks. */
  const loop = (results: Array<Array<Record<string, unknown>>>): Request =>
    AnthropicRequest.parse({
      model: "svc", max_tokens: 100,
      messages: [
        { role: "user", content: "click it" },
        { role: "assistant", content: results.map((_, i) => ({ type: "tool_use", id: `t${i + 1}`, name: "screenshot", input: {} })) },
        { role: "user", content: results.map((content, i) => ({ type: "tool_result", tool_use_id: `t${i + 1}`, content })) },
      ],
    });

  /** The text of every follow-up user message on the Chat wire (those after a tool message). */
  function chatNotes(req: Request): string[] {
    const msgs = renderFor("openai_completion", req).messages as Array<Record<string, unknown>>;
    const notes: string[] = [];
    let seenTool = false;
    for (const m of msgs) {
      if (m.role === "tool") { seenTool = true; continue; }
      if (!seenTool || m.role !== "user") continue;
      if (typeof m.content === "string") { notes.push(m.content); continue; }
      const parts = m.content as Array<Record<string, unknown>>;
      if (!parts.some((p) => p.type === "image_url")) continue;
      notes.push(parts.filter((p) => p.type === "text").map((p) => String(p.text)).join("\n"));
    }
    return notes;
  }

  /** The text of every follow-up user message on the Responses wire. */
  function responsesNotes(req: Request): string[] {
    const input = renderFor("openai_responses", req).input as Array<Record<string, unknown>>;
    const notes: string[] = [];
    let seenOutput = false;
    for (const item of input) {
      if (item.type === "function_call_output") { seenOutput = true; continue; }
      if (!seenOutput || item.role !== "user") continue;
      if (typeof item.content === "string") { notes.push(item.content); continue; }
      const parts = item.content as Array<Record<string, unknown>>;
      if (!parts.some((p) => p.type === "input_image")) continue;
      notes.push(parts.filter((p) => p.type === "input_text").map((p) => String(p.text)).join("\n"));
    }
    return notes;
  }

  const SCENARIOS: Array<[string, Array<Array<Record<string, unknown>>>]> = [
    ["one result: text + one image", [[{ type: "text", text: "done" }, image("aW1n")]]],
    ["one result: image only", [[image("aW1n")]]],
    ["one result: two images", [[{ type: "text", text: "done" }, image("aW1n"), image("aW1o")]]],
    ["two results, each with an image", [[{ type: "text", text: "a" }, image("aW1n")], [{ type: "text", text: "b" }, image("aW1o")]]],
    ["two results, only the second with an image", [[{ type: "text", text: "a" }], [image("aW1o")]]],
  ];

  for (const [name, results] of SCENARIOS) {
    it(`${name}: same note text on both wires`, () => {
      const chat = chatNotes(loop(results));
      const responses = responsesNotes(loop(results));
      // There IS a follow-up carrying the image(s) on each wire ...
      expect(chat.length).toBeGreaterThan(0);
      expect(responses.length).toBeGreaterThan(0);
      // ... it carries a note ...
      expect(chat.join("").trim()).not.toBe("");
      // ... and the note reads the same on both. (The spec fixes the WORDING;
      // how many follow-up messages each wire needs is its own business, so
      // the distinct wordings are compared, not the message count.)
      expect(responses.join("").trim()).not.toBe("");
      expect([...new Set(responses)]).toEqual([...new Set(chat)]);
      expect(new Set(chat).size).toBe(1);
    });
  }

  // Neighbours that must be unchanged.
  it("unchanged: the tool output itself stays text on both wires and the image rides the follow-up", () => {
    const req = loop([[{ type: "text", text: "done" }, image("aW1n")]]);
    const msgs = renderFor("openai_completion", req).messages as Array<Record<string, unknown>>;
    const toolMsg = msgs.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toBe("done");
    expect(JSON.stringify(msgs[msgs.indexOf(toolMsg) + 1])).toContain("data:image/png;base64,aW1n");

    const input = renderFor("openai_responses", req).input as Array<Record<string, unknown>>;
    const out = input.find((i) => i.type === "function_call_output")!;
    expect(out.output).toBe("done");
    expect(JSON.stringify(input[input.indexOf(out) + 1])).toContain("input_image");
  });

  it("unchanged: a tool result with no image gets no follow-up note on either wire", () => {
    const req = loop([[{ type: "text", text: "done" }]]);
    expect(chatNotes(req)).toEqual([]);
    expect(responsesNotes(req)).toEqual([]);
    const msgs = renderFor("openai_completion", req).messages as Array<Record<string, unknown>>;
    expect(msgs[msgs.length - 1].role).toBe("tool");
  });
});
