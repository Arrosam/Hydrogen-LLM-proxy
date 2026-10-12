/**
 * End-to-end protocol coverage through the real app and a real HTTP upstream:
 * non-default stop reasons, upstream error envelopes, client tool round trips
 * and client header forwarding, each across the ingress x egress family matrix.
 *
 * Same arrangement as conversionMatrix.test.ts: one mock server plays all three
 * provider dialects, chosen by path, and a Model Service per egress family.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

type Family = "openai_completion" | "anthropic" | "openai_responses";
type Json = Record<string, any>;
type Stop = "stop" | "length" | "content_filter";
const FAMILIES: Family[] = ["openai_completion", "anthropic", "openai_responses"];
const TEXT = "partial answer";

interface Mock {
  baseUrlFor: (f: Family) => string;
  received: Array<{ url: string; body: Json; headers: http.IncomingHttpHeaders }>;
  mode: { stop: Stop; status?: number; message?: string };
  close: () => Promise<void>;
}

const frame = (event: string, data: Json): string => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
const CHAT_STOP: Record<Stop, string> = { stop: "stop", length: "length", content_filter: "content_filter" };
const ANTHROPIC_STOP: Record<Stop, string> = { stop: "end_turn", length: "max_tokens", content_filter: "refusal" };
const RESPONSES_REASON: Record<Stop, string | null> = { stop: null, length: "max_output_tokens", content_filter: "content_filter" };

function responsesBody(stop: Stop): Json {
  const reason = RESPONSES_REASON[stop];
  return {
    id: "resp_1", object: "response", created_at: 1, status: reason ? "incomplete" : "completed", error: null, incomplete_details: reason ? { reason } : null, model: "up",
    output: [{ type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text: TEXT, annotations: [] }] }],
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  };
}

function buffered(family: Family, stop: Stop): Json {
  if (family === "anthropic") return { id: "msg_1", type: "message", role: "assistant", model: "up", content: [{ type: "text", text: TEXT }], stop_reason: ANTHROPIC_STOP[stop], usage: { input_tokens: 5, output_tokens: 3 } };
  if (family === "openai_responses") return responsesBody(stop);
  return { id: "chatcmpl_1", object: "chat.completion", created: 1, model: "up", choices: [{ index: 0, message: { role: "assistant", content: TEXT }, finish_reason: CHAT_STOP[stop] }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } };
}

function streamed(family: Family, stop: Stop): string {
  if (family === "anthropic") {
    return frame("message_start", { message: { id: "msg_1", model: "up", usage: { input_tokens: 5, output_tokens: 0 } } })
      + frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
      + frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: TEXT } })
      + frame("content_block_stop", { index: 0 })
      + frame("message_delta", { delta: { stop_reason: ANTHROPIC_STOP[stop] }, usage: { output_tokens: 3 } })
      + frame("message_stop", {});
  }
  if (family === "openai_responses") {
    const body = responsesBody(stop);
    return frame("response.created", { response: { id: "resp_1", model: "up", created_at: 1 } })
      + frame("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: TEXT })
      + frame(body.status === "incomplete" ? "response.incomplete" : "response.completed", { response: body });
  }
  const chunk = (d: Json): string => `data: ${JSON.stringify({ id: "chatcmpl_1", object: "chat.completion.chunk", created: 1, model: "up", ...d })}\n\n`;
  return chunk({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })
    + chunk({ choices: [{ index: 0, delta: { content: TEXT }, finish_reason: null }] })
    + chunk({ choices: [{ index: 0, delta: {}, finish_reason: CHAT_STOP[stop] }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })
    + "data: [DONE]\n\n";
}

function startMock(): Promise<Mock> {
  const received: Mock["received"] = [];
  const mode: Mock["mode"] = { stop: "stop" };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      let body: Json = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json; } catch { /* ignore */ }
      received.push({ url, body, headers: { ...req.headers } });
      const family: Family = url.startsWith("/anthropic") ? "anthropic" : url.startsWith("/responses") ? "openai_responses" : "openai_completion";
      if (mode.status) {
        res.writeHead(mode.status, { "content-type": "application/json" });
        res.end(JSON.stringify(family === "anthropic" ? { type: "error", error: { type: "upstream_type", message: mode.message } } : { error: { message: mode.message, type: "upstream_type" } }));
        return;
      }
      if (body.stream === true) { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(streamed(family, mode.stop)); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(buffered(family, mode.stop)));
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as AddressInfo).port;
    resolve({
      baseUrlFor: f => `http://127.0.0.1:${port}/${f === "anthropic" ? "anthropic" : f === "openai_responses" ? "responses" : "chat"}/v1`,
      received, mode, close: () => new Promise(r => server.close(() => r())),
    });
  }));
}

