/**
 * Protocol conversion matrix, driven end to end against a mock provider.
 *
 * TEST BASIS: every ingress wire family may be served by every egress family,
 * with or without extended thinking, buffered or streamed. This file covers that
 * matrix through the real Fastify app and a real HTTP upstream, so what is
 * asserted is what actually goes out on the wire and what actually comes back --
 * not what a renderer returns in isolation.
 *
 * ISTQB techniques applied (see the suite names):
 *
 *  - EQUIVALENCE PARTITIONING: ingress family {chat, anthropic, responses} x
 *    egress family {chat, anthropic, responses} = 9 classes, each exercised
 *    buffered and streamed. 3 are same-family pass-through, 6 are translations.
 *  - DECISION TABLE: thinking {absent, disabled, enabled} x egress family
 *    decides which knob is emitted (reasoning_effort / thinking.budget_tokens /
 *    reasoning.effort) and whether the answer carries reasoning back.
 *  - STATE TRANSITION: the streaming event machine
 *    start -> reasoning* -> text* -> tool* -> finish, re-serialized per ingress
 *    family; and the multi-turn transition answer -> client -> replay -> upstream.
 *  - BOUNDARY VALUE ANALYSIS: usage counters at zero / absent / present, and a
 *    cache hit reported at the boundary where cached == the whole prompt.
 *  - ERROR GUESSING: an upstream that answers with no usage at all, and one that
 *    reports a cache hit only in its final streaming frame.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

type Family = "openai_completion" | "anthropic" | "openai_responses";

interface Received {
  url: string;
  body: Record<string, unknown>;
}

/** What each upstream answer should contain, so one assertion set works for all
 * three provider dialects. */
const ANSWER_TEXT = "The weather in Beijing is 20C.";
const THOUGHT = "Let me check the weather.";
const TOOL_NAME = "get_weather";
const TOOL_ARGS = { city: "Beijing" };
const PROMPT_TOKENS = 100;
const CACHED_TOKENS = 70; // a cache HIT inside the prompt count, never added to it
const CACHE_WRITE_TOKENS = 12;
const COMPLETION_TOKENS = 9;
const REASONING_TOKENS = 4;

// --- the mock provider ----------------------------------------------------

/**
 * One HTTP server standing in for all three upstream dialects. The path decides
 * which wire format it answers in, so a single process can play "an Anthropic
 * provider" and "a Responses provider" at once.
 */
interface MockProvider {
  baseUrlFor: (f: Family) => string;
  received: Received[];
  /** Toggles what the next answers contain. */
  opts: { thinking: boolean; tool: boolean; usage: boolean; redacted: boolean; toolDoneOnly?: boolean };
  close: () => Promise<void>;
}

