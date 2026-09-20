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
import type { ContentPart } from "../src/core/ir/content";
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

let db: OpenedDatabase, dir: string, app: FastifyInstance, tokens: TokenRepo, repo: ResponseRepo, services: ServiceRepo, tools: HostedToolRepo;
let owner: ReturnType<TokenRepo["create"]>, stranger: ReturnType<TokenRepo["create"]>;
let requests: Request[], outputs: ContentPart[][], wait: Promise<void> | undefined;
let serviceId: number, adapter: ReturnType<typeof vi.fn>;
let streamGate: Promise<void> | undefined;
const headers = () => ({ authorization: `Bearer ${owner.secret}` });
const create = (body: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/v1/responses", headers: headers(), payload: { model: "svc", input: "hello", ...body } });
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-state-api-")); db = openDatabase(dir);
  const key = Buffer.alloc(32, 2);
  tokens = new TokenRepo(db.db, key); owner = tokens.create({ name: "owner" }); stranger = tokens.create({ name: "stranger" });
  services = new ServiceRepo(db.db); tools = new HostedToolRepo(db.db, key); repo = new ResponseRepo(db.db, () => 0);
  serviceId = services.create({ name: "svc", definition: { timeoutMs: 1000, steps: [{ model: "m", provider: "p" }] } }).id;
  requests = []; outputs = []; wait = undefined; streamGate = undefined;
  const invoke = async (request: Request): Promise<Invocation> => {
    requests.push(request); if (wait) await wait;
    const content = outputs.shift() ?? [{ type: "text", text: "Hello world" }];
    return { attempts: 1, attemptPath: [], result: { ok: true, value: { family: "openai_responses", providerName: "p", modelName: "m", upstreamModel: "up", upstreamRequest: {},
      response: buildResponse("openai_responses", { id: "upstream-id", model: "up", created: 1, content, stopReason: content.some(p => p.type === "tool_use") ? "tool_use" : "stop", usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } }) } } };
  };
  adapter = vi.fn(async () => ({ status: 200, headers: {}, body: Readable.from(['{"result":"found"}']) }));
  const deps = { services, tokens, transport: { postStream: adapter, getStream: adapter }, factory: { forRow: () => ({ executor: { invoke, stream: async (request: Request) => {
    const inv = await invoke(request); if (!inv.result.ok) throw new Error("fixture");
    const data = inv.result.value.response.data();
    async function* events() { for await (const event of fabricateStream(data, Infinity)) { yield event; if ((event.type === "text_delta" || event.type === "tool_args_delta") && streamGate) await streamGate; } }
    return { ...inv, result: { ok: true, value: { ...inv.result.value, dropReasoning: false, events: events() } } };
  } } }) }, logger: { capture: JSON.stringify, record: vi.fn() }, usage: new UsageMeter(tokens), activeRequests: new ActiveRequestRegistry() } as unknown as ProxyDeps;
  app = Fastify(); const controller = new ResponsesController(deps, repo, tools);
  controller.register(app); new ProxyController(deps, controller).register(app);
});
afterEach(async () => { await app.close(); db.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true }); });
function bind(mode: "all" | "progress" | "final" = "progress") {
  const tool = tools.create(HttpToolSchema.parse({ name: "lookup", parameters: { type: "object" }, url: "https://adapter.test/run", bodyTemplate: { args: "{{arguments}}" }, resultPath: "/result" }));
  tools.bind(serviceId, [tool.id]);
  services.update(serviceId, { definition: { timeoutMs: 1000, steps: [{ model: "m", provider: "p" }], hostedTools: HostedToolOptionsSchema.parse({ streamMode: mode }) } });
}
const toolCall: ContentPart = { type: "tool_use", id: "call1", name: "lookup", input: {} };