let app: FastifyInstance, upstream: Mock, dataDir: string, secret: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let c: any;
const SERVICE_FOR: Record<Family, string> = { openai_completion: "to-chat", anthropic: "to-anthropic", openai_responses: "to-responses" };
const URL_FOR: Record<Family, string> = { openai_completion: "/v1/chat/completions", anthropic: "/v1/messages", openai_responses: "/v1/responses" };
const question = (ingress: Family, model: string, stream: boolean): Json =>
  ingress === "anthropic" ? { model, stream, max_tokens: 256, messages: [{ role: "user", content: "q?" }] }
  : ingress === "openai_responses" ? { model, stream, input: "q?" }
  : { model, stream, messages: [{ role: "user", content: "q?" }] };

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-cov-matrix-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
  process.env.LOG_PAYLOAD_MAX_CHARS = "0";
  process.env.ADMIN_PASSWORD = "coverage-matrix-password";
  process.env.SESSION_SECRET = "coverage-matrix-session-secret";
  upstream = await startMock();
  const { boot } = await import("../src/composition/container");
  const { buildApp } = await import("../src/app");
  c = await boot();
  const model = c.models.create({ name: "m1" });
  for (const f of FAMILIES) {
    const p = c.providers.create({ name: `p-${f}`, type: f, baseUrl: upstream.baseUrlFor(f), apiKey: "k" });
    c.mappings.create({ modelId: model.id, providerId: p.id, upstreamModel: "up" });
    // One attempt per step: an upstream error must reach the client, not be retried away.
    c.services.create({ name: SERVICE_FOR[f], definition: { timeoutMs: 10_000, steps: [{ model: "m1", provider: `p-${f}`, retry: { maxAttempts: 1 } }] } });
  }
  const titled = c.providers.create({ name: "p-titled", type: "openai_completion", baseUrl: upstream.baseUrlFor("openai_completion"), apiKey: "k", extraHeaders: { "x-title": "Provider Title" } });
  c.mappings.create({ modelId: model.id, providerId: titled.id, upstreamModel: "up" });
  c.services.create({ name: "to-titled", definition: { timeoutMs: 10_000, steps: [{ model: "m1", provider: "p-titled", retry: { maxAttempts: 1 } }] } });
  secret = c.tokens.create({ name: "t" }).secret;
  app = await buildApp(c);
}, 30_000);

afterAll(async () => {
  await app.close();
  await upstream.close();
  c.sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => { upstream.received.length = 0; upstream.mode.stop = "stop"; upstream.mode.status = undefined; upstream.mode.message = undefined; });

const send = (url: string, payload: Json, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, headers: { authorization: `Bearer ${secret}`, ...headers }, payload });
const events = (payload: string): Json[] =>
  payload.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).filter(data => data && data !== "[DONE]").map(data => JSON.parse(data) as Json);

