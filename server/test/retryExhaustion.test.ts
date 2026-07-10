/**
 * Long-running retry exhaustion, end to end: real upstream, real proxy, real
 * sockets. Every upstream attempt burns at least 2 seconds before it fails, so
 * these runs take tens of seconds by construction — that is the point. What is
 * being verified is that a request which spends a minute failing still ends in
 * one clean HTTP error for the client, with an attempt count that matches the
 * configured policy exactly.
 *
 * Design (ISTQB):
 *   BVA  retry.maxAttempts at its schema ceiling (20) and floor (1).
 *   ST   the whole chain walked to exhaustion: step 1 -> step 2 -> step 3 -> failed.
 *   EG   which status reaches the client when the steps fail differently, and
 *        what a transport-level death (no HTTP status at all) maps to.
 *   DT   the 499 idempotency guard, observed through the real pipeline.
 *
 * The policy decisions themselves are covered exhaustively, and quickly, in
 * retryPolicy.test.ts. This file exists to prove the engine behaves the same way
 * once real sockets, real timeouts and a real client are in the loop.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

import { startFakeUpstream, type FakeUpstream, type UpstreamBehavior } from "./fixtures/fakeUpstream";

/** Every attempt sits here before it fails. */
const ATTEMPT_COST_MS = 2_000;

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

async function boot(definition: unknown, script: UpstreamBehavior[]): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-exhaust-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
  process.env.LOG_PAYLOAD_MAX_CHARS = "0";
  process.env.ADMIN_PASSWORD = "exhaustion-test-password";
  process.env.SESSION_SECRET = "exhaustion-test-session-secret";
  process.env.SIMULATED_STREAMING_TOKEN_RATE = "2000000";
  // These suites assert the REAL HTTP status of slow failures, so keep the
  // dead-air keep-alive from committing a 200 first (sseKeepalive.test.ts
  // covers the committed path).
  process.env.STREAM_COMMIT_GRACE_MS = "600000";

  // ttfbMs makes every attempt — success or failure — cost real time.
  const upstream = await startFakeUpstream({ text: "ANSWER", chunkChars: 200, script, ttfbMs: ATTEMPT_COST_MS });

  const { boot: bootContainer } = await import("../src/composition/container");
  const { buildApp } = await import("../src/app");
  const c = await bootContainer();

  const provider = c.providers.create({ name: "fake", type: "openai_completion", baseUrl: upstream.baseUrl, apiKey: "k" });
  for (const name of ["m1", "m2", "m3"]) {
    const model = c.models.create({ name });
    c.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "up" });
  }
  c.services.create({ name: "svc", definition: definition as never });
  const { secret } = c.tokens.create({ name: "t" });

  const app = await buildApp(c);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;

  harness = { app, upstream, port, secret, dataDir, sqlite: c.sqlite as never };
  return harness;
}

interface ClientResult { status: number; body: string; sawSse: boolean }

