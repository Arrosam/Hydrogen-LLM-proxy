/**
 * Backup / restore.
 *
 * The load-bearing claim is that a package restores onto an instance whose
 * PROXY_MASTER_KEY differs from the one that wrote it -- the disaster-recovery
 * case, and the whole reason provider keys are re-sealed under a passphrase
 * instead of copied as ciphertext. Most of these tests exist to hold that line.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { openDatabase, type DB } from "../src/db";
import { verifyOrInitMasterKey } from "../src/security/masterKey";
import { ProviderRepo } from "../src/persistence/providerRepo";
import { ModelRepo } from "../src/persistence/modelRepo";
import { MappingRepo } from "../src/persistence/mappingRepo";
import { ServiceRepo } from "../src/persistence/serviceRepo";
import { SettingsRepo } from "../src/persistence/settingsRepo";
import { RequestLogRepo, type LogInsert } from "../src/persistence/requestLogRepo";
import { entrySize, ImageCacheRepo } from "../src/persistence/imageCacheRepo";
import { BackupError, exportBackup, restoreBackup, type BackupPackage } from "../src/backup/archive";
import { PassphraseError, openWithPassphrase, sealWithPassphrase } from "../src/security/passphrase";
import { HostedToolRepo } from "../src/persistence/hostedToolRepo";
import { HttpToolSchema } from "../src/execution/toolHttp";
import { TokenRepo } from "../src/persistence/tokenRepo";
import { ProxyRepo } from "../src/persistence/proxyRepo";
import { ResponseRepo } from "../src/persistence/responseRepo";

const KEY_A = Buffer.alloc(32, 7); // the instance that takes the backup
const KEY_B = Buffer.alloc(32, 9); // a fresh install with its own master key
const PASSPHRASE = "correct horse battery staple";
const API_KEY = "sk-super-secret-provider-key";

interface Instance {
  dir: string;
  sqlite: BetterSqlite3.Database;
  db: DB;
}

function open(masterKey: Buffer): Instance {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydro-backup-"));
  const { db, sqlite } = openDatabase(dir);
  verifyOrInitMasterKey(db, masterKey);
  // Every real instance has an admin, and restore refuses a package without one.
  sqlite.prepare("INSERT INTO users (username, password_hash, role, enabled) VALUES ('admin', 'x', 'admin', 1)").run();
  return { dir, sqlite, db };
}

function close(i: Instance): void {
  i.sqlite.close();
  fs.rmSync(i.dir, { recursive: true, force: true });
}

/** Populate an instance with one of everything worth round-tripping. */
function seed(i: Instance, masterKey: Buffer): void {
  const providers = new ProviderRepo(i.db, masterKey);
  const models = new ModelRepo(i.db);
  const mappings = new MappingRepo(i.db);
  const services = new ServiceRepo(i.db);
  const settings = new SettingsRepo(i.db);
  const logs = new RequestLogRepo(i.db);

  const provider = providers.create({
    name: "siliconflow",
    type: "openai_completion",
    baseUrl: "https://api.siliconflow.cn/v1",
    apiKey: API_KEY,
    extraHeaders: { "x-trace": "on" },
    maxOutputTokens: 8192,
  });
  const keyless = providers.create({ name: "keyless", type: "anthropic", baseUrl: "https://example.com", apiKey: null });
  const model = models.create({ name: "qwen3.5", description: "test model" });
  mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "Qwen/Qwen3.5-4B" });
  services.create({
    name: "testG5",
    description: null,
    definition: { timeoutMs: 20_000, steps: [{ model: "qwen3.5", provider: "siliconflow" }] },
  });
  settings.writeAllowlist(["10.0.0.0/8"]);
  settings.setUiLanguage("zh");

  const log: LogInsert = {
    traceId: "t1", tokenId: null, serviceId: null, requestedService: "testG5",
    servedModel: "qwen3.5", servedProvider: "siliconflow",
    ingressFormat: "openai_completion", egressFormat: "openai_completion",
    streaming: false, httpStatus: 200, requestMethod: "POST", requestPath: "/v1/chat/completions",
    requestQuery: null, requestHeaders: { "content-type": "application/json" },
    requestBody: '{"model":"testG5"}', upstreamRequestBody: '{"model":"Qwen/Qwen3.5-4B"}',
    responseHeaders: null, responseBody: '{"ok":true}',
    promptTokens: 1, completionTokens: 2, totalTokens: 3,
    cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0, latencyMs: 5,
    attempts: 1, attemptPath: [{ step: 1 }], error: null,
  };
  logs.insert(log);
  void keyless;
}

