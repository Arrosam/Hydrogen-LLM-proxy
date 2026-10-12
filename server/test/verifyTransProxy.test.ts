/**
 * Independent verification (spec section TRANS): T2, T13, T15.
 *
 * Written from the verification spec only.
 *  - T2 runs the whole app over real loopback sockets against the scripted fake
 *    upstream, and reads the request-log row the run leaves behind.
 *  - T13 and T15 have no HTTP surface; they are driven through the exported
 *    seams the existing shutdown/heap suites use (signatures only).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { startFakeUpstream, type FakeUpstream, type UpstreamBehavior } from "./fixtures/fakeUpstream";
import { shutdownGracefully, type ClosableServer, type ShutdownResources } from "../src/util/shutdown";
import { ensureHeapSized } from "../src/util/heap";

// ---------------------------------------------------------------------------
// T2 — who broke the stream decides the logged status
// ---------------------------------------------------------------------------

interface Harness {
  app: FastifyInstance;
  upstream: FakeUpstream;
  port: number;
  secret: string;
  dataDir: string;
  sqlite: { close: () => void; prepare: (s: string) => { get: () => unknown; all: () => unknown[] } };
}

let harness: Harness | null = null;

afterEach(async () => {
  delete process.env.STREAM_COMMIT_GRACE_MS;
  if (!harness) return;
  await harness.app.close();
  await harness.upstream.close();
  harness.sqlite.close();
  fs.rmSync(harness.dataDir, { recursive: true, force: true });
  harness = null;
});

/** A plain (not Reliable Streaming) Model Service on a Chat Completions provider: a passthrough stream. */
const PASSTHROUGH = { timeoutMs: 30_000, steps: [{ model: "m", provider: "fake" }] };

async function boot(script: UpstreamBehavior[], o: { text: string; delayMs?: number }): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-verify-proxy-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
  process.env.LOG_PAYLOAD_MAX_CHARS = "0";
  process.env.ADMIN_PASSWORD = "verify-proxy-password";
  process.env.SESSION_SECRET = "verify-proxy-session-secret-0123456789";
  // As the existing socket suites do: keep the dead-air keep-alive out of the picture.
  process.env.STREAM_COMMIT_GRACE_MS = "600000";

  const upstream = await startFakeUpstream({ text: o.text, chunkChars: 200, script, delayMs: o.delayMs });
  const { boot: bootContainer } = await import("../src/composition/container");
  const { buildApp } = await import("../src/app");
  const c = await bootContainer();
  const provider = c.providers.create({ name: "fake", type: "openai_completion", baseUrl: upstream.baseUrl, apiKey: "k" });
  const model = c.models.create({ name: "m" });
  c.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "up" });
  c.services.create({ name: "svc", definition: PASSTHROUGH as never });
  const { secret } = c.tokens.create({ name: "t" });

  const app = await buildApp(c);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  harness = { app, upstream, port, secret, dataDir, sqlite: c.sqlite as never };
  return harness;
}

interface Received {
  status: number;
  text: string;
  /** The response ended without a clean end-of-message. */
  aborted: boolean;
}

/**
 * A streaming chat client. With `hangUpWhen` it destroys its own connection once
 * that predicate holds; without it, it stays connected until the server ends or
 * breaks the response.
 */
function chatStream(port: number, secret: string, hangUpWhen?: (received: string) => boolean): Promise<Received> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ model: "svc", stream: true, messages: [{ role: "user", content: "hi" }] }));
    let text = "";
    let status = 0;
    let done = false;
    const finish = (aborted: boolean): void => {
      if (done) return;
      done = true;
      resolve({ status, text, aborted });
    };
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, "content-length": String(payload.length) } },
      (res) => {
        status = res.statusCode ?? 0;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
          if (hangUpWhen && !done && hangUpWhen(text)) {
            finish(true);
            req.destroy();
          }
        });
        res.on("end", () => finish(!res.complete));
        res.on("aborted", () => finish(true));
        res.on("error", () => finish(true));
        res.on("close", () => finish(!res.complete));
      });
    req.on("error", (e) => { if (done) return; if (status === 0) reject(e); else finish(true); });
    req.end(payload);
  });
}

interface Row { http_status: number; error: string | null; attempts: number; streaming: number }

/** The single request-log row of this boot, once it has been written. */
async function onlyRow(h: Harness, waitMs = 10_000): Promise<Row> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const rows = h.sqlite.prepare("SELECT http_status, error, attempts, streaming FROM request_logs ORDER BY id").all() as Row[];
    if (rows.length > 0) {
      // Give a second (wrong) row the chance to show up before asserting there is one.
      await new Promise((r) => setTimeout(r, 150));
      const settled = h.sqlite.prepare("SELECT http_status, error, attempts, streaming FROM request_logs ORDER BY id").all() as Row[];
      expect(settled).toHaveLength(1);
      return settled[0];
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("no request_logs row was written");
}

