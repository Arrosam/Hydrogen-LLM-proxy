import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDatabase } from "../../src/db";
import { tokens as tokenTable } from "../../src/db/schema";
import { hashToken } from "../../src/security/tokens";
import { TokenRepo } from "../../src/persistence/tokenRepo";
import { ServiceRepo } from "../../src/persistence/serviceRepo";
import { HostedToolRepo } from "../../src/persistence/hostedToolRepo";
import { parseService } from "../../src/execution/definition";
import { HttpToolSchema } from "../../src/execution/toolHttp";
import { RequestGate } from "../../src/util/requestGate";
import { buildApp } from "../../src/app";
import type { Container } from "../../src/composition/container";

export const SYNTHETIC_KEY = "synthetic-discovery-existing-key";
export const SYNTHETIC_SECRET = "synthetic-adapter-credential-never-disclosed";
const MASTER_KEY = Buffer.alloc(32, 56);
export const modelDefinition = (patch: Record<string, unknown> = {}) => parseService({
  steps: [{ model: "private-model", provider: "private-provider", overrides: { system: "private-internal-prompt-never-disclosed" } }], ...patch,
});

/** Real application/router + repositories + SDK client + loopback receiver.
 * No boot(), production environment or generated credential is used. */
export async function createDiscoveryHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-discovery-"));
  const opened = openDatabase(dir), services = new ServiceRepo(opened.db), tools = new HostedToolRepo(opened.db, MASTER_KEY);
  const tokens = new TokenRepo(opened.db, MASTER_KEY);
  const root = services.create({ name: "svc", definition: modelDefinition() });
  const owner = opened.db.insert(tokenTable).values({ name: "existing-synthetic-key", keyHash: hashToken(SYNTHETIC_KEY),
    keyPrefix: "synthetic", scopeServices: [root.id], maxRequests: 0, maxTokens: 0 }).returning().get();
  const counts = { upstreamHttp: 0, modelFactory: 0, upstreamTransport: 0, catalogResolve: 0, quotaReserve: 0, usage: 0, requestLog: 0, decryptingToolRead: 0 };
  const receiver = createServer((_req, res) => { counts.upstreamHttp++; res.writeHead(500); res.end("Unexpected execution"); });
  await new Promise<void>((resolve, reject) => { receiver.once("error", reject); receiver.listen(0, "127.0.0.1", resolve); });
  const receiverUrl = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/private-adapter`;
  const addTool = (name = "web_search", patch: Record<string, unknown> = {}) => tools.create(HttpToolSchema.parse({
    name: `adapter_${name}`, description: `Saved description for ${name}`, parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    url: receiverUrl, headers: { Authorization: SYNTHETIC_SECRET }, bodyTemplate: { internal: "private-body-template", q: "{{arguments.query}}" },
    serverTool: { name }, ...patch,
  }));
  const unavailable = (counter: "modelFactory" | "upstreamTransport" | "catalogResolve" | "usage" | "requestLog") => new Proxy({}, {
    get: () => () => { counts[counter]++; throw new Error(`Discovery must not use ${counter}`); },
  });
  tokens.reserveQuota = () => { counts.quotaReserve++; throw new Error("Discovery must not reserve quota"); };
  const originalIncrement = tokens.incrementUsage.bind(tokens);
  tokens.incrementUsage = (...args) => { counts.usage++; originalIncrement(...args); };
  const originalForService = tools.forService.bind(tools);
  tools.forService = (...args) => { counts.decryptingToolRead++; return originalForService(...args); };
  const app = await buildApp({
    config: { isProduction: true, trustProxy: false, sessionSecret: "synthetic-discovery-cursor-key" },
    services, hostedTools: tools, tokens, requestGate: new RequestGate(),
    settings: { logPayloadMaxChars: () => 2000 }, statsCache: { close: () => {} },
    factory: unavailable("modelFactory"), transport: unavailable("upstreamTransport"), catalog: unavailable("catalogResolve"),
    usageMeter: unavailable("usage"), requestLogger: unavailable("requestLog"),
  } as unknown as Container);
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const clients: Client[] = [];
  const endpoint = (name = "svc") => `${baseUrl}/v1/services/${encodeURIComponent(name)}/mcp`;
  const connect = async (name = "svc", key = SYNTHETIC_KEY) => {
    const client = new Client({ name: "hydrogen-discovery-validation", version: "1.0.0" }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint(name)), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
    return client;
  };
  const rpc = async (method: string, params?: unknown, options: { key?: string | null; service?: string; headers?: Record<string, string>; id?: unknown } = {}) => {
    const key = options.key === undefined ? SYNTHETIC_KEY : options.key;
    const response = await fetch(endpoint(options.service), { method: "POST", headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25",
      ...(key ? { Authorization: `Bearer ${key}` } : {}), ...options.headers,
    }, body: JSON.stringify({ jsonrpc: "2.0", id: options.id === undefined ? 7 : options.id, method, ...(params !== undefined ? { params } : {}) }) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const fingerprint = () => {
    const hash = createHash("sha256");
    const tables = opened.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    for (const table of tables) hash.update(JSON.stringify(opened.sqlite.prepare(`SELECT * FROM "${table.name}"`).all()));
    return hash.digest("hex");
  };
  const changes = () => (opened.sqlite.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
  const close = async () => {
    for (const client of clients) await client.close();
    await app.close(); await new Promise<void>(resolve => receiver.close(() => resolve()));
    opened.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
  };
  return { ...opened, dir, services, tools, tokens, root, owner, counts, addTool, connect, rpc, endpoint, fingerprint, changes, close };
}
export type DiscoveryHarness = Awaited<ReturnType<typeof createDiscoveryHarness>>;