describe("Responses and Conversations HTTP API", () => {
  it("stores stable response identity and restores messages without inheriting instructions", async () => {
    const first = await create({ instructions: "first-only" }); expect(first.statusCode).toBe(200);
    const body = first.json(); expect(body.status).toBe("completed"); expect(body.id).not.toBe("upstream-id");
    const get = await app.inject({ url: `/v1/responses/${body.id}`, headers: headers() }); expect(get.json()).toEqual(body);
    const next = await create({ previous_response_id: body.id, input: "next" }); expect(next.statusCode).toBe(200);
    expect(requests[1].system).toBeUndefined(); expect(requests[1].messages).toHaveLength(3);
    expect(next.json().hydrogen.session_id).toBe(body.hydrogen.session_id);
    expect(tokens.get(owner.token.id)?.usedTokens).toBe(10);
  });
  it("delivers native text deltas before an ordinary streaming model finishes", async () => {
    let release!: () => void; streamGate = new Promise(resolve => { release = resolve; });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/v1/responses`, { method: "POST", headers: { ...headers(), "content-type": "application/json" }, body: JSON.stringify({ model: "svc", input: "hello", stream: true }) });
    const reader = response.body!.getReader(); let received = "";
    try {
      await vi.waitFor(async () => {
        const next = await reader.read(); received += new TextDecoder().decode(next.value);
        expect(received).toContain('"type":"response.output_text.delta"');
      }, { timeout: 2000 });
      expect(received).not.toContain('"type":"response.completed"');
    } finally { release(); }
    while (true) { const next = await reader.read(); if (next.done) break; received += new TextDecoder().decode(next.value); }
    expect(received).toContain('"type":"response.completed"');
  });
  it("isolates reads, deletes and continuation by Key and honors store:false", async () => {
    const body = (await create()).json();
    for (const method of ["GET", "DELETE"] as const) expect((await app.inject({ method, url: `/v1/responses/${body.id}`, headers: { authorization: `Bearer ${stranger.secret}` } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/v1/responses", headers: { authorization: `Bearer ${stranger.secret}` }, payload: { model: "svc", previous_response_id: body.id, input: "steal" } })).statusCode).toBe(404);
    const ephemeral = (await create({ store: false })).json(); expect(repo.response(ephemeral.id, owner.token.id)).toBeUndefined();
    expect((await create({ store: false, background: true })).statusCode).toBe(400);
  });
  it("supports conversation CRUD, item pagination, automatic history and mutually exclusive pointers", async () => {
    const conversation = (await app.inject({ method: "POST", url: "/v1/conversations", headers: headers(), payload: { items: [{ type: "message", role: "user", content: "earlier" }], metadata: { test: "yes" } } })).json();
    expect(conversation.object).toBe("conversation");
    const result = await create({ conversation: conversation.id }); expect(result.statusCode).toBe(200);
    expect(requests[0].messages).toHaveLength(2);
    const paged = (await app.inject({ url: `/v1/conversations/${conversation.id}/items?limit=1&order=asc`, headers: headers() })).json();
    expect(paged.has_more).toBe(true); expect(paged.data).toHaveLength(1);
    expect((await create({ conversation: conversation.id, previous_response_id: result.json().id })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: `/v1/conversations/${conversation.id}/items/${paged.first_id}`, headers: headers() })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/v1/conversations/${conversation.id}`, headers: headers() })).json().deleted).toBe(true);
  });
  it.each(["all", "progress", "final"] as const)("streams %s tool progress, returns stable final output and resumes by event sequence", async mode => {
    bind(mode); outputs.push([toolCall]);
    const response = await create({ stream: true, background: true });
    const events = response.body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    expect(events.some(e => e.type === "hydrogen.model.delta")).toBe(mode === "all");
    expect(events.some(e => e.type === "hydrogen.tool.started")).toBe(mode !== "final");
    const last = events.at(-1); expect(last.type).toBe("response.completed");
    expect(last.response.usage.total_tokens).toBe(10); expect(last.response.output.some((item: any) => item.type === "function_call")).toBe(false);
    expect(last.response.id).toBe(events[0].response.id);
    const stored = (await app.inject({ url: `/v1/responses/${last.response.id}`, headers: headers() })).json(); expect(stored).toEqual(last.response);
    const resumed = await app.inject({ url: `/v1/responses/${last.response.id}?stream=true&starting_after=${events.at(-2).sequence_number}`, headers: headers() });
    expect(resumed.body).toContain('"type":"response.completed"'); expect(resumed.body).not.toContain('"type":"response.created"');
    const ids = events.filter(e => e.type === "response.output_item.added").map(e => e.item.id);
    expect(ids).toEqual(stored.output.map((item: any) => item.id));
  });
  it("cancels background jobs even after quota exhaustion and ignores late model completion", async () => {
    let release!: () => void; wait = new Promise(resolve => { release = resolve; });
    const started = (await create({ background: true })).json(); expect(started.status).toBe("queued");
    tokens.update(owner.token.id, { maxRequests: 0 });
    const cancelled = await app.inject({ method: "POST", url: `/v1/responses/${started.id}/cancel`, headers: headers() }); expect(cancelled.json().status).toBe("cancelled");
    release(); await new Promise(resolve => setTimeout(resolve, 20));
    expect(repo.response(started.id, owner.token.id)?.status).toBe("cancelled");
    expect((await app.inject({ url: `/v1/responses/${started.id}`, headers: headers() })).statusCode).toBe(200);
    expect((await create()).statusCode).toBe(429);
  });
  it("executes mixed Anthropic tools and continues from Hydrogen's saved context", async () => {
    bind(); outputs.push([toolCall, { type: "tool_use", id: "local1", name: "local", input: {} }]);
    const first = await app.inject({ method: "POST", url: "/v1/messages", headers: headers(), payload: { model: "svc", max_tokens: 20, messages: [{ role: "user", content: "hi" }], tools: [{ name: "local", input_schema: { type: "object" } }] } });
    const body = first.json(); expect(body.type).toBe("message"); expect(body.content).toHaveLength(1); expect(body.content[0].name).toBe("local");
    const next = await app.inject({ method: "POST", url: "/v1/messages", headers: headers(), payload: { model: "svc", max_tokens: 20, hydrogen: { previous_response_id: body.hydrogen.response_id }, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "local1", content: "local result" }] }] } });
    expect(next.statusCode).toBe(200); expect(requests[1].messages).toHaveLength(4); expect(adapter).toHaveBeenCalledTimes(1);
  });
});