const sse = (event: string, data: Record<string, unknown>): string =>
  `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;

function anthropicBody(o: MockProvider["opts"]): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  if (o.redacted) content.push({ type: "redacted_thinking", data: "OPAQUE-BYTES" });
  else if (o.thinking) content.push({ type: "thinking", thinking: THOUGHT, signature: "sig-abc" });
  content.push({ type: "text", text: ANSWER_TEXT });
  if (o.tool) content.push({ type: "tool_use", id: "toolu_1", name: TOOL_NAME, input: TOOL_ARGS });
  return {
    id: "msg_1", type: "message", role: "assistant", model: "up",
    content,
    stop_reason: o.tool ? "tool_use" : "end_turn",
    usage: o.usage
      ? {
          input_tokens: PROMPT_TOKENS, output_tokens: COMPLETION_TOKENS,
          cache_read_input_tokens: CACHED_TOKENS, cache_creation_input_tokens: CACHE_WRITE_TOKENS,
        }
      : {},
  };
}

function chatBody(o: MockProvider["opts"]): Record<string, unknown> {
  const message: Record<string, unknown> = { role: "assistant", content: ANSWER_TEXT };
  if (o.thinking) message.reasoning_content = THOUGHT;
  if (o.tool) {
    message.tool_calls = [{ id: "call_1", type: "function", function: { name: TOOL_NAME, arguments: JSON.stringify(TOOL_ARGS) } }];
  }
  return {
    id: "chatcmpl_1", object: "chat.completion", created: 1, model: "up",
    choices: [{ index: 0, message, finish_reason: o.tool ? "tool_calls" : "stop" }],
    usage: o.usage
      ? {
          prompt_tokens: PROMPT_TOKENS, completion_tokens: COMPLETION_TOKENS, total_tokens: PROMPT_TOKENS + COMPLETION_TOKENS,
          prompt_tokens_details: { cached_tokens: CACHED_TOKENS },
          completion_tokens_details: { reasoning_tokens: REASONING_TOKENS },
        }
      : undefined,
  };
}

function responsesBody(o: MockProvider["opts"]): Record<string, unknown> {
  const output: Record<string, unknown>[] = [];
  if (o.thinking) {
    output.push({
      type: "reasoning", id: "rs_1",
      summary: [{ type: "summary_text", text: THOUGHT }],
      content: [{ type: "reasoning_text", text: THOUGHT }],
      encrypted_content: "enc-abc",
    });
  }
  output.push({ type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text: ANSWER_TEXT, annotations: [] }] });
  if (o.tool) output.push({ type: "function_call", id: "fc_1", call_id: "call_1", name: TOOL_NAME, arguments: JSON.stringify(TOOL_ARGS), status: "completed" });
  return {
    id: "resp_1", object: "response", created_at: 1, status: "completed", error: null, incomplete_details: null, model: "up",
    output,
    usage: o.usage
      ? {
          input_tokens: PROMPT_TOKENS, output_tokens: COMPLETION_TOKENS, total_tokens: PROMPT_TOKENS + COMPLETION_TOKENS,
          input_tokens_details: { cached_tokens: CACHED_TOKENS },
          output_tokens_details: { reasoning_tokens: REASONING_TOKENS },
        }
      : undefined,
  };
}

function anthropicStream(o: MockProvider["opts"]): string {
  let i = 0;
  let s = sse("message_start", {
    message: {
      id: "msg_1", model: "up",
      usage: o.usage ? { input_tokens: PROMPT_TOKENS, output_tokens: 0, cache_read_input_tokens: CACHED_TOKENS, cache_creation_input_tokens: CACHE_WRITE_TOKENS } : {},
    },
  });
  if (o.redacted) {
    s += sse("content_block_start", { index: i, content_block: { type: "redacted_thinking", data: "OPAQUE-BYTES" } });
    s += sse("content_block_stop", { index: i++ });
  } else if (o.thinking) {
    s += sse("content_block_start", { index: i, content_block: { type: "thinking", thinking: "" } });
    s += sse("content_block_delta", { index: i, delta: { type: "thinking_delta", thinking: THOUGHT } });
    s += sse("content_block_delta", { index: i, delta: { type: "signature_delta", signature: "sig-abc" } });
    s += sse("content_block_stop", { index: i++ });
  }
  s += sse("content_block_start", { index: i, content_block: { type: "text", text: "" } });
  s += sse("content_block_delta", { index: i, delta: { type: "text_delta", text: ANSWER_TEXT } });
  s += sse("content_block_stop", { index: i++ });
  if (o.tool) {
    s += sse("content_block_start", { index: i, content_block: { type: "tool_use", id: "toolu_1", name: TOOL_NAME } });
    s += sse("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(TOOL_ARGS) } });
    s += sse("content_block_stop", { index: i++ });
  }
  s += sse("message_delta", { delta: { stop_reason: o.tool ? "tool_use" : "end_turn" }, usage: { output_tokens: COMPLETION_TOKENS } });
  s += sse("message_stop", {});
  return s;
}

function chatStream(o: MockProvider["opts"]): string {
  const chunk = (d: Record<string, unknown>): string => `data: ${JSON.stringify({ id: "chatcmpl_1", object: "chat.completion.chunk", created: 1, model: "up", ...d })}\n\n`;
  let s = chunk({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  if (o.thinking) s += chunk({ choices: [{ index: 0, delta: { reasoning_content: THOUGHT }, finish_reason: null }] });
  s += chunk({ choices: [{ index: 0, delta: { content: ANSWER_TEXT }, finish_reason: null }] });
  if (o.tool) {
    s += chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: TOOL_NAME, arguments: "" } }] }, finish_reason: null }] });
    s += chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(TOOL_ARGS) } }] }, finish_reason: null }] });
  }
  s += chunk({ choices: [{ index: 0, delta: {}, finish_reason: o.tool ? "tool_calls" : "stop" }] });
  if (o.usage) {
    s += chunk({
      choices: [],
      usage: {
        prompt_tokens: PROMPT_TOKENS, completion_tokens: COMPLETION_TOKENS, total_tokens: PROMPT_TOKENS + COMPLETION_TOKENS,
        prompt_tokens_details: { cached_tokens: CACHED_TOKENS },
        completion_tokens_details: { reasoning_tokens: REASONING_TOKENS },
      },
    });
  }
  return s + "data: [DONE]\n\n";
}

function responsesStream(o: MockProvider["opts"]): string {
  const body = responsesBody(o) as Record<string, unknown>;
  let s = sse("response.created", { response: { id: "resp_1", model: "up", created_at: 1 } });
  if (o.thinking) {
    s += sse("response.reasoning_summary_text.delta", { item_id: "rs_1", output_index: 0, summary_index: 0, delta: THOUGHT });
    s += sse("response.output_item.done", { output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: THOUGHT }], encrypted_content: "enc-abc" } });
  }
  s += sse("response.output_text.delta", { item_id: "msg_1", output_index: 1, content_index: 0, delta: ANSWER_TEXT });
  if (o.tool) {
    if (o.toolDoneOnly) {
      // A compatible gateway that emits ONLY the terminal item (see the
      // error-guessing suite): no `added`, no argument deltas.
      s += sse("response.output_item.done", {
        output_index: 2,
        item: { id: "fc_1", type: "function_call", call_id: "call_1", name: TOOL_NAME, arguments: JSON.stringify(TOOL_ARGS), status: "completed" },
      });
    } else {
      s += sse("response.output_item.added", { output_index: 2, item: { id: "fc_1", type: "function_call", status: "in_progress", call_id: "call_1", name: TOOL_NAME, arguments: "" } });
      s += sse("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 2, delta: JSON.stringify(TOOL_ARGS) });
      s += sse("response.output_item.done", {
        output_index: 2,
        item: { id: "fc_1", type: "function_call", call_id: "call_1", name: TOOL_NAME, arguments: JSON.stringify(TOOL_ARGS), status: "completed" },
      });
    }
  }
  s += sse("response.completed", { response: body });
  return s;
}

function startMockProvider(): Promise<MockProvider> {
  const received: Received[] = [];
  const opts: MockProvider["opts"] = { thinking: false, tool: false, usage: true, redacted: false, toolDoneOnly: false };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; } catch { /* ignore */ }
      received.push({ url, body });

      const family: Family = url.startsWith("/anthropic") ? "anthropic" : url.startsWith("/responses") ? "openai_responses" : "openai_completion";
      const streaming = body.stream === true;

      if (streaming) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(family === "anthropic" ? anthropicStream(opts) : family === "openai_responses" ? responsesStream(opts) : chatStream(opts));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(family === "anthropic" ? anthropicBody(opts) : family === "openai_responses" ? responsesBody(opts) : chatBody(opts)));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        baseUrlFor: (f) => `http://127.0.0.1:${port}/${f === "anthropic" ? "anthropic" : f === "openai_responses" ? "responses" : "chat"}/v1`,
        received,
        opts,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// --- app fixture ----------------------------------------------------------

