/**
 * T13 — the shutdown path closes the egress proxy pool (EgressProxyPool.closeAll
 * is documented as "called once, on process shutdown" and had no caller).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { shutdownGracefully, type ClosableServer } from "../src/util/shutdown";
import { EgressProxyPool } from "../src/core/upstream/egress/pool";

afterEach(() => { vi.useRealTimers(); });

function fixture(close: ClosableServer["close"]) {
  const order: string[] = [];
  const app: ClosableServer = { close: vi.fn(async () => { const r = await close(); order.push("app.close"); return r; }), server: { closeAllConnections: vi.fn() }, log: { warn: vi.fn() } };
  const resources = {
    statsCache: { flush: vi.fn(() => { order.push("stats.flush"); }) },
    egressPool: { closeAll: vi.fn(async () => { order.push("egress.closeAll:start"); await Promise.resolve(); order.push("egress.closeAll:done"); }) },
    sqlite: { close: vi.fn(() => { order.push("sqlite.close"); }) },
  };
  return { app, resources, order };
}

describe("T13: shutdown closes the egress proxy pool", () => {
  it("after the server drained and before the database closes, waiting for it", async () => {
    const f = fixture(async () => undefined);
    await shutdownGracefully(f.app, f.resources, 30_000);
    expect(f.order).toEqual(["app.close", "stats.flush", "egress.closeAll:start", "egress.closeAll:done", "sqlite.close"]);
  });

  it("a forced drain still starts the pool's teardown, but does only synchronous cleanup", async () => {
    vi.useFakeTimers();
    const f = fixture(() => new Promise(() => {}));
    const done = shutdownGracefully(f.app, f.resources, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    expect(f.resources.egressPool.closeAll).toHaveBeenCalledOnce();
    // The database closed without yielding to the event loop for the pool.
    expect(f.order.slice(0, 3)).toEqual(["stats.flush", "egress.closeAll:start", "sqlite.close"]);
  });

  it("a failing server close still tears the pool down and closes the database", async () => {
    const boom = new Error("close failed");
    const f = fixture(async () => { throw boom; });
    await expect(shutdownGracefully(f.app, f.resources, 1_000)).rejects.toBe(boom);
    expect(f.resources.egressPool.closeAll).toHaveBeenCalledOnce();
    expect(f.resources.sqlite.close).toHaveBeenCalledOnce();
    expect(f.resources.statsCache.flush).not.toHaveBeenCalled();
  });

  it("a real pool satisfies the resource contract, and the entry point goes through this path", async () => {
    const pool = new EgressProxyPool();
    const closeAll = vi.spyOn(pool, "closeAll");
    const f = fixture(async () => undefined);
    await shutdownGracefully(f.app, { ...f.resources, egressPool: pool }, 1_000);
    expect(closeAll).toHaveBeenCalledOnce();
    const entry = fs.readFileSync(path.join(__dirname, "../src/index.ts"), "utf8");
    expect(entry).toMatch(/shutdownGracefully\(app, container, SHUTDOWN_GRACE_MS\)/);
  });
});