const takeBackup = (
  i: Instance,
  key: Buffer,
  includeLogs = true,
  includeImageCache = false,
): Promise<BackupPackage> =>
  exportBackup(i.sqlite, key, { passphrase: PASSPHRASE, includeLogs, includeImageCache, appVersion: "1.0.0" });

/** Round-trip through JSON: a real package arrives as a parsed file, not as the
 * live object the exporter returned. */
const overTheWire = (pkg: BackupPackage): unknown => JSON.parse(JSON.stringify(pkg));

/** A budget far larger than anything these tests store, so nothing is evicted
 * behind the assertion's back. */
const AMPLE_BUDGET = 64 * 1024 * 1024;

/** Put OCR descriptions in an instance's image cache. */
const cacheImages = (i: Instance, entries: Array<{ hash: string; description: string }>): void => {
  new ImageCacheRepo(i.db).put(entries, Date.now(), AMPLE_BUDGET);
};

/** What an instance has cached for `hash`, or undefined. */
const cached = (i: Instance, hash: string): string | undefined => new ImageCacheRepo(i.db).lookup([hash]).get(hash);

/** A hosted tool carrying a secret header, as the dashboard would create it. */
const TOOL_SECRET = "Bearer tool-secret";
const makeTool = (i: Instance, key: Buffer, name = "lookup") =>
  new HostedToolRepo(i.db, key).create(
    HttpToolSchema.parse({
      name,
      url: "https://adapter.test/run",
      parameters: { type: "object" },
      bodyTemplate: { args: "{{arguments}}" },
      headers: { authorization: TOOL_SECRET },
    }),
  );

/** Re-seal a package's secrets after editing them -- what a package written by
 * an older build (or by hand, by someone who knows the passphrase) looks like. */
async function resealed(pkg: BackupPackage, edit: (secrets: Record<string, unknown>) => void): Promise<BackupPackage> {
  const secrets = JSON.parse(await openWithPassphrase(pkg.secrets, PASSPHRASE)) as Record<string, unknown>;
  edit(secrets);
  return { ...pkg, secrets: await sealWithPassphrase(JSON.stringify(secrets), PASSPHRASE) };
}

