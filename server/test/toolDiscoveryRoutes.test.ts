import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { DISCOVERY_META } from "../src/discovery/toolDirectory";
import { hostedTools, modelServices, tokens as tokenTable } from "../src/db/schema";
import { hashToken } from "../src/security/tokens";
import { parseService } from "../src/execution/definition";
import { createDiscoveryHarness, modelDefinition, SYNTHETIC_KEY, SYNTHETIC_SECRET, type DiscoveryHarness } from "./fixtures/discoveryHarness";

let f: DiscoveryHarness;
beforeEach(async () => { f = await createDiscoveryHarness(); });
afterEach(async () => { await f?.close(); vi.restoreAllMocks(); });
const names = (result: { tools: { name: string }[] }) => result.tools.map(tool => tool.name);
const expectNoExecution = () => expect(f.counts).toEqual({ upstreamHttp: 0, modelFactory: 0, upstreamTransport: 0, catalogResolve: 0, quotaReserve: 0, usage: 0, requestLog: 0, decryptingToolRead: 0 });

describe("real SDK initialization/list/call compatibility (AC1, AC2, AC4, AC8)", () => {
  it("initializes, lists exact saved schema, rejects calls and continues listing without inference or DB writes", async () => {
    const tool = f.addTool(); f.tools.bind(f.root.id, [tool.id]); const before = f.fingerprint(), changes = f.changes();
    const client = await f.connect();
    expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: false } });
    expect(client.getServerVersion()).toEqual({ name: "hydrogen-tool-discovery", version: "2.2.3" });
    const result = await client.listTools(); expect(names(result)).toEqual(["web_search"]); expect(result.tools[0].inputSchema).toEqual(tool.parameters);
    expect(result.tools[0]._meta?.[DISCOVERY_META]).toMatchObject({ discoveryOnly: true, executable: false });
    await expect(client.callTool({ name: "web_search", arguments: { query: "test" } })).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
    await expect(client.callTool({ name: "unknown", arguments: {} })).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
    expect(names(await client.listTools())).toEqual(["web_search"]); expect(await client.ping()).toEqual({});
    expect(f.fingerprint()).toBe(before); expect(f.changes()).toBe(changes); expectNoExecution(); expect(f.tokens.get(f.owner.id)).toMatchObject({ usedRequests: 0, usedTokens: 0 });
  });
  it("preserves rich draft-7 schemas and a 64-character downstream name through the official client", async () => {
    const parameters = { $schema: "http://json-schema.org/draft-07/schema#", type: "object", definitions: { query: { type: "string", minLength: 1, maxLength: 64 } },
      properties: { query: { $ref: "#/definitions/query" }, flags: { type: "array", items: { type: "object", properties: { flag: { type: "boolean", default: false } }, required: ["flag"] }, maxItems: 3 },
        mode: { enum: ["fast", "full"], default: "fast" } }, required: ["query"], additionalProperties: false,
      allOf: [{ properties: { query: { maxLength: 64 } } }], anyOf: [{ required: ["mode"] }, { required: ["flags"] }],
      oneOf: [{ properties: { mode: { const: "fast" } } }, { properties: { mode: { const: "full" } } }], "x-example": { public: true } };
    const name = "t".repeat(64), tool = f.addTool(name, { name: "rich_schema_adapter", parameters }); f.tools.bind(f.root.id, [tool.id]);
    const client = await f.connect(), result = await client.listTools(); expect(names(result)).toEqual([name]); expect(result.tools[0].inputSchema).toEqual(parameters); expectNoExecution();
  });
  it("filters actual disabled/unbound/no-contract repository tools and sees enabled/deleted edits", async () => {
    const enabled = f.addTool(), disabled = f.addTool("disabled", { enabled: false }), ordinary = f.addTool("ordinary", { serverTool: undefined });
    f.addTool("unbound"); f.tools.bind(f.root.id, [enabled.id, disabled.id, ordinary.id]);
    const client = await f.connect(); expect(names(await client.listTools())).toEqual(["web_search"]);
    f.db.update(hostedTools).set({ enabled: true }).where(eq(hostedTools.id, disabled.id)).run();
    expect(names(await client.listTools())).toEqual(["disabled", "web_search"]);
    f.tools.delete(enabled.id); expect(names(await client.listTools())).toEqual(["disabled"]);
    f.tools.bind(f.root.id, [ordinary.id]); expect((await client.listTools()).tools).toEqual([]); expectNoExecution();
  });
  it.each(["chat", "ocr", "image", "video", "tts", "stt", "embedding", "rerank", "classification"])("lists category %s using the real client", async category => {
    const tool = f.addTool(); f.tools.bind(f.root.id, [tool.id]); f.services.update(f.root.id, { definition: modelDefinition({ category }) });
    const client = await f.connect(), result = await client.listTools(); expect(names(result)).toEqual(["chat", "ocr"].includes(category) ? ["web_search"] : []);
    expect(result._meta?.[DISCOVERY_META]).toMatchObject({ mayOmitUnknownUpstreamTools: ["chat", "ocr"].includes(category) }); expectNoExecution();
  });
  it("accepts upstream format placeholders through SDK validation and still rejects their calls", async () => {
    const tool = f.addTool(); f.tools.bind(f.root.id, [tool.id]);
    f.services.update(f.root.id, { definition: modelDefinition({ serverToolPolicy: { mode: "whitelist", names: ["web_search", "remote"] } }) });
    const before = f.fingerprint(), client = await f.connect(), result = await client.listTools();
    expect(names(result)).toEqual(["remote", "web_search"]);
    for (const entry of result.tools) {
      expect(entry.inputSchema).toEqual({ type: "object", additionalProperties: true });
      expect(entry._meta?.[DISCOVERY_META]).toMatchObject({ provenance: "admin-declared-upstream", schemaKnown: false, inputSchemaIsPlaceholder: true, validatedContract: false });
      await expect(client.callTool({ name: entry.name, arguments: { arbitrary: true } })).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
    }
    expect(f.fingerprint()).toBe(before); expectNoExecution();
  });
  it("paginates through the actual SDK deterministically and reads edits on the next page", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => f.addTool(`t_${String(index).padStart(3, "0")}`).id); f.tools.bind(f.root.id, ids);
    const client = await f.connect(), first = await client.listTools(); expect(first.tools).toHaveLength(100); expect(first.nextCursor).toBeTruthy();
    expect(await client.listTools()).toEqual(first);
    const second = await client.listTools({ cursor: first.nextCursor }); expect(names(second)).toEqual(["t_100"]); expect(second.nextCursor).toBeUndefined();
    f.db.update(hostedTools).set({ config: { ...f.tools.get(ids[100])!.config, description: "Edited schema and description", parameters: { type: "object", properties: { changed: { type: "boolean" } } } } }).where(eq(hostedTools.id, ids[100])).run();
    const latest = await client.listTools({ cursor: first.nextCursor }); expect(latest.tools[0].description).toContain("Edited schema");
    expect(latest.tools[0].inputSchema).toEqual({ type: "object", properties: { changed: { type: "boolean" } } });
    f.tools.bind(f.root.id, []); expect((await client.listTools({ cursor: first.nextCursor })).tools).toEqual([]); expectNoExecution();
  });
  it("collects later named/inline/nested stages through the real client and persisted bindings", async () => {
    const child = f.services.create({ name: "child", definition: modelDefinition({ serverToolPolicy: { mode: "whitelist", names: ["late_remote"] } }) });
    const tool = f.addTool("late_local"); f.tools.bind(child.id, [tool.id]);
    f.services.update(f.root.id, { definition: parseService({ kind: "micro_agent", stages: [
      { name: "early", steps: [{ model: "m", provider: "p", serverToolPolicy: { mode: "whitelist", names: [] } }] },
      { name: "later", service: "child" },
    ] }) });
    const client = await f.connect(); expect(names(await client.listTools())).toEqual(["late_local", "late_remote"]); expectNoExecution();
  });
});

