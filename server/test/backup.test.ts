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
import { BackupError, exportBackup, restoreBackup, type BackupPackage } from "../src/backup/archive";
import { PassphraseError, openWithPassphrase, sealWithPassphrase } from "../src/security/passphrase";

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
    promptTokens: 1, completionTokens: 2, totalTokens: 3, latencyMs: 5,
    attempts: 1, attemptPath: [{ step: 1 }], error: null,
  };
  logs.insert(log);
  void keyless;
}

const takeBackup = (i: Instance, key: Buffer, includeLogs = true): BackupPackage =>
  exportBackup(i.sqlite, key, { passphrase: PASSPHRASE, includeLogs, appVersion: "1.0.0" });

/** Round-trip through JSON: a real package arrives as a parsed file, not as the
 * live object the exporter returned. */
const overTheWire = (pkg: BackupPackage): unknown => JSON.parse(JSON.stringify(pkg));

describe("passphrase sealing", () => {
  it("opens what it sealed", () => {
    expect(openWithPassphrase(sealWithPassphrase("hello", "pass-phrase-1"), "pass-phrase-1")).toBe("hello");
  });

  it("refuses the wrong passphrase", () => {
    const sealed = sealWithPassphrase("hello", "pass-phrase-1");
    expect(() => openWithPassphrase(sealed, "pass-phrase-2")).toThrow(PassphraseError);
  });

  it("refuses a tampered payload", () => {
    const sealed = sealWithPassphrase("hello", "pass-phrase-1");
    const tampered = { ...sealed, ciphertext: Buffer.from("evil").toString("base64") };
    expect(() => openWithPassphrase(tampered, "pass-phrase-1")).toThrow(PassphraseError);
  });

  it("uses a fresh salt each time, so equal secrets do not look equal", () => {
    const a = sealWithPassphrase("same", "pass-phrase-1");
    const b = sealWithPassphrase("same", "pass-phrase-1");
    expect(a.salt).not.toBe(b.salt);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("rejects absurd KDF parameters rather than hanging on them", () => {
    const sealed = sealWithPassphrase("hello", "pass-phrase-1");
    expect(() => openWithPassphrase({ ...sealed, n: 1 << 30 }, "pass-phrase-1")).toThrow(PassphraseError);
  });
});

describe("backup package", () => {
  let a: Instance;

  beforeEach(() => {
    a = open(KEY_A);
    seed(a, KEY_A);
  });
  afterEach(() => close(a));

  it("never carries the master-key-encrypted columns", () => {
    const pkg = takeBackup(a, KEY_A);
    for (const row of pkg.tables.providers) {
      expect(row).not.toHaveProperty("key_ciphertext");
      expect(row).not.toHaveProperty("key_iv");
      expect(row).not.toHaveProperty("key_tag");
    }
  });

  it("never carries an API key in the clear", () => {
    const pkg = takeBackup(a, KEY_A);
    expect(JSON.stringify(pkg.tables)).not.toContain(API_KEY);
    expect(JSON.stringify(pkg.secrets)).not.toContain(API_KEY);
  });

  it("does not export the master-key sentinel", () => {
    const pkg = takeBackup(a, KEY_A);
    expect(pkg.tables.settings.map((r) => r.key)).not.toContain("master_key_check");
  });

  it("omits logs when asked to", () => {
    const pkg = takeBackup(a, KEY_A, false);
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

  it("brings the provider key back, usable under the new key", () => {
    const pkg = takeBackup(a, KEY_A);
    restoreBackup(b.sqlite, KEY_B, overTheWire(pkg), PASSPHRASE);

    const providers = new ProviderRepo(b.db, KEY_B);
    const restored = providers.getByName("siliconflow")!;
    expect(providers.toUpstream(restored).apiKey).toBe(API_KEY);
  });

  it("keeps a keyless provider keyless", () => {
    restoreBackup(b.sqlite, KEY_B, overTheWire(takeBackup(a, KEY_A)), PASSPHRASE);
    const providers = new ProviderRepo(b.db, KEY_B);
    expect(providers.toUpstream(providers.getByName("keyless")!).apiKey).toBeNull();
  });

  it("restores every table verbatim", () => {
    restoreBackup(b.sqlite, KEY_B, overTheWire(takeBackup(a, KEY_A)), PASSPHRASE);

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

  it("leaves the target's own sentinel intact, so it still boots", () => {
    restoreBackup(b.sqlite, KEY_B, overTheWire(takeBackup(a, KEY_A)), PASSPHRASE);
    // The restored instance must still recognise ITS key, not the source's.
    expect(() => verifyOrInitMasterKey(b.db, KEY_B)).not.toThrow();
    expect(() => verifyOrInitMasterKey(b.db, KEY_A)).toThrow();
  });

  it("replaces what was there instead of merging into it", () => {
    const models = new ModelRepo(b.db);
    models.create({ name: "leftover-from-before", description: null });
    restoreBackup(b.sqlite, KEY_B, overTheWire(takeBackup(a, KEY_A)), PASSPHRASE);
    expect(models.getByName("leftover-from-before")).toBeUndefined();
    expect(models.list()).toHaveLength(1);
  });

  it("is idempotent — restoring the same package twice is a no-op", () => {
    const pkg = overTheWire(takeBackup(a, KEY_A));
    restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE);
    restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE);
    expect(new ModelRepo(b.db).list()).toHaveLength(1);
    expect(new ProviderRepo(b.db, KEY_B).list()).toHaveLength(2);
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

  it("rejects a wrong passphrase before deleting anything", () => {
    expect(() => restoreBackup(b.sqlite, KEY_B, overTheWire(takeBackup(a, KEY_A)), "not-the-passphrase")).toThrow(
      PassphraseError,
    );
    survived();
  });

  it("rejects a file that is not a backup", () => {
    expect(() => restoreBackup(b.sqlite, KEY_B, { hello: "world" }, PASSPHRASE)).toThrow(BackupError);
    survived();
  });

  it("rejects a future package version", () => {
    const pkg = { ...(overTheWire(takeBackup(a, KEY_A)) as BackupPackage), version: 99 };
    expect(() => restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).toThrow(/unsupported backup version/);
    survived();
  });

  it("rejects an unknown table rather than writing part of the package", () => {
    const pkg = overTheWire(takeBackup(a, KEY_A)) as BackupPackage;
    (pkg.tables as Record<string, unknown[]>).evil_table = [{ id: 1 }];
    expect(() => restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).toThrow(BackupError);
    survived();
  });

  it("rolls back the whole transaction when a row is bad", () => {
    const pkg = overTheWire(takeBackup(a, KEY_A)) as BackupPackage;
    // A mapping pointing at a model the package does not contain: the FK fails
    // partway through, after earlier tables have already been written.
    pkg.tables.model_providers.push({ ...pkg.tables.model_providers[0], id: 999, model_id: 4242 });
    expect(() => restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).toThrow(BackupError);
    survived();
    expect(new ProviderRepo(b.db, KEY_B).list()).toHaveLength(0);
  });
});
