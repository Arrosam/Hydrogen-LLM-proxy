/**
 * End-to-end proof of the server-side tool window: a client that DECLARES a
 * provider-executed tool receives the call and its result, sourced from the
 * adapter's own JSON, while a client that does not stays byte-identical.
 *
 * The adapter here is a fixture; what it returns is its own business. The proxy
 * only knows where the entry array sits, which is exactly the contract an
 * operator configures.
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
let owner: ReturnType<TokenRepo["create"]>, adapter: ReturnType<typeof vi.fn>;
let outputs: ContentPart[][], seen: Request[];
const headers = () => ({ authorization: `Bearer ${owner.secret}` });

/** What the operator's adapter returns: its own shape, entries under /results. */
const ADAPTER_BODY = JSON.stringify({
  engine: "fixture",
  results: [
    { url: "https://example.com/a", title: "A", snippet: "first" },
    { url: "https://example.com/b", title: "B", snippet: "second" },
  ],
});

const declare = (tools: unknown[]) => ({ model: "svc", max_tokens: 40, messages: [{ role: "user", content: "q" }], tools });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-server-tools-")); db = openDatabase(dir);
  const key = Buffer.alloc(32, 2);
  tokens = new TokenRepo(db.db, key); owner = tokens.create({ name: "owner" });
  services = new ServiceRepo(db.db); tools = new HostedToolRepo(db.db, key); repo = new ResponseRepo(db.db, () => 0);
  const serviceId = services.create({ name: "svc", definition: { timeoutMs: 1000, steps: [{ model: "m", provider: "p" }] } }).id;
  outputs = []; seen = [];
  const invoke = async (request: Request): Promise<Invocation> => {
    seen.push(request);
    const content = outputs.shift() ?? [{ type: "text", text: "done" }];
    return { attempts: 1, attemptPath: [], result: { ok: true, value: { family: "openai_responses", providerName: "p", modelName: "m", upstreamModel: "up", upstreamRequest: {},
      response: buildResponse("openai_responses", { id: "upstream-id", model: "up", created: 1, content, stopReason: content.some(p => p.type === "tool_use") ? "tool_use" : "stop", usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } }) } } };
  };
  adapter = vi.fn(async () => ({ status: 200, headers: {}, body: Readable.from([ADAPTER_BODY]) }));
  const deps = { services, tokens, transport: { postStream: adapter }, factory: { forRow: () => ({ executor: { invoke, stream: async (request: Request) => {
    const inv = await invoke(request); if (!inv.result.ok) throw new Error("fixture");
    const data = inv.result.value.response.data();
    async function* events() { for await (const event of fabricateStream(data, Infinity)) yield event; }
    return { ...inv, result: { ok: true, value: { ...inv.result.value, dropReasoning: false, events: events() } } };
  } } }) }, logger: { capture: JSON.stringify, record: vi.fn() }, usage: new UsageMeter(tokens), activeRequests: new ActiveRequestRegistry() } as unknown as ProxyDeps;
  app = Fastify(); const controller = new ResponsesController(deps, repo, tools);
  controller.register(app); new ProxyController(deps, controller).register(app);

  // The tool opts into the client protocol; the contract names the block type
  // and where the adapter keeps its entries.
  const tool = tools.create(HttpToolSchema.parse({
    name: "search",
    description: "Search the web",
    parameters: { type: "object", properties: { queries: { type: "array", items: { type: "string" } } }, required: ["queries"] },
    url: "https://adapter.test/search",
    bodyTemplate: { arguments: "{{arguments}}" },
    serverTool: { name: "web_search", resultType: "web_search_result", resultPath: "/results" },
  }));
  tools.bind(serviceId, [tool.id]);
  services.update(serviceId, { definition: { timeoutMs: 1000, steps: [{ model: "m", provider: "p" }], hostedTools: HostedToolOptionsSchema.parse({}) } });
});
afterEach(async () => { await app.close(); db.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true }); });

/** The model is offered the BOUND tool, so that is the name it calls. */
const searchCall: ContentPart = { type: "tool_use", id: "toolu_1", name: "search", input: { queries: ["tokyo"] } };

describe("server-side tool round trip over HTTP", () => {
  it("returns the provider call and its adapter-sourced result to a declaring client", async () => {
    outputs.push([searchCall], [{ type: "text", text: "answer" }]);
    const response = await app.inject({ method: "POST", url: "/v1/messages", headers: headers(), payload: declare([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]) });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const types = (body.content as Record<string, unknown>[]).map(b => b.type);
    expect(types).toEqual(["server_tool_use", "web_search_result", "text"]);

    expect(body.content[0]).toEqual({ type: "server_tool_use", id: "toolu_1", name: "web_search", input: { queries: ["tokyo"] } });
    // Entries pass through verbatim; only the enclosing block carries the envelope.
    expect(body.content[1]).toEqual({
      type: "web_search_result",
      tool_use_id: "toolu_1",
      content: [{ url: "https://example.com/a", title: "A", snippet: "first" }, { url: "https://example.com/b", title: "B", snippet: "second" }],
    });
    expect(body.content[2]).toEqual({ type: "text", text: "answer" });
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("hands the model the bound tool's real schema, not the client's parameterless declaration", async () => {
    outputs.push([searchCall], [{ type: "text", text: "answer" }]);
    await app.inject({ method: "POST", url: "/v1/messages", headers: headers(), payload: declare([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]) });
    // The declaration carries no parameters, so without the rewrite the model
    // would be handed a tool it could never call.
    const offered = seen[0]!.tools!;
    expect(offered.map(t => t.name)).toEqual(["search"]);
    expect(offered[0]!.parameters).toMatchObject({ properties: { queries: { type: "array" } } });
  });

  it("leaves a client that does not declare a server tool unchanged", async () => {
    outputs.push([{ type: "text", text: "plain" }]);
    const response = await app.inject({ method: "POST", url: "/v1/messages", headers: headers(), payload: declare([{ name: "my_fn", input_schema: { type: "object", properties: {} } }]) });
    expect(response.statusCode).toBe(200);
    const types = (response.json().content as Record<string, unknown>[]).map(b => b.type);
    expect(types).toEqual(["text"]);
    expect(adapter).not.toHaveBeenCalled();
  });

  it("flags a broken adapter result instead of reporting an empty search", async () => {
    adapter.mockResolvedValueOnce({ status: 200, headers: {}, body: Readable.from(["{}"]) });
    outputs.push([searchCall], [{ type: "text", text: "answer" }]);
    const response = await app.inject({ method: "POST", url: "/v1/messages", headers: headers(), payload: declare([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]) });
    const body = response.json();
    expect(body.content[1]).toMatchObject({ type: "web_search_result", content: [], is_error: true });
  });
});
