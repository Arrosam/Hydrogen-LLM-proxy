/**
 * Thinking format override, end to end through the client surface.
 *
 * The unit suite (thinkingFormat.test.ts) pins the transform. This one pins the
 * wiring: that the setting is read off the saved definition, reaches both the
 * buffered render and the live relay, and produces the same answer either way.
 *
 * The mock upstream deliberately behaves like a self-hosted open-weight
 * reasoner: it fills no structured reasoning field at all and writes
 * `<think>…</think>` at the head of its answer. That is the case Hydrogen was
 * blind to, and it is the reason this feature needs a scanner rather than a
 * field rename.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

const ADMIN_PASSWORD = "tf-proxy-admin-pass";
const THOUGHT = "The user asked for the capital. It is Paris.";
const ANSWER = "Paris.";

let app: FastifyInstance;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let c: any;
let dataDir: string;
let secret: string;
let upstream: http.Server;
let baseUrl: string;
/** "tags" = thinking inline in the content; "field" = a reasoning_content field;
 * "mixed" = inline content whose two tag halves spell the tag differently;
 * "harmony" = a channel-marker trace no name rule can recognise. */
let style: "tags" | "field" | "tags-spaced" | "thinking-only" | "empty" | "mixed" | "harmony" | "truncated" | "xml" | "recognition" = "tags";
let finishReason = "stop";
let lastUpstreamBody: Record<string, unknown>;
type RecognitionFixture = { thought: string; answer: string; native?: boolean };
let recognitionFixture: RecognitionFixture;
/** A socket test can withhold upstream completion until the client sees output. */
let streamScript: ((sendContent: (text: string) => void, finish: () => void) => void) | undefined;

/** Tags are assembled from parts so a case can pair any two spellings. */
const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const SLASH = String.fromCharCode(47);
const tag = (name: string): string => `${LT}${name}${GT}`;
const endTag = (name: string): string => `${LT}${SLASH}${name}${GT}`;

/** One tag pair, two spellings: the model opens with `thinking` and closes with
 * `reasoning`. Ordinary behaviour, and it must lift exactly like a matched pair. */
const MIXED_TAGGED = `${tag("thinking")}${THOUGHT}${endTag("reasoning")}\n\n${ANSWER}`;

/** GPT-OSS harmony markers: the trace lives in the `analysis` channel and the
* answer in `final`, so there is no tag name to recognise -- a service has to
* declare the pair. */
const HARMONY_OPEN = "<|channel|>analysis<|message|>";
const HARMONY_CLOSE = "<|channel|>final<|message|>";

/** The content this upstream serves for the current style, inline styles only. */
const inlineContent = (tagged: string): string =>
  style === "recognition" ? `<think>${recognitionFixture.thought}</think>${recognitionFixture.answer}`
    : style === "mixed" ? MIXED_TAGGED
    : style === "harmony" ? `${HARMONY_OPEN}${THOUGHT}${HARMONY_CLOSE}${ANSWER}`
      : style === "truncated" ? `<think>${THOUGHT}`
        : style === "xml" ? "<reason>The payment was declined.</reason>"
          : tagged;

