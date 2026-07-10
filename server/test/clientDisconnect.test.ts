/**
 * A client that hangs up while the proxy is still working.
 *
 * Regression for "the client never received the response, but the proxy logged
 * 200": the non-streaming path wrote its 200 row BEFORE reply.send(), never
 * checked delivery, and had no idea the client had left — it even kept retrying
 * a failing upstream on behalf of a client that was long gone, burning retry
 * quota for an answer nobody would receive.
 *
 * Contract now:
 *  - client disconnect aborts the upstream work (no further retries),
 *  - the log row says 499 with a disconnect error, never 200,
 *  - a delivered response still logs 200 exactly as before.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

import { startFakeUpstream, type FakeUpstream, type UpstreamBehavior } from "./fixtures/fakeUpstream";

interface Harness {
  app: FastifyInstance;
  upstream: FakeUpstream;
  port: number;
  secret: string;
  dataDir: string;
  sqlite: { close: () => void; prepare: (s: string) => { get: () => unknown } };
}

let harness: Harness | null = null;

afterEach(async () => {
  if (!harness) return;
  await harness.app.close();
  await harness.upstream.close();
  harness.sqlite.close();
  fs.rmSync(harness.dataDir, { recursive: true, force: true });
  harness = null;
});

async function boot(definition: unknown, script: UpstreamBehavior[], ttfbMs: number): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-gone-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
  process.env.LOG_PAYLOAD_MAX_CHARS = "0";
  process.env.ADMIN_PASSWORD = "disconnect-test-password";
  process.env.SESSION_SECRET = "disconnect-test-session-secret";
  process.env.SIMULATED_STREAMING_TOKEN_RATE = "2000000";

  const upstream = await startFakeUpstream({ text: "THE ANSWER", chunkChars: 200, script, ttfbMs });

  const { boot: bootContainer } = await import("../src/composition/container");
  const { buildApp } = await import("../src/app");
  const c = await bootContainer();

  const provider = c.providers.create({ name: "fake", type: "openai_completion", baseUrl: upstream.baseUrl, apiKey: "k" });
  const model = c.models.create({ name: "m" });
  c.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "up" });
  c.services.create({ name: "svc", definition: definition as never });
  const { secret } = c.tokens.create({ name: "t" });

  const app = await buildApp(c);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;

  harness = { app, upstream, port, secret, dataDir, sqlite: c.sqlite as never };
  return harness;
}

/** Send a request, then destroy the connection after `abortMs`. */
function callAndAbort(port: number, secret: string, stream: boolean, abortMs: number): Promise<number> {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify({ model: "svc", stream, messages: [{ role: "user", content: "hi" }] }));
    let bytes = 0;
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, "content-length": String(payload.length) } },
      (res) => {
        res.on("data", (c: Buffer) => (bytes += c.length));
        res.on("end", () => resolve(bytes));
      });
    req.on("error", () => resolve(bytes));
    req.on("close", () => resolve(bytes));
    setTimeout(() => req.destroy(), abortMs);
    req.end(payload);
  });
}

async function finalRow(h: Harness, waitMs = 12_000): Promise<{ http_status: number; error: string | null; attempts: number }> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const row = h.sqlite.prepare("SELECT http_status, error, attempts FROM request_logs ORDER BY id DESC LIMIT 1").get() as
      { http_status: number; error: string | null; attempts: number } | undefined;
    if (row) return row;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("no request_logs row was written");
}

const RETRYING = { timeoutMs: 30_000, steps: [{ model: "m", provider: "fake", retry: { maxAttempts: 5, on: [503], intervalMs: 0 } }] };

describe("client disconnect while the proxy is still working", () => {
  it("non-streaming: aborts the upstream work, stops retrying, and logs 499 — never 200", async () => {
    // Each attempt costs 2s and fails 503; the client leaves at 500ms.
    const h = await boot(RETRYING, [{ kind: "status", status: 503 }, { kind: "status", status: 503 }], 2_000);
    const received = await callAndAbort(h.port, h.secret, false, 500);

    expect(received).toBe(0); // the client got nothing...
    const row = await finalRow(h);
    expect(row.http_status).toBe(499); // ...and the log says so
    expect(row.error).toContain("client disconnected");
    // The abort stopped the chain: without it, 5 attempts x 2s would run.
    await new Promise((r) => setTimeout(r, 2_500));
    expect(h.upstream.requests).toBeLessThanOrEqual(2);
  }, 30_000);

  it("reliable streaming: a disconnect during the buffering phase also aborts and logs 499", async () => {
    const h = await boot({ ...RETRYING, reliableStreaming: true }, [{ kind: "status", status: 503 }, { kind: "status", status: 503 }], 2_000);
    const received = await callAndAbort(h.port, h.secret, true, 500);

    expect(received).toBe(0);
    const row = await finalRow(h);
    expect(row.http_status).toBe(499);
    expect(row.error).toContain("client disconnected");
    await new Promise((r) => setTimeout(r, 2_500));
    expect(h.upstream.requests).toBeLessThanOrEqual(2);
  }, 30_000);

  it("a patient client still gets the answer, and the row logs 200 after delivery", async () => {
    const h = await boot(RETRYING, [{ kind: "status", status: 503 }], 200);
    const body = await new Promise<string>((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify({ model: "svc", stream: false, messages: [{ role: "user", content: "hi" }] }));
      const req = http.request(
        { host: "127.0.0.1", port: h.port, method: "POST", path: "/v1/chat/completions",
          headers: { "content-type": "application/json", authorization: `Bearer ${h.secret}`, "content-length": String(payload.length) } },
        (res) => {
          let all = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (all += c));
          res.on("end", () => resolve(all));
        });
      req.on("error", reject);
      req.end(payload);
    });

    expect(body).toContain("THE ANSWER");
    const row = await finalRow(h);
    expect(row.http_status).toBe(200);
    expect(row.error).toBeNull();
    expect(row.attempts).toBe(2); // the 503 was still retried
  }, 30_000);
});