describe("Key isolation, current authorization and empty/error distinctions (AC1, AC7)", () => {
  it.each(["missing", "unknown", "disabled", "expired"])("rejects %s Key with a protocol error before definition reads", async state => {
    const read = vi.spyOn(f.tools, "definitionsForService");
    if (state === "disabled") f.tokens.update(f.owner.id, { enabled: false });
    if (state === "expired") f.tokens.update(f.owner.id, { expiresAt: Date.now() - 1000 });
    const result = await f.rpc("tools/list", undefined, { key: state === "missing" ? null : state === "unknown" ? "synthetic-wrong-key" : SYNTHETIC_KEY });
    expect(result.status).toBe(401); expect(result.body).toMatchObject({ jsonrpc: "2.0", id: 7, error: { code: -32001 } });
    expect(result.body.result).toBeUndefined(); expect(read).not.toHaveBeenCalled(); expectNoExecution();
  });
  it.each(["missing", "disabled", "unauthorized"])("rejects %s target service distinctly from empty", async state => {
    const other = f.services.create({ name: "other", definition: modelDefinition(), enabled: state !== "disabled" });
    f.tools.bind(other.id, [f.addTool("other_private_tool").id]); const read = vi.spyOn(f.tools, "definitionsForService");
    const result = await f.rpc("tools/list", undefined, { service: state === "missing" ? "missing" : "other" });
    expect(result.status).toBe(state === "unauthorized" ? 403 : 404); expect(result.body.error).toBeTruthy(); expect(result.body.result).toBeUndefined();
    expect(JSON.stringify(result.body)).not.toContain("other_private_tool"); expect(read).not.toHaveBeenCalled(); expectNoExecution();
  });
  it("permits all-service null/empty scopes and x-api-key authentication without consuming exhausted quota", async () => {
    const other = f.services.create({ name: "other", definition: modelDefinition() });
    for (const scopeServices of [null, []]) {
      f.tokens.update(f.owner.id, { scopeServices });
      const result = await f.rpc("tools/list", undefined, { service: other.name, key: null, headers: { "x-api-key": SYNTHETIC_KEY } });
      expect(result.status).toBe(200); expect(result.body.result.tools).toEqual([]);
    }
    expectNoExecution();
  });
  it.each(["key-disable", "key-expire", "scope-revoke", "service-disable", "service-delete"])("revalidates %s after initialization", async change => {
    const client = await f.connect(); expect((await client.listTools()).tools).toEqual([]);
    if (change === "key-disable") f.tokens.update(f.owner.id, { enabled: false });
    if (change === "key-expire") f.tokens.update(f.owner.id, { expiresAt: Date.now() - 1000 });
    if (change === "scope-revoke") f.tokens.update(f.owner.id, { scopeServices: [f.root.id + 1] });
    if (change === "service-disable") f.services.update(f.root.id, { enabled: false });
    if (change === "service-delete") f.services.delete(f.root.id);
    await expect(client.listTools()).rejects.toBeDefined(); expectNoExecution();
  });
  it("revalidates Key/target bindings on subsequent page HTTP requests", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => f.addTool(`t_${String(index).padStart(3, "0")}`).id); f.tools.bind(f.root.id, ids);
    const client = await f.connect(), first = await client.listTools();
    const otherKey = "synthetic-other-existing-key";
    f.db.insert(tokenTable).values({ name: "other-key", keyPrefix: "synthetic", keyHash: hashToken(otherKey), scopeServices: [f.root.id] }).run();
    const other = await f.connect("svc", otherKey);
    await expect(other.listTools({ cursor: first.nextCursor })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    f.tokens.update(f.owner.id, { enabled: false }); await expect(client.listTools({ cursor: first.nextCursor })).rejects.toBeDefined(); expectNoExecution();
  });
  it("returns valid empty list but explicit errors for malformed configuration and broken references", async () => {
    const client = await f.connect(); expect((await client.listTools()).tools).toEqual([]);
    f.db.update(modelServices).set({ definition: { steps: "private-secret" } as never }).where(eq(modelServices.id, f.root.id)).run();
    await expect(client.listTools()).rejects.toMatchObject({ code: ErrorCode.InternalError, data: { reason: "invalid_configuration" } });
    f.services.update(f.root.id, { definition: parseService({ kind: "micro_agent", stages: [{ name: "private", service: "missing-private-reference" }] }) });
    await expect(client.listTools()).rejects.toMatchObject({ code: ErrorCode.InternalError, data: { reason: "unavailable_reference" } });
    expectNoExecution();
  });
  it("returns explicit ambiguity errors over SDK without lossy schema substitution", async () => {
    const a = f.services.create({ name: "a", definition: modelDefinition() }), b = f.services.create({ name: "b", definition: modelDefinition() });
    f.tools.bind(a.id, [f.addTool("web_search", { name: "adapter_a" }).id]);
    f.tools.bind(b.id, [f.addTool("web_search", { name: "adapter_b", parameters: { type: "object", properties: { term: { type: "number" } } } }).id]);
    f.services.update(f.root.id, { definition: parseService({ kind: "micro_agent", stages: [{ name: "a", service: "a" }, { name: "b", service: "b" }] }) });
    const client = await f.connect(); await expect(client.listTools()).rejects.toMatchObject({ code: ErrorCode.InternalError, data: { reason: "catalog_conflict" } }); expectNoExecution();
  });
});

