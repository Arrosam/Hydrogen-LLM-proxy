import { describe, expect, it } from "vitest";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { parseService } from "../src/execution/definition";
import type { ModelServiceRow } from "../src/db/schema";
import type { HostedToolDefinition } from "../src/persistence/hostedToolRepo";
import { DISCOVERY_META, DISCOVERY_PAGE_SIZE, ToolDirectory } from "../src/discovery/toolDirectory";

const schema = { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false };
const local = (id = 1, name = "web_search", patch: Partial<HostedToolDefinition> = {}): HostedToolDefinition => ({
  id, name: `adapter_${id}`, description: "Search the library.", parameters: structuredClone(schema), enabled: true,
  serverTool: { name, resultType: "web_search_result", resultPath: "/results" }, ...patch,
});
const model = (patch: Record<string, unknown> = {}) => ({ steps: [{ model: "private-model", provider: "private-provider" }], ...patch });
const row = (id: number, definition = model(), enabled = true): ModelServiceRow => ({ id, name: `s${id}`, description: null,
  kind: "model_service", definition: parseService(definition), enabled, createdAt: new Date(0) });
function fixture(root = row(1), available: HostedToolDefinition[] = [local()]) {
  const services = new Map([[root.name, root]]), tools = new Map([[root.id, available]]);
  const directory = new ToolDirectory({ services: { getByName: name => services.get(name) }, tools: { definitionsForService: id => tools.get(id) ?? [] } }, "synthetic-cursor-key");
  return { root, services, tools, directory, list: (cursor?: string, keyId = 7) => directory.list(root, keyId, cursor) };
}
const names = (result: ReturnType<ToolDirectory["list"]>) => result.tools.map(tool => tool.name);
const error = (fn: () => unknown, reason?: string) => {
  try { fn(); throw new Error("Expected a protocol error"); }
  catch (e) { expect(e).toBeInstanceOf(McpError); if (reason) expect((e as McpError).data).toEqual({ reason }); return e as McpError; }
};

describe("policy decision table and truthful definitions (AC3, AC4)", () => {
  for (const mode of ["blacklist", "whitelist"] as const) for (const listed of [false, true]) for (const present of [false, true]) {
    it(`${mode}, listed=${listed}, local=${present}`, () => {
      const f = fixture(row(1, model({ serverToolPolicy: { mode, names: listed ? ["web_search"] : [] } })), present ? [local()] : []);
      const result = f.list();
      expect(names(result)).toEqual(present || mode === "whitelist" && listed ? ["web_search"] : []);
      if (result.tools.length) {
        const upstream = mode === "whitelist" && listed;
        expect(result.tools[0]._meta?.[DISCOVERY_META]).toMatchObject({ discoveryOnly: true, executable: false, schemaKnown: !upstream,
          provenance: upstream ? "admin-declared-upstream" : "hydrogen" });
        expect(result.tools[0].inputSchema).toEqual(upstream ? { type: "object", additionalProperties: true } : schema);
      }
      expect(result._meta?.[DISCOVERY_META]).toMatchObject({ mayOmitUnknownUpstreamTools: mode === "blacklist" });
    });
  }
  it("exposes original downstream names and the exact schema, without generated prefix or identity", () => {
    const f = fixture(); const entry = f.list().tools[0];
    expect(entry.name).toBe("web_search"); expect(entry.description).toContain("Search the library.");
    expect(entry.inputSchema).toEqual(schema); expect(entry.description).toContain("Discovery only");
    expect(JSON.stringify(entry)).not.toContain("provider_server_side_"); expect(JSON.stringify(entry)).not.toContain("adapter_1");
    entry.inputSchema.properties!.query = { type: "number" };
    expect(f.list().tools[0].inputSchema).toEqual(schema);
  });
  it("uses whole step policy replacement, not list merging, and collects later fallbacks", () => {
    const f = fixture(row(1, model({ serverToolPolicy: { mode: "whitelist", names: ["inherited"] }, steps: [
      { model: "m", provider: "p" }, { model: "m", provider: "p", serverToolPolicy: { mode: "blacklist", names: [] } },
      { model: "m", provider: "p", serverToolPolicy: { mode: "whitelist", names: ["later"] } },
    ] })), []);
    expect(names(f.list())).toEqual(["inherited", "later"]); expect(f.list()._meta?.[DISCOVERY_META]).toMatchObject({ mayOmitUnknownUpstreamTools: true });
    f.root.definition = parseService(model({ serverToolPolicy: { mode: "whitelist", names: ["inherited"] }, steps: [
      { model: "m", provider: "p", serverToolPolicy: { mode: "whitelist", names: [] } },
    ] }));
    expect(names(f.list())).toEqual([]);
  });
  it("excludes disabled, unbound and non-declarable tools and preserves names-only matching", () => {
    const f = fixture(row(1, model({ serverToolPolicy: { mode: "whitelist", names: ["web_search_20250305", "Web_Search"] } })),
      [local(), local(2, "disabled", { enabled: false }), local(3, "ordinary", { serverTool: undefined })]);
    expect(names(f.list())).toEqual(["Web_Search", "web_search", "web_search_20250305"]);
    expect(f.list().tools.find(t => t.name === "web_search")!._meta?.[DISCOVERY_META]).toMatchObject({ provenance: "hydrogen" });
  });
  it("warns that upstream placeholder schemas are unknown, unprobed and not callable contracts", () => {
    const entry = fixture(row(1, model({ serverToolPolicy: { mode: "whitelist", names: ["remote"] } })), []).list().tools[0];
    expect(entry.description).toMatch(/real parameter schema is unknown/); expect(entry.description).toMatch(/not a callable or validated contract/);
    expect(entry._meta?.[DISCOVERY_META]).toMatchObject({ upstreamProbed: false, validatedContract: false, inputSchemaIsPlaceholder: true });
  });
});

