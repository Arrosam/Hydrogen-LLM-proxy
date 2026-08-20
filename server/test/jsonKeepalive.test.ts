/**
 * Dead-air keep-alive for NON-streaming requests.
 *
 * An OCR/vision answer routinely takes minutes, and a non-streaming JSON
 * response puts zero bytes on the wire until it is done. Behind Cloudflare
 * that is a guaranteed 524 at ~100 seconds — the upstream then finishes into a
 * connection nobody is reading (the 499/502 rows at 60–180s this repo's own
 * production logs showed). The guard commits 200 after a grace window and
 * writes whitespace heartbeats into the body; leading whitespace is valid
 * JSON, the same technique Anthropic's API uses for long non-streaming calls.
 *
 * Contract:
 *  - bytes start flowing within the grace window, whatever the executor does;
 *  - the finished JSON follows on the same response and still parses;
 *  - a failure AFTER commit arrives as the error JSON body, while the LOG
 *    keeps the semantic status;
 *  - a failure BEFORE commit keeps its real HTTP status, exactly as before;
 *  - JSON_COMMIT_GRACE_MS=0 turns the guard off.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

import { startFakeUpstream, type FakeUpstream, type UpstreamBehavior } from "./fixtures/fakeUpstream";

const ANSWER = "OCR RESULT OF A SLOW IMAGE " + "z".repeat(2_000);

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

async function boot(
  definition: unknown,
  script: UpstreamBehavior[],
  o: { ttfbMs?: number; graceMs: number; pingMs?: number },
): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-jsonping-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
  process.env.LOG_PAYLOAD_MAX_CHARS = "0";
  process.env.ADMIN_PASSWORD = "keepalive-test-password";
  process.env.SESSION_SECRET = "keepalive-test-session-secret";
  process.env.JSON_COMMIT_GRACE_MS = String(o.graceMs);
  process.env.STREAM_PING_INTERVAL_MS = String(o.pingMs ?? 1_000);

  const upstream = await startFakeUpstream({ text: ANSWER, script, ttfbMs: o.ttfbMs });

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

interface Out { status: number; raw: string; firstByteMs: number; totalMs: number }

/** One non-streaming chat request over a real socket, with an image attached
 * (the reported failing shape: OCR of an image with stream:false). */
function call(port: number, secret: string): Promise<Out> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const body = {
      model: "svc",
      stream: false,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "OCR this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aWFtYXBpY3R1cmU=" } },
        ],
      }],
    };
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, "content-length": String(payload.length) } },
      (res) => {
        let raw = "", firstByteMs = -1;
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          if (firstByteMs < 0) firstByteMs = Date.now() - t0;
          raw += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, raw, firstByteMs, totalMs: Date.now() - t0 }));
        res.on("error", reject);
      });
    req.on("error", reject);
    req.end(payload);
  });
}

async function row(h: Harness): Promise<{ http_status: number; error: string | null }> {
  for (let i = 0; i < 100; i++) {
    const r = h.sqlite.prepare("SELECT http_status, error FROM request_logs ORDER BY id DESC LIMIT 1").get() as
      { http_status: number; error: string | null } | undefined;
    if (r) return r;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("no request_logs row was written");
}

const DEF = { timeoutMs: 30_000, steps: [{ model: "m", provider: "fake", retry: { maxAttempts: 2, on: [503], intervalMs: 0 } }] };

describe("dead-air keep-alive on non-streaming requests", () => {
  it("whitespace flows within the grace window; the JSON answer follows and still parses", async () => {
    // The upstream takes 6s; the old behavior was 6s of total silence — a 524
    // from any ~100s intermediary once the answer is slow enough.
    const h = await boot(DEF, [], { ttfbMs: 6_000, graceMs: 1_000, pingMs: 1_000 });
    const got = await call(h.port, h.secret);

    expect(got.status).toBe(200);
    expect(got.firstByteMs).toBeLessThan(4_000); // heartbeats, long before the 6s answer
    expect(got.totalMs).toBeGreaterThanOrEqual(5_500);
    expect(got.raw.startsWith("\n")).toBe(true); // leading whitespace heartbeats...
    const parsed = JSON.parse(got.raw) as { choices: Array<{ message: { content: string } }> };
    // ...that JSON.parse skips, leaving the answer intact. The upstream answers
    // image-bearing requests with its OCR array (one entry per image).
    expect(parsed.choices[0].message.content).toContain("OCR TEXT 1");
    expect((await row(h)).http_status).toBe(200);
  }, 30_000);

  it("a failure after commit arrives as the error JSON body; the log keeps the semantic status", async () => {
    // Two 503 attempts, 2s each: the failure lands well after the 1s commit.
    const h = await boot(DEF, [{ kind: "status", status: 503 }, { kind: "status", status: 503 }], { ttfbMs: 2_000, graceMs: 1_000 });
    const got = await call(h.port, h.secret);

    expect(got.status).toBe(200); // the wire status was already committed...
    const parsed = JSON.parse(got.raw) as { error?: { message?: string } };
    expect(parsed.error?.message).toBeTruthy(); // ...so the failure travels in-body
    const r = await row(h);
    expect(r.http_status).toBe(503); // the LOG keeps the real failure status
    expect(r.error).toContain("error body after keep-alive commit");
  }, 30_000);

  it("a failure before commit keeps its real HTTP status", async () => {
    const h = await boot(DEF, [{ kind: "status", status: 401 }], { graceMs: 2_000 });
    const got = await call(h.port, h.secret);
    expect(got.status).toBe(401);
    expect((await row(h)).http_status).toBe(401);
  }, 30_000);

  it("JSON_COMMIT_GRACE_MS=0 disables the guard: silence until the answer", async () => {
    const h = await boot(DEF, [], { ttfbMs: 2_500, graceMs: 0, pingMs: 500 });
    const got = await call(h.port, h.secret);
    expect(got.status).toBe(200);
    expect(got.firstByteMs).toBeGreaterThanOrEqual(2_400); // no early bytes
    expect(got.raw.startsWith("\n")).toBe(false);
  }, 30_000);
});
