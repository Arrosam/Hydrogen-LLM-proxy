/**
 * Dead-air keep-alive for streaming requests.
 *
 * A Micro Agent / Reliable Streaming request buffers before replying — in
 * production that was 127 seconds of total silence on the wire, and every
 * intermediary (and the client itself) kills a silent connection long before
 * that. The client then "receives nothing" while the proxy, finishing later,
 * logs an honest 200 into a connection nobody was reading.
 *
 * Contract:
 *  - bytes start flowing within the grace window (pings), whatever the
 *    executor is doing;
 *  - the finished answer follows on the same stream, byte-exact;
 *  - a failure AFTER commit arrives as the protocol's in-stream error event —
 *    no [DONE] / message_stop after it — while the LOG keeps the semantic
 *    status (503, 502, ...);
 *  - a failure BEFORE commit keeps its real HTTP status, exactly as before.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

import { startFakeUpstream, type FakeUpstream, type UpstreamBehavior } from "./fixtures/fakeUpstream";

const ANSWER = "HELLO WORLD THE COMPLETE ANSWER " + "z".repeat(5_000);

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-ping-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
  process.env.LOG_PAYLOAD_MAX_CHARS = "0";
  process.env.ADMIN_PASSWORD = "keepalive-test-password";
  process.env.SESSION_SECRET = "keepalive-test-session-secret";
  process.env.SIMULATED_STREAMING_TOKEN_RATE = "2000000";
  process.env.STREAM_COMMIT_GRACE_MS = String(o.graceMs);
  process.env.STREAM_PING_INTERVAL_MS = String(o.pingMs ?? 1_000);

  const upstream = await startFakeUpstream({ text: ANSWER, chunkChars: 500, script, ttfbMs: o.ttfbMs });

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

/** Reassemble the assistant text from openai-format content deltas. */
function openaiText(raw: string): string {
  let text = "";
  for (const frame of raw.split("\n\n")) {
    if (!frame.startsWith("data:")) continue;
    const data = frame.slice(5).trim();
    if (data === "[DONE]") continue;
    try {
      const delta = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content;
      if (typeof delta === "string") text += delta;
    } catch { /* not a content frame */ }
  }
  return text;
}

/** Reassemble the assistant text from anthropic-format content deltas. */
function anthropicText(raw: string): string {
  let text = "";
  for (const frame of raw.split("\n\n")) {
    const line = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    try {
      const j = JSON.parse(line.slice(5).trim()) as { type?: string; delta?: { type?: string; text?: string } };
      if (j.type === "content_block_delta" && j.delta?.type === "text_delta" && typeof j.delta.text === "string") text += j.delta.text;
    } catch { /* not a content frame */ }
  }
  return text;
}

function call(port: number, secret: string, ingress: "openai" | "anthropic"): Promise<Out> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const isAnthropic = ingress === "anthropic";
    const body = isAnthropic
      ? { model: "svc", stream: true, max_tokens: 4096, messages: [{ role: "user", content: "hi" }] }
      : { model: "svc", stream: true, messages: [{ role: "user", content: "hi" }] };
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: isAnthropic ? "/v1/messages" : "/v1/chat/completions",
        headers: {
          "content-type": "application/json", authorization: `Bearer ${secret}`, "content-length": String(payload.length),
          ...(isAnthropic ? { "anthropic-version": "2023-06-01" } : {}),
        } },
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

const RELIABLE = { timeoutMs: 30_000, reliableStreaming: true, steps: [{ model: "m", provider: "fake", retry: { maxAttempts: 2, on: [503], intervalMs: 0 } }] };

describe("dead-air keep-alive on streaming requests", () => {
  it("bytes flow within the grace window while the executor buffers; the answer follows", async () => {
    // The upstream takes 6s; the old behavior was 6s of total silence.
    const h = await boot(RELIABLE, [], { ttfbMs: 6_000, graceMs: 1_000, pingMs: 1_000 });
    const got = await call(h.port, h.secret, "openai");

    expect(got.status).toBe(200);
    expect(got.firstByteMs).toBeLessThan(4_000); // pings, long before the 6s answer
    expect(got.totalMs).toBeGreaterThanOrEqual(5_500);
    expect(got.raw).toContain(": ping"); // SSE comment, ignored by conforming parsers
    expect(openaiText(got.raw)).toBe(ANSWER); // the answer still arrives, byte-exact
    expect(got.raw).toContain("data: [DONE]");
    expect((await row(h)).http_status).toBe(200);
  }, 30_000);

  it("anthropic ingress gets protocol pings (event: ping), then the full answer", async () => {
    const h = await boot(RELIABLE, [], { ttfbMs: 4_000, graceMs: 1_000, pingMs: 1_000 });
    const got = await call(h.port, h.secret, "anthropic");

    expect(got.status).toBe(200);
    expect(got.firstByteMs).toBeLessThan(3_500);
    expect(got.raw).toContain("event: ping"); // Anthropic's own wire format
    expect(anthropicText(got.raw)).toBe(ANSWER); // byte-exact through the pings
    expect(got.raw).toContain("message_stop");
    expect((await row(h)).http_status).toBe(200);
  }, 30_000);

  it("a failure after commit arrives as an in-stream error event; the log keeps the semantic status", async () => {
    // Both attempts fail 503, 2s each: the failure lands well after the 1s commit.
    const h = await boot(RELIABLE, [{ kind: "status", status: 503 }, { kind: "status", status: 503 }], { ttfbMs: 2_000, graceMs: 1_000 });
    const got = await call(h.port, h.secret, "openai");

    expect(got.status).toBe(200); // the wire status was already committed...
    expect(got.raw).toContain('"error"'); // ...so the failure travels in-stream
    expect(got.raw).not.toContain("[DONE]"); // and nothing marks it as a completed answer
    expect(got.raw).not.toContain("HELLO WORLD");
    const r = await row(h);
    expect(r.http_status).toBe(503); // the LOG keeps the real failure status
    expect(r.error).toContain("in-stream error event");
  }, 30_000);

  it("anthropic ingress delivers the in-stream failure as an `error` event", async () => {
    const h = await boot(RELIABLE, [{ kind: "status", status: 503 }, { kind: "status", status: 503 }], { ttfbMs: 2_000, graceMs: 1_000 });
    const got = await call(h.port, h.secret, "anthropic");

    expect(got.status).toBe(200);
    expect(got.raw).toContain("event: error");
    expect(got.raw).toContain('"type":"error"');
    expect(got.raw).not.toContain("message_stop");
    expect((await row(h)).http_status).toBe(503);
  }, 30_000);

  it("a failure faster than the grace window keeps its real HTTP status", async () => {
    // Instant 503s, grace 10s: nothing was committed, so the client gets a real 503.
    const h = await boot(RELIABLE, [{ kind: "status", status: 503 }, { kind: "status", status: 503 }], { graceMs: 10_000 });
    const got = await call(h.port, h.secret, "openai");

    expect(got.status).toBe(503);
    expect(JSON.parse(got.raw)).toMatchObject({ error: { type: "server_error" } });
    expect((await row(h)).http_status).toBe(503);
  }, 30_000);

  it("a fast success is completely unaffected by the keep-alive", async () => {
    const h = await boot(RELIABLE, [], { graceMs: 10_000 });
    const got = await call(h.port, h.secret, "openai");

    expect(got.status).toBe(200);
    expect(got.raw).not.toContain(": ping"); // never committed early
    expect(got.raw).toContain("data: [DONE]");
    expect((await row(h)).http_status).toBe(200);
  }, 30_000);
});