describe("stage unions and configuration failures (AC3, AC5, AC7)", () => {
  it("unions nested later stages, inline steps and inherited availability, deduplicating the same identity", () => {
    const f = fixture(row(1, { kind: "micro_agent", stages: [{ name: "first", service: "s2" }, { name: "later", service: "s3" }] }));
    f.services.set("s2", row(2)); f.tools.set(2, [local(), local(2, "first_only")]);
    f.services.set("s3", row(3, { kind: "micro_agent", stages: [{ name: "nested", steps: [{ model: "m", provider: "p" }] }] }));
    f.tools.set(3, [local(3, "later_only")]);
    expect(names(f.list())).toEqual(["first_only", "later_only", "web_search"]);
  });
  it("excludes tools:none stages and router-only availability", () => {
    const f = fixture(row(1, { kind: "micro_agent", stages: [{ name: "router" }, { name: "silent", service: "s2", tools: "none" },
      { name: "later", steps: [{ model: "m", provider: "p", serverToolPolicy: { mode: "whitelist", names: ["later"] } }] }] }), []);
    f.services.set("s2", row(2)); f.tools.set(2, [local()]); expect(names(f.list())).toEqual(["later"]);
    f.root.definition = parseService({ kind: "micro_agent", stages: [{ name: "router" }] }); f.tools.set(1, [local()]); expect(names(f.list())).toEqual([]);
  });
  it("validates broken references inside tools:none stages and their descendants", () => {
    const f = fixture(row(1, { kind: "micro_agent", stages: [{ name: "silent", service: "s2", tools: "none" }] }), []);
    error(() => f.list(), "unavailable_reference");
    f.services.set("s2", row(2, { kind: "micro_agent", stages: [{ name: "nested", service: "missing" }] }));
    error(() => f.list(), "unavailable_reference");
    f.services.set("missing", row(3)); f.tools.set(3, [local()]); expect(names(f.list())).toEqual([]);
  });
  it("returns empty tools for non-chat media, without pretending it offers upstream tools", () => {
    const result = fixture(row(1, model({ category: "stt" }))).list(); expect(names(result)).toEqual([]);
    expect(result._meta?.[DISCOVERY_META]).toMatchObject({ mayOmitUnknownUpstreamTools: false });
  });
  it.each(["missing", "disabled", "nonchat"])("fails a %s referenced service instead of returning empty", state => {
    const f = fixture(row(1, { kind: "micro_agent", stages: [{ name: "child", service: "s2" }] }), []);
    if (state !== "missing") f.services.set("s2", row(2, model(state === "nonchat" ? { category: "stt" } : {}), state !== "disabled"));
    expect(error(() => f.list(), "unavailable_reference").code).toBe(ErrorCode.InternalError);
  });
  it("fails cyclic graph references without exposing topology", () => {
    const f = fixture(row(1, { kind: "micro_agent", stages: [{ name: "private-stage", service: "s1" }] }));
    const e = error(() => f.list(), "invalid_service_graph"); expect(e.message).not.toMatch(/private-stage|s1/);
  });
  it.each([8, 9])("checks nesting boundary at %s referenced levels", depth => {
    const f = fixture(row(1, { kind: "micro_agent", stages: [{ name: "child", service: "s2" }] }), []);
    for (let id = 2; id <= depth + 1; id++) f.services.set(`s${id}`, row(id, id <= depth
      ? { kind: "micro_agent", stages: [{ name: "child", service: `s${id + 1}` }] } : model()));
    if (depth === 8) expect(names(f.list())).toEqual([]); else error(() => f.list(), "invalid_service_graph");
  });
  it("does not collapse two different local identities sharing one alias", () => {
    const f = fixture(row(1, { kind: "micro_agent", stages: [{ name: "a", service: "s2" }, { name: "b", service: "s3" }] }), []);
    f.services.set("s2", row(2)); f.services.set("s3", row(3)); f.tools.set(2, [local(2)]); f.tools.set(3, [local(3, "web_search", { parameters: { type: "object", properties: { term: { type: "number" } } } })]);
    error(() => f.list(), "catalog_conflict");
  });
  it("rejects duplicate aliases even when a whitelist bypass would hide the duplicates", () => {
    const f = fixture(row(1, model({ serverToolPolicy: { mode: "whitelist", names: ["web_search"] } })), [local(1), local(2)]);
    error(() => f.list(), "catalog_conflict");
  });
  it("rejects known-local versus unknown-upstream ambiguity across effective steps", () => {
    const f = fixture(row(1, model({ steps: [{ model: "m", provider: "p" }, { model: "m", provider: "p", serverToolPolicy: { mode: "whitelist", names: ["web_search"] } }] })));
    error(() => f.list(), "catalog_conflict");
  });
  it("deduplicates repeated admin declarations without claiming actual upstream schemas are known", () => {
    const f = fixture(row(1, model({ serverToolPolicy: { mode: "whitelist", names: ["remote", "remote"] }, steps: [{ model: "m", provider: "p" }, { model: "m", provider: "p" }] })), []);
    expect(names(f.list())).toEqual(["remote"]); expect(f.list().tools[0]._meta?.[DISCOVERY_META]).toMatchObject({ schemaKnown: false });
  });
  it.each(["definition", "schema", "repository"])("sanitizes malformed %s failures", kind => {
    const f = fixture();
    if (kind === "definition") f.root.definition = { steps: "private-prompt-secret" } as never;
    if (kind === "schema") f.tools.set(1, [local(1, "web_search", { parameters: { type: "object", properties: { private_secret: { type: "not-a-type" } } } })]);
    if (kind === "repository") f.tools.get = () => { throw new Error("https://private-adapter/ private-secret"); };
    const e = error(() => f.list(), "invalid_configuration"); expect(e.message).not.toMatch(/private|adapter|not-a-type/);
  });
});

