/**
 * Independent verification, written from the spec only (EXEC E1, E12).
 *
 * E1  A backup whose user list holds no enabled admin is refused and the
 *     target instance is left exactly as it was.
 * E12 The restore report's `providerKeysRestored` is the number of providers
 *     that actually end up with a key.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { openDatabase, type DB } from "../src/db";
import { verifyOrInitMasterKey } from "../src/security/masterKey";
import { ProviderRepo } from "../src/persistence/providerRepo";
import { exportBackup, restoreBackup, type BackupPackage } from "../src/backup/archive";
import { openWithPassphrase, sealWithPassphrase } from "../src/security/passphrase";

const KEY_A = Buffer.alloc(32, 21);
const KEY_B = Buffer.alloc(32, 22);
const PASSPHRASE = "verify exec backup passphrase";

interface Instance { dir: string; sqlite: BetterSqlite3.Database; db: DB }
type Row = Record<string, unknown>;

function open(masterKey: Buffer): Instance {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydro-verify-backup-"));
  const { db, sqlite } = openDatabase(dir);
  verifyOrInitMasterKey(db, masterKey);
  sqlite.prepare("INSERT INTO users (username, password_hash, role, enabled) VALUES ('admin', 'x', 'admin', 1)").run();
  return { dir, sqlite, db };
}
function close(i: Instance): void {
  i.sqlite.close();
  fs.rmSync(i.dir, { recursive: true, force: true });
}

let a: Instance;
let b: Instance;
beforeEach(() => { a = open(KEY_A); b = open(KEY_B); });
afterEach(() => { close(a); close(b); });

const takeBackup = async (i: Instance, key: Buffer): Promise<BackupPackage> =>
  JSON.parse(JSON.stringify(
    await exportBackup(i.sqlite, key, { passphrase: PASSPHRASE, includeLogs: false, includeImageCache: false, appVersion: "t" }),
  )) as BackupPackage;

const rows = (i: Instance, table: string): Row[] => i.sqlite.prepare(`SELECT * FROM "${table}" ORDER BY id`).all() as Row[];
const addUser = (i: Instance, username: string, role: string, enabled: 0 | 1): void => {
  i.sqlite.prepare("INSERT INTO users (username, password_hash, role, enabled) VALUES (?, 'x', ?, ?)").run(username, role, enabled);
};
/** The user rows of a package, re-shaped; every other field of each row is kept. */
function withUsers(pkg: BackupPackage, edit: (users: Row[]) => Row[]): BackupPackage {
  const tables = pkg.tables as Record<string, Row[]>;
  return { ...pkg, tables: { ...tables, users: edit(tables.users.map((u) => ({ ...u }))) } } as BackupPackage;
}

describe("E1: a backup without an enabled admin is refused, and nothing changes", () => {
  /** What the target holds before the attempt -- and must still hold after. */
  function seedTarget(): { users: Row[]; providers: Row[] } {
    addUser(b, "target-manager", "manager", 1);
    new ProviderRepo(b.db, KEY_B).create({ name: "target-prov", type: "openai_completion", baseUrl: "https://target.test/v1", apiKey: "sk-target" });
    return { users: rows(b, "users"), providers: rows(b, "providers") };
  }
  /** A source with different content, so a partial restore would be visible. */
  async function sourcePackage(): Promise<BackupPackage> {
    addUser(a, "source-manager", "manager", 1);
    new ProviderRepo(a.db, KEY_A).create({ name: "source-prov", type: "anthropic", baseUrl: "https://source.test", apiKey: "sk-source" });
    return takeBackup(a, KEY_A);
  }
  const expectUntouched = (before: { users: Row[]; providers: Row[] }): void => {
    expect(rows(b, "users")).toEqual(before.users);
    expect(rows(b, "providers")).toEqual(before.providers);
    expect(new ProviderRepo(b.db, KEY_B).list().map((p) => p.name)).toEqual(["target-prov"]);
  };

  it("an empty user list is rejected", async () => {
    const before = seedTarget();
    const pkg = withUsers(await sourcePackage(), () => []);
    await expect(restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).rejects.toThrow();
    expectUntouched(before);
  });

  it("a user list of managers only is rejected", async () => {
    const before = seedTarget();
    const pkg = withUsers(await sourcePackage(), (users) => users.filter((u) => u.role !== "admin"));
    expect((pkg.tables as Record<string, Row[]>).users.length).toBeGreaterThan(0);
    await expect(restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).rejects.toThrow();
    expectUntouched(before);
  });

  it("a user list whose only admin is disabled is rejected", async () => {
    const before = seedTarget();
    const pkg = withUsers(await sourcePackage(), (users) => users.map((u) => (u.role === "admin" ? { ...u, enabled: 0 } : u)));
    await expect(restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).rejects.toThrow();
    expectUntouched(before);
  });

  it("a disabled admin next to enabled managers is still rejected", async () => {
    const before = seedTarget();
    a.sqlite.prepare("UPDATE users SET enabled = 0 WHERE role = 'admin'").run();
    const pkg = await sourcePackage();
    await expect(restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).rejects.toThrow();
    expectUntouched(before);
  });

  it("the refusal is repeatable -- a second attempt still changes nothing", async () => {
    const before = seedTarget();
    const pkg = withUsers(await sourcePackage(), () => []);
    await expect(restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).rejects.toThrow();
    await expect(restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).rejects.toThrow();
    expectUntouched(before);
  });

  it("unchanged: a backup with an enabled admin restores and replaces the target", async () => {
    seedTarget();
    const pkg = await sourcePackage();
    await expect(restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).resolves.toBeDefined();
    expect(rows(b, "users").map((u) => u.username)).toEqual(["admin", "source-manager"]);
    expect(new ProviderRepo(b.db, KEY_B).list().map((p) => p.name)).toEqual(["source-prov"]);
  });

  it("unchanged: one enabled admin among a disabled admin and managers is enough", async () => {
    seedTarget();
    addUser(a, "old-admin", "admin", 0);
    const pkg = await sourcePackage();
    await expect(restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).resolves.toBeDefined();
    expect(rows(b, "users").map((u) => u.username)).toEqual(["admin", "old-admin", "source-manager"]);
  });
});

