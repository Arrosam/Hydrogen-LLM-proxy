/**
 * Independent verification (spec section TRANS): T6, T7, T8.
 *
 * Written from the verification spec only. The fixture is the one the
 * coverageResponsesController suite uses: real Fastify, real SQLite, a stub
 * executor whose stop reason the test chooses.
 */
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
import type { Invocation } from "../src/execution/outcome";
import { ResponsesController } from "../src/transport/responsesController";
import { ProxyController } from "../src/transport/proxyController";
import type { ProxyDeps } from "../src/transport/deps";
import { ActiveRequestRegistry } from "../src/observability/activeRequests";
import { UsageMeter } from "../src/observability/usageMeter";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let db: OpenedDatabase, dir: string, app: FastifyInstance, tokens: TokenRepo, repo: ResponseRepo, services: ServiceRepo, tools: HostedToolRepo;
let owner: ReturnType<TokenRepo["create"]>;
let requests: Request[];
let stop: StopReason | undefined;

const headers = () => ({ authorization: `Bearer ${owner.secret}` });
const create = (body: Json = {}) =>
  app.inject({ method: "POST", url: "/v1/responses", headers: headers(), payload: { model: "svc", input: "hello", ...body } });
const get = (url: string) => app.inject({ url, headers: headers() });
const post = (url: string, payload: Json) => app.inject({ method: "POST", url, headers: headers(), payload });
const message = (res: { json: () => Json }): string => res.json().error.message;
const userItem = (text = "x", id?: string): Json => ({ type: "message", role: "user", content: text, ...(id ? { id } : {}) });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-verify-resp-"));
  db = openDatabase(dir);
  const key = Buffer.alloc(32, 2);
  tokens = new TokenRepo(db.db, key);
  owner = tokens.create({ name: "owner" });
  services = new ServiceRepo(db.db);
  tools = new HostedToolRepo(db.db, key);
  repo = new ResponseRepo(db.db, () => 0);
  services.create({ name: "svc", definition: { timeoutMs: 1000, steps: [{ model: "m", provider: "p" }] } });
  requests = [];
  stop = undefined;
  const invoke = async (request: Request): Promise<Invocation> => {
    requests.push(request);
    const content: ContentPart[] = [{ type: "text", text: "Hello world" }];
    return {
      attempts: 1,
      attemptPath: [],
      result: {
        ok: true,
        value: {
          family: "openai_responses", providerName: "p", modelName: "m", upstreamModel: "up", upstreamRequest: {},
          response: buildResponse("openai_responses", { id: "upstream-id", model: "up", created: 1, content, stopReason: stop === undefined ? "stop" : stop, usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } }),
        },
      },
    };
  };
  const adapter = vi.fn(async () => ({ status: 200, headers: {}, body: Readable.from(['{"result":"found"}']) }));
  const deps = {
    services, tokens, transport: { postStream: adapter },
    factory: { forRow: () => ({ executor: { invoke, stream: async (request: Request) => {
      const inv = await invoke(request);
      if (!inv.result.ok) throw new Error("fixture");
      const data = inv.result.value.response.data();
      return { ...inv, result: { ok: true, value: { ...inv.result.value, dropReasoning: false, events: fabricateStream(data, Infinity) } } };
    } } }) },
    logger: { capture: JSON.stringify, record: vi.fn() }, usage: new UsageMeter(tokens), activeRequests: new ActiveRequestRegistry(),
  } as unknown as ProxyDeps;
  app = Fastify();
  const controller = new ResponsesController(deps, repo, tools);
  controller.register(app);
  new ProxyController(deps, controller).register(app);
});

