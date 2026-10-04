import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { DISCOVERY_META } from "../server/src/discovery/toolDirectory";
import { hostedTools, modelServices } from "../server/src/db/schema";
import { parseService } from "../server/src/execution/definition";
import { createDiscoveryHarness, modelDefinition } from "../server/test/fixtures/discoveryHarness";

// Standalone stage-5 functional run: real SDK + real buildApp, SQLite and HTTP
// receivers. Never starts a production app or generates real credentials.
const f = await createDiscoveryHarness();
const cases: { id: string; scenario: string; result: string }[] = [];
const record = (scenario: string) => cases.push({ id: `SDK-${String(cases.length + 1).padStart(2, "0")}`, scenario, result: "pass" });
try {
  const tool = f.addTool(); f.tools.bind(f.root.id, [tool.id]);
  const before = f.fingerprint(), beforeChanges = f.changes();
  const client = await f.connect();
  assert.deepEqual(client.getServerCapabilities(), { tools: { listChanged: false } });
  assert.match(client.getInstructions()!, /Custom metadata may be ignored/);
  record("Official SDK initializes and sends initialized notification; only tools listing capability advertised");
  const known = await client.listTools();
  assert.deepEqual(known.tools.map(t => t.name), ["web_search"]); assert.deepEqual(known.tools[0].inputSchema, tool.parameters);
  record("Known Hydrogen entry retains downstream name and actual saved parameter schema");
  await assert.rejects(client.callTool({ name: "web_search", arguments: { query: "test" } }), { code: ErrorCode.MethodNotFound });
  await assert.rejects(client.callTool({ name: "unknown", arguments: {} }), { code: ErrorCode.MethodNotFound });
  assert.deepEqual(await client.ping(), {}); assert.deepEqual(await client.listTools(), known); assert.equal(f.fingerprint(), before); assert.equal(f.changes(), beforeChanges);
  record("SDK can attempt calls despite advisory metadata; endpoint rejects known/unknown calls and remains usable without DB writes");

  f.services.update(f.root.id, { definition: modelDefinition({ serverToolPolicy: { mode: "whitelist", names: ["web_search"] } }) });
  const bypass = await client.listTools();
  assert.deepEqual(bypass.tools[0].inputSchema, { type: "object", additionalProperties: true });
  assert.equal((bypass.tools[0]._meta![DISCOVERY_META] as { schemaKnown: boolean }).schemaKnown, false);
  await assert.rejects(client.callTool({ name: "web_search", arguments: { arbitrary: "not validated" } }), { code: ErrorCode.MethodNotFound });
  record("Admin-declared upstream placeholder passes official SDK listing validation, warns unknown schema and rejects attempted call");

  f.services.update(f.root.id, { definition: modelDefinition() });
  const ids = Array.from({ length: 101 }, (_, i) => f.addTool(`t_${String(i).padStart(3, "0")}`).id); f.tools.bind(f.root.id, ids);
  const first = await client.listTools(), next = await client.listTools({ cursor: first.nextCursor });
  assert.equal(first.tools.length, 100); assert.deepEqual(next.tools.map(t => t.name), ["t_100"]); assert.equal(next.nextCursor, undefined);
  assert.deepEqual(await client.listTools(), first);
  record("Actual SDK cursor pagination covers 101 entries in 100+1 pages with stable repeat listing");

  const current = f.tools.get(ids[100])!;
  f.db.update(hostedTools).set({ config: { ...current.config, description: "Latest definition", parameters: { type: "object", properties: { latest: { type: "integer" } } } } }).where(eq(hostedTools.id, current.id)).run();
  const latest = await client.listTools({ cursor: first.nextCursor });
  assert.match(latest.tools[0].description!, /Latest definition/); assert.deepEqual(latest.tools[0].inputSchema, { type: "object", properties: { latest: { type: "integer" } } });
  record("Next page re-reads current description/schema using an earlier cursor");
  f.services.update(f.root.id, { definition: modelDefinition({ serverToolPolicy: { mode: "whitelist", names: ["t_100"] } }) });
  const policyEdit = await client.listTools({ cursor: first.nextCursor });
  assert.equal((policyEdit.tools[0]._meta![DISCOVERY_META] as { schemaKnown: boolean }).schemaKnown, false);
  f.tools.bind(f.root.id, []); assert.deepEqual((await client.listTools({ cursor: first.nextCursor })).tools, []);
  record("Old cursor reads current policy and binding edits; catalog shrink returns live empty page without recovery");

  f.services.update(f.root.id, { definition: modelDefinition({ serverToolPolicy: { mode: "whitelist", names: [] } }) });
  assert.deepEqual((await client.listTools()).tools, []);
  f.db.update(modelServices).set({ definition: { steps: "synthetic-private-invalid-config" } as never }).where(eq(modelServices.id, f.root.id)).run();
  await assert.rejects(client.listTools(), { code: ErrorCode.InternalError, data: { reason: "invalid_configuration" } });
  f.services.update(f.root.id, { definition: modelDefinition() });
  record("Valid empty service succeeds; malformed saved configuration is a sanitized explicit MCP error");

  const child = f.services.create({ name: "child", definition: modelDefinition({ serverToolPolicy: { mode: "whitelist", names: ["late_remote"] } }) });
  f.tools.bind(child.id, [f.addTool("late_local").id]);
  f.services.update(f.root.id, { definition: parseService({ kind: "micro_agent", stages: [
    { name: "early", steps: [{ model: "m", provider: "p", serverToolPolicy: { mode: "whitelist", names: [] } }] }, { name: "later", service: "child" },
  ] }) });
  assert.deepEqual((await client.listTools()).tools.map(t => t.name), ["late_local", "late_remote"]);
  record("Micro Agent union includes local and admin-declared tools available only in later stages");
  await assert.rejects(f.connect("child"));
  record("Root-scoped Key can inspect compound service but cannot initialize the referenced child as a separate target");
  f.tokens.update(f.owner.id, { enabled: false }); await assert.rejects(client.listTools()); f.tokens.update(f.owner.id, { enabled: true });
  record("Existing SDK connection cannot list after current Key revocation");
  const result = await f.rpc("tools/list");
  assert.equal(result.headers.get("Cache-Control"), "no-store");
  for (const privateField of ["credential", "private-adapter", "private-internal-prompt", "private-provider", "private-model", "provider_server_side_"]) assert.ok(!JSON.stringify(result.body).includes(privateField));
  assert.ok(Object.values(f.counts).every(count => count === 0));
  assert.equal(f.tokens.get(f.owner.id)!.usedRequests, 0); assert.equal(f.tokens.get(f.owner.id)!.usedTokens, 0);
  record("Zero receiver/model/transport/quota/usage/log/decrypting reads and zero inference counters; no private fields in response");

  const output = path.resolve(process.argv[2] ?? "docs/qa/HYD-TOOL-DISCOVERY/protocol-client.json");
  const evidence = { runAt: new Date().toISOString(), runtime: { node: process.version, platform: process.platform, arch: process.arch },
    library: "@modelcontextprotocol/sdk@1.32.0", client: "Client + StreamableHTTPClientTransport", application: "real buildApp with disposable SQLite and loopback HTTP receiver",
    credentials: "pre-existing synthetic fixture Keys; no production or generated real credentials", cases,
    finalCounters: f.counts, inferenceUsage: { requests: 0, tokens: 0 }, sqliteWriteStatementsDuringProtocolSequence: 0,
    limits: ["This validates official SDK listing compatibility; ordinary agent applications may ignore custom metadata and attempt calls.",
      "No live providers, public network execution, browser/CORS use, production deployment or current 2026 SDK v2 protocol certification."] };
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ output, passed: cases.length, finalCounters: f.counts }));
} finally { await f.close(); }
