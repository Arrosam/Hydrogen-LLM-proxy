import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import "../src/core/format";
import { openDatabase, type OpenedDatabase } from "../src/db";
import { buildResponse } from "../src/core/format/registry";
import { fabricateStream } from "../src/core/ir/stream";
import type { ContentPart, StopReason } from "../src/core/ir/content";
import type { Request } from "../src/core/ir/request";
import { TokenRepo } from "../src/persistence/tokenRepo";
import { ServiceRepo } from "../src/persistence/serviceRepo";
import { ResponseRepo } from "../src/persistence/responseRepo";
import { HostedToolRepo } from "../src/persistence/hostedToolRepo";
import { HttpToolSchema } from "../src/execution/toolHttp";
import { HostedToolOptionsSchema } from "../src/execution/definition";
import type { Invocation } from "../src/execution/outcome";
import { ResponsesController } from "../src/transport/responsesController";
import { ProxyController } from "../src/transport/proxyController";
import type { ProxyDeps } from "../src/transport/deps";
import { ActiveRequestRegistry } from "../src/observability/activeRequests";
import { UsageMeter } from "../src/observability/usageMeter";

/**
 * Coverage for the stateful Responses / Conversations HTTP surface: the routes,
 * validation partitions and state transitions that responsesController.test.ts
 * (happy paths) does not reach. Same fixture shape as that file — real Fastify,
 * real SQLite, a stub executor — with two extra switches: `failInvoke` makes the
 * model call throw, `stop` overrides the stop reason of the stub answer.
 */

type Json = Record<string, any>;
let db: OpenedDatabase, dir: string, app: FastifyInstance, tokens: TokenRepo, repo: ResponseRepo, services: ServiceRepo, tools: HostedToolRepo;
let controller: ResponsesController;
let owner: ReturnType<TokenRepo["create"]>, stranger: ReturnType<TokenRepo["create"]>;
let requests: Request[], outputs: ContentPart[][], wait: Promise<void> | undefined;
let serviceId: number, adapter: ReturnType<typeof vi.fn>, record: ReturnType<typeof vi.fn>;
let failInvoke: boolean, stop: StopReason | undefined;

