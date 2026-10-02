import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { openDatabase, schema, type DB } from "../src/db";
import { LogPruner } from "../src/persistence/logPruner";

let dir: string;
let sqlite: BetterSqlite3.Database;
let db: DB;
let pruner: LogPruner;
let executed: { query: string; params: unknown[] }[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydro-logpruner-"));
  sqlite = openDatabase(dir).sqlite;
  executed = [];
  db = drizzle(sqlite, { schema, logger: { logQuery(query, params) { executed.push({ query, params }); } } });
  pruner = new LogPruner(db);
});
afterEach(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function seed(n: number, body = ""): void {
  const insert = sqlite.prepare("insert into request_logs (trace_id, ingress_format, http_status, created_at, request_body) values (?, 'openai_completion', 200, ?, ?)");
  sqlite.transaction(() => {
    for (let i = 0; i < n; i++) insert.run(`synthetic-${i}`, n - i, body);
  })();
}
function ids(): number[] {
  return (sqlite.prepare("select id from request_logs order by id").all() as { id: number }[]).map(r => r.id);
}

describe("LogPruner row budget", () => {
  it.each([0, -1])("disabled cap %i leaves logs untouched without SQL", cap => {
    seed(3);
    expect(pruner.capRows(cap)).toBe(0);
    expect(ids()).toEqual([1, 2, 3]);
    expect(executed).toEqual([]);
  });

  it.each([0, 2, 3])("preserves %i rows at or below a budget of 3 without a table OFFSET scan", n => {
    seed(n);
    expect(pruner.capRows(3)).toBe(0);
    expect(ids()).toHaveLength(n);
    expect(executed).toHaveLength(1);
    expect(executed[0].query).toMatch(/count\(\*\)/i);
    expect(executed.some(s => /offset|delete/i.test(s.query))).toBe(false);
  });

  it.each([1, 3])("keeps exactly the newest %i IDs, independently of timestamps", cap => {
    seed(4);
    expect(pruner.capRows(cap)).toBe(4 - cap);
    expect(ids()).toEqual(cap === 1 ? [4] : [2, 3, 4]);
    expect(pruner.capRows(cap)).toBe(0);
  });

  it("handles previously deleted IDs without treating max(id) as a count", () => {
    seed(8);
    sqlite.prepare("delete from request_logs where id in (2, 4, 6)").run();
    expect(pruner.capRows(3)).toBe(2);
    expect(ids()).toEqual([5, 7, 8]);
    executed.length = 0;
    expect(pruner.capRows(3)).toBe(0);
    expect(executed).toHaveLength(1);
  });

  it("uses a covering-index count and no payload-table traversal for a heavy within-budget log", () => {
    // 4 MiB of synthetic payload, not an unbounded stress fixture.
    seed(256, "x".repeat(16 * 1024));
    expect(pruner.capRows(257)).toBe(0);
    expect(ids()).toHaveLength(256);
    expect(executed).toHaveLength(1);
    const statement = executed[0];
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${statement.query}`).all(...statement.params) as { detail: string }[];
    expect(plan.some(p => /USING COVERING INDEX/.test(p.detail))).toBe(true);
    expect(plan.some(p => p.detail === "SCAN request_logs")).toBe(false);
  });
});
