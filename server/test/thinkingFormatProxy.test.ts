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
/** "tags" = thinking inline in the content; "field" = a reasoning_content field. */
let style: "tags" | "field" = "tags";

function startUpstream(): Promise<void> {
  return new Promise((resolve) => {
    upstream = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
        const tagged = `<think>${THOUGHT}</think>\n\n${ANSWER}`;

        if (body.stream === true) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const chunk = (d: Record<string, unknown>): void => {
            res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "up", ...d })}\n\n`);
          };
          chunk({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
          if (style === "field") {
            for (const piece of [THOUGHT.slice(0, 12), THOUGHT.slice(12)]) {
              chunk({ choices: [{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }] });
            }
            chunk({ choices: [{ index: 0, delta: { content: ANSWER }, finish_reason: null }] });
          } else {
            // Three characters at a time: every tag lands across a boundary,
            // which is the only interesting case for a streamed scanner.
            for (let i = 0; i < tagged.length; i += 3) {
              chunk({ choices: [{ index: 0, delta: { content: tagged.slice(i, i + 3) }, finish_reason: null }] });
            }
          }
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
          res.write("data: [DONE]\n\n");
          return res.end();
        }

        const message = style === "field"
          ? { role: "assistant", content: ANSWER, reasoning_content: THOUGHT }
          : { role: "assistant", content: tagged };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "c1", object: "chat.completion", created: 1, model: "up",
          choices: [{ index: 0, message, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 },
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
const SERVICES: Array<{ name: string; format?: string }> = [
  { name: "plain" },
  { name: "as-content", format: "reasoning_content" },
  { name: "as-reasoning", format: "reasoning" },
  { name: "as-tags", format: "think_tags" },
  { name: "hidden", format: "none" },
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
      definition: { timeoutMs: 10_000, steps: [{ model: "m", provider: "p" }], ...(s.format ? { thinkingFormat: s.format } : {}) },
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

const chat = (model: string, stream = false) =>
  app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: { model, stream, messages: [{ role: "user", content: "capital of France?" }] } as never,
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