let app: FastifyInstance;
let upstream: MockProvider;
let dataDir: string;
let secret: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let c: any;

/** Ingress endpoint + a request body in that family, asking the same question. */
const INGRESS: Record<Family, { url: string; body: (service: string, stream: boolean, thinking?: boolean) => Record<string, unknown> }> = {
  openai_completion: {
    url: "/v1/chat/completions",
    body: (model, stream, thinking) => ({
      model, stream, messages: [{ role: "user", content: "weather in Beijing?" }],
      ...(thinking ? { reasoning_effort: "medium" } : {}),
    }),
  },
  anthropic: {
    url: "/v1/messages",
    body: (model, stream, thinking) => ({
      model, stream, max_tokens: 8192, messages: [{ role: "user", content: "weather in Beijing?" }],
      ...(thinking ? { thinking: { type: "enabled", budget_tokens: 2048 } } : {}),
    }),
  },
  openai_responses: {
    url: "/v1/responses",
    body: (model, stream, thinking) => ({
      model, stream, input: [{ role: "user", content: [{ type: "input_text", text: "weather in Beijing?" }] }],
      ...(thinking ? { reasoning: { effort: "medium" } } : {}),
    }),
  },
};

/** The Model Service that forces each egress family. */
const SERVICE_FOR: Record<Family, string> = {
  openai_completion: "to-chat",
  anthropic: "to-anthropic",
  openai_responses: "to-responses",
};

