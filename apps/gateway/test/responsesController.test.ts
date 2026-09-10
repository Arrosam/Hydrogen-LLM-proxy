import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import "@areelai/wire-format";
import { openDatabase, type OpenedDatabase } from "../src/db/index.js";
import { buildResponse } from "@areelai/wire-format";
import { fabricateStream } from "@areelai/wire-format";
import type { ContentPart } from "@areelai/wire-format";
import type { Request } from "@areelai/wire-format";
import { TokenRepo } from "@areelai/user-management";
import { ServiceRepo } from "@areelai/model-services";
import { ResponseRepo } from "../src/persistence/responseRepo.js";
import { HostedToolRepo } from "@areelai/model-services";
import { HttpToolSchema } from "@areelai/model-services";
import { HostedToolOptionsSchema } from "@areelai/model-services";
import type { Invocation } from "@areelai/model-services";
import { ResponsesController } from "../src/transport/responsesController.js";
import { ProxyController } from "../src/transport/proxyController.js";
import type { ProxyDeps } from "../src/transport/deps.js";
import { ActiveRequestRegistry } from "../src/observability/activeRequests.js";
import { UsageMeter } from "@areelai/user-management";

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
  const deps = { services, tokens, transport: { postStream: adapter }, factory: { forRow: () => ({ executor: { invoke, stream: async (request: Request) => {
    const inv = await invoke(request); if (!inv.result.ok) throw new Error("fixture");
    const data = inv.result.value.response.data();
    async function* events() { for await (const event of fabricateStream(data, Infinity)) { yield event; if (event.type === "text_delta" && streamGate) await streamGate; } }
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
