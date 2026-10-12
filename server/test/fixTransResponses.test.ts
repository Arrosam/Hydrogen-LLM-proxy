/**
 * Stateful Responses surface fixes.
 * T6 — `web_search_call` input items (which this proxy itself emits and stores)
 *      are accepted on /v1/responses and on conversation item create/append.
 * T7 — duplicate client item ids are a 400, not a 500 from the unique index.
 * T8 — a `content_filter` / `pause_turn` stop is returned and stored with
 *      status `incomplete`, the status its own stream ends with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import type { Invocation } from "../src/execution/outcome";
import { ResponsesController } from "../src/transport/responsesController";
import { ProxyController } from "../src/transport/proxyController";
import type { ProxyDeps } from "../src/transport/deps";
import { ActiveRequestRegistry } from "../src/observability/activeRequests";
import { UsageMeter } from "../src/observability/usageMeter";

type Json = Record<string, any>;
let db: OpenedDatabase, dir: string, app: FastifyInstance, tokens: TokenRepo, repo: ResponseRepo;
let owner: ReturnType<TokenRepo["create"]>;
let requests: Request[], stop: StopReason | undefined;

const headers = () => ({ authorization: `Bearer ${owner.secret}` });
const create = (body: Json = {}) =>
  app.inject({ method: "POST", url: "/v1/responses", headers: headers(), payload: { model: "svc", input: "hello", ...body } });
const get = (url: string) => app.inject({ url, headers: headers() });
const post = (url: string, payload: Json) => app.inject({ method: "POST", url, headers: headers(), payload });
const sse = (body: string): Json[] => body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)) as Json);
const userItem = (text = "x", id?: string) => ({ type: "message", role: "user", content: text, ...(id ? { id } : {}) });
const SEARCH_CALL = { id: "ws_1", type: "web_search_call", status: "completed", action: { type: "search", query: "weather", sources: [{ type: "url", url: "https://example.com" }] } };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-fix-responses-")); db = openDatabase(dir);
  const key = Buffer.alloc(32, 2);
  tokens = new TokenRepo(db.db, key); owner = tokens.create({ name: "owner" });
  const services = new ServiceRepo(db.db), tools = new HostedToolRepo(db.db, key); repo = new ResponseRepo(db.db, () => 0);
  services.create({ name: "svc", definition: { timeoutMs: 1000, steps: [{ model: "m", provider: "p" }] } });
  requests = []; stop = undefined;
  const invoke = async (request: Request): Promise<Invocation> => {
    requests.push(request);
    const content: ContentPart[] = [{ type: "text", text: "Hello world" }];
    return { attempts: 1, attemptPath: [], result: { ok: true, value: { family: "openai_responses", providerName: "p", modelName: "m", upstreamModel: "up", upstreamRequest: {},
      response: buildResponse("openai_responses", { id: "upstream-id", model: "up", created: 1, content, stopReason: stop ?? "stop", usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } }) } } };
  };
  const deps = { services, tokens, transport: { postStream: vi.fn() }, factory: { forRow: () => ({ executor: { invoke, stream: async (request: Request) => {
    const inv = await invoke(request); if (!inv.result.ok) throw new Error("fixture");
    return { ...inv, result: { ok: true, value: { ...inv.result.value, dropReasoning: false, events: fabricateStream(inv.result.value.response.data(), Infinity) } } };
  } } }) }, logger: { capture: JSON.stringify, record: vi.fn() }, usage: new UsageMeter(tokens), activeRequests: new ActiveRequestRegistry() } as unknown as ProxyDeps;
  app = Fastify({ logger: false }); const controller = new ResponsesController(deps, repo, tools);
  controller.register(app); new ProxyController(deps, controller).register(app);
});
afterEach(async () => { await app.close(); db.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("T6: web_search_call input items are accepted", () => {
  it("POST /v1/responses replays a search round trip from the client's history", async () => {
    const res = await create({ input: [userItem("what is the weather"), SEARCH_CALL, userItem("and tomorrow?")] });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("completed");
    // The format layer parsed the item into the request the model received.
    expect(JSON.stringify(requests[0]!.messages)).toContain("weather");
    expect(requests[0]!.messages.flatMap(m => m.content).some(p => ["server_tool_use", "server_tool_result"].includes(p.type))).toBe(true);
  });

  it("conversation create and append store the item", async () => {
    const created = await post("/v1/conversations", { items: [userItem("q"), SEARCH_CALL] });
    expect(created.statusCode).toBe(200);
    const appended = await post(`/v1/conversations/${created.json().id}/items`, { items: [{ ...SEARCH_CALL, id: "ws_2" }] });
    expect(appended.statusCode).toBe(200);
    const listed = (await get(`/v1/conversations/${created.json().id}/items?order=asc`)).json();
    expect(listed.data.map((item: Json) => item.type)).toEqual(["message", "web_search_call", "web_search_call"]);
  });

  it("an item type nothing parses is still refused", async () => {
    const res = await create({ input: [{ type: "computer_call", id: "x" }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe("Unsupported conversation input item type");
  });
});

describe("T7: duplicate client item ids are a 400", () => {
  const DUPLICATE = "Duplicate conversation item id: dup";

  it("two items sharing an id in one conversation create", async () => {
    const res = await post("/v1/conversations", { items: [userItem("a", "dup"), userItem("b", "dup")] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe(DUPLICATE);
  });

  it("two items sharing an id in one append, and nothing is stored", async () => {
    const conversation = (await post("/v1/conversations", {})).json();
    const res = await post(`/v1/conversations/${conversation.id}/items`, { items: [userItem("a", "dup"), userItem("b", "dup")] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe(DUPLICATE);
    expect((await get(`/v1/conversations/${conversation.id}/items`)).json().data).toEqual([]);
  });

  it("appending an id the conversation already holds", async () => {
    const conversation = (await post("/v1/conversations", { items: [userItem("a", "dup")] })).json();
    const res = await post(`/v1/conversations/${conversation.id}/items`, { items: [userItem("b", "dup")] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe(DUPLICATE);
    expect((await get(`/v1/conversations/${conversation.id}/items`)).json().data).toHaveLength(1);
  });

  it("the same id in two different conversations is fine", async () => {
    expect((await post("/v1/conversations", { items: [userItem("a", "dup")] })).statusCode).toBe(200);
    expect((await post("/v1/conversations", { items: [userItem("a", "dup")] })).statusCode).toBe(200);
  });

  it("appending to a conversation that does not exist is still a 404", async () => {
    expect((await post("/v1/conversations/conv_missing/items", { items: [userItem("a", "dup")] })).statusCode).toBe(404);
  });
});

describe("T8: a filtered or paused turn is incomplete, buffered and stored", () => {
  for (const reason of ["content_filter", "pause_turn"] as const) {
    it(`${reason}: body, stored row and replayed stream agree`, async () => {
      stop = reason;
      const res = await create();
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("incomplete");
      expect(body.incomplete_details).toEqual({ reason });
      expect(repo.response(body.id, owner.token.id)!.status).toBe("incomplete");
      expect((await get(`/v1/responses/${body.id}`)).json().status).toBe("incomplete");
      const replay = sse((await get(`/v1/responses/${body.id}?stream=true`)).body).at(-1)!;
      expect(replay.type).toBe("response.incomplete");
      expect(replay.response.status).toBe("incomplete");
    });

    it(`${reason}: a streamed request ends with response.incomplete carrying status incomplete`, async () => {
      stop = reason;
      const events = sse((await create({ stream: true })).body);
      expect(events.at(-1)!.type).toBe("response.incomplete");
      expect(events.at(-1)!.response).toMatchObject({ status: "incomplete", incomplete_details: { reason } });
      expect(repo.response(events[0]!.response.id, owner.token.id)!.status).toBe("incomplete");
    });
  }

  it("an ordinary stop stays completed", async () => {
    const body = (await create()).json();
    expect(body.status).toBe("completed");
    expect(repo.response(body.id, owner.token.id)!.status).toBe("completed");
  });
});