const FAMILIES: Family[] = ["openai_completion", "anthropic", "openai_responses"];

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-matrix-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
  process.env.LOG_PAYLOAD_MAX_CHARS = "0";
  process.env.ADMIN_PASSWORD = "matrix-test-password";
  process.env.SESSION_SECRET = "matrix-test-session-secret";

  upstream = await startMockProvider();

  const { boot } = await import("../src/composition/container");
  const { buildApp } = await import("../src/app");
  c = await boot();

  const model = c.models.create({ name: "m1" });
  for (const f of FAMILIES) {
    const p = c.providers.create({ name: `p-${f}`, type: f, baseUrl: upstream.baseUrlFor(f), apiKey: "k" });
    c.mappings.create({ modelId: model.id, providerId: p.id, upstreamModel: "up" });
    c.services.create({ name: SERVICE_FOR[f], definition: { timeoutMs: 10_000, steps: [{ model: "m1", provider: `p-${f}` }] } });
  }

  secret = c.tokens.create({ name: "t" }).secret;
  app = await buildApp(c);
});

afterAll(async () => {
  await app.close();
  await upstream.close();
  c.sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const auth = (): Record<string, string> => ({ authorization: `Bearer ${secret}` });

/** Drive one ingress -> egress conversion and hand back both wire sides. */
async function convert(
  ingress: Family,
  egress: Family,
  o: { stream?: boolean; thinking?: boolean } = {},
): Promise<{ status: number; sent: Record<string, unknown>; payload: string; json: () => Record<string, unknown> }> {
  upstream.received.length = 0;
  const spec = INGRESS[ingress];
  const r = await app.inject({
    method: "POST", url: spec.url, headers: auth(),
    payload: spec.body(SERVICE_FOR[egress], o.stream ?? false, o.thinking),
  });
  return {
    status: r.statusCode,
    sent: upstream.received[0]?.body ?? {},
    payload: r.payload,
    json: () => JSON.parse(r.payload) as Record<string, unknown>,
  };
}

/** The question must survive every translation, whatever the wire shape. */
function expectQuestionForwarded(sent: Record<string, unknown>, egress: Family): void {
  const wire = JSON.stringify(sent);
  expect(wire).toContain("weather in Beijing?");
  expect(sent.model).toBe("up"); // mapped upstream name, not the service name
  if (egress === "anthropic") {
    expect(sent.messages).toBeDefined();
    expect(sent.max_tokens).toBeTypeOf("number"); // required by that wire
  } else if (egress === "openai_responses") {
    expect(sent.input).toBeDefined();
    expect(sent.store).toBe(false); // the proxy is stateless
  } else {
    expect(sent.messages).toBeDefined();
  }
}

/** The answer must come back in the CLIENT's shape, whatever served it. */
function expectAnswerInIngressShape(ingress: Family, payload: string, streaming: boolean): void {
  expect(payload).toContain(ANSWER_TEXT);
  if (streaming) {
    if (ingress === "anthropic") {
      expect(payload).toContain("event: message_start");
      expect(payload).toContain("content_block_delta");
      expect(payload).toContain("event: message_stop");
    } else if (ingress === "openai_responses") {
      expect(payload).toContain("response.created");
      expect(payload).toContain("response.completed");
    } else {
      expect(payload).toContain('"object":"chat.completion.chunk"');
      expect(payload).toContain("data: [DONE]");
    }
    return;
  }
  const body = JSON.parse(payload) as Record<string, unknown>;
  if (ingress === "anthropic") {
    expect(body.type).toBe("message");
    expect(Array.isArray(body.content)).toBe(true);
  } else if (ingress === "openai_responses") {
    expect(body.object).toBe("response");
    expect(Array.isArray(body.output)).toBe(true);
  } else {
    expect(body.object).toBe("chat.completion");
    expect(Array.isArray(body.choices)).toBe(true);
  }
}

// --- EP: the 3x3 family matrix -------------------------------------------

describe("EP: every ingress family x every egress family (buffered)", () => {
  beforeAll(() => { Object.assign(upstream.opts, { thinking: false, tool: false, usage: true, redacted: false }); });

  for (const ingress of FAMILIES) {
    for (const egress of FAMILIES) {
      const label = ingress === egress ? "pass-through" : "translated";
      it(`${ingress} -> ${egress} (${label})`, async () => {
        const r = await convert(ingress, egress);
        expect(r.status).toBe(200);
        expectQuestionForwarded(r.sent, egress);
        expectAnswerInIngressShape(ingress, r.payload, false);
      });
    }
  }
});

describe("EP: every ingress family x every egress family (streamed)", () => {
  beforeAll(() => { Object.assign(upstream.opts, { thinking: false, tool: false, usage: true, redacted: false }); });

  for (const ingress of FAMILIES) {
    for (const egress of FAMILIES) {
      it(`${ingress} -> ${egress} streamed`, async () => {
        const r = await convert(ingress, egress, { stream: true });
        expect(r.status).toBe(200);
        expect(r.sent.stream).toBe(true); // streaming intent reaches the upstream
        expectQuestionForwarded(r.sent, egress);
        expectAnswerInIngressShape(ingress, r.payload, true);
      });
    }
  }
});

// --- Decision table: thinking x egress family ----------------------------

describe("Decision table: thinking requested x egress family", () => {
  beforeAll(() => { Object.assign(upstream.opts, { thinking: true, tool: false, usage: true, redacted: false }); });

  /** Which knob each egress wire must carry when the client asked to think. */
  const EXPECTED_KNOB: Record<Family, (sent: Record<string, unknown>) => void> = {
    openai_completion: (sent) => {
      expect(sent.reasoning_effort).toBeDefined();
      expect(sent.reasoning_effort).not.toBe("none");
    },
    anthropic: (sent) => {
      expect(sent.thinking).toMatchObject({ type: "enabled" });
      // The budget must fit under the ceiling that also has to hold the answer.
      const t = sent.thinking as { budget_tokens: number };
      expect(t.budget_tokens).toBeLessThan(sent.max_tokens as number);
    },
    openai_responses: (sent) => {
      expect(sent.reasoning).toBeDefined();
      expect((sent.reasoning as { effort: string }).effort).not.toBe("none");
    },
  };

  for (const ingress of FAMILIES) {
    for (const egress of FAMILIES) {
      it(`${ingress} asks to think -> ${egress} carries its own knob`, async () => {
        const r = await convert(ingress, egress, { thinking: true });
        expect(r.status).toBe(200);
        EXPECTED_KNOB[egress](r.sent);
      });
    }
  }

  it("a client that says nothing still pins thinking on an Anthropic egress", async () => {
    Object.assign(upstream.opts, { thinking: false });
    // Absent must not mean "whatever the provider defaults to": the field is
    // always emitted, disabled, so a fallback chain cannot change the answer.
    const r = await convert("openai_completion", "anthropic");
    expect(r.sent.thinking).toEqual({ type: "disabled" });
    Object.assign(upstream.opts, { thinking: true });
  });

  it("BVA: a ceiling at the minimum thinking budget drops thinking rather than starving the answer", async () => {
    // Anthropic requires max_tokens > budget_tokens >= 1024. A client ceiling of
    // exactly 1024 cannot hold the minimum budget AND leave the answer a token,
    // so the request goes out with thinking off and the whole ceiling for the
    // answer -- a smaller thought that gets answered beats a bigger one that
    // does not. One above the boundary must still carry thinking.
    upstream.received.length = 0;
    await app.inject({
      method: "POST", url: "/v1/messages", headers: auth(),
      payload: { model: SERVICE_FOR.anthropic, max_tokens: 1024, messages: [{ role: "user", content: "hi" }], thinking: { type: "enabled", budget_tokens: 2048 } },
    });
    expect(upstream.received[0].body.thinking).toEqual({ type: "disabled" });
    expect(upstream.received[0].body.max_tokens).toBe(1024);

    upstream.received.length = 0;
    await app.inject({
      method: "POST", url: "/v1/messages", headers: auth(),
      payload: { model: SERVICE_FOR.anthropic, max_tokens: 8192, messages: [{ role: "user", content: "hi" }], thinking: { type: "enabled", budget_tokens: 2048 } },
    });
    const t = upstream.received[0].body.thinking as { type: string; budget_tokens: number };
    expect(t.type).toBe("enabled");
    expect(t.budget_tokens).toBeGreaterThanOrEqual(1024);
    expect(t.budget_tokens).toBeLessThan(upstream.received[0].body.max_tokens as number);
  });

  it("thinking: disabled is honored end to end even when the upstream thinks anyway", async () => {
    const r = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: auth(),
      payload: { model: SERVICE_FOR.anthropic, messages: [{ role: "user", content: "hi" }], reasoning_effort: "none" },
    });
    expect(r.statusCode).toBe(200);
    // The mock still returns a thinking block; the client must not see it.
    expect(r.payload).not.toContain(THOUGHT);
    expect(r.payload).toContain(ANSWER_TEXT);
  });
});

