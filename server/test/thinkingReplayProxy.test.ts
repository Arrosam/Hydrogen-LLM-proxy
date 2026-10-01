import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { parseResponse, parseStream } from "../src/core/format";
import type { Family } from "../src/core/format/family";
import type { Request } from "../src/core/ir/request";
import type { ThinkingFormat } from "../src/core/ir/thinkingFormat";
import { fabricateStream } from "../src/core/ir/stream";
import { THINKING_REPLAY_ERROR } from "../src/core/ir/thinkingReplay";
import { openDatabase, type OpenedDatabase } from "../src/db";
import { TokenRepo } from "../src/persistence/tokenRepo";
import { ServiceRepo } from "../src/persistence/serviceRepo";
import { ResponseRepo } from "../src/persistence/responseRepo";
import { HostedToolRepo } from "../src/persistence/hostedToolRepo";
import type { Invocation, StreamInvocation } from "../src/execution/outcome";
import { runHostedTools } from "../src/execution/hostedToolLoop";
import { HttpToolSchema } from "../src/execution/toolHttp";
import { HostedToolOptionsSchema } from "../src/execution/definition";
import { ProxyController } from "../src/transport/proxyController";
import { ResponsesController } from "../src/transport/responsesController";
import type { ProxyDeps } from "../src/transport/deps";
import { ActiveRequestRegistry } from "../src/observability/activeRequests";
import { UsageMeter } from "../src/observability/usageMeter";
import type { LogParams } from "../src/observability/requestLogger";