describe("passphrase sealing", () => {
  it("opens what it sealed", async () => {
    expect(await openWithPassphrase(await sealWithPassphrase("hello", "pass-phrase-1"), "pass-phrase-1")).toBe("hello");
  });

  it("refuses the wrong passphrase", async () => {
    const sealed = await sealWithPassphrase("hello", "pass-phrase-1");
    await expect(openWithPassphrase(sealed, "pass-phrase-2")).rejects.toThrow(PassphraseError);
  });

  it("refuses a tampered payload", async () => {
    const sealed = await sealWithPassphrase("hello", "pass-phrase-1");
    const tampered = { ...sealed, ciphertext: Buffer.from("evil").toString("base64") };
    await expect(openWithPassphrase(tampered, "pass-phrase-1")).rejects.toThrow(PassphraseError);
  });

  it("uses a fresh salt each time, so equal secrets do not look equal", async () => {
    const a = await sealWithPassphrase("same", "pass-phrase-1");
    const b = await sealWithPassphrase("same", "pass-phrase-1");
    expect(a.salt).not.toBe(b.salt);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("treats two Unicode spellings of the same passphrase as one", async () => {
    // "é" typed as one code point on one keyboard and as e + combining accent on
    // another: the same passphrase to the person, different bytes to scrypt.
    const composed = "caf\u00e9-pass";
    const decomposed = "cafe\u0301-pass";
    expect(composed).not.toBe(decomposed);
    expect(await openWithPassphrase(await sealWithPassphrase("hello", composed), decomposed)).toBe("hello");
    expect(await openWithPassphrase(await sealWithPassphrase("hello", decomposed), composed)).toBe("hello");
    // Compatibility forms fold too: a full-width digit is the digit.
    expect(await openWithPassphrase(await sealWithPassphrase("hello", "pass-phrase-\uff11"), "pass-phrase-1")).toBe("hello");
  });

  it("still refuses a passphrase that only looks similar", async () => {
    const sealed = await sealWithPassphrase("hello", "caf\u00e9-pass");
    await expect(openWithPassphrase(sealed, "cafe-pass")).rejects.toThrow(PassphraseError);
    await expect(openWithPassphrase(sealed, "Caf\u00e9-pass")).rejects.toThrow(/wrong passphrase, or this backup has been modified/);
  });

  it("refuses a key-derivation function it does not implement", async () => {
    const sealed = await sealWithPassphrase("hello", "pass-phrase-1");
    const foreign = { ...sealed, kdf: "argon2" } as unknown as typeof sealed;
    await expect(openWithPassphrase(foreign, "pass-phrase-1")).rejects.toThrow(PassphraseError);
    await expect(openWithPassphrase(foreign, "pass-phrase-1")).rejects.toThrow(/unsupported key-derivation function/);
  });

  it("rejects absurd KDF parameters rather than hanging on them", async () => {
    const sealed = await sealWithPassphrase("hello", "pass-phrase-1");
    await expect(openWithPassphrase({ ...sealed, n: 1 << 30 }, "pass-phrase-1")).rejects.toThrow(PassphraseError);
  });

  it("rejects a KDF whose memory cost exceeds the ceiling, as a clean 400 not a 500", async () => {
    // n=2^20, r=32 => 128*n*r = 4GB, far over maxmem: scrypt would throw. It must
    // surface as PassphraseError (a bad backup), never an unmapped crash.
    const sealed = await sealWithPassphrase("hello", "pass-phrase-1");
    await expect(openWithPassphrase({ ...sealed, n: 1 << 20, r: 32 }, "pass-phrase-1")).rejects.toThrow(PassphraseError);
  });
});

describe("backup package", () => {
  let a: Instance;

  beforeEach(() => {
    a = open(KEY_A);
    seed(a, KEY_A);
  });
  afterEach(() => close(a));

  it("never carries the master-key-encrypted columns", async () => {
    const pkg = await takeBackup(a, KEY_A);
    for (const row of pkg.tables.providers) {
      expect(row).not.toHaveProperty("key_ciphertext");
      expect(row).not.toHaveProperty("key_iv");
      expect(row).not.toHaveProperty("key_tag");
    }
  });

  it("never carries an API key in the clear", async () => {
    const pkg = await takeBackup(a, KEY_A);
    expect(JSON.stringify(pkg.tables)).not.toContain(API_KEY);
    expect(JSON.stringify(pkg.secrets)).not.toContain(API_KEY);
  });

  it("does not export the master-key sentinel", async () => {
    const pkg = await takeBackup(a, KEY_A);
    expect(pkg.tables.settings.map((r) => r.key)).not.toContain("master_key_check");
  });

  it("omits logs when asked to", async () => {
    const pkg = await takeBackup(a, KEY_A, false);
    expect(pkg.includesLogs).toBe(false);
    expect(pkg.tables.request_logs).toBeUndefined();
    expect(pkg.counts.providers).toBe(2);
  });
});

describe("restore onto a DIFFERENT master key", () => {
  let a: Instance;
  let b: Instance;

  beforeEach(() => {
    a = open(KEY_A);
    seed(a, KEY_A);
    b = open(KEY_B);
  });
  afterEach(() => {
    close(a);
    close(b);
  });

  it("re-encrypts hosted tool headers and preserves service bindings", async () => {
    const source = new HostedToolRepo(a.db, KEY_A);
    const tool = source.create(HttpToolSchema.parse({ name: "lookup", url: "https://adapter.test/run", parameters: { type: "object" }, bodyTemplate: { args: "{{arguments}}" }, headers: { authorization: "Bearer tool-secret" } }));
    const service = new ServiceRepo(a.db).list()[0]; source.bind(service.id, [tool.id]);
    const pkg = await takeBackup(a, KEY_A);
    expect(JSON.stringify(pkg.tables)).not.toContain("tool-secret");
    expect(pkg.tables.hosted_tools[0]).not.toHaveProperty("headers_secret");
    await restoreBackup(b.sqlite, KEY_B, overTheWire(pkg), PASSPHRASE);
    const restored = new HostedToolRepo(b.db, KEY_B);
    expect(restored.forService(service.id)[0].headers.authorization).toBe("Bearer tool-secret");
    expect(restored.boundIds(service.id)).toEqual([tool.id]);
  });

  it("brings the provider key back, usable under the new key", async () => {
    const pkg = await takeBackup(a, KEY_A);
    await restoreBackup(b.sqlite, KEY_B, overTheWire(pkg), PASSPHRASE);

    const providers = new ProviderRepo(b.db, KEY_B);
    const restored = providers.getByName("siliconflow")!;
    expect(providers.toUpstream(restored).apiKey).toBe(API_KEY);
  });

  it("keeps a keyless provider keyless", async () => {
    await restoreBackup(b.sqlite, KEY_B, overTheWire(await takeBackup(a, KEY_A)), PASSPHRASE);
    const providers = new ProviderRepo(b.db, KEY_B);
    expect(providers.toUpstream(providers.getByName("keyless")!).apiKey).toBeNull();
  });

  it("restores every table verbatim", async () => {
    await restoreBackup(b.sqlite, KEY_B, overTheWire(await takeBackup(a, KEY_A)), PASSPHRASE);

    const provider = new ProviderRepo(b.db, KEY_B).getByName("siliconflow")!;
    expect(provider.baseUrl).toBe("https://api.siliconflow.cn/v1");
    expect(provider.extraHeaders).toEqual({ "x-trace": "on" });
    expect(provider.maxOutputTokens).toBe(8192);

    expect(new ModelRepo(b.db).getByName("qwen3.5")?.description).toBe("test model");
    expect(new MappingRepo(b.db).list()[0].upstreamModel).toBe("Qwen/Qwen3.5-4B");
    expect(new ServiceRepo(b.db).getByName("testG5")?.definition).toEqual({
      timeoutMs: 20_000,
      steps: [{ model: "qwen3.5", provider: "siliconflow" }],
    });

    const settings = new SettingsRepo(b.db);
    expect(settings.allowlist()).toEqual(["10.0.0.0/8"]);
    expect(settings.uiLanguage()).toBe("zh");

    const log = new RequestLogRepo(b.db).get(1)!;
    expect(log.requestPayload).toBe('{"model":"testG5"}');
    expect(log.attemptPath).toEqual([{ step: 1 }]);
  });

  it("leaves the target's own sentinel intact, so it still boots", async () => {
    await restoreBackup(b.sqlite, KEY_B, overTheWire(await takeBackup(a, KEY_A)), PASSPHRASE);
    // The restored instance must still recognise ITS key, not the source's.
    expect(() => verifyOrInitMasterKey(b.db, KEY_B)).not.toThrow();
    expect(() => verifyOrInitMasterKey(b.db, KEY_A)).toThrow();
  });

  it("replaces what was there instead of merging into it", async () => {
    const models = new ModelRepo(b.db);
    models.create({ name: "leftover-from-before", description: null });
    await restoreBackup(b.sqlite, KEY_B, overTheWire(await takeBackup(a, KEY_A)), PASSPHRASE);
    expect(models.getByName("leftover-from-before")).toBeUndefined();
    expect(models.list()).toHaveLength(1);
  });

  it("is idempotent — restoring the same package twice is a no-op", async () => {
    const pkg = overTheWire(await takeBackup(a, KEY_A));
    await restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE);
    await restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE);
    expect(new ModelRepo(b.db).list()).toHaveLength(1);
    expect(new ProviderRepo(b.db, KEY_B).list()).toHaveLength(2);
  });

  it("brings API-key secrets back: still revealable, still authenticating", async () => {
    const source = new TokenRepo(a.db, KEY_A);
    const { token, secret } = source.create({ name: "k", maxRequests: 5 });
    source.incrementUsage(token.id, 2, 30);

    const pkg = await takeBackup(a, KEY_A);
    const wire = JSON.stringify(pkg);
    expect(wire).not.toContain(secret);
    for (const row of pkg.tables.tokens) {
      expect(row).not.toHaveProperty("key_ciphertext");
      expect(row).not.toHaveProperty("key_iv");
      expect(row).not.toHaveProperty("key_tag");
    }

    await restoreBackup(b.sqlite, KEY_B, overTheWire(pkg), PASSPHRASE);

    const restored = new TokenRepo(b.db, KEY_B);
    expect(restored.revealSecret(token.id)).toBe(secret);
    expect(restored.authenticate(secret)?.id).toBe(token.id);
    expect(restored.toPublic(restored.get(token.id)!)).toMatchObject({
      name: "k", keyPrefix: token.keyPrefix, hasStoredKey: true, maxRequests: 5, usedRequests: 2, usedTokens: 30, enabled: true,
    });
    // Re-encrypted, not copied: the source's key can no longer open it.
    expect(() => new TokenRepo(b.db, KEY_A).revealSecret(token.id)).toThrow();
  });

  it("brings an egress proxy's password back under the new key, and keeps a password-less one that way", async () => {
    const source = new ProxyRepo(a.db, KEY_A);
    const withPassword = source.create({ name: "px", scheme: "http", host: "127.0.0.1", port: 8080, username: "u", password: "p@ss-proxy-secret" });
    const bare = source.create({ name: "px-open", scheme: "https", host: "proxy.test", port: 3128 });
    const routed = new ProviderRepo(a.db, KEY_A).create({
      name: "routed", type: "openai_completion", baseUrl: "https://api.example.com/v1", apiKey: null, proxyId: withPassword.id,
    });

    const pkg = await takeBackup(a, KEY_A);
    expect(JSON.stringify(pkg)).not.toContain("p@ss-proxy-secret");
    for (const row of pkg.tables.proxies) {
      expect(row).not.toHaveProperty("password_ciphertext");
      expect(row).not.toHaveProperty("password_iv");
      expect(row).not.toHaveProperty("password_tag");
    }
    expect(pkg.counts.proxies).toBe(2);

    const report = await restoreBackup(b.sqlite, KEY_B, overTheWire(pkg), PASSPHRASE);
    expect(report.restored.proxies).toBe(2);

    const restored = new ProxyRepo(b.db, KEY_B);
    const row = restored.getByName("px")!;
    expect(restored.toEgress(row)).toEqual({
      id: withPassword.id, name: "px", scheme: "http", host: "127.0.0.1", port: 8080, username: "u", password: "p@ss-proxy-secret",
    });
    expect(restored.toPublic(row).hasPassword).toBe(true);

    const open = restored.getByName("px-open")!;
    expect(open.id).toBe(bare.id);
    expect(restored.toPublic(open)).toMatchObject({ hasPassword: false, username: null, scheme: "https", host: "proxy.test", port: 3128 });
    expect(restored.toEgress(open).password).toBeNull();

    // The provider still points at its proxy (proxies are written first).
    expect(new ProviderRepo(b.db, KEY_B).getByName("routed")?.proxyId).toBe(routed.proxyId);
    expect(restored.usedBy(withPassword.id)).toEqual([{ id: routed.id, name: "routed" }]);
  });

  it("demotes responses that were still running to failed, and leaves finished ones untouched", async () => {
    const owner = new TokenRepo(a.db, KEY_A).create({ name: "owner" }).token.id;
    const source = new ResponseRepo(a.db, () => 0);
    for (const status of ["queued", "in_progress", "completed", "cancelled"] as const) {
      source.createResponse({
        id: `resp-${status}`, tokenId: owner, status, background: true,
        response: { id: `resp-${status}`, object: "response", status, output: [{ type: "message", text: status }] },
        inputItems: [{ type: "message", role: "user", content: "hi" }], history: [],
      });
    }

    const report = await restoreBackup(b.sqlite, KEY_B, overTheWire(await takeBackup(a, KEY_A)), PASSPHRASE);
    expect(report.restored.stored_responses).toBe(4);

    const restored = new ResponseRepo(b.db, () => 0);
    for (const status of ["queued", "in_progress"]) {
      const row = restored.response(`resp-${status}`, owner)!;
      expect(row.status).toBe("failed");
      expect(row.response).toEqual({
        id: `resp-${status}`, object: "response", status: "failed", output: [{ type: "message", text: status }],
        error: { code: "backup_restored", message: "Execution was not replayed after restoring a backup" },
      });
      expect(row.inputItems).toEqual([{ type: "message", role: "user", content: "hi" }]);
    }

    const raw = (i: Instance, id: string): unknown => i.sqlite.prepare("SELECT * FROM stored_responses WHERE id = ?").get(id);
    for (const status of ["completed", "cancelled"]) {
      expect(raw(b, `resp-${status}`)).toEqual(raw(a, `resp-${status}`));
      expect(restored.response(`resp-${status}`, owner)?.status).toBe(status);
    }
    // The source is only read: its running responses are still running.
    expect(source.response("resp-queued", owner)?.status).toBe("queued");
  });

  it("restores a package written before proxies and hosted tools existed, leaving the target's own alone", async () => {
    const { token, secret } = new TokenRepo(a.db, KEY_A).create({ name: "old-key" });
    const pkg = overTheWire(await takeBackup(a, KEY_A)) as BackupPackage;
    for (const table of ["proxies", "hosted_tools", "service_tools"]) delete (pkg.tables as Record<string, unknown>)[table];
    // ...and its sealed secrets knew only about provider keys.
    const old = await resealed(pkg, (secrets) => {
      delete secrets.tokenKeys;
      delete secrets.proxyPasswords;
      delete secrets.toolHeaders;
    });

    const ownProxy = new ProxyRepo(b.db, KEY_B).create({ name: "own-proxy", scheme: "http", host: "10.0.0.1", port: 1080, password: "own-password" });
    const ownTool = makeTool(b, KEY_B, "own-tool");

    const report = await restoreBackup(b.sqlite, KEY_B, old, PASSPHRASE);
    expect(report.restored).toMatchObject({ proxies: 0, hosted_tools: 0, service_tools: 0, providers: 2, tokens: 1 });

    // Configuration arrived...
    const providers = new ProviderRepo(b.db, KEY_B);
    expect(providers.toUpstream(providers.getByName("siliconflow")!).apiKey).toBe(API_KEY);
    // ...and what the package never mentioned is exactly where it was.
    const proxies = new ProxyRepo(b.db, KEY_B);
    expect(proxies.toEgress(proxies.get(ownProxy.id)!).password).toBe("own-password");
    const tools = new HostedToolRepo(b.db, KEY_B);
    expect(tools.materialize(tools.get(ownTool.id)!).headers).toEqual({ authorization: TOOL_SECRET });

    // A key with no sealed secret restores hash-only: it authenticates, but can
    // never be shown again.
    const restoredTokens = new TokenRepo(b.db, KEY_B);
    expect(restoredTokens.authenticate(secret)?.id).toBe(token.id);
    expect(restoredTokens.revealSecret(token.id)).toBeNull();
    expect(restoredTokens.toPublic(restoredTokens.get(token.id)!).hasStoredKey).toBe(false);
  });

  it("reports what it restored", async () => {
    const report = await restoreBackup(b.sqlite, KEY_B, overTheWire(await takeBackup(a, KEY_A)), PASSPHRASE);
    expect(report).toMatchObject({ includedLogs: true, includedImageCache: false, providerKeysRestored: 1 });
    expect(report.restored).toMatchObject({ providers: 2, models: 1, model_providers: 1, model_services: 1, request_logs: 1, image_cache: 0 });
  });

  it("a config-only (no-logs) restore preserves the target's own request history", async () => {
    // The target has its own logged traffic; restoring a config-only package
    // must bring the config back without wiping that history.
    seed(b, KEY_B); // gives b a request_logs row of its own
    const before = new RequestLogRepo(b.db).query({}).total;
    expect(before).toBeGreaterThan(0);

    await restoreBackup(b.sqlite, KEY_B, overTheWire(await takeBackup(a, KEY_A, false)), PASSPHRASE);

    // Config replaced (a's provider name present), history untouched.
    expect(new ProviderRepo(b.db, KEY_B).getByName("siliconflow")).toBeDefined();
    expect(new RequestLogRepo(b.db).query({}).total).toBe(before);
  });
});

