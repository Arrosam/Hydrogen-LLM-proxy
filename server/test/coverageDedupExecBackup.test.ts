import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { openDatabase, type DB } from "../src/db";
import { verifyOrInitMasterKey } from "../src/security/masterKey";
import { ProviderRepo } from "../src/persistence/providerRepo";
import { ProxyRepo } from "../src/persistence/proxyRepo";
import { TokenRepo } from "../src/persistence/tokenRepo";
import { exportBackup, restoreBackup, type BackupPackage } from "../src/backup/archive";
import { openWithPassphrase, sealWithPassphrase } from "../src/security/passphrase";
import { decryptSecret } from "../src/security/crypto";

// Characterization of the per-table secret handling in backup export/restore:
// what is sealed, what a missing or empty sealed value restores as, and the
// one place where providers differ from proxies and tokens.

const KEY_A = Buffer.alloc(32, 3);
const KEY_B = Buffer.alloc(32, 5);
const PASSPHRASE = "a passphrase for the dedup tests";

interface Instance { dir: string; sqlite: BetterSqlite3.Database; db: DB }
function open(masterKey: Buffer): Instance {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydro-dedup-backup-"));
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

let a: Instance;
let b: Instance;
beforeEach(() => { a = open(KEY_A); b = open(KEY_B); });
afterEach(() => { close(a); close(b); });

const backup = (i: Instance, key: Buffer) => exportBackup(i.sqlite, key, { passphrase: PASSPHRASE, includeLogs: false, includeImageCache: false, appVersion: "t" });
const sealed = async (pkg: BackupPackage) => JSON.parse(await openWithPassphrase(pkg.secrets, PASSPHRASE)) as Record<string, Array<Record<string, unknown>>>;
const reseal = async (pkg: BackupPackage, secrets: unknown): Promise<BackupPackage> =>
  JSON.parse(JSON.stringify({ ...pkg, secrets: await sealWithPassphrase(JSON.stringify(secrets), PASSPHRASE) })) as BackupPackage;
const row = (i: Instance, table: string, id: number) => i.sqlite.prepare(`SELECT * FROM "${table}" WHERE id = ?`).get(id) as Record<string, string | null>;
const open3 = (r: Record<string, string | null>, prefix: string, key: Buffer) =>
  decryptSecret({ ciphertext: r[`${prefix}_ciphertext`]!, iv: r[`${prefix}_iv`]!, tag: r[`${prefix}_tag`]! }, key);

function seed() {
  const provider = new ProviderRepo(a.db, KEY_A).create({ name: "prov", type: "openai_completion", baseUrl: "https://e.test/v1", apiKey: "sk-prov" });
  const proxy = new ProxyRepo(a.db, KEY_A).create({ name: "px", scheme: "http", host: "127.0.0.1", port: 8080, username: "u", password: "px-pass" });
  const { token, secret } = new TokenRepo(a.db, KEY_A).create({ name: "tok" });
  return { provider, proxy, token, secret };
}

describe("backup secret tables", () => {
  it("seals one entry per row with a complete secret, in a fixed payload shape", async () => {
    const s = seed();
    const keyless = new ProviderRepo(a.db, KEY_A).create({ name: "keyless", type: "anthropic", baseUrl: "https://e.test", apiKey: null });
    const pkg = await backup(a, KEY_A);
    const secrets = await sealed(pkg);
    expect(Object.keys(secrets)).toEqual(["providerKeys", "tokenKeys", "proxyPasswords", "toolHeaders"]);
    expect(secrets.providerKeys).toEqual([{ id: s.provider.id, apiKey: "sk-prov" }]);
    expect(secrets.proxyPasswords).toEqual([{ id: s.proxy.id, password: "px-pass" }]);
    expect(secrets.tokenKeys).toEqual([{ id: s.token.id, secret: s.secret }]);
    expect(secrets.toolHeaders).toEqual([]);
    expect(pkg.tables.providers.map((r) => r.id)).toEqual([s.provider.id, keyless.id]);
    for (const [table, prefix] of [["providers", "key"], ["tokens", "key"], ["proxies", "password"]] as const) {
      for (const r of pkg.tables[table]) {
        for (const part of ["ciphertext", "iv", "tag"]) expect(r).not.toHaveProperty(`${prefix}_${part}`);
      }
    }
  });

  it("a row holding only part of a secret seals nothing", async () => {
    const s = seed();
    a.sqlite.prepare(`UPDATE providers SET key_iv = NULL WHERE id = ?`).run(s.provider.id);
    a.sqlite.prepare(`UPDATE proxies SET password_tag = NULL WHERE id = ?`).run(s.proxy.id);
    a.sqlite.prepare(`UPDATE tokens SET key_ciphertext = NULL WHERE id = ?`).run(s.token.id);
    const secrets = await sealed(await backup(a, KEY_A));
    expect(secrets.providerKeys).toEqual([]);
    expect(secrets.proxyPasswords).toEqual([]);
    expect(secrets.tokenKeys).toEqual([]);
  });

  it("restores the three columns last, in ciphertext/iv/tag order, re-encrypted under the target key", async () => {
    const s = seed();
    const report = await restoreBackup(b.sqlite, KEY_B, JSON.parse(JSON.stringify(await backup(a, KEY_A))), PASSPHRASE);
    expect(report.providerKeysRestored).toBe(1);
    expect(open3(row(b, "providers", s.provider.id), "key", KEY_B)).toBe("sk-prov");
    expect(open3(row(b, "proxies", s.proxy.id), "password", KEY_B)).toBe("px-pass");
    expect(open3(row(b, "tokens", s.token.id), "key", KEY_B)).toBe(s.secret);
  });

  it("a row with no sealed entry restores with three NULL columns", async () => {
    const s = seed();
    const pkg = await reseal(await backup(a, KEY_A), { providerKeys: [] });
    const report = await restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE);
    expect(report.providerKeysRestored).toBe(0);
    expect(row(b, "providers", s.provider.id)).toMatchObject({ key_ciphertext: null, key_iv: null, key_tag: null });
    expect(row(b, "proxies", s.proxy.id)).toMatchObject({ password_ciphertext: null, password_iv: null, password_tag: null });
    expect(row(b, "tokens", s.token.id)).toMatchObject({ key_ciphertext: null, key_iv: null, key_tag: null });
  });

  it("an EMPTY sealed value: a provider restores keyless, a proxy and a token keep an encrypted empty string", async () => {
    const s = seed();
    const pkg = await reseal(await backup(a, KEY_A), {
      providerKeys: [{ id: s.provider.id, apiKey: "" }],
      proxyPasswords: [{ id: s.proxy.id, password: "" }],
      tokenKeys: [{ id: s.token.id, secret: "" }],
    });
    const report = await restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE);
    // The report counts rows that ended up with a key, not sealed entries.
    expect(report.providerKeysRestored).toBe(0);
    expect(row(b, "providers", s.provider.id)).toMatchObject({ key_ciphertext: null, key_iv: null, key_tag: null });
    expect(open3(row(b, "proxies", s.proxy.id), "password", KEY_B)).toBe("");
    expect(open3(row(b, "tokens", s.token.id), "key", KEY_B)).toBe("");
  });

  it("the last sealed entry for an id wins", async () => {
    const s = seed();
    const pkg = await reseal(await backup(a, KEY_A), {
      providerKeys: [{ id: s.provider.id, apiKey: "first" }, { id: s.provider.id, apiKey: "second" }],
      proxyPasswords: [{ id: s.proxy.id, password: "first" }, { id: s.proxy.id, password: "second" }],
      tokenKeys: [{ id: s.token.id, secret: "first" }, { id: s.token.id, secret: "second" }],
    });
    const report = await restoreBackup(b.sqlite, KEY_B, pkg, PASSPHRASE);
    expect(report.providerKeysRestored).toBe(1);
    expect(open3(row(b, "providers", s.provider.id), "key", KEY_B)).toBe("second");
    expect(open3(row(b, "proxies", s.proxy.id), "password", KEY_B)).toBe("second");
    expect(open3(row(b, "tokens", s.token.id), "key", KEY_B)).toBe("second");
  });
});
