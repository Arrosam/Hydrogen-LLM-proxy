/**
 * Independent verification, CORE items C9 (client-facing status of an upstream
 * failure) and C10 (the header deadline of a streamed upstream call).
 *
 * Written from the verification spec only.
 *
 * C9 is checked twice: on the exported status mapper, where a non-integer
 * status can be expressed, and end to end through the real app against a real
 * upstream socket that answers with an out-of-range status line.
 *
 * C10 drives the real `UpstreamClient` against a local HTTP server that delays
 * its response headers, and measures wall-clock time. Bounds are generous but
 * meaningful: a 300 ms timeout has to fail in well under 1 s.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo, Socket } from "node:net";
import type { FastifyInstance } from "fastify";

import { failureStatus } from "../src/core/proxy/errors";
import { UpstreamClient } from "../src/core/upstream/client";
import { SsrfGuard } from "../src/core/upstream/ssrf";
import { classifyError } from "../src/execution/steps";
import { startFakeUpstream, type FakeUpstream, type UpstreamBehavior } from "./fixtures/fakeUpstream";

// ---------------------------------------------------------------------------
// C9 — the status mapper
// ---------------------------------------------------------------------------

describe("C9: the status a failed upstream attempt is reported with", () => {
  const failed = (status: number): { ok: false; status: number; kind: "http"; message: string } =>
    ({ ok: false, status, kind: "http", message: `upstream returned ${status}` });

  it.each([600, 601, 700, 999, 1000, 65_536, Number.MAX_SAFE_INTEGER])("status %d (>= 600) is reported as 502", (status) => {
    expect(failureStatus(failed(status))).toBe(502);
  });

  it.each([400.5, 404.4, 499.999, 500.1, 599.5, 600.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "status %d (not an integer) is reported as 502",
    (status) => {
      expect(failureStatus(failed(status))).toBe(502);
    },
  );

  it.each([400, 401, 403, 404, 408, 422, 429, 451, 499, 500, 501, 502, 503, 504, 529, 598, 599])(
    "unchanged: status %d (400-599) passes through",
    (status) => {
      expect(failureStatus(failed(status))).toBe(status);
    },
  );

  it("the boundary is exactly 599 | 600", () => {
    expect(failureStatus(failed(599))).toBe(599);
    expect(failureStatus(failed(600))).toBe(502);
  });

  it("whatever goes in, what comes out is an integer a client can be answered with", () => {
    for (const status of [0, 399, 400, 599, 600, 999, 1e9, 450.5, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const out = failureStatus(failed(status));
      expect(Number.isInteger(out)).toBe(true);
      expect(out).toBeGreaterThanOrEqual(400);
      expect(out).toBeLessThanOrEqual(599);
    }
  });
});

// ---------------------------------------------------------------------------
// C9 — end to end
// ---------------------------------------------------------------------------

describe("C9 end to end: an upstream that answers with an out-of-range status", () => {
  let app: FastifyInstance;
  let upstream: FakeUpstream;
  let dataDir: string;
  let secret: string;
  let port: number;
  let sqlite: { close: () => void };

  /**
   * One behaviour per upstream attempt. The step retries only on 429, so each
   * client request below is exactly one upstream attempt and consumes exactly
   * one entry, in order.
   */
  const SCRIPT: UpstreamBehavior[] = [
    { kind: "status", status: 600 },
    { kind: "status", status: 999 },
    { kind: "status", status: 599 },
    { kind: "status", status: 400 },
    { kind: "status", status: 404 },
    { kind: "status", status: 500 },
    { kind: "status", status: 503 },
    { kind: "status", status: 600 }, // streamed client
    { kind: "status", status: 599 }, // streamed client
  ];

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-verify-core-"));
    process.env.NODE_ENV = "test";
    process.env.DATA_DIR = dataDir;
    process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
    process.env.LOG_PAYLOAD_MAX_CHARS = "0";
    process.env.ADMIN_PASSWORD = "verify-core-test-password";
    process.env.SESSION_SECRET = "verify-core-test-session-secret";
    process.env.STREAM_COMMIT_GRACE_MS = "600000";

    upstream = await startFakeUpstream({ text: "the answer", script: SCRIPT });

    const { boot } = await import("../src/composition/container");
    const { buildApp } = await import("../src/app");
    const c = await boot();
    const provider = c.providers.create({ name: "fake", type: "openai_completion", baseUrl: upstream.baseUrl, apiKey: "k" });
    const model = c.models.create({ name: "m" });
    c.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "up" });
    c.services.create({
      name: "svc",
      definition: { timeoutMs: 20_000, steps: [{ model: "m", provider: "fake", retry: { maxAttempts: 2, on: [429], intervalMs: 0 } }] } as never,
    });
    secret = c.tokens.create({ name: "t" }).secret;
    sqlite = c.sqlite as { close: () => void };

    app = await buildApp(c);
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await upstream.close();
    sqlite.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** One request over a real socket; resolves with status 0 if the proxy drops the connection. */
  function call(stream: boolean): Promise<{ status: number; body: string }> {
    return new Promise((resolve) => {
      const payload = Buffer.from(JSON.stringify({ model: "svc", stream, messages: [{ role: "user", content: "hi" }] }));
      const req = http.request(
        { host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions",
          headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, "content-length": String(payload.length) } },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          res.on("error", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", () => resolve({ status: 0, body: "" }));
      req.end(payload);
    });
  }

  // These run in order against SCRIPT; each asserts it consumed exactly its own entry.
  const BUFFERED: Array<[number, number]> = [
    [600, 502],
    [999, 502],
    [599, 599],
    [400, 400],
    [404, 404],
    [500, 500],
    [503, 503],
  ];

  BUFFERED.forEach(([upstreamStatus, expected], index) => {
    it(`buffered: upstream ${upstreamStatus} -> client ${expected}`, async () => {
      expect(upstream.requests).toBe(index); // harness check: one attempt per earlier request
      const got = await call(false);
      expect(upstream.requests).toBe(index + 1);
      expect(got.status).toBe(expected);
      expect(got.body).toContain("error");
    }, 30_000);
  });

  it("streamed: upstream 600 before any body -> client 502", async () => {
    expect(upstream.requests).toBe(BUFFERED.length);
    const got = await call(true);
    expect(upstream.requests).toBe(BUFFERED.length + 1);
    expect(got.status).toBe(502);
  }, 30_000);

  it("streamed, unchanged: upstream 599 before any body -> client 599", async () => {
    const got = await call(true);
    expect(upstream.requests).toBe(BUFFERED.length + 2);
    expect(got.status).toBe(599);
  }, 30_000);

  it("unchanged: once the script is spent the upstream answers and the client gets 200", async () => {
    const got = await call(false);
    expect(got.status).toBe(200);
    expect(got.body).toContain("the answer");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// C10 — the header deadline of a streamed call
// ---------------------------------------------------------------------------

interface SlowPlan {
  /** Delay before the response headers are written. */
  headerDelayMs: number;
  /** Body chunks written after the headers. */
  chunks: number;
  /** Gap between body chunks. */
  chunkGapMs: number;
  /** A single extra silence inserted after the first chunk. */
  stallAfterFirstMs?: number;
}

interface SlowServer {
  url: string;
  plan: SlowPlan;
  requests: number;
  close: () => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const chunkText = (i: number): string => `data: chunk-${i}\n\n`;

async function startSlowServer(): Promise<SlowServer> {
  const sockets = new Set<Socket>();
  const state: SlowServer = {
    url: "",
    plan: { headerDelayMs: 0, chunks: 1, chunkGapMs: 0 },
    requests: 0,
    close: async () => undefined,
  };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      void (async () => {
        state.requests += 1;
        const plan = { ...state.plan };
        await sleep(plan.headerDelayMs);
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        for (let i = 0; i < plan.chunks; i++) {
          if (res.destroyed) return;
          res.write(chunkText(i));
          if (i === 0 && plan.stallAfterFirstMs) await sleep(plan.stallAfterFirstMs);
          else if (i < plan.chunks - 1) await sleep(plan.chunkGapMs);
        }
        if (!res.destroyed) res.end();
      })();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
  return state;
}

describe("C10: a streamed upstream call times out on slow headers at the configured time", () => {
  let slow: SlowServer;
  const client = (): UpstreamClient => new UpstreamClient(new SsrfGuard({ allowPrivate: true, allowlist: () => [] }));
  const HEADERS = { "content-type": "application/json" };
  const BODY = { model: "up", stream: true, messages: [{ role: "user", content: "hi" }] };

  beforeAll(async () => {
    slow = await startSlowServer();
  });
  afterAll(async () => {
    await slow.close();
  });
  afterEach(() => {
    slow.plan = { headerDelayMs: 0, chunks: 1, chunkGapMs: 0 };
  });

  /** Run a streamed call that is expected to fail; report how long it took and why. */
  async function failAfter(timeoutMs: number, signal?: AbortSignal): Promise<{ elapsed: number; error: unknown }> {
    const started = performance.now();
    try {
      const reply = await client().postStream(slow.url, HEADERS, BODY, { timeoutMs, ...(signal ? { signal } : {}) });
      reply.body.destroy();
      throw new Error(`postStream resolved with status ${reply.status}; expected a timeout`);
    } catch (error) {
      return { elapsed: performance.now() - started, error };
    }
  }

  async function readAll(body: AsyncIterable<Buffer | string>): Promise<string> {
    let text = "";
    for await (const chunk of body) text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    return text;
  }

  // [timeoutMs, the latest the failure may be reported]
  const CASES: Array<[number, number]> = [
    [100, 600],
    [200, 700],
    [300, 800],
    [400, 900],
  ];

  for (const [timeoutMs, mustFailBefore] of CASES) {
    it(`timeout ${timeoutMs} ms, headers delayed 3 s: fails as a timeout in under ${mustFailBefore} ms`, async () => {
      slow.plan = { headerDelayMs: 3_000, chunks: 1, chunkGapMs: 0 };
      const { elapsed, error } = await failAfter(timeoutMs);
      expect(String((error as Error).message)).not.toMatch(/expected a timeout/);
      expect(classifyError(error).kind).toBe("timeout");
      // Not early ...
      expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 30);
      // ... and at roughly the configured time, not ~1 s after it.
      expect(elapsed).toBeLessThan(mustFailBefore);
      expect(elapsed).toBeLessThan(1_000);
    }, 10_000);
  }

  it("the same deadline holds when the caller also passes its own (un-aborted) signal", async () => {
    slow.plan = { headerDelayMs: 3_000, chunks: 1, chunkGapMs: 0 };
    const controller = new AbortController();
    const { elapsed, error } = await failAfter(300, controller.signal);
    expect(classifyError(error).kind).toBe("timeout");
    expect(elapsed).toBeGreaterThanOrEqual(270);
    expect(elapsed).toBeLessThan(800);
  }, 10_000);

  it("headers that miss the deadline by a little still fail at the deadline (timeout 300 ms, headers at 700 ms)", async () => {
    slow.plan = { headerDelayMs: 700, chunks: 1, chunkGapMs: 0 };
    const { elapsed, error } = await failAfter(300);
    expect(String((error as Error).message)).not.toMatch(/expected a timeout/);
    expect(classifyError(error).kind).toBe("timeout");
    expect(elapsed).toBeLessThan(650); // before the headers would have arrived
  }, 10_000);

  it("two timeouts in a row on one client are each on time (no state carried over)", async () => {
    slow.plan = { headerDelayMs: 3_000, chunks: 1, chunkGapMs: 0 };
    const shared = client();
    for (let i = 0; i < 2; i++) {
      const started = performance.now();
      await expect(shared.postStream(slow.url, HEADERS, BODY, { timeoutMs: 250 })).rejects.toBeDefined();
      expect(performance.now() - started).toBeLessThan(750);
    }
  }, 10_000);

  // --- not cut -------------------------------------------------------------

  it("headers in time, body lasting 4x the timeout: the stream is NOT cut", async () => {
    // 16 chunks 80 ms apart = ~1.2 s of body against a 300 ms timeout. No gap
    // between chunks comes near the timeout, so only a (wrong) total deadline
    // could end it.
    slow.plan = { headerDelayMs: 0, chunks: 16, chunkGapMs: 80 };
    const started = performance.now();
    const reply = await client().postStream(slow.url, HEADERS, BODY, { timeoutMs: 300 });
    expect(reply.status).toBe(200);
    const text = await readAll(reply.body);
    const elapsed = performance.now() - started;
    expect(text).toBe(Array.from({ length: 16 }, (_, i) => chunkText(i)).join(""));
    expect(elapsed).toBeGreaterThan(900); // the body really did outlast the timeout
  }, 15_000);

  it("headers arriving late but inside the timeout, then a long body: NOT cut", async () => {
    // Headers at 150 ms of a 400 ms timeout; the body then runs ~1 s more, well
    // past the moment the header deadline would have fired.
    slow.plan = { headerDelayMs: 150, chunks: 11, chunkGapMs: 100 };
    const started = performance.now();
    const reply = await client().postStream(slow.url, HEADERS, BODY, { timeoutMs: 400 });
    expect(reply.status).toBe(200);
    const text = await readAll(reply.body);
    expect(text).toBe(Array.from({ length: 11 }, (_, i) => chunkText(i)).join(""));
    expect(performance.now() - started).toBeGreaterThan(1_000);
  }, 15_000);

  it("the caller's own signal still does not cut a long body either", async () => {
    slow.plan = { headerDelayMs: 0, chunks: 12, chunkGapMs: 80 };
    const controller = new AbortController();
    const reply = await client().postStream(slow.url, HEADERS, BODY, { timeoutMs: 300, signal: controller.signal });
    expect(await readAll(reply.body)).toBe(Array.from({ length: 12 }, (_, i) => chunkText(i)).join(""));
  }, 15_000);

  // --- neighbours that must be unchanged -------------------------------------

  it("unchanged: a prompt upstream is simply answered", async () => {
    slow.plan = { headerDelayMs: 0, chunks: 2, chunkGapMs: 0 };
    const started = performance.now();
    const reply = await client().postStream(slow.url, HEADERS, BODY, { timeoutMs: 300 });
    expect(reply.status).toBe(200);
    expect(await readAll(reply.body)).toBe(chunkText(0) + chunkText(1));
    expect(performance.now() - started).toBeLessThan(300);
  }, 10_000);

  it("unchanged: a body that goes SILENT for far longer than the timeout is still ended by the idle timeout", async () => {
    // Not a total deadline, but silence is still bounded: the upstream stalls
    // for 5 s after its first chunk and the read must fail long before that.
    slow.plan = { headerDelayMs: 0, chunks: 2, chunkGapMs: 0, stallAfterFirstMs: 5_000 };
    const reply = await client().postStream(slow.url, HEADERS, BODY, { timeoutMs: 300 });
    const started = performance.now();
    await expect(readAll(reply.body)).rejects.toBeDefined();
    expect(performance.now() - started).toBeLessThan(3_500);
  }, 15_000);

  it("unchanged: aborting the caller's signal while waiting for headers ends the call at once", async () => {
    slow.plan = { headerDelayMs: 3_000, chunks: 1, chunkGapMs: 0 };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = performance.now();
    await expect(client().postStream(slow.url, HEADERS, BODY, { timeoutMs: 2_000, signal: controller.signal })).rejects.toBeDefined();
    expect(performance.now() - started).toBeLessThan(700);
  }, 10_000);
});