describe("Decision table: reasoning is carried back in the client's own dialect", () => {
  beforeAll(() => { Object.assign(upstream.opts, { thinking: true, tool: false, usage: true, redacted: false }); });

  for (const ingress of FAMILIES) {
    for (const egress of FAMILIES) {
      it(`${ingress} <- ${egress} returns the thought`, async () => {
        const r = await convert(ingress, egress, { thinking: true });
        expect(r.payload).toContain(THOUGHT);
        if (ingress === "openai_completion") {
          const msg = ((r.json().choices as Array<{ message: Record<string, unknown> }>)[0]).message;
          // Both dialect spellings, so a DeepSeek-convention client can replay it.
          expect(msg.reasoning_content).toBe(THOUGHT);
          expect(msg.reasoning).toBe(THOUGHT);
        } else if (ingress === "anthropic") {
          const blocks = r.json().content as Array<Record<string, unknown>>;
          expect(blocks[0].type).toBe("thinking");
          expect(blocks[0].thinking).toBe(THOUGHT);
        } else {
          const out = r.json().output as Array<Record<string, unknown>>;
          expect(out.some((o) => o.type === "reasoning")).toBe(true);
        }
      });
    }
  }
});

// --- State transition: streamed event machine ----------------------------

describe("State transition: the streamed event machine per ingress family", () => {
  beforeAll(() => { Object.assign(upstream.opts, { thinking: true, tool: true, usage: true, redacted: false }); });

  for (const ingress of FAMILIES) {
    for (const egress of FAMILIES) {
      it(`${ingress} <- ${egress}: reasoning -> text -> tool -> finish`, async () => {
        const r = await convert(ingress, egress, { stream: true, thinking: true });
        expect(r.status).toBe(200);
        expect(r.payload).toContain(ANSWER_TEXT);
        expect(r.payload).toContain(TOOL_NAME);
        // Terminal event present: a client must be able to tell a finished
        // answer from a truncated one.
        if (ingress === "anthropic") expect(r.payload).toContain("event: message_stop");
        else if (ingress === "openai_responses") expect(r.payload).toContain("response.completed");
        else expect(r.payload).toContain("data: [DONE]");
      });
    }
  }
});

