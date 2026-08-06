/**
 * Quick reproduction: does an upstream 499 trigger a retry end-to-end?
 * Fake upstream returns 499 on attempt 1, then succeeds. If retry works,
 * upstream.requests === 2 and the client gets 200.
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
  sqlite: { close: () => void };
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-499-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
  process.env.LOG_PAYLOAD_MAX_CHARS = "0";
  process.env.ADMIN_PASSWORD = "499-test-password";
  process.env.SESSION_SECRET = "499-test-session-secret";
  process.env.SIMULATED_STREAMING_TOKEN_RATE = "2000000";
  process.env.STREAM_COMMIT_GRACE_MS = "600000";

  const upstream = await startFakeUpstream({ text: "ANSWER", chunkChars: 200, script, ttfbMs: 50 });

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

function call(port: number, secret: string, stream: boolean): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ model: "svc", stream, messages: [{ role: "user", content: "hi" }] }));
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, "content-length": String(payload.length) } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("upstream 499 retry behavior", () => {
  it("non-streaming: 499 on attempt 1 then success -> should retry and get 200", async () => {
    const def = {
      timeoutMs: 30_000,
      steps: [{ model: "m", provider: "fake", retry: { maxAttempts: 3, on: [499, 502, 503], intervalMs: 0 } }],
    };
    const h = await boot(def, [{ kind: "status", status: 499 }, { kind: "ok" }]);

    const got = await call(h.port, h.secret, false);

    expect(h.upstream.requests).toBe(2); // retried once
    expect(got.status).toBe(200);
    expect(got.body).toContain("ANSWER");
  }, 30_000);

  it("non-streaming: 499 with DEFAULT config (no retry block) -> should retry", async () => {
    const def = {
      timeoutMs: 30_000,
      steps: [{ model: "m", provider: "fake" }], // no retry block -> defaults
    };
    const h = await boot(def, [{ kind: "status", status: 499 }, { kind: "ok" }]);

    const got = await call(h.port, h.secret, false);

    expect(h.upstream.requests).toBe(2);
    expect(got.status).toBe(200);
  }, 30_000);

  it("non-streaming: 499 exhausted -> client gets 499", async () => {
    const def = {
      timeoutMs: 30_000,
      steps: [{ model: "m", provider: "fake", retry: { maxAttempts: 2, on: [499, 502, 503], intervalMs: 0 } }],
    };
    const h = await boot(def, [{ kind: "status", status: 499 }, { kind: "status", status: 499 }]);

    const got = await call(h.port, h.secret, false);

    expect(h.upstream.requests).toBe(2);
    expect(got.status).toBe(499);
  }, 30_000);

  it("streaming: 499 on attempt 1 then success -> should retry and get 200", async () => {
    const def = {
      timeoutMs: 30_000,
      steps: [{ model: "m", provider: "fake" }], // defaults
    };
    const h = await boot(def, [{ kind: "status", status: 499 }, { kind: "ok" }]);

    const got = await call(h.port, h.secret, true);

    expect(h.upstream.requests).toBe(2);
    expect(got.status).toBe(200);
    expect(got.body).toContain("[DONE]");
  }, 30_000);

  it("reliable streaming: 499 on attempt 1 then success -> should retry", async () => {
    const def = {
      timeoutMs: 30_000,
      reliableStreaming: true,
      steps: [{ model: "m", provider: "fake" }],
    };
    const h = await boot(def, [{ kind: "status", status: 499 }, { kind: "ok" }]);

    const got = await call(h.port, h.secret, true);

    expect(h.upstream.requests).toBe(2);
    expect(got.status).toBe(200);
    expect(got.body).toContain("[DONE]");
  }, 30_000);
});
