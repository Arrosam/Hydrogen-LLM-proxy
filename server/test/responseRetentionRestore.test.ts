import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { boot, type Container } from "../src/composition/container";
import { buildApp } from "../src/app";
import { ResponsePruner, type ResponsePruneTask } from "../src/persistence/responsePruner";

let dir: string, app: FastifyInstance, c: Container, cookie: string;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-retention-restore-"));
  vi.stubEnv("DATA_DIR", dir); vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("ADMIN_PASSWORD", "synthetic-restore-admin");
  vi.stubEnv("PROXY_MASTER_KEY", "27".repeat(32)); vi.stubEnv("SESSION_SECRET", "synthetic-retention-restore-session");
  c = await boot({ deferredStats: true }); app = await buildApp(c);
  const login = await app.inject({ method: "POST", url: "/admin/api/login", payload: { username: "admin", password: "synthetic-restore-admin" } });
  expect(login.statusCode).toBe(200); cookie = `hydrogen_session=${login.cookies[0].value}`;
});
afterEach(async () => {
  await app.close(); c.sqlite.close(); fs.rmSync(dir, { force: true, recursive: true });
  vi.useRealTimers(); vi.unstubAllEnvs();
});
async function backup() {
  c.settings.set("restore-sentinel", "before");
  const exported = await app.inject({ method: "POST", url: "/admin/api/backup/export", headers: { cookie }, payload: { passphrase: "synthetic-backup-password", includeLogs: false } });
  expect(exported.statusCode).toBe(200); c.settings.set("restore-sentinel", "after"); return exported.json().backup;
}
async function stoppingWorker() {
  let reject!: (error: Error) => void, exit!: () => void;
  const task: ResponsePruneTask = { result: new Promise((_, no) => { reject = no; }), stopped: new Promise(yes => { exit = yes; }), cancel: vi.fn(() => reject(new Error("cancelled"))) };
  const runner = vi.fn().mockReturnValueOnce(task).mockImplementation(() => ({ result: Promise.resolve({ cursor: { responses: null, conversations: null }, responses: 0, conversations: 0, scanned: 0, batches: 0 }), stopped: Promise.resolve(), cancel() {} }));
  c.responsePruner = new ResponsePruner(path.join(dir, "hydrogen.db"), runner);
  c.responsePruner.start(vi.fn(), vi.fn()); await vi.waitFor(() => { expect(runner).toHaveBeenCalledOnce(); });
  return { task, exit, runner };
}
describe("restore route retention lifecycle", () => {
  it("does not restore until exit is confirmed, then releases admission and restores the exact snapshot", async () => {
    const saved = await backup(), work = await stoppingWorker();
    const restore = app.inject({ method: "POST", url: "/admin/api/backup/restore", headers: { cookie }, payload: { passphrase: "synthetic-backup-password", backup: saved } });
    await vi.waitFor(() => { expect(work.task.cancel).toHaveBeenCalledOnce(); });
    expect(c.settings.get("restore-sentinel")).toBe("after"); expect((await app.inject("/healthz")).statusCode).toBe(503);
    work.exit(); expect((await restore).statusCode).toBe(200);
    expect(c.settings.get("restore-sentinel")).toBe("before"); expect(c.requestGate.activeCount).toBe(0);
    expect((await app.inject("/healthz")).statusCode).toBe(200);
  });
  it("returns 503 on stop timeout, keeps the target unchanged, and releases admission without racing the old worker", async () => {
    const saved = await backup(), work = await stoppingWorker(); vi.useFakeTimers();
    const restore = app.inject({ method: "POST", url: "/admin/api/backup/restore", headers: { cookie }, payload: { passphrase: "synthetic-backup-password", backup: saved } });
    await vi.waitFor(() => { expect(work.task.cancel).toHaveBeenCalledOnce(); });
    await vi.advanceTimersByTimeAsync(5_000); expect((await restore).statusCode).toBe(503);
    expect(c.settings.get("restore-sentinel")).toBe("after"); expect(c.requestGate.activeCount).toBe(0);
    expect((await app.inject("/healthz")).statusCode).toBe(200);
    await vi.advanceTimersByTimeAsync(120_000); expect(work.runner).toHaveBeenCalledOnce();
    c.responsePruner.close(); work.exit(); await vi.advanceTimersByTimeAsync(0);
    expect(c.settings.get("restore-sentinel")).toBe("after");
  });
});
