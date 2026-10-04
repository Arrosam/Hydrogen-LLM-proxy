import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import "../src/core/format";
import { openDatabase, type OpenedDatabase } from "../src/db";
import { verifyOrInitMasterKey } from "../src/security/masterKey";
import { decryptSecret } from "../src/security/crypto";
import { openWithPassphrase, sealWithPassphrase } from "../src/security/passphrase";
import { exportBackup, restoreBackup, type BackupPackage } from "../src/backup/archive";
import { TokenRepo } from "../src/persistence/tokenRepo";
import { ServiceRepo } from "../src/persistence/serviceRepo";
import { ResponseRepo } from "../src/persistence/responseRepo";
import { HostedToolRepo } from "../src/persistence/hostedToolRepo";
import { SettingsRepo } from "../src/persistence/settingsRepo";
import { ProviderRepo } from "../src/persistence/providerRepo";
import { ModelRepo } from "../src/persistence/modelRepo";
import { MappingRepo } from "../src/persistence/mappingRepo";
import { Catalog } from "../src/catalog/catalog";
import { parseService, type ServiceDef } from "../src/execution/definition";
import { HttpToolSchema } from "../src/execution/toolHttp";
import { ServiceFactory } from "../src/execution/serviceFactory";
import { ResponsesController } from "../src/transport/responsesController";
import { ProxyController } from "../src/transport/proxyController";
import type { ProxyDeps } from "../src/transport/deps";
import { ActiveRequestRegistry } from "../src/observability/activeRequests";
import { UsageMeter } from "../src/observability/usageMeter";
import type { Transport } from "../src/core/upstream/transport";
import type { ContentPart } from "../src/core/ir/content";
import { buildResponse, serializeStream } from "../src/core/format/registry";
import { fabricateStream } from "../src/core/ir/stream";

const KEY_A = Buffer.alloc(32, 31), KEY_B = Buffer.alloc(32, 47);
const PASSPHRASE = "snapshot-backup-passphrase";
const TOOL_SECRET = "Bearer private-snapshot-tool-header";
const declared = [{ type: "web_search" }, { type: "external_extra" }];
const snapshotTables = ["stored_responses", "response_conversations"] as const;
type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
type SnapshotRecord = { table: typeof snapshotTables[number]; id: string; snapshot: string | null };
type SealedSecrets = { integrity: string; sessionSnapshots?: SnapshotRecord[]; [key: string]: unknown };
interface Instance extends OpenedDatabase {
  dir: string; key: Buffer; app: FastifyInstance; tokens: TokenRepo; services: ServiceRepo;
  tools: HostedToolRepo; responses: ResponseRepo; settings: SettingsRepo;
  modelCalls: Call[]; adapterCalls: Call[];
}
let source: Instance, target: Instance;
let owner: ReturnType<TokenRepo["create"]>;
let serviceId: number, toolId: number;
const definition = (changed = false): ServiceDef => parseService({ timeoutMs: 1000,
  serverToolPolicy: { mode: "whitelist", names: [] },
  steps: [{ model: "model", provider: "provider", overrides: { temperature: changed ? 0.9 : 0.2 },
    ...(changed ? {} : { serverToolPolicy: { mode: "blacklist", names: [] } }) }],
});