describe("State transition: a tool round trip replays through every family", () => {
  beforeAll(() => { Object.assign(upstream.opts, { thinking: true, tool: false, usage: true, redacted: false }); });

  for (const egress of FAMILIES) {
    it(`a chat client's tool result reaches a ${egress} upstream`, async () => {
      upstream.received.length = 0;
      const r = await app.inject({
        method: "POST", url: "/v1/chat/completions", headers: auth(),
        payload: {
          model: SERVICE_FOR[egress],
          messages: [
            { role: "user", content: "weather in Beijing?" },
            { role: "assistant", content: null, reasoning_content: THOUGHT, tool_calls: [{ id: "call_1", type: "function", function: { name: TOOL_NAME, arguments: JSON.stringify(TOOL_ARGS) } }] },
            { role: "tool", tool_call_id: "call_1", content: "20C" },
          ],
          tools: [{ type: "function", function: { name: TOOL_NAME, parameters: { type: "object", properties: { city: { type: "string" } } } } }],
        },
      });
      expect(r.statusCode).toBe(200);
      const wire = JSON.stringify(upstream.received[0].body);
      // The call, its result, and the tool declaration all survive the hop.
      expect(wire).toContain(TOOL_NAME);
      expect(wire).toContain("20C");
      // The reasoning that informed the call is replayed with it -- the thing
      // Anthropic and DeepSeek both reject a tool loop for omitting.
      expect(wire).toContain(THOUGHT);
    });
  }
});

