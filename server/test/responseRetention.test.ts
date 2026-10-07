import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type OpenedDatabase } from "../src/db";
import { TokenRepo } from "../src/persistence/tokenRepo";
import { SettingsRepo } from "../src/persistence/settingsRepo";
import { ResponseRepo } from "../src/persistence/responseRepo";
import { ResponseRetentionQueries, retentionCandidates, retentionDelete, runResponseRetentionCycle, RETENTION_MAX_BATCHES, RETENTION_BATCH_SIZE,
  type RetentionCursor, type RetentionResult } from "../src/persistence/responseRetention";
import { ResponsePruner, startResponsePrune, type ResponsePruneTask } from "../src/persistence/responsePruner";
import { exportBackup } from "../src/backup/archive";
import { sql } from "drizzle-orm";

const DAY = 86_400_000, NOW = Date.UTC(2026, 9, 7), empty = (): RetentionCursor => ({ responses: null, conversations: null });
let dir: string, opened: OpenedDatabase, owner: number, settings: SettingsRepo, tasks: ResponsePruneTask[];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-retention-")); opened = openDatabase(dir);
  owner = new TokenRepo(opened.db, Buffer.alloc(32, 39)).create({ name: "synthetic-retention-owner" }).token.id;
  settings = new SettingsRepo(opened.db); settings.set("response_retention_days", "1"); tasks = [];
  vi.stubEnv("NODE_ENV", "test");
});
afterEach(async () => {
  for (const task of tasks) { task.cancel(); await task.stopped; }
  vi.restoreAllMocks(); opened.sqlite.close(); fs.rmSync(dir, { force: true, recursive: true }); vi.useRealTimers(); vi.unstubAllEnvs();
});
function response(id: string, status = "completed", touched = NOW - DAY - 1, conversation: string | null = null, payload = "{}"): void {
  opened.sqlite.prepare("INSERT INTO stored_responses(id,token_id,status,response_json,input_items_json,history_json,touched_at,conversation_id) VALUES (?,?,?,?,'[]','[]',?,?)")
    .run(id, owner, status, payload, touched, conversation);
  opened.sqlite.prepare("INSERT INTO response_events(response_id,event) VALUES (?,'{}')").run(id);
}
function conversation(id: string, touched = NOW - DAY - 1): void {
  opened.sqlite.prepare("INSERT INTO response_conversations(id,token_id,metadata_json,touched_at) VALUES (?,?,'{}',?)").run(id, owner, touched);
  opened.sqlite.prepare("INSERT INTO conversation_items(id,conversation_id,item_json) VALUES (?,?,'{}')").run(`item-${id}`, id);
}
function ids(sqlite: Database.Database, table: string): unknown[] { return sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(); }
function sweep(now = NOW, size = 2): void {
  const queries = new ResponseRetentionQueries(opened.sqlite, size);
  for (const phase of ["responses", "conversations"] as const) {
    let cursor = null, previousTtl: number | undefined;
    for (let i = 0; i < 100; i++) {
      const batch = queries.batch(phase, cursor, now, previousTtl);
      if (batch.done) break;
      cursor = batch.cursor; previousTtl = batch.ttlMs;
      if (i === 99) throw new Error("Synthetic sweep failed to progress");
    }
  }
}

