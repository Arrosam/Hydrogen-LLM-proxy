/**
 * E1: a package that would leave the instance without an enabled admin is
 * rejected before anything is deleted.
 * E12: RestoreReport.providerKeysRestored counts provider rows that ended up
 * with a key, not sealed entries.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { openDatabase, type DB } from "../src/db";
import { verifyOrInitMasterKey } from "../src/security/masterKey";
import { ProviderRepo } from "../src/persistence/providerRepo";
import { UserRepo } from "../src/persistence/userRepo";
import { BackupError, exportBackup, restoreBackup, type BackupPackage } from "../src/backup/archive";
import { sealWithPassphrase } from "../src/security/passphrase";

const KEY_A = Buffer.alloc(32, 11);
const KEY_B = Buffer.alloc(32, 13);
const PASSPHRASE = "fix-exec-backup passphrase";

interface Instance { dir: string; sqlite: BetterSqlite3.Database; db: DB }
async function open(masterKey: Buffer, admin: string): Promise<Instance> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydro-fix-backup-"));
  const { db, sqlite } = openDatabase(dir);
  verifyOrInitMasterKey(db, masterKey);
  await new UserRepo(db).create({ username: admin, password: "an-admin-password", role: "admin", enabled: true });
  return { dir, sqlite, db };
}
function close(i: Instance): void {
  i.sqlite.close();
  fs.rmSync(i.dir, { recursive: true, force: true });
}

let a: Instance;
let b: Instance;
beforeEach(async () => { a = await open(KEY_A, "admin-a"); b = await open(KEY_B, "admin-b"); });
afterEach(() => { close(a); close(b); });

const backup = async (): Promise<BackupPackage> =>
  JSON.parse(JSON.stringify(await exportBackup(a.sqlite, KEY_A, { passphrase: PASSPHRASE, includeLogs: false, includeImageCache: false, appVersion: "t" }))) as BackupPackage;
const usernames = (i: Instance): string[] => new UserRepo(i.db).list().map((u) => u.username);

describe("E1: restore never leaves the instance without an admin", () => {
  const rejected = async (pkg: BackupPackage): Promise<void> => {
    await expect(restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).rejects.toThrow(BackupError);
    await expect(restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE)).rejects.toThrow(/no enabled admin user/);
    expect(usernames(b)).toEqual(["admin-b"]);
  };

  it("rejects an empty users table and deletes nothing", async () => {
    const pkg = await backup();
    pkg.tables.users = [];
    await rejected(pkg);
  });

  it("rejects a users table with only managers", async () => {
    const pkg = await backup();
    pkg.tables.users = pkg.tables.users.map((u) => ({ ...u, role: "manager" }));
    await rejected(pkg);
  });

  it("rejects a users table whose only admin is disabled", async () => {
    const pkg = await backup();
    pkg.tables.users = pkg.tables.users.map((u) => ({ ...u, enabled: 0 }));
    await rejected(pkg);
  });

  it("is checked before the passphrase is even tried", async () => {
    const pkg = await backup();
    pkg.tables.users = [];
    await expect(restoreBackup(b.sqlite, KEY_B, pkg, "wrong passphrase")).rejects.toThrow(/no enabled admin user/);
  });

  it("still restores a package with an enabled admin", async () => {
    const report = await restoreBackup(b.sqlite, KEY_B, await backup(), PASSPHRASE);
    expect(report.restored.users).toBe(1);
    expect(usernames(b)).toEqual(["admin-a"]);
  });
});

describe("E12: providerKeysRestored counts provider rows that got a key", () => {
  it("ignores an empty sealed key and a sealed entry for no provider row", async () => {
    const providers = new ProviderRepo(a.db, KEY_A);
    const keyed = providers.create({ name: "keyed", type: "openai_completion", baseUrl: "https://e.test/v1", apiKey: "sk-a" });
    const emptied = providers.create({ name: "emptied", type: "openai_completion", baseUrl: "https://e.test/v1", apiKey: "sk-b" });
    providers.create({ name: "keyless", type: "anthropic", baseUrl: "https://e.test", apiKey: null });
    const pkg = await backup();
    pkg.secrets = await sealWithPassphrase(
      JSON.stringify({ providerKeys: [{ id: keyed.id, apiKey: "sk-a" }, { id: emptied.id, apiKey: "" }, { id: 9999, apiKey: "sk-orphan" }] }),
      PASSPHRASE,
    );
    const report = await restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE);
    expect(report.restored.providers).toBe(3);
    expect(report.providerKeysRestored).toBe(1);
  });
});
