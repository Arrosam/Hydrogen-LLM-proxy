// Run after npm run build: node --import tsx scripts/validate-response-retention.mjs
// Synthetic data only. One child server, loopback only, 128 MiB JS heap, <128 MiB fixture budget.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { openDatabase } from "../server/src/db/index.ts";
import { seedAdminIfEmpty } from "../server/src/db/bootstrap.ts";
import { TokenRepo } from "../server/src/persistence/tokenRepo.ts";
import { retentionCandidates, retentionDelete } from "../server/src/persistence/responseRetention.ts";

const root = path.resolve(import.meta.dirname, ".."), dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-retention-bundle-"));
const DAY = 86_400_000, key = Buffer.alloc(32, 39), now = Date.now(), expiredRows = 1024, freshRows = 2048;
process.env.MIGRATIONS_DIR = path.join(root, "server/drizzle");
let opened, child;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = async (promise, ms) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic validation timed out")), ms); })]); }
  finally { clearTimeout(timer); }
};
try {
  opened = openDatabase(dir);
  await seedAdminIfEmpty(opened.db, { username: "admin", password: "synthetic-bundle-password" });
  const owner = new TokenRepo(opened.db, key).create({ name: "synthetic-bundle-owner" });
  opened.sqlite.transaction(() => {
    const response = opened.sqlite.prepare("INSERT INTO stored_responses(id,token_id,status,response_json,input_items_json,history_json,touched_at,conversation_id) VALUES (?,?,'completed',?,'[]','[]',?,?)");
    const conversation = opened.sqlite.prepare("INSERT INTO response_conversations(id,token_id,metadata_json,touched_at) VALUES (?,?,'{}',?)");
    for (let i = 0; i < 100; i++) {
      conversation.run(`old-conv-${i}`, owner.token.id, now - 2 * DAY);
      opened.sqlite.prepare("INSERT INTO conversation_items(id,conversation_id,item_json) VALUES (?,?,'{}')").run(`old-item-${i}`, `old-conv-${i}`);
    }
    for (let i = 0; i < expiredRows + freshRows; i++) {
      const old = i < expiredRows, id = `${old ? "old" : "fresh"}-${i}`;
      response.run(id, owner.token.id, JSON.stringify({ id, status: "completed", output: [], synthetic: "x".repeat(4096) }), old ? now - 2 * DAY : now, old ? `old-conv-${i % 100}` : null);
      if (old) opened.sqlite.prepare("INSERT INTO response_events(response_id,event) VALUES (?,'{}')").run(id);
    }
    opened.sqlite.prepare("INSERT INTO settings VALUES ('response_retention_days','0'),('validation-sentinel','preserve-config')").run();
    opened.sqlite.prepare("INSERT INTO image_cache(hash,description,size_bytes,last_used_at) VALUES ('synthetic-image','preserve-image',14,?)").run(now);
  })();
  const plans = {};
  const explain = (query, params) => opened.sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...params).map(row => row.detail);
  const oldResponseSql = "DELETE FROM stored_responses WHERE touched_at < ? AND status IN ('completed','failed','cancelled','incomplete')";
  const oldConversationSql = "DELETE FROM response_conversations WHERE touched_at < ? AND NOT EXISTS (SELECT 1 FROM stored_responses r WHERE r.conversation_id=response_conversations.id AND r.status IN ('queued','in_progress'))";
  plans.oldResponses = explain(oldResponseSql, [now - DAY]); plans.oldConversations = explain(oldConversationSql, [now - DAY]);
  plans.candidates = explain(retentionCandidates("responses", false), [now - DAY, 32]);
  plans.sameTimestamp = explain(retentionCandidates("responses", "same"), [now - DAY, now - 2 * DAY, 512, 32]);
  plans.conversationDelete = explain(retentionDelete("conversations", 2), [1, 2, now - DAY]);
  assert(plans.candidates.some(line => /COVERING INDEX .*touch_idx/.test(line)));
  assert(plans.sameTimestamp.some(line => /rowid>\?/.test(line))); assert(!plans.conversationDelete.some(line => /CORRELATED/.test(line)));
  await opened.sqlite.backup(path.join(dir, "oracle.db"));
  const oracle = new Database(path.join(dir, "oracle.db")); oracle.pragma("foreign_keys=ON");
  const oldStart = performance.now(); oracle.prepare(oldResponseSql).run(now - DAY); oracle.prepare(oldConversationSql).run(now - DAY);
  const oldSynchronousMs = performance.now() - oldStart;
  const counts = sqlite => Object.fromEntries(["stored_responses", "response_events", "response_conversations", "conversation_items"].map(table => [table, sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
  const expected = counts(oracle); oracle.close();
  const socket = net.createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const diagnostics = []; let listening = false;
  const started = performance.now();
  child = spawn(process.execPath, ["--max-old-space-size=128", path.join(root, "server/dist/server.cjs")], {
    cwd: dir, env: { PATH: process.env.PATH, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dir,
      PROXY_MASTER_KEY: key.toString("hex"), SESSION_SECRET: "synthetic-bundle-session-secret", ADMIN_PASSWORD: "synthetic-bundle-password",
      MIGRATIONS_DIR: path.join(root, "server/drizzle"), WEB_DIR: path.join(root, "web/dist"), HYDROGEN_HEAP_AUTOSIZE: "0", GIT_SHA: "synthetic-retention-validation" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const consume = chunk => {
    for (const line of String(chunk).split("\n")) {
      try {
        const record = JSON.parse(line);
        if (record.msg?.includes("Hydrogen listening")) listening = true;
        if (record.event === "startup" || record.msg?.startsWith("response retention")) diagnostics.push(record);
      } catch { /* Synthetic credential banner is deliberately omitted. */ }
    }
  };
  child.stdout.on("data", consume); child.stderr.on("data", consume);
  const base = `http://127.0.0.1:${port}`, healthMs = [], writeMs = [], settingMs = [];
  const request = async (url, options = {}, samples) => {
    const start = performance.now(), response = await fetch(base + url, { ...options, signal: AbortSignal.timeout(2000) });
    if (samples) samples.push(performance.now() - start); return response;
  };
  await bounded((async () => { while (!listening) { assert.equal(child.exitCode, null); await delay(20); } })(), 10_000);
  const startupMs = performance.now() - started;
  assert.equal(counts(opened.sqlite).stored_responses, expiredRows + freshRows);
  assert(!diagnostics.some(record => record.stage === "responses.prune"));
  const login = await request("/admin/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "synthetic-bundle-password" }) });
  assert.equal(login.status, 200); const cookie = login.headers.get("set-cookie").split(";")[0]; await login.arrayBuffer();
  const apply = async days => {
    const response = await request("/admin/api/settings/response-retention", { method: "PUT", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ days }) }, settingMs);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { days });
  };
  await apply(1); const cleanupStarted = performance.now();
  let writes = 0;
  for (let i = 0; i < 64; i++) {
    const response = await request("/healthz", {}, healthMs); assert.equal(response.status, 200); await response.arrayBuffer();
    if (i % 8 === 0) {
      const created = await request("/v1/conversations", { method: "POST", headers: { authorization: `Bearer ${owner.secret}`, "Content-Type": "application/json" }, body: "{}" }, writeMs);
      assert.equal(created.status, 200); await created.arrayBuffer(); writes++;
    }
    await delay(5);
  }
  const pending = () => opened.sqlite.prepare("SELECT count(*) AS n FROM stored_responses WHERE touched_at < ?").get(now - DAY).n;
  await bounded((async () => { while (pending()) { await apply(1); await delay(100); } })(), 10_000);
  const cleanupMs = performance.now() - cleanupStarted, actual = counts(opened.sqlite);
  assert.equal(actual.stored_responses, expected.stored_responses); assert.equal(actual.response_events, expected.response_events);
  assert.equal(actual.response_conversations, expected.response_conversations + writes); assert.equal(actual.conversation_items, expected.conversation_items);
  assert.equal(opened.sqlite.prepare("SELECT value FROM settings WHERE key='validation-sentinel'").get().value, "preserve-config");
  assert.equal(opened.sqlite.prepare("SELECT description FROM image_cache WHERE hash='synthetic-image'").get().description, "preserve-image");
  assert.deepEqual(opened.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  const fixtureBytes = fs.readdirSync(dir).filter(name => /\.db(?:-wal|-shm)?$/.test(name)).reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
  assert(fixtureBytes < 128 * 1024 * 1024);
  const exit = once(child, "exit"), shutdownStart = performance.now(); child.kill("SIGTERM");
  const [exitCode, exitSignal] = await bounded(exit, 3000); assert.equal(exitCode, 0); assert.equal(exitSignal, null);
  const stat = values => ({ samples: values.length, maximumMs: Math.round(Math.max(...values) * 100) / 100 });
  console.log(JSON.stringify({ environment: { node: process.version, platform: process.platform, arch: process.arch, worker: "bundled CJS, launched outside repository cwd" },
    fixture: { expiredRows, freshRows, payloadBytes: 4096, fixtureBytes, maximumHeapMiB: 128 },
    startupMs: Math.round(startupMs), oldSynchronousMs: Math.round(oldSynchronousMs * 100) / 100, cleanupMs: Math.round(cleanupMs),
    health: stat(healthMs), databaseWrites: stat(writeMs), settings: stat(settingMs), actual, expectedBeforeNewConversations: expected,
    configurationPreserved: true, imageCachePreserved: true, foreignKeyCheck: "passed", shutdownMs: Math.round(performance.now() - shutdownStart),
    gracefulExitCode: exitCode, maintenanceCyclesReported: diagnostics.filter(record => record.msg?.startsWith("response retention")).map(record => ({ message: record.msg, reason: record.reason, responses: record.responses, conversations: record.conversations, scanned: record.scanned, batches: record.batches })), plans,
    limitations: ["Synthetic SSD fixture cannot establish production I/O performance or active incident SQL", "The cycle budget is checked between native calls; cascades and active-set scans may exceed it", "No Docker image, production access, publication or deployment"] }, null, 2));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGKILL"); await bounded(exit, 3000); }
  opened?.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true });
}