const THOUGHT = "hidden-reasoning-regression-secret";
const SIGNATURE = "native-provider-signature";
const REDACTED = "opaque-redacted-provider-data";
const TOOL = { type: "tool_use", id: "call1", name: "lookup", input: { city: "Paris" } };
const FORMATS: ThinkingFormat[] = ["original", "reasoning", "reasoning_content", "none", "think_tags"];
type Style = "signed" | "redacted" | "unsigned" | "plain";
let db: OpenedDatabase, dir: string, app: FastifyInstance, tokens: TokenRepo;
let secret: string, tokenId: number, requests: Request[], family: Family, style: Style, hasTool: boolean;
let reads: number, closed: boolean, statefulEnabled: boolean, omitStart: boolean;
let logs: LogParams[], active: ActiveRequestRegistry;
let invoke: (request: Request) => Promise<Invocation>;
let invocationGate: Promise<void> | undefined;
const frame = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const chatFrame = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: "up", model: "up", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
function content() {
  return [
    ...(style === "plain" ? [] : style === "redacted" ? [{ type: "redacted_thinking", data: REDACTED }]
      : [{ type: "thinking", thinking: THOUGHT, ...(style === "signed" ? { signature: SIGNATURE } : {}) }]),
    hasTool ? TOOL : { type: "text", text: "answer" },
  ];
}
function body(): Record<string, unknown> {
  if (family === "openai_completion") return { id: "up", model: "up", choices: [{ message: {
    role: "assistant", content: "answer", ...(style === "plain" ? {} : { reasoning_content: THOUGHT }),
    ...(hasTool ? { tool_calls: [{ id: "call1", type: "function", function: { name: "lookup", arguments: JSON.stringify(TOOL.input) } }] } : {}),
  }, finish_reason: hasTool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 } };
  if (family === "openai_responses") return { id: "up", model: "up", status: "completed", output: [
    { type: "reasoning", id: "rs_original", encrypted_content: SIGNATURE, summary: [{ type: "summary_text", text: THOUGHT }] },
    { type: "function_call", id: "fc1", call_id: "call1", name: "lookup", arguments: JSON.stringify(TOOL.input) },
  ], usage: { input_tokens: 5, output_tokens: 9, total_tokens: 14 } };
  return { id: "up", model: "up", content: content(), stop_reason: hasTool ? "tool_use" : "end_turn", usage: { input_tokens: 5, output_tokens: 9 } };
}
function frames(): string[] {
  if (family === "openai_completion") return [chatFrame({ role: "assistant" }), chatFrame({ reasoning_content: THOUGHT }), chatFrame({ content: "answer" }),
    ...(hasTool ? [chatFrame({ tool_calls: [{ index: 0, id: "call1", type: "function", function: { name: "lookup", arguments: JSON.stringify(TOOL.input) } }] })] : []),
    chatFrame({}, hasTool ? "tool_calls" : "stop"), "data: [DONE]\n\n"];
  if (family === "openai_responses") return [frame("response.created", { response: { id: "up", model: "up" } }),
    frame("response.output_item.added", { output_index: 0, item: { type: "reasoning", id: "rs_original", summary: [] } }),
    frame("response.reasoning_summary_text.delta", { item_id: "rs_original", delta: THOUGHT }),
    frame("response.output_item.done", { output_index: 0, item: (body().output as unknown[])[0] }),
    frame("response.output_item.added", { output_index: 1, item: (body().output as unknown[])[1] }),
    frame("response.completed", { response: body() })];
  const out = omitStart ? [] : [frame("message_start", { message: { id: "up", model: "up", usage: { input_tokens: 5 } } })];
  for (const [index, block] of content().entries()) {
    out.push(frame("content_block_start", { index, content_block: block.type === "thinking" ? { type: "thinking", thinking: "" } : block }));
    if (block.type === "thinking") {
      out.push(frame("content_block_delta", { index, delta: { type: "thinking_delta", thinking: THOUGHT } }));
      if (style === "signed") out.push(frame("content_block_delta", { index, delta: { type: "signature_delta", signature: SIGNATURE } }));
    }
    out.push(frame("content_block_stop", { index }));
  }
  out.push(frame("message_delta", { delta: { stop_reason: hasTool ? "tool_use" : "end_turn" }, usage: { output_tokens: 9 } }), frame("message_stop", {}));
  return out;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-replay-")); db = openDatabase(dir);
  const key = Buffer.alloc(32, 7);
  tokens = new TokenRepo(db.db, key); const token = tokens.create({ name: "owner" }); secret = token.secret; tokenId = token.token.id;
  const services = new ServiceRepo(db.db), tools = new HostedToolRepo(db.db, key), repo = new ResponseRepo(db.db, () => 0);
  for (const thinkingFormat of FORMATS) services.create({ name: thinkingFormat, definition: { steps: [{ model: "m", provider: "p" }], thinkingFormat } });
  requests = []; logs = []; family = "anthropic"; style = "signed"; hasTool = true; reads = 0; closed = false; statefulEnabled = false; omitStart = false; invocationGate = undefined;
  active = new ActiveRequestRegistry();
  invoke = async request => {
    requests.push(request); if (invocationGate) await invocationGate;
    return { attempts: 1, attemptPath: [], result: { ok: true, value: { family, providerName: "p", modelName: "m", upstreamModel: "up", upstreamRequest: request.render({ upstreamModel: "up" }), response: parseResponse(family, body()) } } };
  };
  const stream = async (request: Request): Promise<StreamInvocation> => {
    requests.push(request); if (invocationGate) await invocationGate;
    const wire = frames();
    async function* upstream() { try { for (const f of wire) { reads++; yield f; } } finally { closed = true; } }
    return { attempts: 1, attemptPath: [], result: { ok: true, value: { family, providerName: "p", modelName: "m", upstreamModel: "up", upstreamRequest: {}, dropReasoning: false, events: parseStream(family, upstream()) } } };
  };
  const deps = { services, tokens, factory: { forRow: () => ({ executor: { invoke, stream } }) },
    logger: { capture: JSON.stringify, record: (log: LogParams) => logs.push(log) },
    usage: new UsageMeter(tokens), activeRequests: active,
    streamCommitGraceMs: 1, jsonCommitGraceMs: 1, streamPingIntervalMs: 5,
  } as unknown as ProxyDeps;
  app = Fastify(); const stateful = new ResponsesController(deps, repo, tools); stateful.register(app);
  new ProxyController(deps, { accepts: (b, f) => statefulEnabled && stateful.accepts(b, f), create: (r, p, f) => stateful.create(r, p, f) }).register(app);
});
afterEach(async () => { await app.close(); db.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const headers = () => ({ authorization: `Bearer ${secret}` });
const request = (format: ThinkingFormat, stream = false, ingress: Family = "anthropic") => app.inject({ method: "POST", headers: headers(),
  url: ingress === "anthropic" ? "/v1/messages" : ingress === "openai_completion" ? "/v1/chat/completions" : "/v1/responses",
  payload: { model: format, stream, ...(ingress === "openai_responses" ? { input: "find Paris" } : { messages: [{ role: "user", content: "find Paris" }], max_tokens: 64 }) },
});
function expectSafe(payload: string) {
  expect(payload).toContain(THINKING_REPLAY_ERROR);
  expect(payload).not.toContain(THOUGHT);
  expect(payload).not.toContain(SIGNATURE);
  expect(payload).not.toContain(REDACTED);
  expect(payload).not.toContain('"name":"lookup"');
  expect(payload).not.toContain("message_stop");
  expect(payload).not.toContain("response.completed");
  expect(payload).not.toContain("[DONE]");
}

describe("ordinary stateless proxy replay guard", () => {
  for (const stream of [false, true]) for (const format of ["none", "think_tags"] as const) {
    it.each(["signed", "redacted", "unsigned"] as const)(`${format}, stream=${stream}: rejects %s before tool delivery and records a config error`, async responseStyle => {
      style = responseStyle;
      const response = await request(format, stream);
      expectSafe(response.payload);
      expect(response.statusCode).toBe(stream ? 200 : 400);
      expect(logs.at(-1)).toMatchObject({ httpStatus: 400, error: THINKING_REPLAY_ERROR, usage: { promptTokens: 5, completionTokens: stream ? 0 : 9, totalTokens: stream ? 5 : 14 } });
      expect(JSON.stringify(logs.at(-1)?.responseBody)).not.toContain(THOUGHT);
      expect(tokens.get(tokenId)?.usedTokens).toBe(stream ? 5 : 14);
      expect(tokens.get(tokenId)?.usedRequests).toBe(1);
      expect(active.listActive()).toHaveLength(0);
      expect(active.listCompleted()[0]).toMatchObject({ httpStatus: 400, error: THINKING_REPLAY_ERROR });
      if (stream) { expect(reads).toBe(2); expect(closed).toBe(true); }
    });
    it(`${format}, stream=${stream}: protects unsigned ordinary Anthropic turns too`, async () => {
      style = "unsigned"; hasTool = false;
      expectSafe((await request(format, stream)).payload);
    });
    it(`${format}, stream=${stream}: permits native textual Chat reasoning`, async () => {
      family = "openai_completion";
      const response = await request(format, stream, "openai_completion");
      expect(response.statusCode).toBe(200);
      expect(response.payload).not.toContain(THINKING_REPLAY_ERROR);
      expect(response.payload).toContain('"name":"lookup"');
      if (format === "none") expect(response.payload).not.toContain(THOUGHT);
      else expect(response.payload).toContain(THOUGHT);
      if (stream) expect(response.payload).toContain("[DONE]");
      expect(logs.at(-1)?.httpStatus).toBe(200);
    });
    it(`${format}, stream=${stream}: protects native Responses items through an ordinary proxy`, async () => {
      family = "openai_responses";
      expectSafe((await request(format, stream, "openai_responses")).payload);
      expect(logs.at(-1)?.httpStatus).toBe(400);
    });
  }

  it.each(["anthropic", "openai_completion", "openai_responses"] as const)("serializes safe streamed errors in the %s ingress format", async ingress => {
    const response = await request("none", true, ingress);
    expectSafe(response.payload);
    expect(response.payload).toContain('"type":"invalid_request_error"');
    if (ingress !== "openai_completion") expect(response.payload).toContain("event: error");
  });

  it("returns HTTP 400 when a streamed rejection precedes all output", async () => {
    omitStart = true;
    const response = await request("none", true);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("invalid_request_error");
    expectSafe(response.payload);
    expect(logs.at(-1)).toMatchObject({ httpStatus: 400, usage: { totalTokens: 0, incomplete: true } });
  });

  it.each([false, true])("after keepalive commit, stream=%s delivers a semantic 400 without content", async stream => {
    let release!: () => void;
    invocationGate = new Promise<void>(resolve => { release = resolve; });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const response = await fetch(`${address}/v1/messages`, { method: "POST", headers: { ...headers(), "content-type": "application/json" }, body: JSON.stringify({ model: "none", stream, max_tokens: 64, messages: [{ role: "user", content: "hello" }] }) });
      expect(response.status).toBe(200); // the heartbeat already committed it
      release();
      expectSafe(await response.text());
      await vi.waitFor(() => expect(logs.at(-1)?.httpStatus).toBe(400));
      expect(tokens.get(tokenId)?.usedTokens).toBe(stream ? 5 : 14);
    } finally { release(); }
  });

  it.each(["original", "reasoning", "reasoning_content"] as const)("%s reaches the client natively and replays signatures on the next request", async format => {
    const first = await request(format);
    expect(first.statusCode).toBe(200);
    expect(first.json().content[0]).toEqual({ type: "thinking", thinking: THOUGHT, signature: SIGNATURE });
    style = "plain"; hasTool = false;
    const next = await app.inject({ method: "POST", url: "/v1/messages", headers: headers(), payload: { model: format, max_tokens: 64, messages: [
      { role: "user", content: "find Paris" }, { role: "assistant", content: first.json().content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call1", content: "found" }] },
    ] } });
    expect(next.statusCode).toBe(200);
    const rendered = requests[1].render({ upstreamModel: "up" }) as { messages: Array<{ content: unknown[] }> };
    expect(rendered.messages[1].content).toContainEqual({ type: "thinking", thinking: THOUGHT, signature: SIGNATURE });
  });

  it.each(["original", "reasoning", "reasoning_content"] as const)("streamed %s preserves provider signatures instead of rejecting", async format => {
    const response = await request(format, true);
    expect(response.statusCode).toBe(200);
    expect(response.payload).toContain(SIGNATURE);
    expect(response.payload).toContain("message_stop");
    expect(response.payload).not.toContain(THINKING_REPLAY_ERROR);
    expect(logs.at(-1)).toMatchObject({ httpStatus: 200, usage: { totalTokens: 14 } });
  });
});

describe("stateful continuation and hosted execution stay canonical", () => {
  it.each(["none", "think_tags"] as const)("%s does not reject stateful Responses; previous_response_id restores private originals", async format => {
    statefulEnabled = true;
    const first = await request(format, false, "openai_responses");
    expect(first.statusCode).toBe(200);
    expect(first.payload).not.toContain(THINKING_REPLAY_ERROR);
    if (format === "none") expect(first.payload).not.toContain(THOUGHT);
    style = "plain"; hasTool = false;
    const next = await app.inject({ method: "POST", url: "/v1/responses", headers: headers(), payload: { model: format, previous_response_id: first.json().id, input: [{ type: "function_call_output", call_id: "call1", output: "found" }] } });
    expect(next.statusCode).toBe(200);
    expect(requests[1].messages.flatMap(m => m.content)).toContainEqual({ type: "reasoning", origin: "anthropic", text: THOUGHT, signature: SIGNATURE });
  });

  it("hosted tools still hide process thinking while replaying signed originals", async () => {
    await request("original");
    const seed = requests[0]; requests = [];
    const tool = HttpToolSchema.parse({ name: "lookup", parameters: { type: "object" }, url: "https://adapter.test/run", bodyTemplate: { args: "{{arguments}}" }, resultPath: "/result" });
    const events: unknown[] = [];
    const next = async (req: Request) => { const result = await invoke(req); style = "plain"; hasTool = false; return result; };
    const executor = { invoke: next, stream: async (req: Request): Promise<StreamInvocation> => {
      const result = await next(req);
      if (!result.result.ok) throw new Error("fixture invocation failed");
      const value = result.result.value;
      return { attempts: 1, attemptPath: [], result: { ok: true, value: { ...value, dropReasoning: false, events: fabricateStream(value.response.data(), Infinity) } } };
    } };
    const transport = { postStream: vi.fn(async () => ({ status: 200, headers: {}, body: Readable.from(['{"result":"found"}']) })) };
    const run = await runHostedTools(executor, seed, [tool], transport, { sessionId: "session", thinkingFormat: "none", config: HostedToolOptionsSchema.parse({ streamMode: "all" }), emit: async ev => { events.push(ev); } });
    expect(run.value.response.text()).toBe("answer");
    expect(JSON.stringify(events)).not.toContain(THOUGHT);
    expect(requests[1].messages.flatMap(m => m.content)).toContainEqual({ type: "reasoning", origin: "anthropic", text: THOUGHT, signature: SIGNATURE });
    expect(transport.postStream).toHaveBeenCalledTimes(1);
  });
});
