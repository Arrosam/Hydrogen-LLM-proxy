/**
 * Upgrade path from a pre-split release: a DATA_DIR holding hydrogen.db and
 * no hydro.db gets its rows copied into the package-owned tables on the first
 * boot, the legacy file stays byte-for-byte untouched, and every later boot
 * ignores it. The legacy database here is built with the real legacy
 * migration chain, so its shape is exactly what v2.0.0 left on disk.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { encryptSecret } from "@areelai/common";
import { createSupplierStores } from "@areelai/supplier-management";
import { createUserStores } from "@areelai/user-management";
import { createModelServiceStores } from "@areelai/model-services";
import { DB_FILE, LEGACY_DB_FILE, openDatabase } from "../src/db/index.js";
import { legacyImportRecord } from "../src/db/legacyImport.js";
import { verifyOrInitMasterKey } from "../src/security/masterKey.js";

const LEGACY_MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../legacy-migrations");
const KEY = Buffer.alloc(32, 9);

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** A v2.0.0-shaped hydrogen.db with a little of everything in it. */
function buildLegacy(file: string): void {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  migrate(drizzle(sqlite), { migrationsFolder: LEGACY_MIGRATIONS });

  sqlite.prepare("INSERT INTO users (username, password_hash, role, enabled, must_change_password) VALUES (?, ?, ?, 1, 0)").run("admin", "$argon2id$fake", "admin");
  sqlite.prepare("INSERT INTO proxies (name, scheme, host, port) VALUES (?, 'http', 'proxy.local', 7890)").run("corp");
  const key = encryptSecret("sk-legacy-provider-key", KEY);
  sqlite
    .prepare("INSERT INTO providers (name, type, base_url, key_ciphertext, key_iv, key_tag, proxy_id, enabled) VALUES (?, 'openai_completion', ?, ?, ?, ?, 1, 1)")
    .run("openai", "https://api.openai.com/v1", key.ciphertext, key.iv, key.tag);
  sqlite.prepare("INSERT INTO models (name, enabled) VALUES (?, 1)").run("gpt");
  sqlite.prepare("INSERT INTO model_providers (model_id, provider_id, upstream_model, priority, enabled) VALUES (1, 1, ?, 0, 1)").run("gpt-4o");
  sqlite
    .prepare("INSERT INTO model_services (name, kind, definition_json, enabled) VALUES (?, 'model_service', ?, 1)")
    .run("chat", JSON.stringify({ kind: "model_service", timeoutMs: 60_000, steps: [{ model: "gpt", provider: "openai" }] }));
  sqlite
    .prepare("INSERT INTO model_services (name, kind, definition_json, enabled) VALUES (?, 'micro_agent', ?, 1)")
    .run("agent", JSON.stringify({ kind: "micro_agent", timeoutMs: 60_000, stages: [{ name: "s", service: "chat", input: [] }] }));
  sqlite
    .prepare("INSERT INTO tokens (name, key_hash, key_prefix, owner_user_id, scope_services_json, used_requests, used_tokens, enabled) VALUES (?, ?, ?, 1, ?, 3, 40, 1)")
    .run("client", "a".repeat(64), "sk-abc123", JSON.stringify([1]));
  const sentinel = encryptSecret("hydrogen-master-key-ok", KEY);
  sqlite.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("master_key_check", JSON.stringify(sentinel));
  sqlite.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("ui_language", "zh");
  sqlite
    .prepare("INSERT INTO request_logs (trace_id, token_id, service_id, requested_service, ingress_format, streaming, http_status, prompt_tokens, completion_tokens, total_tokens, latency_ms, attempts) VALUES (?, 1, 1, 'chat', 'openai_completion', 0, 200, 10, 5, 15, 120, 1)")
    .run("trace-1");
  sqlite.close();
}

let dir: string;
let legacyFile: string;
let hashBefore: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydro-legacy-"));
  legacyFile = path.join(dir, LEGACY_DB_FILE);
  buildLegacy(legacyFile);
  hashBefore = sha256(legacyFile);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("legacy hydrogen.db import", () => {
  it("copies every table into the new database on the first boot and leaves the legacy file untouched", () => {
    const opened = openDatabase(dir);
    try {
      expect(opened.legacyImport).not.toBeNull();
      const report = opened.legacyImport!;
      expect(report.migrated).toBe(true);
      expect(report.tables).toMatchObject({
        users: 1, proxies: 1, providers: 1, models: 1, model_providers: 1, model_services: 2, tokens: 1, request_logs: 1,
      });
      expect(report.tables.settings).toBeGreaterThanOrEqual(2);
      expect(fs.existsSync(path.join(dir, DB_FILE))).toBe(true);

      // The record survives in the new database for later diagnostics.
      expect(legacyImportRecord(opened.sqlite)?.source).toBe(legacyFile);

      // The same master key still opens the imported secrets: the sentinel
      // and the provider key came across as ciphertext, verbatim.
      expect(() => verifyOrInitMasterKey(opened.db, KEY)).not.toThrow();
      const supplier = createSupplierStores(opened.sqlite, KEY);
      const provider = supplier.providers.getByName("openai")!;
      expect(supplier.providers.toUpstream(provider).apiKey).toBe("sk-legacy-provider-key");
      expect(supplier.providers.toUpstream(provider).proxy?.host).toBe("proxy.local");
      expect(supplier.catalog.resolve("gpt", "openai").ok).toBe(true);

      const user = createUserStores(opened.sqlite, KEY);
      expect(user.users.get(1)?.username).toBe("admin");
      const token = user.tokens.get(1)!;
      expect(token.usedRequests).toBe(3);
      expect(token.scopeServices).toEqual([1]);

      const ms = createModelServiceStores(opened.sqlite, KEY);
      expect(ms.services.list().map((s) => [s.name, s.kind])).toEqual([["chat", "model_service"], ["agent", "micro_agent"]]);

      expect(opened.sqlite.prepare("SELECT value FROM settings WHERE key = 'ui_language'").get()).toEqual({ value: "zh" });
      expect(opened.sqlite.prepare("SELECT count(*) AS n FROM request_logs").get()).toEqual({ n: 1 });
    } finally {
      opened.sqlite.close();
    }
    expect(sha256(legacyFile)).toBe(hashBefore);
  });

  it("ignores the legacy file once hydro.db exists, so nothing is imported twice", () => {
    const opened = openDatabase(dir);
    try {
      expect(opened.legacyImport).toBeNull();
      expect(createUserStores(opened.sqlite, KEY).users.list().length).toBe(1);
      expect(opened.sqlite.prepare("SELECT count(*) AS n FROM request_logs").get()).toEqual({ n: 1 });
    } finally {
      opened.sqlite.close();
    }
    expect(sha256(legacyFile)).toBe(hashBefore);
  });

  it("starts empty when there is no legacy file at all", () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "hydro-fresh-"));
    const opened = openDatabase(fresh);
    try {
      expect(opened.legacyImport).toBeNull();
      expect(createUserStores(opened.sqlite, KEY).users.list()).toEqual([]);
    } finally {
      opened.sqlite.close();
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});