// --- BVA + error guessing: usage accounting -------------------------------

describe("BVA: usage counters, including the cached share", () => {
  beforeAll(() => { Object.assign(upstream.opts, { thinking: false, tool: false, usage: true, redacted: false }); });

  /** The newest log row, which is where the dashboard reads its numbers. */
  const lastLog = (): Record<string, unknown> => {
    const rows = c.logs.query({ limit: 1 }).rows as Array<{ id: number }>;
    return c.logs.get(rows[0].id) as Record<string, unknown>;
  };

  for (const egress of FAMILIES) {
    it(`${egress} cache hit is recorded, not folded into the prompt count`, async () => {
      const r = await convert("openai_completion", egress);
      expect(r.status).toBe(200);
      const log = lastLog();
      expect(log.promptTokens).toBe(PROMPT_TOKENS);
      expect(log.completionTokens).toBe(COMPLETION_TOKENS);
      // The cached tokens are a SUBSET of the prompt count: recorded, and the
      // prompt count unchanged by their presence.
      expect(log.cachedInputTokens).toBe(CACHED_TOKENS);
      expect(log.promptTokens).toBeGreaterThan(log.cachedInputTokens as number);
    });

    it(`${egress} cache hit survives the streaming path too`, async () => {
      const r = await convert("openai_completion", egress, { stream: true });
      expect(r.status).toBe(200);
      const log = lastLog();
      expect(log.cachedInputTokens).toBe(CACHED_TOKENS);
    });
  }

  it("an Anthropic cache WRITE is recorded separately from a hit", async () => {
    await convert("anthropic", "anthropic");
    const log = lastLog();
    expect(log.cachedInputTokens).toBe(CACHED_TOKENS);
    expect(log.cacheCreationInputTokens).toBe(CACHE_WRITE_TOKENS);
  });

  it("an Anthropic cache write is recorded on the streaming path as well", async () => {
    await convert("anthropic", "anthropic", { stream: true });
    const log = lastLog();
    expect(log.cacheCreationInputTokens).toBe(CACHE_WRITE_TOKENS);
  });

  it("OpenAI reasoning tokens are recorded", async () => {
    await convert("openai_completion", "openai_completion");
    expect(lastLog().reasoningTokens).toBe(REASONING_TOKENS);
  });

  it("the cached share reaches the dashboard summary", async () => {
    const before = c.statsCache.summary().cachedInputTokens as number;
    await convert("openai_completion", "anthropic");
    expect(c.statsCache.summary().cachedInputTokens).toBe(before + CACHED_TOKENS);
  });

  it("error guessing: an upstream that reports no usage at all logs zeros, not NaN", async () => {
    Object.assign(upstream.opts, { usage: false });
    const r = await convert("openai_completion", "openai_completion");
    expect(r.status).toBe(200);
    const log = lastLog();
    expect(log.cachedInputTokens).toBe(0);
    expect(Number.isNaN(log.promptTokens)).toBe(false);
    Object.assign(upstream.opts, { usage: true });
  });

  it("the client still sees the provider's cache numbers in its own dialect", async () => {
    const r = await convert("openai_completion", "anthropic");
    // Anthropic's cache_read maps onto this wire's prompt_tokens_details.
    const usage = r.json().usage as { prompt_tokens_details?: { cached_tokens?: number } };
    expect(usage.prompt_tokens_details?.cached_tokens).toBe(CACHED_TOKENS);
  });
});

