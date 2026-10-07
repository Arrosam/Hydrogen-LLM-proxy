import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { performance } from "node:perf_hooks";
import { openDatabase } from "../src/db";
import { boot, type Container } from "../src/composition/container";
import { buildApp } from "../src/app";
import { TokenRepo } from "../src/persistence/tokenRepo";
import { ResponsePruner, startResponsePrune, type ResponsePruneTask } from "../src/persistence/responsePruner";

const KEY = Buffer.alloc(32, 39), DAY = 86_400_000;
let dir: string | undefined, app: FastifyInstance | undefined, container: Container | undefined;
const tasks: ResponsePruneTask[] = [];
afterEach(async () => {
  await app?.close(); container?.responsePruner.close();
  for (const task of tasks) { task.cancel(); await task.stopped; } tasks.length = 0;
  container?.sqlite.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true });
  app = undefined; container = undefined; dir = undefined; vi.unstubAllEnvs();
});

describe("real loopback retention interface", () => {
  it("defers startup, serves authenticated reads/writes during cleanup, applies 0/1 live, and preserves configuration/cache", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-retention-http-"));
    const opened = openDatabase(dir), token = new TokenRepo(opened.db, KEY).create({ name: "synthetic-client" });
    const count = 512;
    opened.sqlite.transaction(() => {
      const insert = opened.sqlite.prepare("INSERT INTO stored_responses(id,token_id,status,response_json,input_items_json,history_json,touched_at) VALUES (?,?,'completed',?,'[]','[]',?)");
      for (let i = 0; i < count; i++) insert.run(`old-${i}`, token.token.id, JSON.stringify({ id: `old-${i}`, status: "completed", output: [], synthetic: "x".repeat(1024) }), Date.now() - 2 * DAY);
      opened.sqlite.prepare("INSERT INTO settings VALUES ('response_retention_days','1')").run();
      opened.sqlite.prepare("INSERT INTO settings VALUES ('retention-sentinel','preserve-configuration')").run();
      opened.sqlite.prepare("INSERT INTO image_cache(hash,description,size_bytes,last_used_at) VALUES ('synthetic-image','preserve-description',20,?)").run(Date.now());
    })(); opened.sqlite.close();
    vi.stubEnv("DATA_DIR", dir); vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("ADMIN_PASSWORD", "synthetic-admin-password");
    vi.stubEnv("PROXY_MASTER_KEY", KEY.toString("hex")); vi.stubEnv("SESSION_SECRET", "synthetic-retention-http-session");
    const stages: string[] = [];
    container = await boot({ deferredStats: true, reportStartup: event => { stages.push(event.stage); } });
    const remaining = () => (container!.sqlite.prepare("SELECT count(*) AS n FROM stored_responses").get() as { n: number }).n;
    expect(remaining()).toBe(count); expect(stages).not.toContain("responses.prune");
    let active = 0, maximum = 0, cycles = 0;
    container.responsePruner = new ResponsePruner(path.join(dir, "hydrogen.db"), (file, cursor) => {
      cycles++; active++; maximum = Math.max(maximum, active);
      const task = startResponsePrune(file, cursor); tasks.push(task); void task.stopped.then(() => { active--; }); return task;
    }, 50);
    app = await buildApp(container); expect(remaining()).toBe(count); expect(cycles).toBe(0);
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const call = async (url: string, options: RequestInit = {}) => fetch(base + url, { ...options, signal: AbortSignal.timeout(2_000) });
    const login = await call("/admin/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "synthetic-admin-password" }) });
    expect(login.status).toBe(200); const cookie = login.headers.get("set-cookie")!.split(";")[0]; await login.arrayBuffer();
    await vi.waitFor(() => { expect(remaining()).toBeLessThan(count); }, { timeout: 2_000, interval: 5 });
    expect(active).toBe(1);
    const samples: number[] = [];
    let overlappingRequests = 0;
    for (let i = 0; i < 12; i++) {
      if (active) overlappingRequests++;
      const before = performance.now();
      const health = await call("/healthz"); expect(health.status).toBe(200); await health.arrayBuffer();
      const setting = await call("/admin/api/settings/response-retention", { headers: { cookie } }); expect(setting.status).toBe(200); await setting.arrayBuffer();
      const write = await call("/v1/conversations", { method: "POST", headers: { "Content-Type": "application/json", authorization: `Bearer ${token.secret}` }, body: "{}" });
      expect(write.status).toBe(200); await write.arrayBuffer(); samples.push(performance.now() - before);
    }
    expect(Math.max(...samples)).toBeLessThan(1_000);
    expect(overlappingRequests).toBeGreaterThan(0);
    const put = async (days: number) => {
      const res = await call("/admin/api/settings/response-retention", { method: "PUT", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ days }) });
      expect(res.status).toBe(200); expect(await res.json()).toEqual({ days });
    };
    await put(0);
    await vi.waitFor(() => { expect(active).toBe(0); }, { timeout: 2_000, interval: 5 });
    // A cleanup may legitimately finish before the settings request reaches the
    // server. Insert a known expired row after the zero setting is acknowledged
    // to test retained data without assuming machine speed or resurrecting rows.
    container.sqlite.prepare("INSERT INTO stored_responses(id,token_id,status,response_json,input_items_json,history_json,touched_at) VALUES ('zero-kept',?,'completed','{}','[]','[]',?)").run(token.token.id, Date.now() - 2 * DAY);
    const kept = remaining(); expect(kept).toBeGreaterThan(0);
    const example = (container.sqlite.prepare("SELECT id FROM stored_responses LIMIT 1").get() as { id: string }).id;
    const history = await call(`/v1/responses/${example}`, { headers: { authorization: `Bearer ${token.secret}` } });
    expect(history.status).toBe(200); await history.arrayBuffer();
    await new Promise(resolve => setTimeout(resolve, 100)); expect(remaining()).toBe(kept);
    await put(1);
    await vi.waitFor(() => { expect(remaining()).toBe(0); }, { timeout: 4_000, interval: 10 });
    expect(maximum).toBe(1); expect(container.settings.get("retention-sentinel")).toBe("preserve-configuration");
    expect(container.sqlite.prepare("SELECT description FROM image_cache WHERE hash='synthetic-image'").get()).toEqual({ description: "preserve-description" });
    expect(container.sqlite.prepare("SELECT count(*) AS n FROM response_conversations").get()).toEqual({ n: 12 });
    const auth = await call("/admin/api/settings/response-retention"); expect(auth.status).toBe(401); await auth.arrayBuffer();
    await app.close(); app = undefined;
    for (const task of tasks) await task.stopped;
    const closedCycles = cycles; await new Promise(resolve => setTimeout(resolve, 100)); expect(cycles).toBe(closedCycles);
  }, 10_000);
});