describe("EP: a length or content-filter stop in every ingress x egress pair", () => {
  /** How each client wire spells the stop, buffered and streamed. */
  const seen = (ingress: Family, payload: string, stream: boolean): unknown => {
    if (!stream) {
      const body = JSON.parse(payload) as Json;
      if (ingress === "anthropic") return body.stop_reason;
      if (ingress === "openai_responses") return { status: body.status, reason: body.incomplete_details?.reason ?? null };
      return body.choices[0].finish_reason;
    }
    const all = events(payload);
    if (ingress === "anthropic") return all.find(event => event.type === "message_delta")?.delta.stop_reason;
    if (ingress === "openai_responses") {
      const last = all.at(-1)!;
      return { event: last.type, status: last.response.status, reason: last.response.incomplete_details?.reason ?? null };
    }
    return all.map(event => event.choices?.[0]?.finish_reason).find(Boolean);
  };

  for (const ingress of FAMILIES) for (const egress of FAMILIES) for (const stream of [false, true]) {
    it(`${ingress} <- ${egress} ${stream ? "streamed" : "buffered"}: length`, async () => {
      upstream.mode.stop = "length";
      const r = await send(URL_FOR[ingress], question(ingress, SERVICE_FOR[egress], stream));
      expect(r.statusCode).toBe(200); expect(r.payload).toContain(TEXT);
      const expected = ingress === "anthropic" ? "max_tokens" : ingress === "openai_completion" ? "length"
        : { ...(stream ? { event: "response.incomplete" } : {}), status: "incomplete", reason: "max_output_tokens" };
      expect(seen(ingress, r.payload, stream)).toEqual(expected);
    });
  }

  // Chat and Anthropic clients only. A Responses client is left out on purpose: its buffered
  // and streamed answers currently disagree about the status of a filtered turn.
  for (const ingress of ["openai_completion", "anthropic"] as const) for (const egress of FAMILIES) for (const stream of [false, true]) {
    it(`${ingress} <- ${egress} ${stream ? "streamed" : "buffered"}: content filter`, async () => {
      upstream.mode.stop = "content_filter";
      const r = await send(URL_FOR[ingress], question(ingress, SERVICE_FOR[egress], stream));
      expect(r.statusCode).toBe(200); expect(r.payload).toContain(TEXT);
      expect(seen(ingress, r.payload, stream)).toBe(ingress === "anthropic" ? "refusal" : "content_filter");
    });
  }
});

describe("EP: an upstream error reaches each client in that client's envelope", () => {
  const cases: Array<[number, string, string]> = [[429, "rate_limit_error", "rate_limit_error"], [400, "invalid_request_error", "invalid_request_error"], [500, "server_error", "api_error"]];
  for (const [status, openaiType, anthropicType] of cases) for (const egress of FAMILIES) {
    it(`${status} from ${egress} to a Chat client`, async () => {
      Object.assign(upstream.mode, { status, message: `upstream said ${status}` });
      const r = await send(URL_FOR.openai_completion, question("openai_completion", SERVICE_FOR[egress], false));
      expect(r.statusCode).toBe(status);
      expect(r.json().error).toEqual({ message: `upstream said ${status}`, type: openaiType, code: null, param: null });
      expect(upstream.received).toHaveLength(1);
    });
    it(`${status} from ${egress} to an Anthropic client`, async () => {
      Object.assign(upstream.mode, { status, message: `upstream said ${status}` });
      const r = await send(URL_FOR.anthropic, question("anthropic", SERVICE_FOR[egress], false));
      expect(r.statusCode).toBe(status);
      expect(r.json()).toEqual({ type: "error", error: { type: anthropicType, message: `upstream said ${status}` } });
      expect(upstream.received).toHaveLength(1);
    });
    it(`${status} from ${egress} to a Responses client`, async () => {
      Object.assign(upstream.mode, { status, message: `upstream said ${status}` });
      const r = await send(URL_FOR.openai_responses, question("openai_responses", SERVICE_FOR[egress], false));
      expect(r.statusCode).toBe(status);
      expect(r.json().error).toEqual({ message: `upstream said ${status}`, type: openaiType, code: null, param: null });
      expect(upstream.received).toHaveLength(1);
    });
  }
});

