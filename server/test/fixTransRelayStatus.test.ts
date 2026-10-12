/**
 * T2 — an upstream that fails in the middle of a passthrough stream is an
 * upstream failure. The client is still connected, so the request-log row must
 * not land in the client-closed (499) bucket; a clean truncation already logs
 * the upstream-failure status and a thrown one must agree with it.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

import { startFakeUpstream, type FakeUpstream, type UpstreamBehavior } from "./fixtures/fakeUpstream";

const ANSWER = "abcdefghij".repeat(10_000);

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

async function boot(script: UpstreamBehavior[]): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-fix-relay-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
  process.env.ADMIN_PASSWORD = "fix-relay-test-password";
  process.env.SESSION_SECRET = "fix-relay-test-session-secret";
  process.env.STREAM_COMMIT_GRACE_MS = "600000";

  const upstream = await startFakeUpstream({ text: ANSWER, chunkChars: 200, script });
  const { boot: bootContainer } = await import("../src/composition/container");
  const { buildApp } = await import("../src/app");
  const c = await bootContainer();
  const provider = c.providers.create({ name: "fake", type: "openai_completion", baseUrl: upstream.baseUrl, apiKey: "k" });
  const model = c.models.create({ name: "m" });
  c.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "up" });
  c.services.create({ name: "svc", definition: { timeoutMs: 5_000, steps: [{ model: "m", provider: "fake" }] } as never });
  const { secret } = c.tokens.create({ name: "t" });
  const app = await buildApp(c);
  await app.listen({ port: 0, host: "127.0.0.1" });
  harness = { app, upstream, port: (app.server.address() as AddressInfo).port, secret, dataDir, sqlite: c.sqlite as never };
  return harness;
}

/** Read the stream to its (possibly broken) end, staying connected throughout. */
function stream(port: number, secret: string): Promise<{ status: number; aborted: boolean }> {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify({ model: "svc", stream: true, messages: [{ role: "user", content: "hi" }] }));
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, "content-length": String(payload.length) } },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, aborted: false }));
        res.on("aborted", () => resolve({ status: res.statusCode ?? 0, aborted: true }));
        res.on("error", () => resolve({ status: res.statusCode ?? 0, aborted: true }));
      },
    );
    req.on("error", () => resolve({ status: 0, aborted: true }));
    req.end(payload);
  });
}

async function loggedRow(h: Harness): Promise<{ http_status: number; error: string | null }> {
  for (let i = 0; i < 100; i++) {
    const row = h.sqlite.prepare("SELECT http_status, error FROM request_logs ORDER BY id DESC LIMIT 1").get() as
      { http_status: number; error: string | null } | undefined;
    if (row) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("no request_logs row was ever written");
}

describe("T2: a passthrough stream that breaks upstream is logged as an upstream failure", () => {
  it("socket reset mid-answer -> 502 with the upstream's error, not 499", async () => {
    const h = await boot([{ kind: "reset", afterChars: 20_000 }]);
    const got = await stream(h.port, h.secret);
    expect(got.status).toBe(200);
    expect(got.aborted).toBe(true);

    const row = await loggedRow(h);
    expect(row.http_status).toBe(502);
    expect(row.error).toBeTruthy();
    expect(row.error).not.toMatch(/client disconnected/);
  }, 30_000);

  it("clean EOF mid-answer still logs 502 (unchanged)", async () => {
    const h = await boot([{ kind: "truncate", afterChars: 20_000 }]);
    await stream(h.port, h.secret);
    expect((await loggedRow(h)).http_status).toBe(502);
  }, 30_000);
});