describe("MCP HTTP errors and non-execution/data boundaries (AC2, AC8, AC9)", () => {
  it.each(["GET", "DELETE"])("returns authenticated %s method-not-supported instead of opening a stream", async method => {
    const response = await fetch(f.endpoint(), { method, headers: { Authorization: `Bearer ${SYNTHETIC_KEY}` } });
    expect(response.status).toBe(405); expect(response.headers.get("Allow")).toBe("POST"); expect((await response.json()).error.code).toBe(ErrorCode.MethodNotFound); expectNoExecution();
  });
  it("rejects browser Origin, malformed JSON and oversized bodies using MCP errors", async () => {
    const origin = await f.rpc("tools/list", undefined, { headers: { Origin: "https://outside.test" } }); expect(origin.status).toBe(403); expect(origin.body.error.code).toBe(-32003);
    for (const [body, status] of [["{", 400], [JSON.stringify({ padding: "a".repeat(65_536) }), 413]] as const) {
      const response = await fetch(f.endpoint(), { method: "POST", headers: { Authorization: `Bearer ${SYNTHETIC_KEY}`, "Content-Type": "application/json" }, body });
      expect(response.status).toBe(status); expect(await response.json()).toMatchObject({ jsonrpc: "2.0", error: { code: ErrorCode.ParseError } });
    }
    expectNoExecution();
  });
  it("returns SDK errors for malformed protocol, wrong Accept/version, unsupported methods and invalid cursors", async () => {
    expect((await f.rpc("tools/list", undefined, { headers: { Accept: "text/plain" } })).status).toBe(406);
    expect((await f.rpc("tools/list", undefined, { headers: { "MCP-Protocol-Version": "bogus" } })).status).toBe(400);
    for (const [method, params, code] of [["list_service_tools", undefined, ErrorCode.MethodNotFound], ["resources/list", undefined, ErrorCode.MethodNotFound],
      ["tools/call", { name: "web_search", arguments: {} }, ErrorCode.MethodNotFound], ["tools/call", { name: 7 }, ErrorCode.InvalidParams],
      ["tools/list", { cursor: "bad" }, ErrorCode.InvalidParams], ["tools/list", { cursor: 7 }, ErrorCode.InvalidParams]] as const) {
      const result = await f.rpc(method, params); expect(result.body.error.code).toBe(code); expect(result.body.result).toBeUndefined();
    }
    expectNoExecution();
  });
  it.each([{ body: [] }, { body: [{ jsonrpc: "2.0", id: 7, method: "tools/list" }] }, { body: [
    { jsonrpc: "2.0", id: 7, method: "tools/list" }, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "web_search" } },
  ] }])("rejects a top-level batch %j before dispatch", async ({ body }) => {
    const read = vi.spyOn(f.tools, "definitionsForService"), before = f.fingerprint();
    const response = await fetch(f.endpoint(), { method: "POST", headers: { Authorization: `Bearer ${SYNTHETIC_KEY}`,
      "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify(body) });
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: ErrorCode.InvalidRequest } });
    expect(read).not.toHaveBeenCalled(); expect(f.fingerprint()).toBe(before); expectNoExecution();
  });
  it("still accepts a single initialized notification with 202 and no response body", async () => {
    const response = await fetch(f.endpoint(), { method: "POST", headers: { Authorization: `Bearer ${SYNTHETIC_KEY}`,
      "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(response.status).toBe(202); expect(await response.text()).toBe(""); expectNoExecution();
  });
  it("uses definition projections without decrypting credentials, and never serializes private config", async () => {
    const tool = f.addTool(); f.tools.bind(f.root.id, [tool.id]);
    f.db.update(hostedTools).set({ headersSecret: { ciphertext: "invalid-synthetic-ciphertext", iv: "invalid", tag: "invalid" } }).where(eq(hostedTools.id, tool.id)).run();
    const decrypt = vi.spyOn(f.tools, "materialize").mockImplementation(() => { throw new Error(SYNTHETIC_SECRET); });
    const before = f.fingerprint(), client = await f.connect(), result = await client.listTools();
    expect(names(result)).toEqual(["web_search"]); expect(decrypt).not.toHaveBeenCalled();
    const output = JSON.stringify(result);
    for (const secret of [SYNTHETIC_SECRET, SYNTHETIC_KEY, "private-adapter", "private-provider", "private-model", "private-internal-prompt", "private-body-template", "invalid-synthetic-ciphertext", "provider_server_side_"]) expect(output).not.toContain(secret);
    expect(f.fingerprint()).toBe(before); expectNoExecution();
  });
  it("sanitizes repository errors and sends non-cacheable responses through the real app", async () => {
    vi.spyOn(f.tools, "definitionsForService").mockImplementation(() => { throw new Error(`${SYNTHETIC_SECRET} https://private-adapter/ internal-prompt`); });
    const result = await f.rpc("tools/list"); expect(result.body.error.code).toBe(ErrorCode.InternalError); expect(result.body.result).toBeUndefined();
    expect(JSON.stringify(result.body)).not.toMatch(/credential|private-adapter|internal-prompt/);
    expect(result.headers.get("Cache-Control")).toBe("no-store"); expect(result.headers.get("X-Content-Type-Options")).toBe("nosniff"); expectNoExecution();
  });
});