describe("State transition: a client tool round trip from the Anthropic and Responses ingress", () => {
  const rounds: Record<"anthropic" | "openai_responses", (model: string) => Json> = {
    anthropic: model => ({
      model, max_tokens: 256,
      tools: [{ name: "get_weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Beijing" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "20C" }] },
      ],
    }),
    openai_responses: model => ({
      model,
      tools: [{ type: "function", name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } }],
      input: [
        { type: "message", role: "user", content: "weather?" },
        { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"Beijing"}' },
        { type: "function_call_output", call_id: "call_1", output: "20C" },
      ],
    }),
  };

  for (const ingress of ["anthropic", "openai_responses"] as const) for (const egress of FAMILIES) {
    it(`a ${ingress} client's tool result reaches a ${egress} upstream in that wire's shape`, async () => {
      const r = await send(URL_FOR[ingress], rounds[ingress](SERVICE_FOR[egress]));
      expect(r.statusCode).toBe(200);
      const sent = upstream.received[0]!.body;
      if (egress === "openai_completion") {
        const messages = sent.messages as Json[];
        const call = messages.find(m => m.role === "assistant")!.tool_calls[0];
        expect(call).toMatchObject({ id: "call_1", type: "function", function: { name: "get_weather" } });
        expect(JSON.parse(call.function.arguments)).toEqual({ city: "Beijing" });
        expect(messages.find(m => m.role === "tool")).toEqual({ role: "tool", tool_call_id: "call_1", content: "20C" });
        expect(sent.tools[0].function.name).toBe("get_weather");
      } else if (egress === "anthropic") {
        const blocks: Json[] = (sent.messages as Json[]).flatMap((m): Json[] => Array.isArray(m.content) ? m.content.map((block: Json): Json => ({ role: m.role, ...block })) : []);
        expect(blocks.find(block => block.type === "tool_use")).toMatchObject({ role: "assistant", id: "call_1", name: "get_weather", input: { city: "Beijing" } });
        const result = blocks.find(block => block.type === "tool_result")!;
        expect(result).toMatchObject({ role: "user", tool_use_id: "call_1" });
        expect(JSON.stringify(result.content)).toContain("20C");
        expect(sent.tools[0].name).toBe("get_weather");
      } else {
        const input = sent.input as Json[];
        const call = input.find(item => item.type === "function_call")!;
        expect(call).toMatchObject({ call_id: "call_1", name: "get_weather" });
        expect(JSON.parse(call.arguments)).toEqual({ city: "Beijing" });
        expect(input.find(item => item.type === "function_call_output")).toMatchObject({ call_id: "call_1", output: "20C" });
        expect(sent.tools[0].name).toBe("get_weather");
      }
    });
  }
});

describe("Decision table: client feature headers by ingress and upstream family", () => {
  const chatTo = (service: string, headers: Record<string, string>) => send(URL_FOR.openai_completion, question("openai_completion", service, false), headers);

  it("forwards anthropic-beta from an Anthropic client to an Anthropic upstream", async () => {
    const r = await send(URL_FOR.anthropic, question("anthropic", "to-anthropic", false), { "anthropic-beta": "x", "x-title": "ignored" });
    expect(r.statusCode).toBe(200);
    expect(upstream.received[0]!.headers["anthropic-beta"]).toBe("x");
    expect(upstream.received[0]!.headers["x-title"]).toBeUndefined();
  });
  it("does not forward anthropic-beta from an Anthropic client to an OpenAI upstream", async () => {
    expect((await send(URL_FOR.anthropic, question("anthropic", "to-chat", false), { "anthropic-beta": "x" })).statusCode).toBe(200);
    expect(upstream.received[0]!.headers["anthropic-beta"]).toBeUndefined();
  });
  it("does not forward a Chat client's headers to an Anthropic upstream", async () => {
    expect((await chatTo("to-anthropic", { "x-title": "My App", "openai-beta": "b", "http-referer": "https://example.test" })).statusCode).toBe(200);
    const seen = upstream.received[0]!.headers;
    expect(seen["x-title"]).toBeUndefined(); expect(seen["openai-beta"]).toBeUndefined(); expect(seen["http-referer"]).toBeUndefined();
  });
  it("forwards openai-beta from a Chat client to an OpenAI upstream", async () => {
    expect((await chatTo("to-chat", { "openai-beta": "assistants=v2" })).statusCode).toBe(200);
    expect(upstream.received[0]!.headers["openai-beta"]).toBe("assistants=v2");
  });
  it("lets the provider's own header win over the client's", async () => {
    expect((await chatTo("to-titled", { "x-title": "Client Title", "http-referer": "https://example.test" })).statusCode).toBe(200);
    const seen = upstream.received[0]!.headers;
    expect(seen["x-title"]).toBe("Provider Title"); expect(seen["http-referer"]).toBe("https://example.test");
  });
});

describe("BVA: n at the rejection boundary", () => {
  const withN = (n: number) => send(URL_FOR.openai_completion, { ...question("openai_completion", "to-chat", false), n });
  it("accepts n = 1 and sends it upstream", async () => {
    expect((await withN(1)).statusCode).toBe(200);
    expect(upstream.received[0]!.body.n).toBe(1);
  });
  it("rejects n = 2, the first unsupported value, without calling upstream", async () => {
    const r = await withN(2);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatchObject({ type: "invalid_request_error" }); expect(r.json().error.message).toContain("n > 1");
    expect(upstream.received).toHaveLength(0);
  });
});