/**
 * The image cache is opt-in on the way out and never required on the way in.
 * The asymmetry is the point: a package that carries it is a convenience (the
 * target skips re-running OCR), while one that does not must leave whatever the
 * target had already transcribed exactly where it was.
 */
describe("image description cache", () => {
  let a: Instance;
  let b: Instance;

  beforeEach(() => {
    a = open(KEY_A);
    seed(a, KEY_A);
    cacheImages(a, [{ hash: "hash-from-a", description: "a red bicycle against a wall" }]);
    b = open(KEY_B);
  });
  afterEach(() => {
    close(a);
    close(b);
  });

  it("stays out of the package unless asked for", async () => {
    const pkg = await takeBackup(a, KEY_A);
    expect(pkg.includesImageCache).toBe(false);
    expect(pkg.tables.image_cache).toBeUndefined();
    expect(pkg.counts.image_cache).toBeUndefined();
  });

  it("travels when asked for, and restores under a different master key", async () => {
    const pkg = await takeBackup(a, KEY_A, true, true);
    expect(pkg.includesImageCache).toBe(true);
    expect(pkg.counts.image_cache).toBe(1);

    const report = await restoreBackup(b.sqlite, KEY_B, overTheWire(pkg), PASSPHRASE);
    expect(report.includedImageCache).toBe(true);
    // Descriptions are not encrypted under the master key -- unlike provider
    // keys, they cross instances as-is.
    expect(cached(b, "hash-from-a")).toBe("a red bicycle against a wall");
  });

  it("leaves the target's own cache alone when the package omits it", async () => {
    cacheImages(b, [{ hash: "hash-from-b", description: "already transcribed here" }]);

    const report = await restoreBackup(b.sqlite, KEY_B, overTheWire(await takeBackup(a, KEY_A)), PASSPHRASE);

    expect(report.includedImageCache).toBe(false);
    expect(cached(b, "hash-from-b")).toBe("already transcribed here");
    expect(cached(b, "hash-from-a")).toBeUndefined();
  });

  it("replaces the target's cache when the package carries one", async () => {
    cacheImages(b, [{ hash: "hash-from-b", description: "already transcribed here" }]);

    await restoreBackup(b.sqlite, KEY_B, overTheWire(await takeBackup(a, KEY_A, true, true)), PASSPHRASE);

    expect(cached(b, "hash-from-a")).toBe("a red bicycle against a wall");
    expect(cached(b, "hash-from-b")).toBeUndefined();
  });

  it("keeps the size bookkeeping intact, so the budget still applies after a restore", async () => {
    await restoreBackup(b.sqlite, KEY_B, overTheWire(await takeBackup(a, KEY_A, true, true)), PASSPHRASE);

    const repo = new ImageCacheRepo(b.db);
    // size_bytes rides along on the row; a restore that dropped or zeroed it
    // would leave the LRU unable to account for what it is holding.
    expect(repo.stats()).toEqual({ entries: 1, usedBytes: entrySize("hash-from-a", "a red bicycle against a wall") });
    expect(repo.enforceBudget(1)).toBe(1);
    expect(repo.stats().entries).toBe(0);
  });
});

