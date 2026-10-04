/** Disposable combined UI/HTTP fixture. Never use with production data. */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import "../server/src/core/format";
import { buildResponse, serializeStream } from "../server/src/core/format/registry";
import { fabricateStream } from "../server/src/core/ir/stream";
import type { ContentPart } from "../server/src/core/ir/content";
import { HttpToolSchema } from "../server/src/execution/toolHttp";
import { parseService } from "../server/src/execution/definition";

const evidenceDir = path.resolve(process.argv[2] ?? "../evidence");
fs.mkdirSync(evidenceDir, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-integration-ui-"));
Object.assign(process.env, {
  NODE_ENV: "test", DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: "18091",
  ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "synthetic-preview-admin-2026",
  SESSION_SECRET: "synthetic-preview-session-0000123456789", PROXY_MASTER_KEY: "35".repeat(32),
  ALLOW_PRIVATE_UPSTREAMS: "1", COOKIE_SECURE: "false", JSON_COMMIT_GRACE_MS: "0",
  STREAM_COMMIT_GRACE_MS: "600000", UPDATE_RESTART_ENABLED: "false", LOG_PAYLOAD_MAX_CHARS: "0",
});
type FixtureBody = Record<string, unknown> & {
  model?: string; stream?: boolean; tools?: { type?: string; name?: string }[];
  input?: { type?: string; call_id?: string }[];
};
let modelRequests: FixtureBody[] = [], adapterRequests: Record<string, unknown>[] = [];
let failNextSave = false, nextCall = 0;
const fake = http.createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as FixtureBody;
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/tool")) {
      adapterRequests.push(body);
      res.end(JSON.stringify({ results: [{ type: "web_search_result", title: "Synthetic preview result", url: "https://example.invalid/preview" }] }));
      return;
    }
    modelRequests.push(body);
    const selected = body.tools?.find(tool => tool.type === "function");
    const done = body.input?.some(item => item.type === "function_call_output");
    const content: ContentPart[] = selected && !done
      ? [{ type: "tool_use", id: `preview-call-${++nextCall}`, name: selected.name!, input: { query: "synthetic preview" } }]
      : [{ type: "text", text: "Synthetic preview answer" }];
    const response = buildResponse("openai_responses", {
      id: `preview-${modelRequests.length}`, model: "preview-model", created: 1, content,
      stopReason: content[0].type === "tool_use" ? "tool_use" : "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    if (body.stream) {
      res.setHeader("content-type", "text/event-stream");
      for await (const chunk of serializeStream("openai_responses", fabricateStream(response.data(), Infinity), { model: "preview-model" })) res.write(chunk);
      res.end();
    } else res.end(JSON.stringify(response.renderSelf("preview-model")));
  } catch { res.statusCode = 500; res.end('{"error":"synthetic fixture error"}'); }
});
await new Promise<void>((resolve, reject) => { fake.once("error", reject); fake.listen(0, "127.0.0.1", resolve); });
const upstream = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
const { boot } = await import("../server/src/composition/container");
const { buildApp } = await import("../server/src/app");
const c = await boot();
const packageVersion = (JSON.parse(fs.readFileSync(new URL("../server/package.json", import.meta.url), "utf8")) as { version: string }).version;
c.updates.check = async () => ({ current: packageVersion, latest: null, updateAvailable: false, releaseUrl: null, releaseNotes: null,
  publishedAt: null, prerelease: true, checkedAt: Date.now(), runtime: "node", restartSupported: false });