/** A streaming client. On failure it must receive one error object, not a stream. */
function call(port: number, secret: string): Promise<ClientResult> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ model: "svc", stream: true, messages: [{ role: "user", content: "hi" }] }));
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, "content-length": String(payload.length) } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, sawSse: body.includes("data:") }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function logRow(h: Harness): Promise<{ http_status: number; attempts: number; error: string | null; attempt_path_json: string }> {
  for (let i = 0; i < 100; i++) {
    const row = h.sqlite
      .prepare("SELECT http_status, attempts, error, attempt_path_json FROM request_logs ORDER BY id DESC LIMIT 1")
      .get() as { http_status: number; attempts: number; error: string | null; attempt_path_json: string } | undefined;
    if (row) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("no request_logs row was written");
}

const repeat = (n: number, b: UpstreamBehavior): UpstreamBehavior[] => Array.from({ length: n }, () => b);

// ---------------------------------------------------------------------------

describe("retry exhaustion — a long, slow, failing request still ends cleanly", () => {
  it(
    "BVA: 20 retries (the schema ceiling), each costing 2s, then one 503 for the client",
    async () => {
      const def = {
        timeoutMs: 30_000,
        steps: [{ model: "m1", provider: "fake", retry: { maxAttempts: 20, on: [503], intervalMs: 0 } }],
      };
      const h = await boot(def, repeat(20, { kind: "status", status: 503 }));

      const t0 = Date.now();
      const got = await call(h.port, h.secret);
      const elapsed = Date.now() - t0;

      expect(h.upstream.requests).toBe(20); // exactly the ceiling — not 19, not 21
      expect(elapsed).toBeGreaterThanOrEqual(20 * ATTEMPT_COST_MS);

      expect(got.status).toBe(503);
      expect(got.sawSse).toBe(false); // an error object, never a partial stream
      expect(JSON.parse(got.body)).toMatchObject({ error: { type: "server_error" } });

      const row = await logRow(h);
      expect(row.http_status).toBe(503);
      expect(row.attempts).toBe(20);
      expect(JSON.parse(row.attempt_path_json)).toHaveLength(20);
      expect(row.error).toContain("retry#19"); // the last retry's context is carried
    },
    180_000,
  );

  it(
    "ST: the whole chain walked to exhaustion — 3 steps x 5 attempts, 15 slow failures",
    async () => {
      const def = {
        timeoutMs: 30_000,
        steps: [
          { model: "m1", provider: "fake", retry: { maxAttempts: 5, on: [503], intervalMs: 0 } },
          { model: "m2", provider: "fake", retry: { maxAttempts: 5, on: [429], intervalMs: 0 } },
          { model: "m3", provider: "fake", retry: { maxAttempts: 5, on: [500], intervalMs: 0 } },
        ],
      };
      const script = [...repeat(5, { kind: "status", status: 503 } as const), ...repeat(5, { kind: "status", status: 429 } as const), ...repeat(5, { kind: "status", status: 500 } as const)];
      const h = await boot(def, script);

      const t0 = Date.now();
      const got = await call(h.port, h.secret);
      const elapsed = Date.now() - t0;

      expect(h.upstream.requests).toBe(15);
      expect(elapsed).toBeGreaterThanOrEqual(15 * ATTEMPT_COST_MS);

      // EG: the LAST failure is what the client is told, not the first.
      expect(got.status).toBe(500);
      expect(got.sawSse).toBe(false);

      const row = await logRow(h);
      expect(row.http_status).toBe(500);
      expect(row.attempts).toBe(15);
      const attemptPath = JSON.parse(row.attempt_path_json) as Array<{ step: number; model: string; status: number }>;
      expect(attemptPath.map((a) => a.step)).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3]);
      expect(attemptPath.map((a) => a.model)).toContain("m3");
      expect(attemptPath.at(-1)?.status).toBe(500);
    },
    180_000,
  );

  it(
    "ST: a step that succeeds after the previous one exhausted stops the chain there",
    async () => {
      const def = {
        timeoutMs: 30_000,
        steps: [
          { model: "m1", provider: "fake", retry: { maxAttempts: 5, on: [503], intervalMs: 0 } },
          { model: "m2", provider: "fake", retry: { maxAttempts: 5, on: [503], intervalMs: 0 } },
        ],
      };
      const h = await boot(def, repeat(5, { kind: "status", status: 503 }));

      const got = await call(h.port, h.secret);

      expect(h.upstream.requests).toBe(6); // 5 failures on step 1, then step 2 succeeds
      expect(got.status).toBe(200);
      expect(got.sawSse).toBe(true);
      expect(got.body).toContain("[DONE]");

      const row = await logRow(h);
      expect(row.http_status).toBe(200);
      expect(row.attempts).toBe(6);
    },
    180_000,
  );

  it(
    "EG: exhausting retries against a transport death (no HTTP status at all) yields 502",
    async () => {
      // The upstream kills the socket before sending headers, so nothing is
      // committed and every attempt is retryable — even on a passthrough stream.
      const def = {
        timeoutMs: 30_000,
        steps: [{ model: "m1", provider: "fake", retry: { maxAttempts: 4, on: ["error"], intervalMs: 0 } }],
      };
      const h = await boot(def, repeat(4, { kind: "hangup" }));

      const t0 = Date.now();
      const got = await call(h.port, h.secret);
      const elapsed = Date.now() - t0;

      expect(h.upstream.requests).toBe(4);
      expect(elapsed).toBeGreaterThanOrEqual(4 * ATTEMPT_COST_MS);

      // A dead socket has no status; the proxy must not invent one below 400.
      expect(got.status).toBe(502);
      expect(got.sawSse).toBe(false);

      const row = await logRow(h);
      expect(row.http_status).toBe(502);
      expect(row.attempts).toBe(4);
    },
    180_000,
  );

  it(
    "EG: a mid-stream reset is retried when the service buffers, and still ends at 502",
    async () => {
      // Reliable Streaming has not committed anything when the socket dies, so
      // unlike a passthrough stream it can retry — and exhaust — a reset.
      const def = {
        timeoutMs: 30_000,
        reliableStreaming: true,
        steps: [{ model: "m1", provider: "fake", retry: { maxAttempts: 4, on: ["error"], intervalMs: 0 } }],
      };
      const h = await boot(def, repeat(4, { kind: "reset", afterChars: 3 }));

      const got = await call(h.port, h.secret);

      expect(h.upstream.requests).toBe(4);
      expect(got.status).toBe(502);
      expect(got.sawSse).toBe(false);
      expect(got.body).not.toContain("ANS"); // no fragment of the partial answer
    },
    180_000,
  );

  it(
    "BVA: maxAttempts=1 (the floor) makes exactly one slow attempt, then fails",
    async () => {
      const def = {
        timeoutMs: 30_000,
        steps: [{ model: "m1", provider: "fake", retry: { maxAttempts: 1, on: [503], intervalMs: 0 } }],
      };
      const h = await boot(def, repeat(3, { kind: "status", status: 503 }));

      const t0 = Date.now();
      const got = await call(h.port, h.secret);
      const elapsed = Date.now() - t0;

      expect(h.upstream.requests).toBe(1);
      expect(elapsed).toBeGreaterThanOrEqual(ATTEMPT_COST_MS);
      expect(elapsed).toBeLessThan(3 * ATTEMPT_COST_MS); // it did not silently retry
      expect(got.status).toBe(503);
    },
    120_000,
  );

  it(
    "DT: a 499 under idempotency=unsafe is never retried, however many are allowed",
    async () => {
      const def = {
        timeoutMs: 30_000,
        steps: [{ model: "m1", provider: "fake", retry: { maxAttempts: 20, on: [499], intervalMs: 0, idempotency: "unsafe" } }],
      };
      const h = await boot(def, repeat(20, { kind: "status", status: 499 }));

      const t0 = Date.now();
      const got = await call(h.port, h.secret);
      const elapsed = Date.now() - t0;

      expect(h.upstream.requests).toBe(1); // the guard fires before the first retry
      expect(elapsed).toBeLessThan(3 * ATTEMPT_COST_MS);
      expect(got.status).toBe(499);

      const row = await logRow(h);
      expect(row.attempts).toBe(1);
      expect(row.error).toContain("499 suppressed");
    },
    120_000,
  );

  it(
    "Reliable Streaming: 20 slow truncations exhaust the retries and the user gets 502, never a partial answer",
    async () => {
      const def = {
        timeoutMs: 30_000,
        reliableStreaming: true,
        steps: [{ model: "m1", provider: "fake", retry: { maxAttempts: 20, on: [502], intervalMs: 0 } }],
      };
      const h = await boot(def, repeat(20, { kind: "truncate", afterChars: 3 }));

      const t0 = Date.now();
      const got = await call(h.port, h.secret);
      const elapsed = Date.now() - t0;

      expect(h.upstream.requests).toBe(20);
      expect(elapsed).toBeGreaterThanOrEqual(20 * ATTEMPT_COST_MS);

      expect(got.status).toBe(502);
      expect(got.sawSse).toBe(false); // not one byte of the truncated answer leaked
      expect(got.body).not.toContain("ANSWER");

      const row = await logRow(h);
      expect(row.http_status).toBe(502);
      expect(row.attempts).toBe(20);
    },
    180_000,
  );
});