describe("a restore that cannot succeed changes nothing", () => {
  let a: Instance;
  let b: Instance;

  beforeEach(() => {
    a = open(KEY_A);
    seed(a, KEY_A);
    b = open(KEY_B);
    new ModelRepo(b.db).create({ name: "pre-existing", description: null });
  });
  afterEach(() => {
    close(a);
    close(b);
  });

  const survived = (): void => {
    expect(new ModelRepo(b.db).getByName("pre-existing")).toBeDefined();
  };

  it("rejects a wrong passphrase before deleting anything", async () => {
    await expect(restoreBackup(b.sqlite, KEY_B, overTheWire(await takeBackup(a, KEY_A)), "not-the-passphrase")).rejects.toThrow(
      PassphraseError,
    );
    survived();
  });

  it("rejects a file that is not a backup", async () => {
    await expect(restoreBackup(b.sqlite, KEY_B, { hello: "world" }, PASSPHRASE)).rejects.toThrow(BackupError);
    survived();
  });

  it("rejects a future package version", async () => {
    const pkg = { ...(overTheWire(await takeBackup(a, KEY_A)) as BackupPackage), version: 99 };
    await expect(restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).rejects.toThrow(/unsupported backup version/);
    survived();
  });

  it("rejects an unknown table rather than writing part of the package", async () => {
    const pkg = overTheWire(await takeBackup(a, KEY_A)) as BackupPackage;
    (pkg.tables as Record<string, unknown[]>).evil_table = [{ id: 1 }];
    await expect(restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).rejects.toThrow(BackupError);
    survived();
  });

  it("rejects a package with no tables instead of bricking the instance", async () => {
    const pkg = overTheWire(await takeBackup(a, KEY_A)) as BackupPackage;
    pkg.tables = {};
    await expect(restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).rejects.toThrow(/missing required table/);
    survived();
  });

  it("rejects a package missing the users table (would lock everyone out)", async () => {
    const pkg = overTheWire(await takeBackup(a, KEY_A)) as BackupPackage;
    delete (pkg.tables as Record<string, unknown[]>).users;
    await expect(restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).rejects.toThrow(/missing required table "users"/);
    survived();
  });

  it("rejects a package with no sealed secrets", async () => {
    const pkg = overTheWire(await takeBackup(a, KEY_A)) as Partial<BackupPackage>;
    delete pkg.secrets;
    await expect(restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).rejects.toThrow(BackupError);
    await expect(restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).rejects.toThrow(/missing sealed secrets/);
    survived();
  });

  it("rejects a package whose table data is not an object", async () => {
    const pkg = overTheWire(await takeBackup(a, KEY_A)) as BackupPackage;
    for (const tables of ["x", null, 7]) {
      const broken = { ...pkg, tables };
      await expect(restoreBackup(b.sqlite, KEY_B, broken, PASSPHRASE)).rejects.toThrow(BackupError);
      await expect(restoreBackup(b.sqlite, KEY_B, broken, PASSPHRASE)).rejects.toThrow(/missing table data/);
    }
    survived();
  });

  it("rejects a table that is not a list of rows", async () => {
    const pkg = overTheWire(await takeBackup(a, KEY_A)) as BackupPackage;
    (pkg.tables as Record<string, unknown>).users = {};
    await expect(restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).rejects.toThrow(BackupError);
    await expect(restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).rejects.toThrow(/table "users" is not a list of rows/);
    survived();
  });

  it("rejects things that are not packages at all, and other products' files", async () => {
    for (const junk of [null, undefined, "a string", 42]) {
      await expect(restoreBackup(b.sqlite, KEY_B, junk, PASSPHRASE)).rejects.toThrow(/^not a backup file$/);
    }
    const pkg = overTheWire(await takeBackup(a, KEY_A)) as BackupPackage;
    await expect(restoreBackup(b.sqlite, KEY_B, { ...pkg, format: "someone-elses-backup" }, PASSPHRASE)).rejects.toThrow(/not a Hydrogen backup file/);
    survived();
  });

  it("rejects secrets sealed with a key-derivation function it does not implement", async () => {
    const pkg = overTheWire(await takeBackup(a, KEY_A)) as BackupPackage;
    (pkg.secrets as { kdf: string }).kdf = "argon2";
    await expect(restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).rejects.toThrow(PassphraseError);
    await expect(restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).rejects.toThrow(/unsupported key-derivation function/);
    survived();
  });

  it("rolls back when a hosted tool arrives without its sealed headers", async () => {
    makeTool(a, KEY_A);
    const pkg = await resealed(overTheWire(await takeBackup(a, KEY_A)) as BackupPackage, (secrets) => {
      delete secrets.toolHeaders;
    });
    expect(pkg.tables.hosted_tools).toHaveLength(1);

    const attempt = restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE);
    await expect(attempt).rejects.toThrow(BackupError);
    await expect(attempt).rejects.toThrow("Missing sealed tool headers");
    // Providers come before hosted tools, so they had already been written.
    survived();
    expect(new ProviderRepo(b.db, KEY_B).list()).toHaveLength(0);
    expect(new HostedToolRepo(b.db, KEY_B).list()).toHaveLength(0);
  });

  it("rolls back the whole transaction when a row is bad", async () => {
    const pkg = overTheWire(await takeBackup(a, KEY_A)) as BackupPackage;
    // A mapping pointing at a model the package does not contain: the FK fails
    // partway through, after earlier tables have already been written.
    pkg.tables.model_providers.push({ ...pkg.tables.model_providers[0], id: 999, model_id: 4242 });
    await expect(restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).rejects.toThrow(BackupError);
    survived();
    expect(new ProviderRepo(b.db, KEY_B).list()).toHaveLength(0);
  });
});
