/** Combined SDK/admin/inference state transitions against the disposable fixture. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { DISCOVERY_META } from "../server/src/discovery/toolDirectory";
import pkg from "../server/package.json";

const dir = path.resolve(process.argv[2] ?? "../evidence");
const fixture = JSON.parse(fs.readFileSync(path.join(dir, "private-fixture.json"), "utf8")) as {
  baseUrl: string; token: string; scopedToken: string; password: string; serviceId: number; snapshotId: number; toolId: number;
  pagedSecondId: number; sha: string;
};
const { baseUrl, token } = fixture;
const ledger: Record<string, unknown>[] = [];
const clients: Client[] = [];
const record = (scenario: string, extra: Record<string, unknown> = {}) => { const row = { scenario, passed: true, ...extra }; ledger.push(row); console.log(JSON.stringify(row)); };
const login = await fetch(`${baseUrl}/admin/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: fixture.password }) });
assert.equal(login.status, 200); const cookie = login.headers.get("set-cookie")!.split(";")[0];
const admin = async (url: string, method = "GET", body?: unknown) => {
  const response = await fetch(`${baseUrl}/admin/api${url}`, { method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
};
const counters = async () => await (await fetch(`${baseUrl}/__qa/counters`)).json() as { modelRequests: { tools?: { type: string; name?: string }[] }[]; adapterRequests: { tool?: string }[]; databaseChanges: number };
const reset = async () => assert.equal((await fetch(`${baseUrl}/__qa/reset`, { method: "POST" })).status, 200);
const request = async (model: string, extra: Record<string, unknown> = {}) => {
  const response = await fetch(`${baseUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ model, input: "Synthetic aggregate test", ...extra }) });
  return { status: response.status, body: await response.json() };
};
const connect = async (name: string, key = token) => {
  const client = new Client({ name: "aggregate-preview-validation", version: "1.0.0" }); clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/v1/services/${encodeURIComponent(name)}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return client;
};
const noDispatch = async () => { const n = await counters(); assert.equal(n.modelRequests.length, 0); assert.equal(n.adapterRequests.length, 0); return n; };
const toolMeta = (tool: { _meta?: Record<string, unknown> }) => tool._meta?.[DISCOVERY_META];
const serviceById = async (id: number) => (await admin("/services")).services.find((service: { id: number }) => service.id === id);
const original = await serviceById(fixture.snapshotId);
const initialPrefix = (await admin("/settings/server-tool-name-prefix")).prefix;
let pagedOriginal: unknown;
try {
  await reset(); const before = await counters(); const catalog = await connect("Integration UI fixture");
  assert.deepEqual(catalog.getServerVersion(), { name: "hydrogen-tool-discovery", version: pkg.version });
  const bypass = await catalog.listTools(); assert.equal(bypass.tools[0].name, "web_search");
  assert.deepEqual(toolMeta(bypass.tools[0]), { discoveryOnly: true, executable: false, provenance: "admin-declared-upstream", schemaKnown: false, inputSchemaIsPlaceholder: true, validatedContract: false, upstreamProbed: false });
  await assert.rejects(catalog.callTool({ name: "web_search", arguments: {} }), { code: ErrorCode.MethodNotFound });
  assert.deepEqual(await catalog.ping(), {}); const after = await noDispatch(); assert.equal(after.databaseChanges, before.databaseChanges);
  record("combined SDK negotiation, unverified whitelist placeholder, rejected call: zero model/adapter/DB changes");
  await reset(); const none = await request("Integration UI fixture"); assert.equal(none.status, 200);
  let n = await counters(); assert.equal(n.modelRequests.length, 1); assert.equal(n.adapterRequests.length, 0); assert(!n.modelRequests[0].tools?.length);
  record("UI-selected binding without client declarations emits no tools", { modelRequests: 1, adapterRequests: 0 });
  await reset(); const client = await request("Integration UI fixture", { tools: [{ type: "function", name: "web_search", parameters: { type: "object" } }] });
  assert.equal(client.status, 200); assert(client.body.output.some((item: { type: string; name?: string }) => item.type === "function_call" && item.name === "web_search"));
  n = await counters(); assert.equal(n.modelRequests.length, 1); assert.equal(n.adapterRequests.length, 0);
  record("ordinary same-name client function remains client-owned", { modelRequests: 1, adapterRequests: 0 });
  await reset(); const frozen = await request("Snapshot fixture", { tools: [{ type: "web_search" }] }); assert.equal(frozen.status, 200); assert.equal(frozen.body.status, "incomplete");
  n = await counters(); assert.equal(n.adapterRequests.length, 0); assert.equal(n.modelRequests[0].tools![0].name, "provider_server_side_preview_search");
  const snapshotClient = await connect("Snapshot fixture"); const known = await snapshotClient.listTools(); assert.equal((toolMeta(known.tools[0]) as { schemaKnown: boolean }).schemaKnown, true);
  record("saved pending inference captures original prefix, schema and exact executor while discovery lists known schema");
  await admin("/settings/server-tool-name-prefix", "PUT", { prefix: "" });
  await admin(`/services/${fixture.snapshotId}`, "PATCH", { steps: { ...original.steps, hostedTools: { maxRounds: 8 }, serverToolPolicy: { mode: "whitelist", names: ["web_search"] } }, toolIds: [] });
  await reset(); const fresh = await snapshotClient.listTools(); assert.equal((toolMeta(fresh.tools[0]) as { schemaKnown: boolean }).schemaKnown, false);
  record("same initialized discovery client observes current policy/unbound placeholder after configuration edit");
  const resumed = await request("Snapshot fixture", { previous_response_id: frozen.body.id, input: "Continue original pending work", tools: [] });
  assert.equal(resumed.status, 200); assert.equal(resumed.body.status, "completed"); n = await counters(); assert.equal(n.adapterRequests.length, 1); assert.equal(n.adapterRequests[0].tool, "preview_search");
  assert(JSON.stringify(n.modelRequests).includes("provider_server_side_preview_search"));
  record("old saved pending inference executes original adapter once after live policy/binding/prefix edits", { adapterRequests: 1 });
  await reset(); const third = await request("Snapshot fixture", { previous_response_id: resumed.body.id, input: "New turn", tools: [] }); assert.equal(third.status, 200); n = await counters(); assert.equal(n.adapterRequests.length, 0);
  assert(!JSON.stringify(third.body).includes("hydrogenTool")); record("later continuation does not replay completed private work or expose provenance", { adapterRequests: 0 });
  await reset(); const newSession = await request("Snapshot fixture", { tools: [{ type: "web_search" }] }); assert.equal(newSession.status, 200); n = await counters(); assert.equal(n.adapterRequests.length, 0); assert.equal(n.modelRequests[0].tools![0].type, "web_search");
  record("new inference session observes current native bypass instead of frozen local executor", { adapterRequests: 0 });
  await admin(`/services/${fixture.snapshotId}`, "PATCH", { steps: { ...original.steps, hostedTools: { maxRounds: 8 } }, toolIds: [fixture.toolId] });
  await reset(); const empty = await request("Snapshot fixture", { tools: [{ type: "web_search" }] }); assert.equal(empty.status, 200); n = await counters(); assert.equal(n.modelRequests[0].tools![0].name, "preview_search"); assert.equal(n.adapterRequests.length, 1);
  record("explicit empty global prefix executes current local binding with unchanged stored adapter name", { adapterRequests: 1 });
  await admin("/settings/server-tool-name-prefix", "PUT", { prefix: initialPrefix });
  await reset(); const started = Date.now(); const fallback = await request("Fallback fixture", { tools: [{ type: "web_search" }, { type: "web_fetch" }] }); assert.equal(fallback.status, 200);
  n = await counters(); assert.equal(n.adapterRequests.length, 1); assert.equal(n.modelRequests.length, 2);
  const stages = await (await fetch(`${baseUrl}/__qa/stages`)).json(); assert(stages.includes(1) && stages.includes(2)); assert(Date.now() - started < 3000);
  record("typed policy mismatch advances sequentially without configured 600000ms retry; same local owner executes once", { stages, modelRequests: 2, adapterRequests: 1 });
  await reset(); const collision = await request("Snapshot fixture", { tools: [{ type: "web_search" }, { type: "function", name: "provider_server_side_preview_search", parameters: { type: "object" } }] });
  assert.equal(collision.status, 400); assert.equal(collision.body.error.code, "hydrogen_tool_name_conflict"); await noDispatch();
  record("actual emitted client/local collision is terminal before all dispatch");
  await reset(); await assert.rejects(connect("Snapshot fixture", fixture.scopedToken)); await noDispatch(); record("existing scoped Key cannot initialize a different target after integration");
  const paged = await connect("Paged discovery agent"); const first = await paged.listTools(); assert.equal(first.tools.length, 100); assert(first.nextCursor);
  const second = await paged.listTools({ cursor: first.nextCursor }); assert.equal(second.tools.length, 5); assert.equal(second.nextCursor, undefined);
  assert.equal(new Set([...first.tools, ...second.tools].map(t => t.name)).size, 105);
  record("MCP unions two normally bounded children into deterministic 100+5 catalog pages");
  pagedOriginal = await serviceById(fixture.pagedSecondId);
  await admin(`/services/${fixture.pagedSecondId}`, "PATCH", { toolIds: [] }); const changed = await paged.listTools({ cursor: first.nextCursor }); assert.equal(changed.tools.length, 0);
  record("next discovery page rereads changed bindings; no pagination snapshot compensation");
  const conflictSource = await serviceById(fixture.pagedSecondId);
  await admin(`/services/${fixture.pagedSecondId}`, "PATCH", { steps: { ...conflictSource.steps, serverToolPolicy: { mode: "whitelist", names: ["web_search"] } } });
  await assert.rejects(paged.listTools(), (error: unknown) => { const e = error as { code?: number; data?: { reason?: string } }; return e.code === ErrorCode.InternalError && e.data?.reason === "catalog_conflict"; });
  await noDispatch(); record("combined multi-stage known local versus upstream alias conflict returns sanitized catalog_conflict");
} finally {
  if (pagedOriginal) { const value = pagedOriginal as { steps: unknown; toolIds: number[] }; await admin(`/services/${fixture.pagedSecondId}`, "PATCH", { steps: value.steps, toolIds: value.toolIds }); }
  await admin(`/services/${fixture.snapshotId}`, "PATCH", { steps: original.steps, toolIds: original.toolIds });
  await admin("/settings/server-tool-name-prefix", "PUT", { prefix: initialPrefix });
  for (const client of clients) await client.close();
  fs.writeFileSync(path.join(dir, "aggregate-http-sdk.json"), JSON.stringify({ sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), fixtureSha: fixture.sha, version: pkg.version,
    verifiedAt: new Date().toISOString(), passed: ledger.length, scenarios: ledger }, null, 2));
}