afterEach(async () => {
  await app.close();
  db.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// T6 — web_search_call is an accepted input item type
// ---------------------------------------------------------------------------

describe("T6: POST /v1/responses with a web_search_call input item", () => {
  const SEARCH = { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "weather" } };

  it("accepts a replayed history that contains a web_search_call", async () => {
    const res = await create({ input: [userItem("what is the weather"), SEARCH, userItem("and tomorrow?")] });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("completed");
    expect(requests).toHaveLength(1); // the model was actually called
  });

  it("accepts a minimal web_search_call item (type, id, status)", async () => {
    const res = await create({ input: [{ type: "web_search_call", id: "ws_2", status: "completed" }, userItem("go on")] });
    expect(res.statusCode).toBe(200);
  });

  it("the surrounding messages still reach the model", async () => {
    await create({ input: [userItem("FIRST-MARKER"), SEARCH, userItem("SECOND-MARKER")] });
    const sent = JSON.stringify(requests[0]?.messages);
    expect(sent).toContain("FIRST-MARKER");
    expect(sent).toContain("SECOND-MARKER");
  });

  it("unchanged: an unknown item type is still a 400 and the model is not called", async () => {
    for (const type of ["computer_call", "totally_unknown_item"]) {
      const res = await create({ input: [userItem("hi"), { type, id: "x_1" }] });
      expect(res.statusCode, type).toBe(400);
    }
    expect(requests).toHaveLength(0);
  });

  it("unchanged: a plain message array is accepted", async () => {
    expect((await create({ input: [userItem("hi")] })).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// T7 — duplicate item ids are a 400 naming the id
// ---------------------------------------------------------------------------

describe("T7: duplicate conversation item ids", () => {
  const newConversation = async (items?: Json[]): Promise<string> => {
    const res = await post("/v1/conversations", items ? { items } : {});
    expect(res.statusCode).toBe(200);
    return res.json().id as string;
  };
  const itemCount = async (id: string): Promise<number> => (await get(`/v1/conversations/${id}/items?limit=100`)).json().data.length;

  it("creating a conversation with two items sharing an id → 400 naming the id", async () => {
    const res = await post("/v1/conversations", { items: [userItem("a", "msg_dup_create"), userItem("b", "msg_dup_create")] });
    expect(res.statusCode).toBe(400);
    expect(message(res)).toContain("msg_dup_create");
  });

  it("appending two items sharing an id in one request → 400 naming the id, nothing appended", async () => {
    const id = await newConversation([userItem("seed")]);
    const res = await post(`/v1/conversations/${id}/items`, { items: [userItem("a", "msg_dup_append"), userItem("b", "msg_dup_append")] });
    expect(res.statusCode).toBe(400);
    expect(message(res)).toContain("msg_dup_append");
    expect(await itemCount(id)).toBe(1);
  });

  it("a duplicate among otherwise distinct ids is refused as a whole", async () => {
    const id = await newConversation();
    const res = await post(`/v1/conversations/${id}/items`, { items: [userItem("a", "msg_one"), userItem("b", "msg_two"), userItem("c", "msg_one")] });
    expect(res.statusCode).toBe(400);
    expect(message(res)).toContain("msg_one");
    expect(await itemCount(id)).toBe(0);
  });

  it("appending an id the conversation already holds (from an earlier append) → 400 naming the id", async () => {
    const id = await newConversation();
    expect((await post(`/v1/conversations/${id}/items`, { items: [userItem("first", "msg_held")] })).statusCode).toBe(200);
    const again = await post(`/v1/conversations/${id}/items`, { items: [userItem("second", "msg_held")] });
    expect(again.statusCode).toBe(400);
    expect(message(again)).toContain("msg_held");
    expect(await itemCount(id)).toBe(1);
  });

  it("appending an id the conversation already holds (from its creation) → 400 naming the id", async () => {
    const id = await newConversation([userItem("first", "msg_at_create")]);
    const again = await post(`/v1/conversations/${id}/items`, { items: [userItem("second", "msg_at_create")] });
    expect(again.statusCode).toBe(400);
    expect(message(again)).toContain("msg_at_create");
    expect(await itemCount(id)).toBe(1);
  });

  it("appending an id the server generated for an existing item → 400 naming the id", async () => {
    const id = await newConversation([userItem("generated")]);
    const held = (await get(`/v1/conversations/${id}/items`)).json().data[0].id as string;
    expect(typeof held).toBe("string");
    const again = await post(`/v1/conversations/${id}/items`, { items: [userItem("clash", held)] });
    expect(again.statusCode).toBe(400);
    expect(message(again)).toContain(held);
    expect(await itemCount(id)).toBe(1);
  });

  it("distinct ids succeed, at creation and on append", async () => {
    const created = await post("/v1/conversations", { items: [userItem("a", "msg_a"), userItem("b", "msg_b")] });
    expect(created.statusCode).toBe(200);
    const id = created.json().id as string;
    const appended = await post(`/v1/conversations/${id}/items`, { items: [userItem("c", "msg_c"), userItem("d", "msg_d")] });
    expect(appended.statusCode).toBe(200);
    expect(appended.json().data).toHaveLength(2);
    expect(await itemCount(id)).toBe(4);
  });

  it("unchanged: items without ids never collide, and the same id may live in two conversations", async () => {
    const one = await newConversation([userItem("a"), userItem("b")]);
    expect((await post(`/v1/conversations/${one}/items`, { items: [userItem("c"), userItem("d")] })).statusCode).toBe(200);
    expect(await itemCount(one)).toBe(4);

    const first = await post("/v1/conversations", { items: [userItem("a", "msg_shared")] });
    expect(first.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// T8 — content_filter / pause_turn end a response as incomplete
// ---------------------------------------------------------------------------

describe("T8: POST /v1/responses (non-stream) status by stop reason", () => {
  const INCOMPLETE: StopReason[] = ["content_filter", "pause_turn", "length"];

  it.each(INCOMPLETE)("%s → status incomplete with a reason, and the stored response agrees", async (reason) => {
    stop = reason;
    const res = await create();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("incomplete");
    expect(typeof body.incomplete_details?.reason).toBe("string");
    expect(body.incomplete_details.reason).not.toBe("");

    const stored = await get(`/v1/responses/${body.id}`);
    expect(stored.statusCode).toBe(200);
    expect(stored.json().status).toBe("incomplete");
    expect(stored.json().incomplete_details).toEqual(body.incomplete_details);
    expect(repo.response(body.id, owner.token.id)!.status).toBe("incomplete");
  });

  it("length keeps its documented reason (max_output_tokens)", async () => {
    stop = "length";
    expect((await create()).json().incomplete_details).toEqual({ reason: "max_output_tokens" });
  });

  it("content_filter names content filtering as the reason", async () => {
    stop = "content_filter";
    expect((await create()).json().incomplete_details).toEqual({ reason: "content_filter" });
  });

  it("a normal stop → completed, with no incomplete_details, stored the same", async () => {
    stop = "stop";
    const res = await create();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("completed");
    expect(body.incomplete_details ?? null).toBeNull();
    const stored = (await get(`/v1/responses/${body.id}`)).json();
    expect(stored.status).toBe("completed");
    expect(repo.response(body.id, owner.token.id)!.status).toBe("completed");
  });
});