const headers = () => ({ authorization: `Bearer ${owner.secret}` });
const strangerHeaders = () => ({ authorization: `Bearer ${stranger.secret}` });
const create = (body: Json = {}, extra: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/v1/responses", headers: { ...headers(), ...extra }, payload: { model: "svc", input: "hello", ...body } });
const messages = (body: Json = {}) =>
  app.inject({ method: "POST", url: "/v1/messages", headers: headers(), payload: { model: "svc", max_tokens: 20, messages: [{ role: "user", content: "hi" }], ...body } });
const get = (url: string, as = headers()) => app.inject({ url, headers: as });
const post = (url: string, payload?: Json, as = headers()) => app.inject({ method: "POST", url, headers: as, ...(payload === undefined ? {} : { payload }) });
const del = (url: string, as = headers()) => app.inject({ method: "DELETE", url, headers: as });
const sse = (body: string): Json[] => body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)) as Json);
const message = (res: { json: () => Json }): string => res.json().error.message;
const gate = () => { let release!: () => void; wait = new Promise<void>(resolve => { release = resolve; }); return release; };
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
const userItem = (text = "x") => ({ type: "message", role: "user", content: text });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-state-cov-")); db = openDatabase(dir);
  const key = Buffer.alloc(32, 2);
  tokens = new TokenRepo(db.db, key); owner = tokens.create({ name: "owner" }); stranger = tokens.create({ name: "stranger" });
  services = new ServiceRepo(db.db); tools = new HostedToolRepo(db.db, key); repo = new ResponseRepo(db.db, () => 0);
  serviceId = services.create({ name: "svc", definition: { timeoutMs: 1000, steps: [{ model: "m", provider: "p" }] } }).id;
  requests = []; outputs = []; wait = undefined; failInvoke = false; stop = undefined;
  const invoke = async (request: Request): Promise<Invocation> => {
    requests.push(request); if (wait) await wait;
    if (failInvoke) throw new Error("fixture model failure");
    const content = outputs.shift() ?? [{ type: "text", text: "Hello world" }];
    return { attempts: 1, attemptPath: [], result: { ok: true, value: { family: "openai_responses", providerName: "p", modelName: "m", upstreamModel: "up", upstreamRequest: {},
      response: buildResponse("openai_responses", { id: "upstream-id", model: "up", created: 1, content, stopReason: stop ?? (content.some(p => p.type === "tool_use") ? "tool_use" : "stop"), usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } }) } } };
  };
  adapter = vi.fn(async () => ({ status: 200, headers: {}, body: Readable.from(['{"result":"found"}']) }));
  record = vi.fn();
  const deps = { services, tokens, transport: { postStream: adapter }, factory: { forRow: () => ({ executor: { invoke, stream: async (request: Request) => {
    const inv = await invoke(request); if (!inv.result.ok) throw new Error("fixture");
    const data = inv.result.value.response.data();
    return { ...inv, result: { ok: true, value: { ...inv.result.value, dropReasoning: false, events: fabricateStream(data, Infinity) } } };
  } } }) }, logger: { capture: JSON.stringify, record }, usage: new UsageMeter(tokens), activeRequests: new ActiveRequestRegistry() } as unknown as ProxyDeps;
  app = Fastify(); controller = new ResponsesController(deps, repo, tools);
  controller.register(app); new ProxyController(deps, controller).register(app);
});
afterEach(async () => { await app.close(); db.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function bind() {
  const tool = tools.create(HttpToolSchema.parse({ name: "lookup", parameters: { type: "object" }, url: "https://adapter.test/run", bodyTemplate: { args: "{{arguments}}" }, resultPath: "/result" }));
  tools.bind(serviceId, [tool.id]);
  services.update(serviceId, { definition: { timeoutMs: 1000, steps: [{ model: "m", provider: "p" }], hostedTools: HostedToolOptionsSchema.parse({ streamMode: "progress" }) } });
}
const toolCall: ContentPart = { type: "tool_use", id: "call1", name: "lookup", input: {} };

describe("GET /v1/responses/:id/input_items", () => {
  const chain = async () => {
    const first = (await create()).json();
    const second = (await create({ previous_response_id: first.id, input: "next" })).json();
    return `/v1/responses/${second.id}/input_items`;
  };

  it("lists the merged input history newest first by default", async () => {
    const url = await chain();
    const res = await get(url); expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe("list"); expect(body.data).toHaveLength(3); expect(body.has_more).toBe(false);
    expect(JSON.stringify(body.data[0])).toContain("next");
    expect(JSON.stringify(body.data[2])).toContain("hello");
    expect(body.first_id).toBe(body.data[0].id); expect(body.last_id).toBe(body.data[2].id);
    for (const item of body.data) { expect(typeof item.id).toBe("string"); expect(item.id).not.toBe(""); }
    expect(new Set(body.data.map((item: Json) => item.id)).size).toBe(3);
  });

  it("pages ascending with limit and after", async () => {
    const url = await chain();
    const first = (await get(`${url}?order=asc&limit=1`)).json();
    expect(first.data).toHaveLength(1); expect(first.has_more).toBe(true);
    expect(JSON.stringify(first.data[0])).toContain("hello");
    const rest = (await get(`${url}?order=asc&after=${first.data[0].id}`)).json();
    expect(rest.data).toHaveLength(2); expect(rest.has_more).toBe(false);
    expect(JSON.stringify(rest.data[0])).toContain("Hello world");
    expect(JSON.stringify(rest.data[1])).toContain("next");
  });

  it("rejects an unknown cursor and out-of-range paging parameters", async () => {
    const url = await chain();
    const unknown = await get(`${url}?after=nope`);
    expect(unknown.statusCode).toBe(400); expect(message(unknown)).toBe("Item cursor not found");
    expect((await get(`${url}?limit=0`)).statusCode).toBe(400);
    expect((await get(`${url}?limit=101`)).statusCode).toBe(400);
    expect((await get(`${url}?limit=100`)).statusCode).toBe(200);
    expect((await get(`${url}?limit=1`)).statusCode).toBe(200);
    expect((await get(`${url}?order=sideways`)).statusCode).toBe(400);
  });

  it("hides another key's input items", async () => {
    const url = await chain();
    expect((await get(url, strangerHeaders())).statusCode).toBe(404);
  });
});

describe("continuation with outstanding client tool calls", () => {
  const pending = async () => {
    bind(); outputs.push([toolCall, { type: "tool_use", id: "local1", name: "local", input: {} }]);
    const first = await messages({ tools: [{ name: "local", input_schema: { type: "object" } }] });
    expect(first.statusCode).toBe(200);
    return first.json().hydrogen.response_id as string;
  };
  const result = (id: string) => ({ type: "tool_result", tool_use_id: id, content: "r" });
  const rejected = async (content: unknown, expected: string) => {
    const id = await pending();
    const modelCalls = requests.length, adapterCalls = adapter.mock.calls.length;
    const res = await messages({ hydrogen: { previous_response_id: id }, messages: [{ role: "user", content }] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ type: "error", error: { type: "invalid_request_error", message: expected } });
    expect(requests).toHaveLength(modelCalls); expect(adapter).toHaveBeenCalledTimes(adapterCalls);
  };

  it("rejects a tool result that names no outstanding call", () =>
    rejected([result("nope")], "Tool result does not match an outstanding client call"));
  it("rejects a continuation that leaves a client call unanswered", () =>
    rejected("plain text", "Supply results for all outstanding client tool calls before continuing"));
  it("rejects the same tool result supplied twice", () =>
    rejected([result("local1"), result("local1")], "Tool result does not match an outstanding client call"));
});

describe("previous_response_id by state of the previous response", () => {
  const continueFrom = (id: string) => create({ previous_response_id: id, input: "next" });

  it("refuses to continue from a response that is still running", async () => {
    const release = gate();
    const running = (await create({ background: true })).json();
    wait = undefined;
    const res = await continueFrom(running.id);
    expect(res.statusCode).toBe(409); expect(message(res)).toBe("Previous response is not ready for continuation");
    release(); await settle();
  });

  it("refuses to continue from a cancelled response", async () => {
    const release = gate();
    const running = (await create({ background: true })).json();
    expect((await post(`/v1/responses/${running.id}/cancel`)).json().status).toBe("cancelled");
    release(); wait = undefined; await settle();
    const res = await continueFrom(running.id);
    expect(res.statusCode).toBe(409); expect(message(res)).toBe("Previous response is not ready for continuation");
  });

  it("refuses to continue from a failed response", async () => {
    failInvoke = true;
    const failed = (await create()).json();
    failInvoke = false;
    const res = await continueFrom(failed.hydrogen.response_id);
    expect(res.statusCode).toBe(409); expect(message(res)).toBe("Previous response is not ready for continuation");
  });

  it("treats a store:false previous response as not found", async () => {
    const ephemeral = (await create({ store: false })).json();
    const res = await continueFrom(ephemeral.id);
    expect(res.statusCode).toBe(404); expect(message(res)).toBe("Previous response not found");
    const unknown = await continueFrom("resp_unknown");
    expect(unknown.statusCode).toBe(404); expect(message(unknown)).toBe("Previous response not found");
  });

  it("continues from an incomplete response", async () => {
    stop = "length";
    const cut = (await create()).json(); expect(cut.status).toBe("incomplete");
    stop = undefined;
    const res = await continueFrom(cut.id);
    expect(res.statusCode).toBe(200); expect(requests[1].messages).toHaveLength(3);
  });
});

describe("failed execution", () => {
  it("answers 502 in the OpenAI error shape and stores a failed response", async () => {
    failInvoke = true;
    const res = await create();
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error).toEqual({ message: "Hosted tool execution failed", type: "server_error", code: null, param: null });
    expect(typeof body.hydrogen.response_id).toBe("string");
    const row = repo.response(body.hydrogen.response_id, owner.token.id)!;
    expect(row.status).toBe("failed");
    expect(row.response).toMatchObject({ status: "failed", error: { code: "execution_failed", message: "Hosted tool execution failed" } });
    const stored = await get(`/v1/responses/${row.id}`);
    expect(stored.statusCode).toBe(200); expect(stored.json().status).toBe("failed");
    const replay = sse((await get(`/v1/responses/${row.id}?stream=true`)).body);
    expect(replay.at(-1)!.type).toBe("response.failed"); expect(replay.at(-1)!.response.status).toBe("failed");
    expect(replay.some(event => event.type === "response.completed")).toBe(false);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toMatchObject({ httpStatus: 502, error: "Hosted tool execution failed", ingress: "openai_responses" });
  });

  it("ends a streamed request with response.failed", async () => {
    failInvoke = true;
    const events = sse((await create({ stream: true })).body);
    expect(events[0]!.type).toBe("response.created");
    expect(events.at(-1)!.type).toBe("response.failed");
    expect(events.at(-1)!.response.error.code).toBe("execution_failed");
  });

  it("answers the Anthropic error shape and logs a hydrogen.response.failed event", async () => {
    bind(); failInvoke = true;
    const res = await messages();
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body).toMatchObject({ type: "error", error: { type: "api_error", message: "Hosted tool execution failed" } });
    const id = body.hydrogen.response_id as string;
    expect(repo.response(id, owner.token.id)!.status).toBe("failed");
    expect(repo.events(id, owner.token.id).at(-1)!.type).toBe("hydrogen.response.failed");
    expect(record.mock.calls[0]![0]).toMatchObject({ httpStatus: 502, ingress: "anthropic" });
  });
});