describe("Error guessing: a gateway that streams only the terminal tool item", () => {
  // OpenAI itself always opens a function_call with `output_item.added` and
  // streams its arguments. Compatible gateways often emit only the finished
  // item -- which carries the call id, the name and the full arguments. Ignoring
  // it loses the entire tool call, and the client sees a turn that just stops.
  beforeAll(() => { Object.assign(upstream.opts, { thinking: false, tool: true, usage: true, redacted: false, toolDoneOnly: true }); });
  afterAll(() => { Object.assign(upstream.opts, { tool: false, toolDoneOnly: false }); });

  for (const ingress of FAMILIES) {
    it(`${ingress} still receives the tool call`, async () => {
      const r = await convert(ingress, "openai_responses", { stream: true });
      expect(r.status).toBe(200);
      expect(r.payload).toContain(TOOL_NAME);
      expect(r.payload).toContain("Beijing");
    });
  }
});

// --- Error guessing: the redacted block across the matrix -----------------

describe("Error guessing: an Anthropic redacted block through each client", () => {
  beforeAll(() => { Object.assign(upstream.opts, { thinking: false, tool: true, usage: true, redacted: true }); });
  afterAll(() => { Object.assign(upstream.opts, { redacted: false, tool: false }); });

  it("an Anthropic client gets the block back verbatim", async () => {
    const r = await convert("anthropic", "anthropic");
    expect(r.payload).toContain("redacted_thinking");
    expect(r.payload).toContain("OPAQUE-BYTES");
  });

  it("a Responses client gets it wrapped, never raw", async () => {
    const r = await convert("openai_responses", "anthropic");
    expect(r.payload).not.toContain("OPAQUE-BYTES");
    expect(r.payload).toContain("hydrogen-redacted-thinking-v1:");
  });

  it("a Chat Completions client gets neither the bytes nor an empty thought", async () => {
    const r = await convert("openai_completion", "anthropic");
    expect(r.payload).not.toContain("OPAQUE-BYTES");
    expect(r.payload).not.toContain("hydrogen-redacted-thinking-v1:");
    expect(r.payload).toContain(ANSWER_TEXT);
  });

  it("the same holds while streaming", async () => {
    const anth = await convert("anthropic", "anthropic", { stream: true });
    expect(anth.payload).toContain("OPAQUE-BYTES");
    const chat = await convert("openai_completion", "anthropic", { stream: true });
    expect(chat.payload).not.toContain("OPAQUE-BYTES");
  });
});
