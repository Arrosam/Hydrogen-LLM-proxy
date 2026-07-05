import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applyLegacyRenames } from "../src/db/legacy";

/** The pre-rename (v0.2 / 0000-baseline) subset touched by the rename. */
function oldSchema(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE model_use_behaviors (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      name text NOT NULL,
      steps_json text NOT NULL,
      enabled integer DEFAULT true NOT NULL
    );
    CREATE UNIQUE INDEX mub_name_idx ON model_use_behaviors (name);
    CREATE TABLE tokens (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      name text NOT NULL,
      scope_mubs_json text
    );
    CREATE TABLE request_logs (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      token_id integer,
      mub_id integer,
      mub_name text,
      http_status integer NOT NULL,
      FOREIGN KEY (mub_id) REFERENCES model_use_behaviors(id) ON DELETE SET NULL
    );
    CREATE INDEX request_logs_mub_idx ON request_logs (mub_id);
  `);
  return db;
}

function columns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
}

describe("applyLegacyRenames", () => {
  it("renames the MUB table/columns/indexes to Model Service names", () => {
    const db = oldSchema();
    applyLegacyRenames(db);

    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_services'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_use_behaviors'").get()).toBeUndefined();
    expect(columns(db, "request_logs")).toEqual(expect.arrayContaining(["service_id", "service_name"]));
    expect(columns(db, "request_logs")).not.toEqual(expect.arrayContaining(["mub_id"]));
    expect(columns(db, "tokens")).toContain("scope_services_json");
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='service_name_idx'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='request_logs_service_idx'").get()).toBeTruthy();

    // The renamed tables accept writes under the new names.
    db.prepare("INSERT INTO model_services (name, steps_json) VALUES ('svc', '{}')").run();
    db.prepare(
      "INSERT INTO request_logs (token_id, service_id, service_name, http_status) VALUES (NULL, 1, 'svc', 200)",
    ).run();
    expect(db.prepare("SELECT count(*) n FROM request_logs").get()).toEqual({ n: 1 });
  });

  it("is idempotent (second run is a no-op)", () => {
    const db = oldSchema();
    applyLegacyRenames(db);
    expect(() => applyLegacyRenames(db)).not.toThrow();
    expect(columns(db, "request_logs")).toContain("service_id");
  });

  it("leaves an already-renamed database untouched", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE model_services (id integer PRIMARY KEY, name text NOT NULL);
      CREATE UNIQUE INDEX service_name_idx ON model_services (name);
      CREATE TABLE tokens (id integer PRIMARY KEY, scope_services_json text);
      CREATE TABLE request_logs (id integer PRIMARY KEY, service_id integer, service_name text);
      CREATE INDEX request_logs_service_idx ON request_logs (service_id);
    `);
    expect(() => applyLegacyRenames(db)).not.toThrow();
    expect(columns(db, "request_logs")).toEqual(["id", "service_id", "service_name"]);
  });
});