describe("E12: providerKeysRestored counts providers that end up with a key", () => {
  const reseal = async (pkg: BackupPackage, edit: (secrets: Record<string, unknown>) => void): Promise<BackupPackage> => {
    const secrets = JSON.parse(await openWithPassphrase(pkg.secrets, PASSPHRASE)) as Record<string, unknown>;
    edit(secrets);
    return JSON.parse(JSON.stringify({ ...pkg, secrets: await sealWithPassphrase(JSON.stringify(secrets), PASSPHRASE) })) as BackupPackage;
  };
  /** Providers in the target holding a complete stored key. */
  const keyed = (): number =>
    rows(b, "providers").filter((r) => r.key_ciphertext != null && r.key_iv != null && r.key_tag != null).length;

  function seedProviders(): { one: number; two: number; keyless: number } {
    const repo = new ProviderRepo(a.db, KEY_A);
    const one = repo.create({ name: "one", type: "openai_completion", baseUrl: "https://one.test/v1", apiKey: "sk-one" }).id;
    const two = repo.create({ name: "two", type: "openai_completion", baseUrl: "https://two.test/v1", apiKey: "sk-two" }).id;
    const keyless = repo.create({ name: "keyless", type: "anthropic", baseUrl: "https://none.test", apiKey: null }).id;
    return { one, two, keyless };
  }

  it("two keyed providers and one keyless: 2", async () => {
    seedProviders();
    const report = await restoreBackup(b.sqlite, KEY_B, await takeBackup(a, KEY_A), PASSPHRASE);
    expect(keyed()).toBe(2);
    expect(report.providerKeysRestored).toBe(2);
  });

  it("no providers at all: 0", async () => {
    const report = await restoreBackup(b.sqlite, KEY_B, await takeBackup(a, KEY_A), PASSPHRASE);
    expect(report.providerKeysRestored).toBe(0);
  });

  it("a sealed key for a provider id that is not in the package is not counted", async () => {
    const s = seedProviders();
    const orphanId = s.keyless + 1000;
    const pkg = await reseal(await takeBackup(a, KEY_A), (secrets) => {
      secrets.providerKeys = [
        { id: s.one, apiKey: "sk-one" },
        { id: orphanId, apiKey: "sk-orphan" },
      ];
    });
    const report = await restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE);
    expect(rows(b, "providers").map((r) => r.id)).not.toContain(orphanId);
    expect(keyed()).toBe(1);
    expect(report.providerKeysRestored).toBe(1);
  });

  it("only orphan sealed keys: 0", async () => {
    const s = seedProviders();
    const pkg = await reseal(await takeBackup(a, KEY_A), (secrets) => {
      secrets.providerKeys = [{ id: s.keyless + 1000, apiKey: "sk-orphan" }, { id: s.keyless + 1001, apiKey: "sk-orphan-2" }];
    });
    const report = await restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE);
    expect(keyed()).toBe(0);
    expect(report.providerKeysRestored).toBe(0);
  });

  it("two sealed entries for the same provider count once", async () => {
    const s = seedProviders();
    const pkg = await reseal(await takeBackup(a, KEY_A), (secrets) => {
      secrets.providerKeys = [{ id: s.one, apiKey: "first" }, { id: s.one, apiKey: "second" }];
    });
    const report = await restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE);
    expect(keyed()).toBe(1);
    expect(report.providerKeysRestored).toBe(1);
  });

  it("an empty sealed key leaves the provider keyless and is not counted", async () => {
    const s = seedProviders();
    const pkg = await reseal(await takeBackup(a, KEY_A), (secrets) => {
      secrets.providerKeys = [{ id: s.one, apiKey: "" }, { id: s.two, apiKey: "sk-two" }];
    });
    const report = await restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE);
    expect(report.providerKeysRestored).toBe(keyed());
    expect(report.providerKeysRestored).toBe(1);
  });
});