describe("retention semantics and query shape", () => {
  it("matches legacy SQL on status/age/active/null partitions including all cascades", async () => {
    for (const status of ["completed", "failed", "cancelled", "incomplete", "queued", "in_progress", "unknown"]) {
      for (const delta of [-1, 0, 1]) response(`${status}-${delta}`, status, NOW - DAY + delta);
    }
    conversation("idle"); conversation("queued"); conversation("running"); conversation("boundary", NOW - DAY); conversation("fresh", NOW);
    response("reservation-q", "queued", NOW - 2 * DAY, "queued"); response("reservation-r", "in_progress", NOW - 2 * DAY, "running");
    response("null-active", "queued", NOW - 2 * DAY, null); response("idle-done", "completed", NOW - 2 * DAY, "idle");
    const original = new Database(path.join(dir, "oracle.db")); original.close();
    await opened.sqlite.backup(path.join(dir, "oracle.db"));
    const oracle = new Database(path.join(dir, "oracle.db")); oracle.pragma("foreign_keys = ON");
    try {
      oracle.prepare("DELETE FROM stored_responses WHERE touched_at < ? AND status IN ('completed','failed','cancelled','incomplete')").run(NOW - DAY);
      oracle.prepare("DELETE FROM response_conversations WHERE touched_at < ? AND NOT EXISTS (SELECT 1 FROM stored_responses r WHERE r.conversation_id=response_conversations.id AND r.status IN ('queued','in_progress'))").run(NOW - DAY);
      sweep();
      for (const table of ["stored_responses", "response_events", "response_conversations", "conversation_items"]) expect(ids(opened.sqlite, table)).toEqual(ids(oracle, table));
      expect(opened.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      const repo = new ResponseRepo(opened.db, () => DAY, () => NOW);
      expect(repo.response("completed-0", owner)).toBeUndefined(); // existing read <= boundary
      expect(opened.sqlite.prepare("SELECT id FROM stored_responses WHERE id='completed-0'").get()).toBeDefined(); // delete remains <
      expect(repo.response("queued--1", owner)).toBeDefined();
    } finally { oracle.close(); }
  });
  it.each([[undefined, 30], ["0", 0], ["1", 1], ["3650", 3650], ["-1", 30], ["3651", 30], ["1.5", 30], ["NaN", 30], ["", 0], ["Infinity", 30]] as const)("shares live setting partition %s (expected %s days) with foreground reads", (raw, expected) => {
    if (raw === undefined) settings.clear("response_retention_days"); else settings.set("response_retention_days", raw);
    response("old", "completed", NOW - 4000 * DAY);
    const query = new ResponseRetentionQueries(opened.sqlite);
    const batch = query.batch("responses", null, NOW);
    expect(settings.responseRetentionDays()).toBe(expected); expect(batch.ttlMs).toBe(expected * DAY);
    expect(batch.deleted).toBe(expected === 0 ? 0 : 1);
    if (expected === 0) expect(batch.scanned).toBe(0);
  });
  it("moves through equal-age running rows instead of starving terminal rows; resets on policy change", () => {
    for (let i = 0; i < 5; i++) response(`active-${i}`, "queued"); response("last");
    const queries = new ResponseRetentionQueries(opened.sqlite, 2);
    const a = queries.batch("responses", null, NOW), b = queries.batch("responses", a.cursor, NOW, a.ttlMs);
    expect(a.deleted + b.deleted).toBe(0);
    const c = queries.batch("responses", b.cursor, NOW, b.ttlMs); expect(c.deleted).toBe(1);
    settings.set("response_retention_days", "0"); expect(queries.batch("responses", c.cursor, NOW, c.ttlMs)).toMatchObject({ scanned: 0, deleted: 0, cursor: null });
    response("behind", "completed", NOW - 3 * DAY); settings.set("response_retention_days", "2");
    expect(queries.batch("responses", b.cursor, NOW, b.ttlMs).deleted).toBe(1);
  });
  it("protects a newly reserved conversation and a freshly touched row on the next batch", () => {
    conversation("reserved"); response("fresh-touch");
    response("just-reserved", "in_progress", NOW, "reserved");
    opened.sqlite.prepare("UPDATE stored_responses SET touched_at=? WHERE id='fresh-touch'").run(NOW);
    sweep(); expect(opened.sqlite.prepare("SELECT id FROM response_conversations WHERE id='reserved'").get()).toBeDefined();
    expect(opened.sqlite.prepare("SELECT id FROM stored_responses WHERE id='fresh-touch'").get()).toBeDefined();
  });
  it("preserves committed scan progress when a later batch meets a writer lock", async () => {
    for (let i = 0; i < 5; i++) response(`prefix-${i}`, "queued"); response("later-expired");
    opened.sqlite.pragma("busy_timeout=0");
    const secondary = new Database(path.join(dir, "hydrogen.db"), { timeout: 0 }), queries = new ResponseRetentionQueries(opened.sqlite, 2);
    let locked = false;
    try {
      const partial = await runResponseRetentionCycle(queries, empty(), NOW, async () => { if (!locked) { secondary.exec("BEGIN IMMEDIATE"); locked = true; } });
      expect(partial).toMatchObject({ deferred: "busy", batches: 1, scanned: 2, responses: 0 });
      expect(partial.cursor.responses?.rowid).toBe(2);
      secondary.exec("ROLLBACK"); locked = false;
      const resumed = await runResponseRetentionCycle(queries, partial.cursor, NOW);
      expect(resumed.responses).toBe(1); expect(resumed.scanned).toBe(4);
      expect(ids(opened.sqlite, "stored_responses")).toHaveLength(5);
    } finally { if (locked) secondary.exec("ROLLBACK"); secondary.close(); }
  });
  it("observes a zero-retention change between committed batches without further deletion", async () => {
    for (let i = 0; i < 64; i++) response(`live-policy-${i}`);
    const queries = new ResponseRetentionQueries(opened.sqlite);
    const result = await runResponseRetentionCycle(queries, empty(), NOW, async () => { settings.set("response_retention_days", "0"); });
    expect(result).toMatchObject({ responses: 32, scanned: 32, batches: 2, cursor: { ttlMs: 0 } });
    expect(ids(opened.sqlite, "stored_responses")).toHaveLength(32);
    expect(ids(opened.sqlite, "response_events")).toHaveLength(32);
  });
  it("uses bounded covering time ranges and primary-key deletes with one noncorrelated active set", () => {
    for (const phase of ["responses", "conversations"] as const) {
      for (const after of [false, "same", "later"] as const) {
        const params = after === "same" ? [NOW, 0, 0, 32] : after === "later" ? [NOW, 0, 32] : [NOW, 32];
        const query = retentionCandidates(phase, after);
        const plan = opened.sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...params) as { detail: string }[];
        expect(plan.some(p => /COVERING INDEX .*touch_idx/.test(p.detail))).toBe(true);
        expect(plan.some(p => /SCAN |TEMP B-TREE/.test(p.detail))).toBe(false);
        if (after === "same") {
          expect(plan.some(p => /touched_at=\?.*rowid>\?/.test(p.detail))).toBe(true);
          const vm = opened.sqlite.prepare(`EXPLAIN ${query}`).all(...params) as { opcode: string; p4: string }[];
          expect(vm.some(op => op.opcode === "SeekGT" && op.p4 === "2")).toBe(true);
        }
      }
      const plan = opened.sqlite.prepare(`EXPLAIN QUERY PLAN ${retentionDelete(phase, 2)}`).all(1, 2, NOW) as { detail: string }[];
      expect(plan.some(p => /INTEGER PRIMARY KEY.*rowid=/.test(p.detail))).toBe(true);
      expect(plan.some(p => /CORRELATED/.test(p.detail))).toBe(false);
      if (phase === "conversations") expect(plan.some(p => /stored_responses_status_idx/.test(p.detail))).toBe(true);
    }
  });
  it("reserves the main writer before guards, preserves nested rollback and explicit readonly snapshots", () => {
    response("old");
    const secondary = new Database(path.join(dir, "hydrogen.db"), { timeout: 0 }); secondary.pragma("foreign_keys=ON");
    const queries = new ResponseRetentionQueries(secondary);
    try {
      opened.db.transaction(tx => {
        expect(tx.get(sql`SELECT id FROM stored_responses WHERE id='old'`)).toBeDefined();
        expect(() => queries.batch("responses", null, NOW)).toThrow(/locked/);
        expect(() => tx.transaction(nested => { nested.run(sql`INSERT INTO settings VALUES ('nested-test','x')`); throw new Error("rollback"); })).toThrow("rollback");
        tx.run(sql`INSERT INTO settings VALUES ('main-test','x')`);
      });
      expect(settings.get("nested-test")).toBeUndefined(); expect(settings.get("main-test")).toBe("x");
      opened.db.transaction(tx => {
        expect(tx.get(sql`SELECT id FROM stored_responses WHERE id='old'`)).toBeDefined();
        expect(queries.batch("responses", null, NOW).deleted).toBe(1);
        expect(tx.get(sql`SELECT id FROM stored_responses WHERE id='old'`)).toBeDefined();
      }, { behavior: "deferred" });
      expect(opened.sqlite.prepare("SELECT id FROM stored_responses WHERE id='old'").get()).toBeUndefined();
    } finally { secondary.close(); }
  });
  it("exports parents, child items/events and secrets from one readonly snapshot during a concurrent prune", async () => {
    conversation("snapshot"); response("snapshot-response", "completed", NOW - 2 * DAY, "snapshot");
    const secondary = new Database(path.join(dir, "hydrogen.db"), { timeout: 0 }); secondary.pragma("foreign_keys=ON");
    const queries = new ResponseRetentionQueries(secondary), nativePrepare = opened.sqlite.prepare.bind(opened.sqlite);
    let injected = false;
    vi.spyOn(opened.sqlite, "prepare").mockImplementation((text: string) => {
      // Commit between table reads, exactly where the former unsnapshotted
      // export could include a parent while losing its children.
      if (!injected && text.includes('table_info("conversation_items")')) {
        injected = true; expect(queries.batch("responses", null, NOW).deleted).toBe(1);
        expect(queries.batch("conversations", null, NOW).deleted).toBe(1);
      }
      return nativePrepare(text);
    });
    try {
      const pkg = await exportBackup(opened.sqlite, Buffer.alloc(32, 39), { passphrase: "synthetic-backup-password", includeLogs: true, includeImageCache: true, appVersion: "synthetic" });
      expect(injected).toBe(true);
      expect(pkg.counts).toMatchObject({ response_conversations: 1, conversation_items: 1, stored_responses: 1, response_events: 1 });
      expect(ids(secondary, "stored_responses")).toEqual([]); expect(ids(secondary, "response_conversations")).toEqual([]);
    } finally { secondary.close(); }
  });
});

