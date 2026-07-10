/**
 * A slow upstream — the local-model case.
 *
 * A local model holds the response until the whole completion is computed:
 * on a big prompt that is easily tens of minutes with NOTHING on the wire.
 * Two proxy-side caps used to kill such calls regardless of configuration:
 *
 *  - undici defaults headersTimeout/bodyTimeout to 5 MINUTES when not passed.
 *    postStream always passed them; postJson — every Micro Agent stage and
 *    every non-streaming call — did not, so the service's timeoutMs was
 *    silently overridden by undici's 300s for any wait past 5 minutes.
 *  - the definition schema capped timeoutMs at 600_000 (10 minutes), so a
 *    30-minute inference could not be configured at all (bounds pinned in
 *    retryPolicy.test.ts).
 *
 * These tests pin the semantic contract at a testable scale: the service's
 * timeoutMs is the ONLY cap on how long the proxy waits for a response, in
 * both directions, on the postJson path.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

import { startFakeUpstream, type FakeUpstream } from "./fixtures/fakeUpstream";

const ANSWER = "THE SLOW LOCAL ANSWER " + "z".repeat(2_000);

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

async function boot(definition: unknown, ttfbMs: number): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-slow-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
  process.env.LOG_PAYLOAD_MAX_CHARS = "0";
  process.env.ADMIN_PASSWORD = "slow-upstream-test-password";
  process.env.SESSION_SECRET = "slow-upstream-test-session-secret";
  process.env.SIMULATED_STREAMING_TOKEN_RATE = "2000000";
  process.env.STREAM_COMMIT_GRACE_MS = "600000"; // real HTTP statuses in these tests

  const upstream = await startFakeUpstream({ text: ANSWER, chunkChars: 500, script: [], ttfbMs });

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

/** A patient NON-streaming client — the postJson path a Micro Agent stage uses. */
function call(port: number, secret: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ model: "svc", stream: false, messages: [{ role: "user", content: "hi" }] }));
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, "content-length": String(payload.length) } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      });
    req.on("error", reject);
    req.end(payload);
  });
}

describe("slow upstream — timeoutMs is the only cap", () => {
  it("a response slower than the old defaults arrives when timeoutMs allows it", async () => {
    // 4s of silence before headers; timeoutMs 15s. No retry needed, one attempt.
    const h = await boot({ timeoutMs: 15_000, steps: [{ model: "m", provider: "fake", retry: { maxAttempts: 1 } }] }, 4_000);
    const got = await call(h.port, h.secret);

    expect(got.status).toBe(200);
    expect(got.body).toContain("THE SLOW LOCAL ANSWER");
    expect(h.upstream.requests).toBe(1); // no spurious timeout retry fired mid-wait
  }, 30_000);

  it("a wait past timeoutMs times out, retries per policy, and reports a timeout", async () => {
    // 4s of silence, timeoutMs 1.5s, 2 attempts: both time out.
    const h = await boot({ timeoutMs: 1_500, steps: [{ model: "m", provider: "fake", retry: { maxAttempts: 2, on: ["timeout"], intervalMs: 0 } }] }, 4_000);
    const got = await call(h.port, h.secret);

    expect(got.status).toBe(502); // a timeout has no upstream status
    expect(h.upstream.requests).toBe(2); // retried exactly per policy
    const row = h.sqlite.prepare("SELECT http_status, error FROM request_logs ORDER BY id DESC LIMIT 1").get() as
      { http_status: number; error: string | null };
    expect(row.http_status).toBe(502);
    expect(row.error).toMatch(/timeout|aborted/i);
  }, 30_000);

  it("a Micro Agent stage waits out a slow model the same way", async () => {
    const agent = {
      kind: "micro_agent",
      timeoutMs: 15_000,
      stages: [{ name: "s", steps: [{ model: "m", provider: "fake", retry: { maxAttempts: 1 } }], input: [] }],
    };
    const h = await boot(agent, 4_000);
    const got = await call(h.port, h.secret);

    expect(got.status).toBe(200);
    expect(got.body).toContain("THE SLOW LOCAL ANSWER");
    expect(h.upstream.requests).toBe(1);
  }, 30_000);
});