describe("T2: chat passthrough stream — logged status when the stream breaks", () => {
  const ANSWER = "y".repeat(60_000);

  it("the UPSTREAM connection resets mid-stream while the client is still connected → 502, not 499", async () => {
    const h = await boot([{ kind: "reset", afterChars: 20_000 }], { text: ANSWER });
    const got = await chatStream(h.port, h.secret);

    // The stream had started and broke short; the client never hung up itself.
    expect(got.status).toBe(200);
    expect(got.text).toContain('"content":"yyy');
    expect(got.text).not.toContain("[DONE]");

    const row = await onlyRow(h);
    expect(row.http_status).toBe(502);
    expect(row.error).toBeTruthy();
    expect(row.streaming).toBe(1);
    expect(h.upstream.requests).toBe(1);
  }, 30_000);

  it("the same, with a slowly generating upstream (the client is mid-read when the upstream dies) → 502", async () => {
    // ~330 KB of SSE in 16 KiB writes, 40 ms apart, cut after 150 000 answer characters.
    const long = "y".repeat(200_000);
    const h = await boot([{ kind: "reset", afterChars: 150_000 }], { text: long, delayMs: 40 });
    const got = await chatStream(h.port, h.secret);

    expect(got.status).toBe(200);
    expect(got.text).not.toContain("[DONE]");

    const row = await onlyRow(h);
    expect(row.http_status).toBe(502);
    expect(row.http_status).not.toBe(499);
  }, 30_000);

  it("the CLIENT disconnects mid-stream → 499", async () => {
    // Left alone this upstream keeps streaming for about three seconds.
    const long = "y".repeat(200_000);
    const h = await boot([], { text: long, delayMs: 150 });
    const got = await chatStream(h.port, h.secret, (r) => r.includes('"content":"yyy'));

    expect(got.status).toBe(200);
    expect(got.text).not.toContain("[DONE]");

    const row = await onlyRow(h);
    expect(row.http_status).toBe(499);
    expect(row.error).toBeTruthy();
  }, 30_000);

  it("unchanged: a stream that completes is logged 200", async () => {
    const h = await boot([], { text: ANSWER });
    const got = await chatStream(h.port, h.secret);

    expect(got.status).toBe(200);
    expect(got.text).toContain("[DONE]");
    expect(got.aborted).toBe(false);

    const row = await onlyRow(h);
    expect(row.http_status).toBe(200);
    expect(row.error).toBeNull();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// T13 — graceful shutdown closes the egress proxy pool after the drain
// ---------------------------------------------------------------------------

describe("T13: graceful shutdown and the egress proxy pool", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function fixture(close: () => Promise<unknown>) {
    const order: string[] = [];
    const app: ClosableServer = {
      close: vi.fn(async () => {
        order.push("drain:start");
        await close();
        order.push("drain:end");
      }),
      server: { closeAllConnections: vi.fn(() => { order.push("force"); }) },
      log: { warn: vi.fn() },
    };
    const closeAll = vi.fn(async () => { order.push("pool.closeAll"); });
    const flush = vi.fn(() => { order.push("stats.flush"); });
    const sqliteClose = vi.fn(() => { order.push("sqlite.close"); });
    const resources: ShutdownResources = { statsCache: { flush }, egressPool: { closeAll }, sqlite: { close: sqliteClose } };
    return { app, resources, closeAll, flush, sqliteClose, order };
  }

  it("invokes the pool's closeAll exactly once on a clean shutdown", async () => {
    const f = fixture(async () => undefined);
    await shutdownGracefully(f.app, f.resources, 30_000);
    expect(f.closeAll).toHaveBeenCalledTimes(1);
    expect(f.app.server.closeAllConnections).not.toHaveBeenCalled();
  });

  it("closes the pool only after in-flight requests have drained", async () => {
    vi.useFakeTimers();
    // The drain takes 500 ms: requests are still in flight until then.
    const f = fixture(() => new Promise<void>((resolve) => setTimeout(resolve, 500)));
    const stopping = shutdownGracefully(f.app, f.resources, 30_000);

    await vi.advanceTimersByTimeAsync(499);
    expect(f.closeAll).not.toHaveBeenCalled(); // still draining: the pool must stay usable

    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(f.closeAll).toHaveBeenCalledTimes(1);
    expect(f.order.indexOf("pool.closeAll")).toBeGreaterThan(f.order.indexOf("drain:end"));
  });

  it("the shutdown waits for the pool teardown to finish after a clean drain", async () => {
    const order: string[] = [];
    const app: ClosableServer = { close: async () => { order.push("drained"); }, server: {}, log: { warn: vi.fn() } };
    const resources: ShutdownResources = {
      statsCache: { flush: () => undefined },
      egressPool: { closeAll: async () => { await new Promise((r) => setTimeout(r, 30)); order.push("pool closed"); } },
      sqlite: { close: () => undefined },
    };
    await shutdownGracefully(app, resources, 30_000);
    expect(order).toEqual(["drained", "pool closed"]);
  });

  it("unchanged: the stats cache is still flushed and the database still closed", async () => {
    const f = fixture(async () => undefined);
    await shutdownGracefully(f.app, f.resources, 30_000);
    expect(f.flush).toHaveBeenCalledTimes(1);
    expect(f.sqliteClose).toHaveBeenCalledTimes(1);
    expect(f.order.indexOf("stats.flush")).toBeGreaterThan(f.order.indexOf("drain:end"));
    expect(f.order.indexOf("sqlite.close")).toBeGreaterThan(f.order.indexOf("drain:end"));
  });

  it("a drain that never finishes: the pool is not torn down before the grace deadline", async () => {
    vi.useFakeTimers();
    const f = fixture(() => new Promise<void>(() => undefined));
    const stopping = shutdownGracefully(f.app, f.resources, 1_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.closeAll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(f.app.server.closeAllConnections).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// T15 — NODE_HEAP_PERCENT out of range: warn, use 100
// ---------------------------------------------------------------------------

describe("T15: NODE_HEAP_PERCENT out of range", () => {
  const MIB = 1024 * 1024;
  const LIMIT_MB = 4096;
  let sigterm: NodeJS.SignalsListener[];
  let sigint: NodeJS.SignalsListener[];
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sigterm = process.listeners("SIGTERM");
    sigint = process.listeners("SIGINT");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    for (const l of process.listeners("SIGTERM")) if (!sigterm.includes(l)) process.removeListener("SIGTERM", l);
    for (const l of process.listeners("SIGINT")) if (!sigint.includes(l)) process.removeListener("SIGINT", l);
    vi.restoreAllMocks();
  });

  /** Start with this NODE_HEAP_PERCENT in a 4096 MiB container; report the heap flag and the warnings. */
  function start(percent: string | undefined): { flag: string | undefined; warnings: string[] } {
    const calls: string[][] = [];
    const child = new EventEmitter() as EventEmitter & { kill: (s: string) => boolean };
    child.kill = () => true;
    const spawnFn = ((_cmd: string, args: string[]) => {
      calls.push(args);
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const env: NodeJS.ProcessEnv = percent === undefined ? {} : { NODE_HEAP_PERCENT: percent };
    ensureHeapSized({ argv: ["node", "server.cjs"], execArgv: [], env, read: () => String(LIMIT_MB * MIB), spawnFn, onExit: () => undefined });
    const warnings = [...warn.mock.calls, ...error.mock.calls].map((args) => args.map(String).join(" "));
    return { flag: calls[0]?.find((a) => a.startsWith("--max-old-space-size=")), warnings };
  }

  it.each(["0", "101", "abc", "-5", "100.5", "1000"])("NODE_HEAP_PERCENT=%j logs a warning and sizes the heap at 100%%", (percent) => {
    const got = start(percent);
    expect(got.flag).toBe(`--max-old-space-size=${LIMIT_MB}`);
    expect(got.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("the warning names the setting", () => {
    const got = start("abc");
    expect(got.warnings.join("\n")).toContain("NODE_HEAP_PERCENT");
  });

  it.each([
    ["100", 4096],
    ["80", 3276],
    ["50", 2048],
    ["1", 128], // 40 MiB, raised to the documented 128 MiB floor
  ] as Array<[string, number]>)("unchanged: an in-range NODE_HEAP_PERCENT=%j is honoured without a warning", (percent, mb) => {
    const got = start(percent);
    expect(got.flag).toBe(`--max-old-space-size=${mb}`);
    expect(got.warnings).toEqual([]);
  });

  it("unchanged: with NODE_HEAP_PERCENT unset the default is 100 and nothing is warned", () => {
    const got = start(undefined);
    expect(got.flag).toBe(`--max-old-space-size=${LIMIT_MB}`);
    expect(got.warnings).toEqual([]);
  });
});