const many = (count: number) => Array.from({ length: count }, (_, index) => local(index + 1, `tool_${String(index).padStart(3, "0")}`));
describe("stable/live paging and safe cursor boundaries (AC6)", () => {
  it.each([0, 1, 99, 100, 101, 200, 201])("pages %s entries deterministically", count => {
    const f = fixture(row(1), many(count)); const all: string[] = []; let cursor: string | undefined;
    do { const page = f.list(cursor); expect(page.tools.length).toBeLessThanOrEqual(DISCOVERY_PAGE_SIZE);
      expect(page).toEqual(f.list(cursor)); all.push(...names(page)); cursor = page.nextCursor;
    } while (cursor);
    expect(all).toEqual(many(count).map(t => t.serverTool!.name)); expect(new Set(all).size).toBe(count);
  });
  it("reads latest definitions, bindings and policy on each page, with no frozen recovery", () => {
    const f = fixture(row(1), many(101)); const cursor = f.list().nextCursor!;
    f.tools.set(1, [...many(100), local(1000, "z_latest", { description: "Latest description", parameters: { type: "object", required: ["new"] } })]);
    expect(names(f.list(cursor))).toEqual(["z_latest"]); expect(f.list(cursor).tools[0].description).toContain("Latest description");
    f.root.definition = parseService(model({ serverToolPolicy: { mode: "whitelist", names: ["z_latest"] } }));
    expect(f.list(cursor).tools[0]._meta?.[DISCOVERY_META]).toMatchObject({ schemaKnown: false });
    f.tools.set(1, []); expect(names(f.list(cursor))).toEqual([]); // Accepted live omission after shrink, no restart/compensation.
  });
  it("permits owner-accepted duplicates/omissions after edits before the live offset", () => {
    const f = fixture(row(1), many(101)); const first = f.list();
    f.tools.set(1, [local(999, "a_new"), ...many(101)]); expect(names(f.list(first.nextCursor))).toEqual(["tool_099", "tool_100"]);
    f.tools.set(1, many(102).slice(1)); expect(names(f.list(first.nextCursor))).toEqual(["tool_101"]);
  });
  it.each(["", "x", "x".repeat(81), "v2.100.x", "v1.0.x", "v1.-100.x", "v1.0100.x", "v1.100.0", "v1.9007199254741000." + "A".repeat(43)])("rejects invalid cursor %j", cursor => {
    expect(error(() => fixture().list(cursor)).code).toBe(ErrorCode.InvalidParams);
  });
  it("rejects tampering, cross-Key/target replay and noncanonical base64; exposes no Key or service IDs", () => {
    const f = fixture(row(1), many(101)); const cursor = f.list().nextCursor!;
    expect(cursor).toMatch(/^v1\.100\.[A-Za-z0-9_-]{43}$/);
    error(() => f.list(cursor, 8)); error(() => f.list(cursor.replace("100", "200")));
    error(() => f.directory.list(row(2), 7, cursor));
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const noncanonical = cursor.slice(0, -1) + alphabet[alphabet.indexOf(cursor.at(-1)!) + 1];
    error(() => f.list(noncanonical));
    const changedSecret = new ToolDirectory({ services: { getByName: () => undefined }, tools: { definitionsForService: () => [] } }, "rotated-synthetic-key");
    error(() => changedSecret.list(f.root, 7, cursor));
  });
});