describe("a length stop", () => {
  it("is stored and returned as an incomplete response", async () => {
    stop = "length";
    const res = await create(); expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("incomplete"); expect(body.incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect(repo.response(body.id, owner.token.id)!.status).toBe("incomplete");
    expect((await get(`/v1/responses/${body.id}`)).json()).toEqual(body);
    expect(sse((await get(`/v1/responses/${body.id}?stream=true`)).body).at(-1)!.type).toBe("response.incomplete");
  });

  it("ends a streamed request with response.incomplete, not response.completed", async () => {
    stop = "length";
    const events = sse((await create({ stream: true })).body);
    expect(events.at(-1)!.type).toBe("response.incomplete");
    expect(events.at(-1)!.response).toMatchObject({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
    expect(events.some(event => event.type === "response.completed")).toBe(false);
    expect(repo.response(events[0]!.response.id, owner.token.id)!.status).toBe("incomplete");
  });
});

describe("POST /v1/responses/:id/cancel", () => {
  it("refuses a response that was not created in the background", async () => {
    const body = (await create()).json();
    const res = await post(`/v1/responses/${body.id}/cancel`);
    expect(res.statusCode).toBe(400); expect(message(res)).toBe("Only background responses can be cancelled");
    expect(repo.response(body.id, owner.token.id)!.status).toBe("completed");
  });

  it("returns a finished background response unchanged", async () => {
    const started = (await create({ background: true })).json();
    await vi.waitFor(() => expect(repo.response(started.id, owner.token.id)!.status).toBe("completed"));
    const stored = (await get(`/v1/responses/${started.id}`)).json();
    const res = await post(`/v1/responses/${started.id}/cancel`);
    expect(res.statusCode).toBe(200); expect(res.json()).toEqual(stored); expect(res.json().status).toBe("completed");
  });

  it("is idempotent and logs a single response.cancelled event that ends a replay", async () => {
    const release = gate();
    const started = (await create({ background: true })).json();
    const first = await post(`/v1/responses/${started.id}/cancel`);
    expect(first.statusCode).toBe(200); expect(first.json().status).toBe("cancelled");
    const second = await post(`/v1/responses/${started.id}/cancel`);
    expect(second.statusCode).toBe(200); expect(second.json().status).toBe("cancelled");
    release(); await settle();
    const events = repo.events(started.id, owner.token.id);
    expect(events.filter(event => event.type === "response.cancelled")).toHaveLength(1);
    const replay = sse((await get(`/v1/responses/${started.id}?stream=true`)).body);
    expect(replay.at(-1)!.type).toBe("response.cancelled"); expect(replay.at(-1)!.response.status).toBe("cancelled");
  });

  it("hides another key's response", async () => {
    const release = gate();
    const started = (await create({ background: true })).json();
    expect((await post(`/v1/responses/${started.id}/cancel`, undefined, strangerHeaders())).statusCode).toBe(404);
    expect(repo.response(started.id, owner.token.id)!.status).not.toBe("cancelled");
    release(); await settle();
  });
});

describe("POST /v1/responses request validation", () => {
  const refused = async (res: Awaited<ReturnType<typeof create>>, status: number, text: string) => {
    expect(res.statusCode).toBe(status); expect(message(res)).toBe(text); expect(requests).toHaveLength(0);
  };

  it("rejects provider-stored prompt templates", async () =>
    refused(await create({ prompt: { id: "p" } }), 400, "Provider-stored prompt templates are not supported"));
  it("rejects an input that is neither a string nor an array", async () =>
    refused(await create({ input: { a: 1 } }), 400, "input must be a string or an item array"));
  it("rejects an unsupported input item type", async () =>
    refused(await create({ input: [{ type: "computer_call" }] }), 400, "Unsupported conversation input item type"));
  it("rejects an empty model", async () =>
    refused(await create({ model: "" }), 400, "Missing model"));
  it("answers 404 for an unknown model", async () =>
    refused(await create({ model: "nope" }), 404, "Model service not found"));
  it("answers 404 for a disabled service", async () => {
    services.create({ name: "off", enabled: false, definition: { timeoutMs: 1000, steps: [{ model: "m", provider: "p" }] } });
    await refused(await create({ model: "off" }), 404, "Model service not found");
  });
  it("answers 403 when the key's scope excludes the service", async () => {
    const other = services.create({ name: "other", definition: { timeoutMs: 1000, steps: [{ model: "m", provider: "p" }] } }).id;
    tokens.update(owner.token.id, { scopeServices: [other] });
    await refused(await create(), 403, "API key does not allow this service");
    expect((await create({ model: "other" })).statusCode).toBe(200);
  });
  it("rejects background on the Anthropic ingress", async () => {
    const res = await messages({ hydrogen: {}, background: true });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ type: "error", error: { type: "invalid_request_error", message: "Background requires Responses with store:true" } });
    expect(requests).toHaveLength(0);
  });
  it("rejects a non-boolean stream flag", async () => {
    const res = await create({ stream: "yes" });
    expect(res.statusCode).toBe(400); expect(res.json().error.type).toBe("invalid_request_error"); expect(requests).toHaveLength(0);
  });
  it("answers 404 for an unknown conversation and accepts the object form", async () => {
    await refused(await create({ conversation: "conv_missing" }), 404, "Conversation not found");
    const conversation = (await post("/v1/conversations", { items: [userItem("earlier")] })).json();
    const res = await create({ conversation: { id: conversation.id } });
    expect(res.statusCode).toBe(200); expect(res.json().conversation).toEqual({ id: conversation.id });
    expect(requests[0].messages).toHaveLength(2);
  });
});

describe("conversation routes", () => {
  const conversationWith = async (payload: Json = {}) => (await post("/v1/conversations", payload)).json();

  it("reads a conversation and hides it from another key", async () => {
    const created = await conversationWith({ metadata: { a: "b" } });
    const res = await get(`/v1/conversations/${created.id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ id: created.id, object: "conversation", created_at: created.created_at, metadata: { a: "b" } });
    expect(Number.isInteger(body.created_at)).toBe(true);
    const foreign = await get(`/v1/conversations/${created.id}`, strangerHeaders());
    expect(foreign.statusCode).toBe(404); expect(message(foreign)).toBe("Conversation not found");
  });

  it("replaces metadata on update instead of merging it", async () => {
    const created = await conversationWith({ metadata: { old: "1" } });
    const res = await post(`/v1/conversations/${created.id}`, { metadata: { a: "b" } });
    expect(res.statusCode).toBe(200); expect(res.json().metadata).toEqual({ a: "b" });
    expect((await get(`/v1/conversations/${created.id}`)).json().metadata).toEqual({ a: "b" });
    expect((await post(`/v1/conversations/${created.id}`, {})).statusCode).toBe(400);
    expect((await post(`/v1/conversations/${created.id}`, { metadata: { a: "c" } }, strangerHeaders())).statusCode).toBe(404);
    expect((await get(`/v1/conversations/${created.id}`)).json().metadata).toEqual({ a: "b" });
  });

  it("appends items with generated ids and rejects unsupported item types", async () => {
    const created = await conversationWith();
    const res = await post(`/v1/conversations/${created.id}/items`, { items: [userItem()] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe("list"); expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ type: "message", role: "user", content: "x" });
    expect(typeof body.data[0].id).toBe("string"); expect(body.data[0].id).not.toBe("");
    expect(body.first_id).toBe(body.data[0].id); expect(body.last_id).toBe(body.data[0].id);
    const bad = await post(`/v1/conversations/${created.id}/items`, { items: [{ type: "computer_call" }] });
    expect(bad.statusCode).toBe(400); expect(message(bad)).toBe("Unsupported conversation input item type");
    expect((await post(`/v1/conversations/${created.id}/items`, {})).statusCode).toBe(400);
    expect((await get(`/v1/conversations/${created.id}/items`)).json().data).toHaveLength(1);
    const atCreate = await post("/v1/conversations", { items: [{ type: "computer_call" }] });
    expect(atCreate.statusCode).toBe(400); expect(message(atCreate)).toBe("Unsupported conversation input item type");
  });

  it("reads one item by id and answers 404 for an unknown item", async () => {
    const created = await conversationWith({ items: [userItem("kept")] });
    const item = (await get(`/v1/conversations/${created.id}/items`)).json().data[0];
    const res = await get(`/v1/conversations/${created.id}/items/${item.id}`);
    expect(res.statusCode).toBe(200); expect(res.json()).toEqual(item);
    const missing = await get(`/v1/conversations/${created.id}/items/nope`);
    expect(missing.statusCode).toBe(404); expect(message(missing)).toBe("Conversation item not found");
    const gone = await del(`/v1/conversations/${created.id}/items/nope`);
    expect(gone.statusCode).toBe(404); expect(message(gone)).toBe("Conversation item not found");
    expect((await get(`/v1/conversations/${created.id}/items/${item.id}`, strangerHeaders())).statusCode).toBe(404);
  });

  it("appends a completed turn's input and output to the conversation", async () => {
    const created = await conversationWith({ items: [userItem("earlier")] });
    expect((await create({ conversation: created.id })).statusCode).toBe(200);
    const listed = (await get(`/v1/conversations/${created.id}/items?order=asc`)).json();
    expect(listed.data).toHaveLength(3); expect(listed.has_more).toBe(false);
    expect(listed.data.map((item: Json) => item.role)).toEqual(["user", "user", "assistant"]);
    expect(JSON.stringify(listed.data[0])).toContain("earlier");
    expect(JSON.stringify(listed.data[1])).toContain("hello");
    expect(JSON.stringify(listed.data[2])).toContain("Hello world");
    // The next turn replays all three; adjacent user items arrive as one user message.
    expect((await create({ conversation: created.id, input: "again" })).statusCode).toBe(200);
    expect(requests[1].messages.map(m => [m.role, m.content.map(part => part.type === "text" ? part.text : part.type)])).toEqual([
      ["user", ["earlier", "hello"]], ["assistant", ["Hello world"]], ["user", ["again"]],
    ]);
  });

  it("refuses to edit or delete a conversation with an active response", async () => {
    const created = await conversationWith();
    const release = gate();
    const started = await create({ conversation: created.id, background: true }); expect(started.statusCode).toBe(200);
    const append = await post(`/v1/conversations/${created.id}/items`, { items: [userItem()] });
    expect(append.statusCode).toBe(409); expect(message(append)).toBe("Conversation already has an active response");
    const remove = await del(`/v1/conversations/${created.id}`);
    expect(remove.statusCode).toBe(409); expect(message(remove)).toBe("Conversation already has an active response");
    const second = await create({ conversation: created.id });
    expect(second.statusCode).toBe(409); expect(message(second)).toBe("Conversation already has an active response");
    release();
    await vi.waitFor(() => expect(repo.response(started.json().id, owner.token.id)!.status).toBe("completed"));
    expect((await post(`/v1/conversations/${created.id}/items`, { items: [userItem()] })).statusCode).toBe(200);
    expect((await del(`/v1/conversations/${created.id}`)).json()).toEqual({ id: created.id, object: "conversation.deleted", deleted: true });
    expect((await get(`/v1/conversations/${created.id}`)).statusCode).toBe(404);
  });
});

describe("schema limits", () => {
  const entries = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, "v"]));
  const cases: Array<[string, Json, number]> = [
    ["16 entries", entries(16), 200], ["17 entries", entries(17), 400],
    ["a 64-character key", { ["k".repeat(64)]: "v" }, 200], ["a 65-character key", { ["k".repeat(65)]: "v" }, 400],
    ["a 512-character value", { k: "v".repeat(512) }, 200], ["a 513-character value", { k: "v".repeat(513) }, 400],
  ];
  it.each(cases)("metadata with %s on a conversation", async (_name, metadata, status) => {
    expect((await post("/v1/conversations", { metadata })).statusCode).toBe(status);
  });
  it.each(cases)("metadata with %s on a response", async (_name, metadata, status) => {
    const res = await create({ metadata });
    expect(res.statusCode).toBe(status);
    if (status === 200) expect(res.json().metadata).toEqual(metadata); else expect(requests).toHaveLength(0);
  });

  it("accepts 100 items and rejects 101 on conversation create and append", async () => {
    const many = (count: number) => Array.from({ length: count }, (_, i) => userItem(`m${i}`));
    const created = await post("/v1/conversations", { items: many(100) }); expect(created.statusCode).toBe(200);
    expect((await post("/v1/conversations", { items: many(101) })).statusCode).toBe(400);
    const id = created.json().id as string;
    expect((await post(`/v1/conversations/${id}/items`, { items: many(101) })).statusCode).toBe(400);
    const appended = await post(`/v1/conversations/${id}/items`, { items: many(100) });
    expect(appended.statusCode).toBe(200); expect(appended.json().data).toHaveLength(100);
    const page = (await get(`/v1/conversations/${id}/items?limit=100`)).json();
    expect(page.data).toHaveLength(100); expect(page.has_more).toBe(true);
  });

  it("bounds the conversation item page size at 1 and 100", async () => {
    const id = (await post("/v1/conversations", { items: [userItem("a"), userItem("b")] })).json().id as string;
    const one = await get(`/v1/conversations/${id}/items?limit=1`);
    expect(one.statusCode).toBe(200); expect(one.json().data).toHaveLength(1); expect(one.json().has_more).toBe(true);
    expect((await get(`/v1/conversations/${id}/items?limit=100`)).statusCode).toBe(200);
    for (const limit of ["0", "101", "abc", "1.5"]) expect((await get(`/v1/conversations/${id}/items?limit=${limit}`)).statusCode).toBe(400);
    const defaults = (await get(`/v1/conversations/${id}/items`)).json();
    expect(JSON.stringify(defaults.data[0])).toContain('"b"');
  });
});

describe("active job cap", () => {
  it("accepts 32 concurrent jobs, rejects the 33rd and recovers once they finish", async () => {
    const release = gate();
    const started: string[] = [];
    for (let i = 0; i < 32; i++) {
      const res = await create({ background: true }); expect(res.statusCode).toBe(200); started.push(res.json().id);
    }
    const over = await create({ background: true });
    expect(over.statusCode).toBe(429); expect(over.json().error).toMatchObject({ message: "Too many active response jobs", type: "rate_limit_error" });
    expect((await create()).statusCode).toBe(429);
    release();
    await vi.waitFor(() => { for (const id of started) expect(repo.response(id, owner.token.id)!.status).toBe("completed"); });
    await vi.waitFor(async () => expect((await create()).statusCode).toBe(200));
  });
});

describe("replaying a finished response", () => {
  it("replays the whole event log and closes", async () => {
    const body = (await create()).json();
    const res = await get(`/v1/responses/${body.id}?stream=true`);
    expect(res.statusCode).toBe(200); expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = sse(res.body);
    expect(events[0]!.type).toBe("response.created"); expect(events.at(-1)!.type).toBe("response.completed");
    expect(events.at(-1)!.response).toEqual(body);
    const sequence = events.map(event => event.sequence_number as number);
    expect([...sequence].sort((a, b) => a - b)).toEqual(sequence); expect(new Set(sequence).size).toBe(sequence.length);
    // Each frame names its event type on the `event:` line.
    expect(res.body.startsWith("event: response.created\ndata: ")).toBe(true);
  });

  it("honours the starting_after cursor at its boundaries", async () => {
    const body = (await create()).json();
    const url = `/v1/responses/${body.id}`;
    const all = sse((await get(`${url}?stream=true`)).body);
    const last = all.at(-1)!.sequence_number as number;
    const past = await get(`${url}?stream=true&starting_after=${last}`);
    expect(past.statusCode).toBe(200); expect(sse(past.body)).toEqual([]);
    expect(sse((await get(`${url}?stream=true&starting_after=-1`)).body)).toEqual(all);
    expect(sse((await get(`${url}?stream=true&starting_after=${all[0]!.sequence_number}`)).body)).toEqual(all.slice(1));
    expect((await get(`${url}?stream=true&starting_after=-2`)).statusCode).toBe(400);
    expect((await get(`${url}?stream=maybe`)).statusCode).toBe(400);
    expect((await get(`${url}?stream=false`)).json()).toEqual(body);
  });
});

describe("DELETE /v1/responses/:id", () => {
  it("deletes an owned finished response", async () => {
    const body = (await create()).json();
    const res = await del(`/v1/responses/${body.id}`);
    expect(res.statusCode).toBe(200); expect(res.json()).toEqual({ id: body.id, object: "response", deleted: true });
    expect((await get(`/v1/responses/${body.id}`)).statusCode).toBe(404);
    expect((await del(`/v1/responses/${body.id}`)).statusCode).toBe(404);
  });

  it("refuses to delete a response that is still running", async () => {
    const release = gate();
    const started = (await create({ background: true })).json();
    const res = await del(`/v1/responses/${started.id}`);
    expect(res.statusCode).toBe(409); expect(message(res)).toBe("Cancel the active response before deleting it");
    release();
    await vi.waitFor(() => expect(repo.response(started.id, owner.token.id)!.status).toBe("completed"));
    expect((await del(`/v1/responses/${started.id}`)).statusCode).toBe(200);
  });
});

describe("client tools next to hosted tools", () => {
  it("rejects a client tool that shares a hosted tool's name", async () => {
    bind();
    const res = await create({ tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }] });
    expect(res.statusCode).toBe(400); expect(message(res)).toBe("Client and hosted tool names must be distinct");
    expect(requests).toHaveLength(0);
    expect((await create({ tools: [{ type: "function", name: "other", parameters: { type: "object" } }] })).statusCode).toBe(200);
  });
});

describe("which requests the stateful controller takes", () => {
  it("takes every Responses request and no Chat request", () => {
    expect(controller.accepts({ model: "svc" }, "openai_responses")).toBe(true);
    expect(controller.accepts(null, "openai_responses")).toBe(true);
    expect(controller.accepts({ model: "svc" }, "openai_completion")).toBe(false);
    expect(controller.accepts({ model: "svc", hydrogen: {} }, "openai_completion")).toBe(false);
  });
  it("takes an Anthropic request only with the hydrogen extension or a service with hosted tools", () => {
    expect(controller.accepts(null, "anthropic")).toBe(false);
    expect(controller.accepts("text", "anthropic")).toBe(false);
    expect(controller.accepts({ model: "svc" }, "anthropic")).toBe(false);
    expect(controller.accepts({ model: "unknown" }, "anthropic")).toBe(false);
    expect(controller.accepts({ model: "unknown", hydrogen: {} }, "anthropic")).toBe(true);
    bind();
    expect(controller.accepts({ model: "svc" }, "anthropic")).toBe(true);
    expect(controller.accepts({ model: "unknown" }, "anthropic")).toBe(false);
  });
});

describe("client feature headers on the stateful path", () => {
  it("forwards only the headers of the ingress family", async () => {
    expect((await create({}, { "openai-beta": "x", "anthropic-beta": "y" })).statusCode).toBe(200);
    expect(requests[0].params.forwardHeaders).toEqual({ family: "openai_responses", headers: { "openai-beta": "x" } });
  });
  it("carries no forwardHeaders when the client sent none", async () => {
    expect((await create({}, { "anthropic-beta": "y" })).statusCode).toBe(200);
    expect(requests[0].params.forwardHeaders).toBeUndefined();
  });
  it("forwards anthropic-beta from an Anthropic client", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/messages", headers: { ...headers(), "anthropic-beta": "y", "x-title": "t" },
      payload: { model: "svc", max_tokens: 20, hydrogen: {}, messages: [{ role: "user", content: "hi" }] } });
    expect(res.statusCode).toBe(200);
    expect(requests[0].params.forwardHeaders).toEqual({ family: "anthropic", headers: { "anthropic-beta": "y" } });
  });
});

describe("request lifetime", () => {
  it("cancels a foreground response when its client disconnects", async () => {
    const release = gate();
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const abort = new AbortController();
    const pending = fetch(`${address}/v1/responses`, { method: "POST", signal: abort.signal, headers: { ...headers(), "content-type": "application/json" }, body: JSON.stringify({ model: "svc", input: "hello" }) });
    pending.catch(() => undefined);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    abort.abort();
    await expect(pending).rejects.toThrow();
    await settle(); release();
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    const logged = record.mock.calls[0]![0] as Json;
    expect(logged).toMatchObject({ httpStatus: 499, error: "Response execution cancelled" });
    const row = repo.response(logged.responseBody.id as string, owner.token.id)!;
    expect(row.status).toBe("cancelled"); expect(row.response).toMatchObject({ error: { code: "cancelled" } });
  });

  it("streams a store:false response to completion and then forgets it", async () => {
    const events = sse((await create({ store: false, stream: true })).body);
    expect(events[0]!.type).toBe("response.created"); expect(events.at(-1)!.type).toBe("response.completed");
    const id = events[0]!.response.id as string;
    await vi.waitFor(() => expect(repo.response(id, owner.token.id)).toBeUndefined());
    expect((await get(`/v1/responses/${id}`)).statusCode).toBe(404);
  });
});