describe("Fishball compact hosted contract", () => {
  const request = (extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/v1/fishball/messages", headers: headers(), payload: {
    model: "svc", max_tokens: 200, stream: true, hydrogen: { search: "fishball_search_v1" },
    messages: [{ role: "user", content: "search for 药物" }], tools: [{ name: "search", input_schema: { type: "object" } }, { name: "read_page", input_schema: { type: "object" } }], ...extra,
  } });
  function searchBinding() {
    const tool = tools.create(HttpToolSchema.parse({ name: "fish-search", parameters: { type: "object" }, url: "https://searx.test/search", bodyTemplate: {}, adapter: { kind: "fishball_search_v1" } }));
    tools.bind(serviceId, [tool.id]);
    adapter.mockImplementation(async () => ({ status: 200, headers: {}, body: Readable.from([JSON.stringify({ results: [{ url: "https://who.int/a", title: "A", content: "source words" }], raw_engine_payload: "x".repeat(10000) })]) }));
  }
  const searchCall: ContentPart = { type: "tool_use", id: "search1", name: "search", input: { queries: ["药物"] } };
  it("executes model-search-model in one mobile request and never returns raw tool rounds", async () => {
    searchBinding(); outputs.push([searchCall]);
    const response = await request();
    expect(response.statusCode).toBe(200); expect(requests).toHaveLength(2); expect(adapter).toHaveBeenCalledTimes(1);
    expect(response.body).toContain('"type":"hydrogen.search"'); expect(response.body).toContain('"status":"success"');
    expect(response.body).toContain("Hello world"); expect(response.body).not.toContain("hydrogen.tool.completed"); expect(response.body).not.toContain("tool_calls"); expect(response.body).not.toContain("raw_engine_payload");
    const legacyBytes = Buffer.byteLength(JSON.stringify({ tool_call: searchCall })) + Buffer.byteLength(JSON.stringify({ results: [{ url: "https://who.int/a", title: "A", content: "source words" }], raw_engine_payload: "x".repeat(10000) })) + Buffer.byteLength(JSON.stringify(requests[1].messages));
    const compactBytes = Buffer.byteLength(response.body);
    expect(compactBytes).toBeLessThan(legacyBytes);
    console.log(JSON.stringify({ measurement: "one-search deterministic fixture, response plus search leg", legacyRequests: 3, hostedRequests: 1, legacyBytes, compactBytes }));
  });
  it("continues local tools by token-owned pointer with the server search context intact", async () => {
    searchBinding(); outputs.push([searchCall], [{ type: "tool_use", id: "page1", name: "read_page", input: { url: "https://who.int/a" } }]);
    const first = await request({ stream: false }); const id = first.json().hydrogen.response_id;
    expect(first.json().content[0].name).toBe("read_page");
    const next = await request({ stream: false, hydrogen: { search: "fishball_search_v1", previous_response_id: id }, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "page1", content: "page body" }] }] });
    expect(next.statusCode).toBe(200); expect(adapter).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("source words");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("page body");
  });
  it("fails before answering when search fails, including authorization and malformed upstream", async () => {
    searchBinding();
    for (const status of [403, 200]) {
      adapter.mockImplementation(async () => ({ status, headers: {}, body: Readable.from(['{}']) })); outputs.push([searchCall]);
      const before = requests.length; const result = await request();
      expect(result.body).toContain('"status":"failed"'); expect(result.body).toContain("hydrogen.response.failed"); expect(result.body).not.toContain("Hello world"); expect(requests.length - before).toBe(1);
    }
  });
  it("streams the final answer before the model finishes, with no duplicated arguments", async () => {
    searchBinding(); outputs.push([searchCall], [{ type: "tool_use", id: "answer1", name: "answer", input: { text: "FINAL-LIVE" } }]);
    let release!: () => void; streamGate = new Promise(resolve => { release = resolve; });
    // Let the search tool arguments pass; gate only the final answer's stream.
    streamGate = undefined;
    adapter.mockImplementation(async () => {
      streamGate = new Promise(resolve => { release = resolve; });
      return { status: 200, headers: {}, body: Readable.from(['{"results":[]}']) };
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/v1/fishball/messages`, { method: "POST", headers: { ...headers(), "content-type": "application/json" }, body: JSON.stringify({ model: "svc", max_tokens: 200, stream: true, hydrogen: { search: "fishball_search_v1" }, messages: [{ role: "user", content: "q" }], tools: [{ name: "search", input_schema: { type: "object" } }, { name: "answer", input_schema: { type: "object" } }] }) });
    const reader = response.body!.getReader(); let received = "";
    try {
      await vi.waitFor(async () => { received += new TextDecoder().decode((await reader.read()).value); expect(received).toContain("FINAL-LIVE"); }, { timeout: 2000 });
      expect(received).not.toContain("hydrogen.response.completed");
    } finally { release(); }
    while (true) { const next = await reader.read(); if (next.done) break; received += new TextDecoder().decode(next.value); }
    expect(received.match(/FINAL-LIVE/g)).toHaveLength(1);
    expect(received).toContain("hydrogen.response.completed");
  });
  it("cancels server search on mobile disconnect without another model call", async () => {
    searchBinding(); outputs.push([searchCall]);
    let aborted = false;
    adapter.mockImplementation(async (_url: string, _headers: unknown, opts: { signal: AbortSignal }) => {
      await new Promise((_resolve, reject) => {
        const cancel = () => { aborted = true; reject(opts.signal.reason); };
        if (opts.signal.aborted) cancel(); else opts.signal.addEventListener("abort", cancel, { once: true });
      });
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/v1/fishball/messages`, { method: "POST", headers: { ...headers(), "content-type": "application/json" }, body: JSON.stringify({ model: "svc", max_tokens: 200, stream: true, hydrogen: { search: "fishball_search_v1" }, messages: [{ role: "user", content: "q" }], tools: [{ name: "search", input_schema: { type: "object" } }] }) });
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledTimes(1));
    await response.body!.cancel();
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(requests).toHaveLength(1);
    app.server.closeAllConnections();
  });
  it("requires a compatible binding and contract, and authenticates the dedicated endpoint", async () => {
    expect((await request()).statusCode).toBe(409); expect(requests).toHaveLength(0);
    expect((await request({ hydrogen: { search: "unknown" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/fishball/messages", payload: {} })).statusCode).toBe(401);
  });
  it("keeps old clients on client search when the new binding is installed", async () => {
    searchBinding(); outputs.push([searchCall]);
    const old = await app.inject({ method: "POST", url: "/v1/messages", headers: headers(), payload: { model: "svc", max_tokens: 200, messages: [{ role: "user", content: "q" }], tools: [{ name: "search", input_schema: { type: "object" } }] } });
    expect(old.statusCode).toBe(200); expect(old.json().content[0].name).toBe("search"); expect(adapter).not.toHaveBeenCalled();
  });
});