describe("actual retention worker", () => {
  it("bounds each cycle and carries its cursor through a backlog without loading payloads", async () => {
    const count = RETENTION_BATCH_SIZE * RETENTION_MAX_BATCHES + 8;
    opened.sqlite.transaction(() => { for (let i = 0; i < count; i++) response(`backlog-${i}`, "completed", Date.now() - 2 * DAY, null, JSON.stringify({ synthetic: "x".repeat(1024) })); })();
    let cursor = empty(), deleted = 0;
    for (let cycle = 0; cycle < 6 && deleted < count; cycle++) {
      const task = startResponsePrune(path.join(dir, "hydrogen.db"), cursor); tasks.push(task);
      const result = await task.result; await task.stopped;
      expect(result.batches).toBeLessThanOrEqual(RETENTION_MAX_BATCHES);
      expect(result.scanned).toBeLessThanOrEqual(RETENTION_BATCH_SIZE * RETENTION_MAX_BATCHES);
      deleted += result.responses; cursor = result.cursor;
    }
    expect(deleted).toBe(count); expect(ids(opened.sqlite, "response_events")).toEqual([]);
  }, 10_000);
  it("fails a missing database without creating it and yields to an existing writer, then succeeds", async () => {
    const missing = path.join(dir, "absent.db"), a = startResponsePrune(missing, empty()); tasks.push(a);
    await expect(a.result).rejects.toThrow("Response retention failed"); await a.stopped; expect(fs.existsSync(missing)).toBe(false);
    response("old", "completed", Date.now() - 2 * DAY);
    opened.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const busy = startResponsePrune(path.join(dir, "hydrogen.db"), empty()); tasks.push(busy);
      expect(await busy.result).toMatchObject({ deferred: "busy", responses: 0, scanned: 0, batches: 0 }); await busy.stopped;
      expect(ids(opened.sqlite, "stored_responses")).toHaveLength(1);
    } finally { opened.sqlite.exec("ROLLBACK"); }
    const retry = startResponsePrune(path.join(dir, "hydrogen.db"), empty()); tasks.push(retry);
    expect((await retry.result).responses).toBe(1); await retry.stopped;
  });
  it("cancels without further writes once worker exit is confirmed", async () => {
    const count = 1024;
    opened.sqlite.transaction(() => { for (let i = 0; i < count; i++) response(`cancel-${i}`, "completed", Date.now() - 2 * DAY); })();
    const task = startResponsePrune(path.join(dir, "hydrogen.db"), empty()); tasks.push(task);
    await vi.waitFor(() => { expect((opened.sqlite.prepare("SELECT count(*) AS n FROM stored_responses").get() as { n: number }).n).toBeLessThan(count); }, { timeout: 2_000, interval: 1 });
    const rejected = expect(task.result).rejects.toThrow("cancelled"); task.cancel(); await rejected; await task.stopped;
    const remaining = ids(opened.sqlite, "stored_responses"); expect(remaining.length).toBeGreaterThan(0); expect(remaining.length).toBeLessThan(count);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(ids(opened.sqlite, "stored_responses")).toEqual(remaining);
    expect(ids(opened.sqlite, "response_events")).toHaveLength(remaining.length);
  });
});

