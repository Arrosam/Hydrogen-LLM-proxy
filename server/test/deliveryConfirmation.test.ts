/**
 * The log must not claim a delivery that did not happen.
 *
 * Node's 'finish' event fires when every byte has entered the KERNEL's send
 * buffer — not when the client received anything. A response small enough to
 * fit there (a few hundred KB) "finishes" instantly even when the client has
 * stopped reading, so the relay used to write a 200 row and move on; the client
 * then aborted holding a fraction of the answer, and the buffered remainder
 * evaporated. Log: 200, complete. Client: partial. That mismatch is exactly the
 * bug this file pins down.
 *
 * The fix keeps watching the client socket after a 200 row is written: a reset
 * before any further inbound data demotes the row to 499.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

import { startFakeUpstream, type FakeUpstream } from "./fixtures/fakeUpstream";

// Small enough to fit in the kernel send buffer, so 'finish' fires while the
// client is stalled — the window where the old code lied.
const RESPONSE_CHARS = 200_000;

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

async function boot(): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-delivery-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
  process.env.LOG_PAYLOAD_MAX_CHARS = "0";
  process.env.ADMIN_PASSWORD = "delivery-test-password";
  process.env.SESSION_SECRET = "delivery-test-session-secret";
  process.env.SIMULATED_STREAMING_TOKEN_RATE = "2000000";

  const upstream = await startFakeUpstream({ text: "z".repeat(RESPONSE_CHARS), chunkChars: 2000 });

  const { boot: bootContainer } = await import("../src/composition/container");
  const { buildApp } = await import("../src/app");
  const c = await bootContainer();

  const provider = c.providers.create({ name: "fake", type: "openai_completion", baseUrl: upstream.baseUrl, apiKey: "k" });
  const model = c.models.create({ name: "m" });
  c.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "up" });
  c.services.create({ name: "svc", definition: { timeoutMs: 30_000, steps: [{ model: "m", provider: "fake" }] } as never });
  const { secret } = c.tokens.create({ name: "t" });

  const app = await buildApp(c);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;

  harness = { app, upstream, port, secret, dataDir, sqlite: c.sqlite as never };
  return harness;
}

function request(port: number, secret: string): { head: string; payload: string } {
  const payload = JSON.stringify({ model: "svc", stream: true, messages: [{ role: "user", content: "hi" }] });
  const head =
    `POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${secret}\r\n` +
    `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n`;
  return { head, payload };
}

async function finalStatus(h: Harness, waitMs = 10_000): Promise<{ http_status: number; error: string | null }> {
  const deadline = Date.now() + waitMs;
  let row: { http_status: number; error: string | null } | undefined;
  // Wait for the row, then keep polling: the amendment arrives after the insert.
  while (Date.now() < deadline) {
    row = h.sqlite.prepare("SELECT http_status, error FROM request_logs ORDER BY id DESC LIMIT 1").get() as typeof row;
    if (row && row.http_status !== 200) return row;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!row) throw new Error("no request_logs row was written");
  return row;
}

describe("delivery confirmation — the log row matches what the client got", () => {
  it("a client that stalls, then aborts after 'finish', ends as 499 — not a lying 200", async () => {
    const h = await boot();
    const { head, payload } = request(h.port, h.secret);

    const received = await new Promise<number>((resolve) => {
      let bytes = 0;
      const sock = net.connect(h.port, "127.0.0.1", () => sock.write(head + payload));
      sock.on("data", (c: Buffer) => {
        bytes += c.length;
        if (bytes >= 16_384) sock.pause(); // stop reading: the TCP window closes
      });
      sock.on("close", () => resolve(bytes));
      sock.on("error", () => { /* our own RST on destroy */ });
      // Give the relay time to write everything into the kernel buffer and log,
      // then abandon the connection the way a timed-out client does.
      setTimeout(() => sock.destroy(), 1_500);
    });

    // The client demonstrably does not have the answer...
    expect(received).toBeLessThan(RESPONSE_CHARS);
    // ...so the log must not say it does.
    const row = await finalStatus(h);
    expect(row.http_status).toBe(499);
    expect(row.error).toBeTruthy();
  }, 30_000);

  it("a client that reads everything keeps its 200", async () => {
    const h = await boot();
    const { head, payload } = request(h.port, h.secret);

    const got = await new Promise<string>((resolve) => {
      let all = "";
      const sock = net.connect(h.port, "127.0.0.1", () => sock.write(head + payload));
      sock.setEncoding("utf8");
      sock.on("data", (c: string) => {
        all += c;
        if (all.includes("data: [DONE]")) sock.end(); // clean FIN after reading it all
      });
      sock.on("close", () => resolve(all));
    });

    expect(got).toContain("[DONE]");
    // The clean close must NOT be mistaken for a failed delivery.
    await new Promise((r) => setTimeout(r, 1_000));
    const row = h.sqlite.prepare("SELECT http_status, error FROM request_logs ORDER BY id DESC LIMIT 1").get() as
      { http_status: number; error: string | null };
    expect(row.http_status).toBe(200);
    expect(row.error).toBeNull();
  }, 30_000);

  it("a keep-alive client that sends a second request confirms the first delivery", async () => {
    const h = await boot();
    const { head, payload } = request(h.port, h.secret);

    const doneCount = await new Promise<number>((resolve) => {
      let all = "";
      let sent = 1;
      const sock = net.connect(h.port, "127.0.0.1", () => sock.write(head + payload));
      sock.setEncoding("utf8");
      sock.on("data", (c: string) => {
        all += c;
        const dones = (all.match(/data: \[DONE\]/g) ?? []).length;
        if (dones === 1 && sent === 1) { sent = 2; sock.write(head + payload); } // reuse the socket
        if (dones === 2) sock.end();
      });
      sock.on("close", () => resolve((all.match(/data: \[DONE\]/g) ?? []).length));
    });

    expect(doneCount).toBe(2);
    await new Promise((r) => setTimeout(r, 1_000));
    const rows = h.sqlite.prepare("SELECT COUNT(*) AS n FROM request_logs WHERE http_status = 200").get() as { n: number };
    expect(rows.n).toBe(2); // neither row was demoted
  }, 30_000);
});