function instance(key: Buffer): Instance {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-backup-snapshot-"));
  const opened = openDatabase(dir);
  verifyOrInitMasterKey(opened.db, key);
  const tokens = new TokenRepo(opened.db, key), services = new ServiceRepo(opened.db);
  const tools = new HostedToolRepo(opened.db, key), responses = new ResponseRepo(opened.db, () => 0, Date.now, key);
  const settings = new SettingsRepo(opened.db);
  const catalog = new Catalog(new ModelRepo(opened.db), new ProviderRepo(opened.db, key), new MappingRepo(opened.db));
  const modelCalls: Call[] = [], adapterCalls: Call[] = [];
  const modelResponse = (url: string, headers: Record<string, string>, request: unknown) => {
    const body = request as Record<string, unknown>;
    modelCalls.push({ url, headers, body });
    const offered = (body.tools as Array<{ type: string; name?: string }> | undefined)?.find(tool => tool.type === "function");
    const input = body.input as Array<{ type: string }>;
    const complete = input.at(-1)?.type === "function_call_output";
    const content: ContentPart[] = offered && !complete
      ? [{ type: "tool_use", id: `call_${key[0]}_${modelCalls.length}`, name: offered.name!, input: { q: "fixture" } }]
      : [{ type: "text", text: "continued answer" }];
    return buildResponse("openai_responses", { id: "fake-upstream", model: "model", created: 1, content,
      stopReason: content[0].type === "tool_use" ? "tool_use" : "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
  };
  const transport: Transport = {
    postJson: async (url, headers, request) => {
      const json = modelResponse(url, headers, request).renderSelf("model");
      return { status: 200, headers: {}, json, text: JSON.stringify(json) };
    },
    postStream: async (url, headers, request) => {
      if (url.startsWith("https://adapter.test/")) {
        adapterCalls.push({ url, headers, body: request as Record<string, unknown> });
        return { status: 200, headers: {}, body: Readable.from([JSON.stringify({ results: [{ type: "web_search_result", title: "Synthetic result", url: "https://result.test/" }] })]) };
      }
      const response = modelResponse(url, headers, request);
      return { status: 200, headers: {}, body: Readable.from(serializeStream("openai_responses", fabricateStream(response.data(), Infinity), "model")) };
    },
  };
  const factory = new ServiceFactory(services, { catalog, transport, serverToolNamePrefix: () => settings.serverToolNamePrefix(), simulatedStreamingTokenRate: Infinity }, 1000, null, tools);
  const deps = { services, tokens, tools, factory, catalog, transport, logger: { capture: JSON.stringify, record: vi.fn() },
    usage: new UsageMeter(tokens), activeRequests: new ActiveRequestRegistry() } as unknown as ProxyDeps;
  const app = Fastify(), controller = new ResponsesController(deps, responses, tools);
  controller.register(app); new ProxyController(deps, controller).register(app);
  return { ...opened, dir, key, app, tokens, services, tools, responses, settings, modelCalls, adapterCalls };
}

beforeEach(() => {
  source = instance(KEY_A); target = instance(KEY_B);
  source.sqlite.prepare("INSERT INTO users (username,password_hash,role,enabled) VALUES (?,?,?,?)")
    .run("backup-admin", "$argon2id$v=19$m=65536,t=3,p=4$fixture$fixture", "admin", 1);
  owner = source.tokens.create({ name: "snapshot-owner" });
  const provider = new ProviderRepo(source.db, KEY_A).create({ name: "provider", type: "openai_responses", baseUrl: "https://provider.test/v1", apiKey: "synthetic-provider-key" });
  const model = new ModelRepo(source.db).create({ name: "model" });
  new MappingRepo(source.db).create({ providerId: provider.id, modelId: model.id, upstreamModel: "model" });
  source.settings.setServerToolNamePrefix("original_");
  serviceId = source.services.create({ name: "svc", definition: definition() }).id;
  toolId = source.tools.create(HttpToolSchema.parse({ name: "lookup", url: "https://adapter.test/original", parameters: { type: "object" },
    bodyTemplate: { args: "{{arguments}}", session: "{{session.id}}" }, headers: { Authorization: TOOL_SECRET },
    resultPath: "/results", serverTool: { name: "web_search", resultPath: "" } })).id;
  source.tools.bind(serviceId, [toolId]);
  new ModelRepo(target.db).create({ name: "target-before-restore" });
  target.settings.set("session_epoch", "123");
});
afterEach(async () => {
  for (const value of [target, source]) {
    await value.app.close(); value.sqlite.close(); fs.rmSync(value.dir, { recursive: true, force: true });
  }
});

const headers = () => ({ authorization: `Bearer ${owner.secret}` });
const create = (value: Instance, body: Record<string, unknown> = {}) => value.app.inject({ method: "POST", url: "/v1/responses", headers: headers(),
  payload: { model: "svc", input: "find fixture", tools: declared, ...body } });
const backup = (includeLogs = true) => exportBackup(source.sqlite, KEY_A, { passphrase: PASSPHRASE, includeLogs, includeImageCache: false, appVersion: "test" });
const wire = (pkg: BackupPackage) => JSON.parse(JSON.stringify(pkg)) as BackupPackage;
const openSecrets = async (pkg: BackupPackage) => JSON.parse(await openWithPassphrase(pkg.secrets, PASSPHRASE)) as SealedSecrets;

async function start(conversation = false) {
  let conversationId: string | undefined;
  if (conversation) {
    const response = await source.app.inject({ method: "POST", url: "/v1/conversations", headers: headers(), payload: {} });
    expect(response.statusCode).toBe(200); conversationId = response.json().id;
  }
  const first = await create(source, conversationId ? { conversation: conversationId } : {});
  expect(first.statusCode, first.payload).toBe(200); expect(first.json().status).toBe("completed");
  expect(source.adapterCalls).toHaveLength(1);
  return { responseId: first.json().id as string, conversationId, snapshot: source.responses.responseSnapshot(first.json().id, owner.token.id)! };
}

/** Construct authenticated legacy/malformed fixtures with the v2 wire digest.
 * Normal tamper tests keep the original sealed digest and must be rejected. */
async function reseal(pkg: BackupPackage, secrets: SealedSecrets): Promise<void> {
  const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(item => `${canonical(item)},`).join("")}]`
    : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])},`).join("")}}`
    : JSON.stringify(value) ?? "null";
  const { format, version, createdAt, appVersion, includesLogs, includesImageCache, counts, tables } = pkg;
  secrets.integrity = createHash("sha256").update(canonical({ format, version, createdAt, appVersion, includesLogs, includesImageCache, counts, tables })).digest("hex");
  pkg.secrets = await sealWithPassphrase(JSON.stringify(secrets), PASSPHRASE);
}

function targetState() {
  return Object.fromEntries(["users", "models", "tokens", "model_services", "hosted_tools", "service_tools", "settings", ...snapshotTables, "response_events", "conversation_items"]
    .map(table => [table, target.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

describe("portable encrypted session snapshots", () => {
  it.each([false, true])("reseals snapshots for a different key and continues the original %s identity", async conversation => {
    const session = await start(conversation), pkg = await backup();
    const sourceBlob = source.responses.response(session.responseId, owner.token.id)!.serviceSnapshotSecret!;
    for (const table of snapshotTables) for (const row of pkg.tables[table]) expect(row).not.toHaveProperty("service_snapshot_secret");
    expect(JSON.stringify(pkg)).not.toContain(TOOL_SECRET);
    expect(JSON.stringify(pkg.tables)).not.toContain("serverToolNamePrefix");
    const secrets = await openSecrets(pkg);
    expect(secrets.sessionSnapshots).toContainEqual({ table: "stored_responses", id: session.responseId, snapshot: JSON.stringify(session.snapshot) });
    if (session.conversationId) expect(secrets.sessionSnapshots).toContainEqual({ table: "response_conversations", id: session.conversationId, snapshot: JSON.stringify(session.snapshot) });
    const report = await restoreBackup(target.sqlite, KEY_B, wire(pkg), PASSPHRASE);
    expect(report.restored.stored_responses).toBe(1);
    expect(target.responses.responseSnapshot(session.responseId, owner.token.id)).toEqual(session.snapshot);
    if (session.conversationId) expect(target.responses.conversationSnapshot(session.conversationId, owner.token.id)).toEqual(session.snapshot);
    const restoredBlob = target.responses.response(session.responseId, owner.token.id)!.serviceSnapshotSecret!;
    expect(restoredBlob).not.toEqual(sourceBlob);
    expect(JSON.parse(decryptSecret(restoredBlob, KEY_B))).toEqual(session.snapshot);
    expect(() => decryptSecret(restoredBlob, KEY_A)).toThrow();

    // Editing live configuration after restore must not recapture the session.
    target.settings.setServerToolNamePrefix("changed_");
    const current = target.tools.materialize(target.tools.get(toolId)!);
    target.tools.update(toolId, { ...current, url: "https://adapter.test/changed", headers: { Authorization: "Bearer changed-header" } });
    target.services.update(serviceId, { definition: definition(true) });
    const continued = await create(target, session.conversationId ? { conversation: session.conversationId } : { previous_response_id: session.responseId });
    expect(continued.statusCode, continued.payload).toBe(200); expect(continued.json().status).toBe("completed");
    expect(target.modelCalls).toHaveLength(2); expect(target.adapterCalls).toHaveLength(1);
    expect(target.modelCalls[0].body).toMatchObject({ temperature: 0.2, tools: expect.arrayContaining([{ type: "external_extra" }, expect.objectContaining({ type: "function", name: "original_lookup" })]) });
    expect(target.adapterCalls[0]).toMatchObject({ url: "https://adapter.test/original", headers: { authorization: TOOL_SECRET } });
    expect(continued.json().output.some((item: { type: string }) => item.type === "web_search_call")).toBe(true);
    const before = target.modelCalls.length;
    expect((await create(target)).statusCode).toBe(400);
    expect(target.modelCalls).toHaveLength(before);
    expect(target.responses.responseSnapshot(continued.json().id, owner.token.id)).toEqual(session.snapshot);
    if (session.conversationId) expect(target.responses.conversationSnapshot(session.conversationId, owner.token.id)).toEqual(session.snapshot);
  });

  it("keeps history snapshots out of config-only backups", async () => {
    await start(true);
    const pkg = await backup(false);
    expect((await openSecrets(pkg)).sessionSnapshots).toEqual([]);
    for (const table of snapshotTables) expect(pkg.tables[table]).toBeUndefined();
    expect(JSON.stringify(pkg)).not.toContain(TOOL_SECRET);
    await restoreBackup(target.sqlite, KEY_B, wire(pkg), PASSPHRASE);
    expect(target.sqlite.prepare("SELECT * FROM stored_responses").all()).toEqual([]);
    expect(target.sqlite.prepare("SELECT * FROM response_conversations").all()).toEqual([]);
  });

  it("restores unfinished rows as failed while retaining decryptable snapshots", async () => {
    const session = await start(true);
    source.sqlite.prepare("UPDATE stored_responses SET status = 'in_progress' WHERE id = ?").run(session.responseId);
    await restoreBackup(target.sqlite, KEY_B, wire(await backup()), PASSPHRASE);
    expect(target.responses.response(session.responseId, owner.token.id)).toMatchObject({ status: "failed", response: { status: "failed", error: { code: "backup_restored" } } });
    expect(target.responses.responseSnapshot(session.responseId, owner.token.id)).toEqual(session.snapshot);
    expect(target.responses.conversationSnapshot(session.conversationId!, owner.token.id)).toEqual(session.snapshot);
    expect(target.modelCalls).toHaveLength(0); expect(target.adapterCalls).toHaveLength(0);
  });
});

describe("legacy snapshot backup compatibility", () => {
  it.each(["absent", "null"])("restores %s legacy snapshot columns without fabricating configuration", async columns => {
    const conversation = source.responses.createConversation(owner.token.id, {});
    source.responses.createResponse({ id: "legacy-response", tokenId: owner.token.id, serviceId, conversationId: conversation.id,
      status: "completed", response: { id: "legacy-response", model: "svc", store: true }, inputItems: [], history: [] });
    const pkg = await backup(), secrets = await openSecrets(pkg);
    expect(secrets.sessionSnapshots?.every(record => record.snapshot === null)).toBe(true);
    delete secrets.sessionSnapshots;
    if (columns === "null") for (const table of snapshotTables) for (const row of pkg.tables[table]) row.service_snapshot_secret = null;
    await reseal(pkg, secrets);
    await restoreBackup(target.sqlite, KEY_B, wire(pkg), PASSPHRASE);
    expect(target.responses.responseSnapshot("legacy-response", owner.token.id)).toBeUndefined();
    expect(target.responses.conversationSnapshot(conversation.id, owner.token.id)).toBeUndefined();
    expect((await create(target, { previous_response_id: "legacy-response" })).statusCode).toBe(409);
    expect((await create(target, { conversation: conversation.id })).statusCode).toBe(409);
    expect(target.modelCalls).toHaveLength(0);
  });

  it("authenticates old non-null ciphertext on a same-key restore and rejects it atomically under a different key", async () => {
    const session = await start(true), pkg = await backup(), secrets = await openSecrets(pkg);
    delete secrets.sessionSnapshots;
    for (const table of snapshotTables) for (const row of pkg.tables[table]) {
      row.service_snapshot_secret = (source.sqlite.prepare(`SELECT service_snapshot_secret FROM ${table} WHERE id = ?`).get(row.id) as { service_snapshot_secret: string }).service_snapshot_secret;
    }
    await reseal(pkg, secrets);
    const before = targetState();
    await expect(restoreBackup(target.sqlite, KEY_B, wire(pkg), PASSPHRASE)).rejects.toThrow(/Legacy session snapshot cannot be decrypted/);
    expect(targetState()).toEqual(before);
    await restoreBackup(source.sqlite, KEY_A, wire(pkg), PASSPHRASE);
    expect(source.responses.responseSnapshot(session.responseId, owner.token.id)).toEqual(session.snapshot);
    expect(source.responses.conversationSnapshot(session.conversationId!, owner.token.id)).toEqual(session.snapshot);
  });
});

describe("snapshot archive integrity and atomic restore", () => {
  it.each(["tables", "secrets"])("rejects tampered %s while leaving target data unchanged", async part => {
    await start(true); const pkg = await backup(), before = targetState();
    if (part === "tables") pkg.tables.stored_responses[0].id = "changed-identity";
    else {
      const ciphertext = Buffer.from(pkg.secrets.ciphertext, "base64"); ciphertext[0] ^= 1; pkg.secrets.ciphertext = ciphertext.toString("base64");
    }
    await expect(restoreBackup(target.sqlite, KEY_B, wire(pkg), PASSPHRASE)).rejects.toThrow(/modified/);
    expect(targetState()).toEqual(before);
  });

  it.each(["missing", "duplicate", "orphan", "malformed"])("rejects an authenticated but %s snapshot record before changing target data", async kind => {
    await start(true); const pkg = await backup(), secrets = await openSecrets(pkg), before = targetState();
    if (kind === "missing") secrets.sessionSnapshots!.pop();
    if (kind === "duplicate") secrets.sessionSnapshots!.push({ ...secrets.sessionSnapshots![0] });
    if (kind === "orphan") secrets.sessionSnapshots!.push({ ...secrets.sessionSnapshots![0], id: "orphan-session" });
    if (kind === "malformed") secrets.sessionSnapshots![0].snapshot = "invalid JSON";
    await reseal(pkg, secrets);
    await expect(restoreBackup(target.sqlite, KEY_B, wire(pkg), PASSPHRASE)).rejects.toThrow(/sealed session snapshot/i);
    expect(targetState()).toEqual(before);
  });

  it("rolls back restored and re-encrypted snapshots when a later table write fails", async () => {
    await start(true); const pkg = await backup(), before = targetState();
    expect(pkg.tables.response_events.length).toBeGreaterThan(0);
    target.sqlite.exec("CREATE TRIGGER reject_restored_event BEFORE INSERT ON response_events BEGIN SELECT RAISE(ABORT, 'synthetic late restore failure'); END");
    await expect(restoreBackup(target.sqlite, KEY_B, wire(pkg), PASSPHRASE)).rejects.toThrow(/could not restore table "response_events"/);
    expect(targetState()).toEqual(before);
    expect(() => verifyOrInitMasterKey(target.db, KEY_B)).not.toThrow();
  });
});
