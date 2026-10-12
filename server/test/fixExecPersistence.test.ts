/**
 * E7: `hasKey` / `hasPassword` use the same three-column test as the decrypt
 *     helpers, so a partially written secret is never advertised as present.
 * E8: a bare-number duration in the settings table is milliseconds, as in env.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { openDatabase, type DB } from "../src/db";
import { ProviderRepo } from "../src/persistence/providerRepo";
import { ProxyRepo } from "../src/persistence/proxyRepo";
import { parseDurationToMs, SettingsRepo } from "../src/persistence/settingsRepo";

const KEY = Buffer.alloc(32, 21);
let dir: string;
let sqlite: BetterSqlite3.Database;
let db: DB;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydro-fix-persist-"));
  ({ db, sqlite } = openDatabase(dir));
});
afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("E7: a secret with a missing column is not reported as stored", () => {
  it.each(["key_iv", "key_tag"])("provider: %s null -> hasKey false, and no key is materialized", (column) => {
    const providers = new ProviderRepo(db, KEY);
    const p = providers.create({ name: `partial-${column}`, type: "openai_completion", baseUrl: "https://e.test/v1", apiKey: "sk-x" });
    expect(providers.toPublic(p).hasKey).toBe(true);
    sqlite.prepare(`UPDATE providers SET ${column} = NULL WHERE id = ?`).run(p.id);
    const row = providers.get(p.id)!;
    expect(providers.toUpstream(row).apiKey).toBeNull();
    expect(providers.toPublic(row).hasKey).toBe(false);
  });

  it.each(["password_iv", "password_tag"])("proxy: %s null -> hasPassword false, and no password is materialized", (column) => {
    const proxies = new ProxyRepo(db, KEY);
    const p = proxies.create({ name: `partial-${column}`, scheme: "http", host: "127.0.0.1", port: 8080, password: "pw" });
    expect(proxies.toPublic(p).hasPassword).toBe(true);
    sqlite.prepare(`UPDATE proxies SET ${column} = NULL WHERE id = ?`).run(p.id);
    const row = proxies.get(p.id)!;
    expect(proxies.toEgress(row).password).toBeNull();
    expect(proxies.toPublic(row).hasPassword).toBe(false);
  });
});

describe("E8: bare-number durations", () => {
  it("are milliseconds, matching the env parser", () => {
    expect(parseDurationToMs("30")).toBe(30);
    expect(parseDurationToMs("90000")).toBe(90_000);
  });

  it("what the settings route stores keeps its meaning", () => {
    const settings = new SettingsRepo(db, { allowPrivate: false, logPayloadMaxChars: 1, simulatedStreamingTokenRate: 1, sessionTtlMs: 1, imageCacheMaxBytes: 1, promptCacheTtlMinutes: 1 });
    settings.setSessionTtlMs(7_200_000);
    expect(settings.get("session_ttl")).toBe("7200s");
    expect(settings.sessionTtlMs()).toBe(7_200_000);
  });
});