function startUpstream(): Promise<void> {
  return new Promise((resolve) => {
    upstream = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
        lastUpstreamBody = body;
        const tagged = `<think>${THOUGHT}${style === "tags-spaced" ? "</think \n >" : "</think>"}\n\n${ANSWER}`;

        if (body.stream === true) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const chunk = (d: Record<string, unknown>): void => {
            res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "up", ...d })}\n\n`);
          };
          const sendContent = (text: string): void => {
            chunk({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
          };
          const finish = (): void => {
            chunk({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
            chunk({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14, completion_tokens_details: { reasoning_tokens: 4 } } });
            res.write("data: [DONE]\n\n");
            res.end();
          };
          chunk({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
          if (streamScript) return streamScript(sendContent, finish);
          if (style === "recognition" && recognitionFixture.native) {
            for (let i = 0; i < recognitionFixture.thought.length; i += 3) {
              chunk({ choices: [{ index: 0, delta: { reasoning_content: recognitionFixture.thought.slice(i, i + 3) }, finish_reason: null }] });
            }
            for (let i = 0; i < recognitionFixture.answer.length; i += 3) sendContent(recognitionFixture.answer.slice(i, i + 3));
          } else if (style === "field" || style === "thinking-only") {
            for (const piece of [THOUGHT.slice(0, 12), THOUGHT.slice(12)]) {
              chunk({ choices: [{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }] });
            }
            if (style === "field") sendContent(ANSWER);
          } else if (style !== "empty") {
            // Three characters at a time: every tag lands across a boundary,
            // which is the only interesting case for a streamed scanner.
            const served = inlineContent(tagged);
            for (let i = 0; i < served.length; i += 3) {
              sendContent(served.slice(i, i + 3));
            }
          }
          return finish();
        }

        const message = style === "recognition" && recognitionFixture.native
          ? { role: "assistant", content: recognitionFixture.answer, reasoning_content: recognitionFixture.thought }
          : style === "empty" ? { role: "assistant", content: null }
          : style === "thinking-only" ? { role: "assistant", content: null, reasoning_content: THOUGHT }
          : style === "field"
          ? { role: "assistant", content: ANSWER, reasoning_content: THOUGHT }
          : { role: "assistant", content: inlineContent(tagged) };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "c1", object: "chat.completion", created: 1, model: "up",
          choices: [{ index: 0, message, finish_reason: finishReason }],
          usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14, completion_tokens_details: { reasoning_tokens: 4 } },
        }));
      });
    });
    upstream.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
      resolve();
    });
  });
}

/** One service per format, so a case never has to mutate a definition. */
const SERVICES: Array<{ name: string; format?: string; thinkingProcessing?: boolean; reliableStreaming?: boolean; delimiters?: { open: string; close: string } }> = [
  { name: "plain" },
  { name: "processing-off", format: "none", thinkingProcessing: false },
  { name: "processing-off-reliable", format: "think_tags", thinkingProcessing: false, reliableStreaming: true },
  { name: "as-content", format: "reasoning_content" },
  { name: "as-reasoning", format: "reasoning" },
  { name: "as-tags", format: "think_tags" },
  { name: "hidden", format: "none" },
  { name: "reliable-content", format: "reasoning_content", reliableStreaming: true },
  { name: "reliable-hidden", format: "none", reliableStreaming: true },
  { name: "custom-think", format: "reasoning_content", delimiters: { open: "<think>", close: "</think>" } },
  { name: "as-harmony", format: "reasoning_content", delimiters: { open: HARMONY_OPEN, close: HARMONY_CLOSE } },
  { name: "as-mixed", format: "reasoning_content", delimiters: { open: "<thinking>", close: "</reasoning>" } },
  { name: "hide-mixed", format: "none", delimiters: { open: "<thinking>", close: "</reasoning>" } },
  { name: "hide-spaced", format: "none", delimiters: { open: "<think>", close: "</think \n >" } },
];

beforeAll(async () => {
  await startUpstream();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-tfproxy-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.SESSION_SECRET = "tf-proxy-session-secret-0123456789";

  const { boot } = await import("../src/composition/container");
  const { buildApp } = await import("../src/app");
  c = await boot();

  const provider = c.providers.create({ name: "p", type: "openai_completion", baseUrl, apiKey: "k" });
  const model = c.models.create({ name: "m" });
  c.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "up" });
  for (const s of SERVICES) {
    c.services.create({
      name: s.name,
      definition: {
        timeoutMs: 10_000,
        ...(s.reliableStreaming ? { reliableStreaming: true } : {}),
        steps: [{ model: "m", provider: "p", ...(s.format ? { thinkingParser: s.delimiters
          ? { mode: "custom", delimiters: s.delimiters } : { mode: "think_tags" } } : {}) }],
        ...(s.format ? { thinkingFormat: s.format } : {}),
        ...(s.thinkingProcessing !== undefined ? { thinkingProcessing: s.thinkingProcessing } : {}),
      },
    });
  }
  secret = c.tokens.create({ name: "t" }).secret;
  app = await buildApp(c);
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((r) => upstream.close(() => r()));
  c.sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const chat = (model: string, stream = false, extra: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: { model, stream, messages: [{ role: "user", content: "capital of France?" }], ...extra } as never,
    headers: { authorization: `Bearer ${secret}` },
  });

const messages = (model: string) =>
  app.inject({
    method: "POST",
    url: "/v1/messages",
    payload: { model, max_tokens: 256, messages: [{ role: "user", content: "capital of France?" }] } as never,
    headers: { authorization: `Bearer ${secret}` },
  });

/** The assistant message from a buffered Chat Completions answer. */
const messageOf = (r: { json: () => unknown }): Record<string, unknown> =>
  ((r.json() as { choices: Array<{ message: Record<string, unknown> }> }).choices[0].message);

/** Concatenate the streamed content / reasoning deltas of a Chat Completions SSE body. */
function streamed(payload: string): { content: string; reasoning: string; reasoningContent: string } {
  let content = "";
  let reasoning = "";
  let reasoningContent = "";
  for (const line of payload.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const raw = line.slice(6).trim();
    if (!raw || raw === "[DONE]") continue;
    const parsed = JSON.parse(raw) as { choices?: Array<{ delta?: Record<string, unknown> }> };
    for (const ch of parsed.choices ?? []) {
      const d = ch.delta ?? {};
      if (typeof d.content === "string") content += d.content;
      if (typeof d.reasoning === "string") reasoning += d.reasoning;
      if (typeof d.reasoning_content === "string") reasoningContent += d.reasoning_content;
    }
  }
  return { content, reasoning, reasoningContent };
}

describe("EP: the default leaves an existing service exactly as it was", () => {
  beforeAll(() => { style = "tags"; });

  it("a <think> block still reaches the client as answer text", async () => {
    const message = messageOf(await chat("plain"));
    expect(message.content).toBe(`<think>${THOUGHT}</think>\n\n${ANSWER}`);
    expect(message.reasoning).toBeUndefined();
    expect(message.reasoning_content).toBeUndefined();
  });

  it("...and the same on the streaming path", async () => {
    const out = streamed((await chat("plain", true)).payload);
    expect(out.content).toBe(`<think>${THOUGHT}</think>\n\n${ANSWER}`);
    expect(out.reasoning).toBe("");
  });
});

describe("EP: thinking processing off passes through despite retained parser and format settings", () => {
  for (const model of ["processing-off", "processing-off-reliable"]) for (const stream of [false, true]) {
    it(`preserves raw inline thinking (${model}, stream=${stream})`, async () => {
      style = "tags";
      const result = await chat(model, stream);
      expect(result.statusCode).toBe(200);
      const content = stream ? streamed(result.payload).content : messageOf(result).content;
      expect(content).toBe(`<think>${THOUGHT}</think>\n\n${ANSWER}`);
    });
    it(`does not parse or reject unclosed thinking (${model}, stream=${stream})`, async () => {
      style = "truncated";
      const result = await chat(model, stream);
      expect(result.statusCode).toBe(200);
      const content = stream ? streamed(result.payload).content : messageOf(result).content;
      expect(content).toBe(`<think>${THOUGHT}`);
    });
    it(`preserves native reasoning (${model}, stream=${stream})`, async () => {
      style = "field";
      const result = await chat(model, stream);
      expect(result.statusCode).toBe(200);
      if (stream) expect(streamed(result.payload)).toMatchObject({ content: ANSWER, reasoningContent: THOUGHT });
      else expect(messageOf(result)).toMatchObject({ content: ANSWER, reasoning_content: THOUGHT });
    });
  }
});

describe("EP: an override finds thinking the upstream never labelled", () => {
  beforeAll(() => { style = "tags"; });

  it("reasoning_content: lifted out of the text, delivered under that name ONLY", async () => {
    const message = messageOf(await chat("as-content"));
    expect(message.reasoning_content).toBe(THOUGHT);
    expect(message.reasoning).toBeUndefined();
    expect(message.content).toBe(ANSWER);
  });

  it("reasoning: the same thinking under the other name only", async () => {
    const message = messageOf(await chat("as-reasoning"));
    expect(message.reasoning).toBe(THOUGHT);
    expect(message.reasoning_content).toBeUndefined();
    expect(message.content).toBe(ANSWER);
  });

  it("none: the client sees the answer and nothing else", async () => {
    const message = messageOf(await chat("hidden"));
    expect(message.content).toBe(ANSWER);
    expect(message.reasoning).toBeUndefined();
    expect(message.reasoning_content).toBeUndefined();
  });

  /** The streamed scan has to survive tags split across deltas, which the mock
   * guarantees by chunking three characters at a time. */
  it("the streamed answer is identical to the buffered one", async () => {
    const buffered = messageOf(await chat("as-content"));
    const out = streamed((await chat("as-content", true)).payload);
    expect(out.reasoningContent).toBe(THOUGHT);
    expect(out.reasoning).toBe("");
    expect(out.content).toBe(buffered.content);
  });
});

describe("EP: an override re-says thinking the upstream DID label", () => {
  beforeAll(() => { style = "field"; });
  afterAll(() => { style = "tags"; });

  it("think_tags folds a structured field back into the answer", async () => {
    const message = messageOf(await chat("as-tags"));
    expect(message.content).toBe(`<think>\n${THOUGHT}\n</think>\n\n${ANSWER}`);
    expect(message.reasoning).toBeUndefined();
    expect(message.reasoning_content).toBeUndefined();
  });

  it("...and does the same on the streaming path", async () => {
    const out = streamed((await chat("as-tags", true)).payload);
    expect(out.content).toBe(`<think>\n${THOUGHT}\n</think>\n\n${ANSWER}`);
    expect(out.reasoning).toBe("");
  });

  it("reasoning_content drops the spelling the client did not ask for", async () => {
    const message = messageOf(await chat("as-content"));
    expect(message.reasoning_content).toBe(THOUGHT);
    expect(message.reasoning).toBeUndefined();
  });
});

describe("DT: an Anthropic client, whose wire has no field to choose", () => {
  beforeAll(() => { style = "tags"; });

  it("reasoning_content still lifts the block — it just stays a native thinking block", async () => {
    const body = (await messages("as-content")).json() as { content: Array<Record<string, unknown>> };
    expect(body.content[0]).toMatchObject({ type: "thinking", thinking: THOUGHT });
    expect(body.content[1]).toMatchObject({ type: "text", text: ANSWER });
    expect(JSON.stringify(body)).not.toContain("reasoning_content");
  });

  it("think_tags reaches this wire too: one text block carrying the tags", async () => {
    const body = (await messages("as-tags")).json() as { content: Array<Record<string, unknown>> };
    expect(body.content).toHaveLength(1);
    expect(body.content[0].type).toBe("text");
    expect(String(body.content[0].text)).toBe(`<think>\n${THOUGHT}\n</think>\n\n${ANSWER}`);
  });

  it("the default still hands this wire the raw tags as text", async () => {
    const body = (await messages("plain")).json() as { content: Array<Record<string, unknown>> };
    expect(String(body.content[0].text)).toContain("<think>");
  });
});

describe("ST: the request log records the copy the client received", () => {
  beforeAll(() => { style = "tags"; });

  it("a shaped answer is logged shaped, not canonical", async () => {
    await chat("as-content");
    const rows = c.logs.query({ limit: 1 }).rows as Array<{ id: number }>;
    const log = c.logs.get(rows[0].id) as { responseBody: string };
    // The log is the evidence of what was delivered; a canonical form nobody
    // saw would make a support question unanswerable.
    expect(log.responseBody).toContain("reasoning_content");
    expect(log.responseBody).not.toContain("<think>");
  });
});

describe("native DeepSeek thinking disabled", () => {
  beforeAll(() => { style = "field"; finishReason = "stop"; });
  afterAll(() => { style = "tags"; finishReason = "stop"; });

  for (const stream of [false, true]) {
    it(`stream=${stream}: sends both off signals and drops upstream reasoning`, async () => {
      // The upstream deliberately ignores the toggle: filtering must still work.
      style = "field";
      finishReason = "stop";
      const r = await chat("plain", stream, { thinking: { type: "disabled" }, max_tokens: 64 });
      expect(r.statusCode).toBe(200);
      expect(lastUpstreamBody).toMatchObject({ thinking: { type: "disabled" }, reasoning_effort: "none", max_tokens: 64 });
      expect(r.payload).not.toContain(THOUGHT);
      expect(r.payload).not.toMatch(/"(?:reasoning|reasoning_content|reasoning_details|reasoning_text)"/);
      if (stream) {
        expect(streamed(r.payload)).toEqual({ content: ANSWER, reasoning: "", reasoningContent: "" });
        expect(r.payload).toContain("[DONE]");
      } else expect(messageOf(r).content).toBe(ANSWER);
    });

    it(`stream=${stream}: still errors on reasoning-only token exhaustion without leaking it`, async () => {
      style = "thinking-only";
      finishReason = "length";
      const r = await chat("plain", stream, { thinking: { type: "disabled" }, max_tokens: 64 });
      const message = "upstream exhausted the output token limit before producing an answer or tool call";
      expect(r.payload).toContain(message);
      expect(r.payload).not.toContain(THOUGHT);
      expect(r.payload).not.toMatch(/"(?:reasoning|reasoning_content|reasoning_details|reasoning_text)"/);
      if (stream) expect(r.payload).not.toContain("[DONE]");
      else {
        expect(r.statusCode).toBe(502);
        expect(r.json().error.message).toBe(message);
      }
      const log = c.logs.get(c.logs.query({ limit: 1 }).rows[0].id);
      expect(log.httpStatus).toBe(502);
      expect(log.completionTokens).toBe(9 * log.attempts);
    });
  }
});

describe("blank response regressions", () => {
  afterAll(() => { style = "tags"; finishReason = "stop"; });

  it("hidden thinking with a spaced closing tag retains the answer in both modes", async () => {
    style = "tags-spaced";
    expect(messageOf(await chat("hide-spaced")).content).toBe(ANSWER);
    expect(streamed((await chat("hide-spaced", true)).payload).content).toBe(ANSWER);
  });

  for (const responseStyle of ["thinking-only", "empty"] as const) {
    for (const stream of [false, true]) {
      it(`${responseStyle}, stream=${stream}: sends an error and retains usage`, async () => {
        style = responseStyle;
        finishReason = "stop";
        const r = await chat("plain", stream);
        expect(r.payload).toContain("no answer or tool call");
        if (stream) expect(r.payload).not.toContain("[DONE]");
        else expect(r.statusCode).toBe(502);
        const log = c.logs.get(c.logs.query({ limit: 1 }).rows[0].id);
        expect(log).toMatchObject({ httpStatus: 502, promptTokens: 5 * log.attempts, completionTokens: 9 * log.attempts, reasoningTokens: 4 * log.attempts });
        expect(log.error).toContain("no answer or tool call");
        const raw = JSON.parse(log.responseBody);
        if (stream) expect(raw.usage).toMatchObject({ completionTokens: 9, reasoningTokens: 4 });
        else expect(log.attemptPath).toHaveLength(log.attempts);
      });
    }
  }

  it("records token exhaustion distinctly from an empty normal completion", async () => {
    style = "thinking-only";
    finishReason = "length";
    for (const stream of [false, true]) {
      const r = await chat("hidden", stream);
      expect(r.payload).toContain("output token limit");
      const log = c.logs.get(c.logs.query({ limit: 1 }).rows[0].id);
      expect(log.httpStatus).toBe(502);
      expect(log.completionTokens).toBe(9 * log.attempts);
    }
  });
});

describe("an upstream with explicitly declared asymmetric markers", () => {
  beforeAll(() => { style = "mixed"; });
  afterAll(() => { style = "tags"; });

  it("uses the step's exact custom grammar", async () => {
    const message = messageOf(await chat("as-mixed"));
    expect(message.reasoning_content).toBe(THOUGHT);
    expect(message.content).toBe(ANSWER);
  });

  it("...and the streamed answer is identical to the buffered one", async () => {
    const out = streamed((await chat("as-mixed", true)).payload);
    expect(out.reasoningContent).toBe(THOUGHT);
    expect(out.reasoning).toBe("");
    expect(out.content).toBe(ANSWER);
  });

  it("a service that hides thinking loses it rather than leaking it into the answer", async () => {
    // Detection is independent of presentation and specific to this upstream.
    const message = messageOf(await chat("hide-mixed"));
    expect(message.content).toBe(ANSWER);
    expect(message.reasoning).toBeUndefined();
    expect(message.reasoning_content).toBeUndefined();
  });
});

describe("explicit decoding safety", () => {
  afterAll(() => { style = "tags"; finishReason = "stop"; });

  for (const stream of [false, true]) {
    it(`stream=${stream}: unterminated hidden reasoning is an error, not answer text`, async () => {
      style = "truncated";
      finishReason = "length";
      const response = await chat("hidden", stream);
      expect(response.payload).not.toContain(THOUGHT);
      expect(response.payload).not.toContain("<think>");
      expect(response.payload).toContain("thinking");
      if (stream) expect(response.payload).not.toContain("[DONE]");
      else expect(response.statusCode).toBe(502);
      const log = c.logs.get(c.logs.query({ limit: 1 }).rows[0].id);
      expect(log.httpStatus).toBe(502);
      expect(log.completionTokens).toBe(9 * log.attempts);
    });

    it(`stream=${stream}: legitimate reason XML is preserved`, async () => {
      style = "xml";
      finishReason = "stop";
      const response = await chat("hidden", stream);
      expect(response.statusCode).toBe(200);
      const text = stream ? streamed(response.payload).content : messageOf(response).content;
      expect(text).toBe("<reason>The payment was declined.</reason>");
    });
  }
});

describe("EG: a service that declares its upstream's boundaries", () => {
  beforeAll(() => { style = "harmony"; });
  afterAll(() => { style = "tags"; });

  it("buffered: the declared pair separates the trace from the answer", async () => {
    // The whole point of the escape hatch: nothing about this trace is
    // tag-shaped, so the scanner could never guess it. The pair is matched
    // literally, and the marker that ends it is where the answer starts.
    const message = messageOf(await chat("as-harmony"));
    expect(message.reasoning_content).toBe(THOUGHT);
    expect(message.content).toBe(ANSWER);
  });

  it("...and streaming agrees with it", async () => {
    const out = streamed((await chat("as-harmony", true)).payload);
    expect(out.reasoningContent).toBe(THOUGHT);
    expect(out.content).toBe(ANSWER);
  });

  it("a service without the pair never scans those markers", async () => {
    // Declared boundaries are opt-in per service: the same upstream through a
    // service that declared nothing stays untouched.
    const out = streamed((await chat("plain", true)).payload);
    expect(out.content).toBe(`${HARMONY_OPEN}${THOUGHT}${HARMONY_CLOSE}${ANSWER}`);
  });
});

const RECOGNITION_CASES: Array<RecognitionFixture & { name: string }> = [
  {
    name: "an inline-code closing tag is thought, not the boundary",
    thought: "The closing tag is `</think>`. Still reasoning.",
    answer: "Actual answer",
  },
  {
    name: "a fenced closing tag stays in thought until the real boundary",
    thought: "Example:\n```xml\n</think>\n```\nStill reasoning.",
    answer: "Actual answer",
  },
  {
    name: "an unpaired backtick cannot consume the actual answer",
    thought: "An unfinished `code sample. Still reasoning.",
    answer: "Actual answer",
  },
  {
    name: "an unclosed fence cannot consume the actual answer",
    thought: "Example:\n```xml\nAn unfinished sample. Still reasoning.",
    answer: "Actual answer",
  },
  {
    name: "the answer's opening fence is not the thought's closing fence",
    thought: "Example:\n```xml\nAn unfinished sample.",
    answer: "```ts\nconst answer = 42;\n```",
  },
  {
    name: "native structured reasoning is authoritative over tag-shaped text",
    native: true,
    thought: "Native thought: `</think>` and <think>literal example</think>.",
    answer: "<think>This is answer text, not another thought.</think>Actual answer",
  },
];