const provider = c.providers.create({ name: "Synthetic preview provider", type: "openai_responses", baseUrl: `${upstream}/v1`, apiKey: "synthetic-provider-key" });
const model = c.models.create({ name: "preview-model" });
c.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: model.name });
const step = { model: model.name, provider: provider.name, retry: { on: [], maxAttempts: 1, intervalMs: 0, idempotency: "read" } };
const create = (name: string, patch: Record<string, unknown> = {}) => c.services.create({ name, definition: parseService({ timeoutMs: 10000, steps: [step], ...patch }) });
const service = create("Integration UI fixture", { serverToolPolicy: { mode: "whitelist", names: ["web_search"] } });
const emptyService = create("No binding fixture");
const snapshot = create("Snapshot fixture", { hostedTools: { maxRounds: 1 } });
const fallback = create("Fallback fixture", { steps: [
  { ...step, retry: { on: [400, 500, 503], maxAttempts: 3, intervalMs: 600000, idempotency: "read" }, serverToolPolicy: { mode: "blacklist", names: ["web_fetch"] } },
  { ...step, serverToolPolicy: { mode: "whitelist", names: ["web_fetch"] } },
] });
const tool = c.hostedTools.create(HttpToolSchema.parse({
  name: "preview_search", description: "Synthetic local search with a real saved schema",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  url: `${upstream}/tool`, headers: { Authorization: "synthetic-adapter-private-header" }, bodyTemplate: { arguments: "{{arguments}}", tool: "{{tool.name}}" },
  serverTool: { name: "web_search", resultType: "web_search_tool_result", resultPath: "/results" },
}));
for (const row of [service, snapshot, fallback]) c.hostedTools.bind(row.id, [tool.id]);
const agent = c.services.create({ name: "Micro agent fixture", definition: parseService({ kind: "micro_agent", timeoutMs: 10000, stages: [{ name: "answer", service: service.name, input: [] }] }) });
for (let i = 1; i <= 105; i++) c.hostedTools.create(HttpToolSchema.parse({
  name: i === 2 ? "catalog_002_long_name_with_wrapped_description_for_narrow_view" : `catalog_${String(i).padStart(3, "0")}`,
  description: i === 2 ? "Synthetic inventory description that is deliberately long enough to wrap naturally in a narrow selector without clipping any option or removal control." : `Synthetic inventory entry ${i}`,
  enabled: i !== 3, parameters: { type: "object", properties: { query: { type: "string" } } }, url: `${upstream}/tool`, bodyTemplate: {},
  serverTool: { name: `catalog_${String(i).padStart(3, "0")}` },
}));
const allIds = c.hostedTools.list().filter(t => t.enabled).map(t => t.id);
const paged = create("Paged catalog fixture");
const pagedAgent = c.services.create({ name: "Paged discovery agent", definition: parseService({ kind: "micro_agent", timeoutMs: 10000, stages: [{ name: "page", service: paged.name }] }) });
// Database fixtures intentionally cover a large discovery catalog beyond UI binding limits.
// Two referenced children each respect the normal 64-binding boundary.
const pagedSecond = create("Paged catalog second fixture");
c.hostedTools.bind(paged.id, allIds.slice(0, 64)); c.hostedTools.bind(pagedSecond.id, allIds.slice(64));
c.services.update(pagedAgent.id, { definition: parseService({ kind: "micro_agent", stages: [{ name: "first", service: paged.name }, { name: "second", service: pagedSecond.name }] }) });
const token = c.tokens.create({ name: "synthetic preview client" });
const scoped = c.tokens.create({ name: "synthetic scoped client", scopeServices: [service.id] });
const app = await buildApp(c); app.log.level = "silent";
app.addHook("onRequest", async (req, reply) => {
  if (failNextSave && ((req.method === "PATCH" && req.url.startsWith("/admin/api/services/")) || (req.method === "PUT" && req.url === "/admin/api/settings/server-tool-name-prefix"))) {
    failNextSave = false; return reply.code(503).send({ error: "Synthetic save failure; draft can be retried" });
  }
});
const counters = () => ({ modelRequests, adapterRequests, databaseChanges: (c.sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n });
app.get("/__qa/counters", counters);
app.post("/__qa/reset", () => { modelRequests = []; adapterRequests = []; c.activeRequests.clear(); return { ok: true }; });
app.post("/__qa/fail-next-save", () => { failNextSave = true; return { ok: true }; });
app.get("/__qa/stages", () => c.activeRequests.listCompleted(1)[0]?.events.filter(e => e.node === "step.start").map(e => Number(e.message.match(/step (\d+)/)?.[1])) ?? []);
await app.listen({ port: 0, host: "127.0.0.1" });
const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
fs.writeFileSync(path.join(evidenceDir, "private-fixture.json"), JSON.stringify({ baseUrl, token: token.secret, scopedToken: scoped.secret,
  serviceId: service.id, emptyServiceId: emptyService.id, snapshotId: snapshot.id, fallbackId: fallback.id, toolId: tool.id, agentId: agent.id,
  pagedAgentId: pagedAgent.id, pagedSecondId: pagedSecond.id, admin: "admin", password: "synthetic-preview-admin-2026", dataDir, sha }, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(evidenceDir, "fixture-context.json"), JSON.stringify({ sha, version: packageVersion, node: process.version, baseUrl, synthetic: true, startedAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify({ ready: true, baseUrl, sha }));
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await app.close(); await c.egressPool.closeAll(); c.sqlite.close();
  await new Promise<void>(resolve => fake.close(() => resolve())); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0);
}
process.on("SIGINT", () => void stop()); process.on("SIGTERM", () => void stop());