function controlled() {
  let resolve!: (result: RetentionResult) => void, reject!: (error: Error) => void, exit!: () => void;
  const task: ResponsePruneTask = { result: new Promise((yes, no) => { resolve = yes; reject = no; }),
    stopped: new Promise(yes => { exit = yes; }), cancel: vi.fn(() => reject(new Error("cancelled"))) };
  return { task, resolve, reject, exit };
}
const result = (): RetentionResult => ({ cursor: empty(), responses: 0, conversations: 0, scanned: 0, batches: 0 });
describe("completion-relative lifecycle", () => {
  it("has no pre-listen work, overlap or catch-up; waits for exit and retries failures", async () => {
    vi.useFakeTimers(); const a = controlled(), b = controlled(), runner = vi.fn().mockReturnValueOnce(a.task).mockReturnValueOnce(b.task);
    const pruner = new ResponsePruner("synthetic.db", runner, 60_000), report = vi.fn(), failed = vi.fn();
    pruner.request(); await vi.advanceTimersByTimeAsync(90_000); expect(runner).not.toHaveBeenCalled();
    pruner.start(report, failed); await vi.advanceTimersByTimeAsync(0); expect(runner).toHaveBeenCalledOnce();
    pruner.request(); await vi.advanceTimersByTimeAsync(180_000); expect(runner).toHaveBeenCalledOnce();
    a.resolve(result()); await vi.advanceTimersByTimeAsync(90_000); expect(runner).toHaveBeenCalledOnce();
    a.exit(); await vi.advanceTimersByTimeAsync(59_999); expect(runner).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(runner).toHaveBeenCalledTimes(2);
    b.reject(new Error("synthetic failure")); b.exit(); await vi.advanceTimersByTimeAsync(0); expect(failed).toHaveBeenCalledOnce();
    pruner.close(); await vi.advanceTimersByTimeAsync(180_000); expect(runner).toHaveBeenCalledTimes(2);
  });
  it("pauses restore until worker exit, discards stale completion, and closes without rescheduling", async () => {
    vi.useFakeTimers(); const a = controlled(), b = controlled(), runner = vi.fn().mockReturnValueOnce(a.task).mockReturnValueOnce(b.task);
    const pruner = new ResponsePruner("synthetic.db", runner), report = vi.fn(); pruner.start(report, vi.fn()); await vi.advanceTimersByTimeAsync(0);
    let paused = false; const pause = pruner.pause().then(() => { paused = true; });
    await vi.advanceTimersByTimeAsync(0); expect(paused).toBe(false); expect(a.task.cancel).toHaveBeenCalledOnce();
    a.exit(); await pause; expect(paused).toBe(true); expect(report).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(90_000); expect(runner).toHaveBeenCalledOnce();
    pruner.resume(); await vi.advanceTimersByTimeAsync(0); expect(runner).toHaveBeenCalledTimes(2);
    pruner.close(); b.exit(); await vi.advanceTimersByTimeAsync(120_000); expect(runner).toHaveBeenCalledTimes(2);
  });
  it("times out a blocked restore without starting a replacement before old-worker exit", async () => {
    vi.useFakeTimers(); const a = controlled(), runner = vi.fn(() => a.task), pruner = new ResponsePruner("synthetic.db", runner);
    pruner.start(vi.fn(), vi.fn()); await vi.advanceTimersByTimeAsync(0);
    const rejected = expect(pruner.pause()).rejects.toMatchObject({ statusCode: 503 });
    await vi.advanceTimersByTimeAsync(5_000); await rejected; pruner.resume(); await vi.advanceTimersByTimeAsync(120_000);
    expect(runner).toHaveBeenCalledOnce(); pruner.close(); a.exit(); await vi.advanceTimersByTimeAsync(0);
  });
});