const RECOGNITION_MODES = [
  { name: "buffered JSON", stream: false, reliable: false },
  { name: "live SSE", stream: true, reliable: false },
  { name: "reliable SSE", stream: true, reliable: true },
] as const;

/** Exercise the saved per-step parser through real HTTP upstream transport,
 * collection (including reliable streaming), and the downstream formatter. */
describe("quoted closing tags and malformed quotation recovery", () => {
  afterAll(() => { style = "tags"; finishReason = "stop"; });

  for (const fixture of RECOGNITION_CASES) {
    for (const mode of RECOGNITION_MODES) {
      for (const format of ["reasoning_content", "none"] as const) {
        it(`${mode.name}, ${format}: ${fixture.name}`, async () => {
          style = "recognition";
          recognitionFixture = fixture;
          finishReason = "stop";
          const model = format === "none"
            ? (mode.reliable ? "reliable-hidden" : "hidden")
            : (mode.reliable ? "reliable-content" : "as-content");
          const response = await chat(model, mode.stream);
          expect(response.statusCode).toBe(200);
          // Pin the upstream path too: reliable mode must collect actual SSE,
          // rather than accidentally testing the buffered JSON fixture twice.
          expect(lastUpstreamBody.stream === true).toBe(mode.stream);
          if (mode.stream) {
            expect(response.payload).toContain("[DONE]");
            expect(streamed(response.payload)).toEqual({
              content: fixture.answer,
              reasoning: "",
              reasoningContent: format === "none" ? "" : fixture.thought,
            });
          } else {
            const message = messageOf(response);
            expect(message.content).toBe(fixture.answer);
            expect(message.reasoning).toBeUndefined();
            expect(message.reasoning_content).toBe(format === "none" ? undefined : fixture.thought);
          }
        });
      }
    }
  }

  for (const stream of [false, true]) {
    it(`stream=${stream}: custom protocol delimiters remain literal inside backticks`, async () => {
      style = "recognition";
      recognitionFixture = RECOGNITION_CASES[0];
      const response = await chat("custom-think", stream);
      expect(response.statusCode).toBe(200);
      const out = stream ? streamed(response.payload) : {
        content: messageOf(response).content,
        reasoningContent: messageOf(response).reasoning_content,
      };
      expect(out.reasoningContent).toBe("The closing tag is `");
      expect(out.content).toBe("`. Still reasoning.</think>Actual answer");
    });
  }
});

/** Injection collects the whole body, so it cannot prove incremental delivery.
 * These real-socket tests make upstream progress depend on downstream output:
 * thought must arrive before the closing marker is sent, and an actual answer
 * must start before finish_reason/[DONE] or EOF. The watchdog detects deadlocks;
 * it is not a throughput assertion. */
describe("real-socket thinking recognition does not wait for upstream EOF", () => {
  let address: string;
  beforeAll(async () => { address = await app.listen({ port: 0, host: "127.0.0.1" }); });
  afterAll(() => { streamScript = undefined; style = "tags"; });

  for (const malformed of ["unpaired backtick followed by a newline"] as const) {
    for (const format of ["reasoning_content", "none"] as const) {
      it(`${format}, ${malformed}: streams before both close and completion`, async () => {
        const initial = "Initial reasoning is already available. ";
        const suffix = "An unfinished `sample.";
        // A newline ends this dangling inline quotation. The long answer must
        // stream while upstream remains open, not wait for terminal metadata.
        const answer = `Actual answer ${"x".repeat(8192)}`;
        let sendClose: (() => void) | undefined;
        let finish: (() => void) | undefined;
        let sentClose = false;
        let sentFinish = false;
        let sawThoughtBeforeClose = false;
        let sawAnswerBeforeFinish = false;
        streamScript = (sendContent, end) => {
          finish = () => {
            if (sentFinish) return;
            sentFinish = true;
            end();
          };
          sendClose = () => {
            if (sentClose) return;
            sentClose = true;
            const tail = `${suffix}</think>\n${answer}`;
            for (let i = 0; i < tail.length; i += 257) sendContent(tail.slice(i, i + 257));
          };
          sendContent(`<think>${initial}`);
          // A none client intentionally cannot acknowledge private thought.
          if (format === "none") sendClose();
        };
        const controller = new AbortController();
        const watchdog = setTimeout(() => controller.abort(new Error("thinking/answer delivery stalled before upstream completion")), 2500);
        try {
          const response = await fetch(`${address}/v1/chat/completions`, {
            method: "POST",
            headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
            body: JSON.stringify({ model: format === "none" ? "hidden" : "as-content", stream: true, messages: [{ role: "user", content: "test incremental recognition" }] }),
            signal: controller.signal,
          });
          expect(response.status).toBe(200);
          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let payload = "";
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            payload += decoder.decode(value, { stream: true });
            // Network chunks need not align with JSON/SSE frame boundaries.
            const out = streamed(payload.slice(0, payload.lastIndexOf("\n\n") + 2));
            if (!sentClose && out.reasoningContent.includes(initial)) {
              sawThoughtBeforeClose = true;
              sendClose!();
            }
            if (!sentFinish && out.content.startsWith("Actual answer")) {
              sawAnswerBeforeFinish = true;
              finish!();
            }
          }
          payload += decoder.decode();
          if (format === "reasoning_content") expect(sawThoughtBeforeClose).toBe(true);
          expect(sawAnswerBeforeFinish).toBe(true);
          expect(streamed(payload)).toEqual({
            content: answer,
            reasoning: "",
            reasoningContent: format === "none" ? "" : `${initial}${suffix}`,
          });
          expect(payload).toContain("[DONE]");
        } finally {
          clearTimeout(watchdog);
          controller.abort();
          finish?.();
          streamScript = undefined;
        }
      });
    }
  }

  for (const quotation of ["unclosed fence", "long legitimate quoted example"] as const) {
    for (const format of ["reasoning_content", "none"] as const) {
      it(`${format}, ${quotation}: bounded ambiguity errors before EOF without leaking text`, async () => {
        const privateMarker = "PRIVATE_AMBIGUOUS_REASONING";
        const longTail = `${privateMarker}${"x".repeat(8192)}`;
        const wire = `<think>Private example:\n\`\`\`xml\n</think>${longTail}`
          + (quotation === "long legitimate quoted example" ? "\n```\nStill private.</think>Actual answer" : "");
        const finishes: Array<() => void> = [];
        let sentFinish = false;
        streamScript = (sendContent, end) => {
          finishes.push(() => { sentFinish = true; end(); });
          for (let i = 0; i < wire.length; i += 257) sendContent(wire.slice(i, i + 257));
          // No finish_reason, [DONE], or EOF. The bounded ambiguity guard must
          // terminate independently, not silently hide or leak an unbounded tail.
        };
        const controller = new AbortController();
        const watchdog = setTimeout(() => controller.abort(new Error("ambiguous thinking waited for upstream EOF")), 2500);
        try {
          const response = await fetch(`${address}/v1/chat/completions`, {
            method: "POST",
            headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
            body: JSON.stringify({ model: format === "none" ? "hidden" : "as-content", stream: true, messages: [{ role: "user", content: "test bounded recognition" }] }),
            signal: controller.signal,
          });
          const payload = await response.text();
          expect(sentFinish).toBe(false);
          expect(payload).toContain("Upstream thinking boundary is ambiguous");
          expect(payload).not.toContain("[DONE]");
          expect(streamed(payload).content).toBe("");
          expect(payload).not.toContain(privateMarker);
          if (format === "none") {
            expect(payload).not.toContain("Private example");
            expect(streamed(payload).reasoningContent).toBe("");
          }
        } finally {
          clearTimeout(watchdog);
          controller.abort();
          for (const finish of finishes) finish();
          streamScript = undefined;
        }
      });
    }
  }
});
