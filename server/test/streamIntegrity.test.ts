/**
 * End-to-end stream integrity over real TCP sockets.
 *
 * A real upstream provider, the real Fastify app, and a real HTTP client. The
 * assertion is byte-exact: the text the client reassembles must equal the text
 * the upstream emitted.
 *
 * Regression: parseSSE() used to decode each chunk with `chunk.toString("utf8")`.
 * Chunk boundaries land wherever the network puts them, routinely inside a
 * multi-byte character — each split character was replaced by U+FFFD, so a large
 * non-ASCII response reached the client corrupted even though the proxy had
 * received it intact.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

import { startFakeUpstream, type FakeUpstream } from "./fixtures/fakeUpstream";
import { parseSSE } from "../src/core/ir/stream";

// ---------------------------------------------------------------------------
// unit-level: the decoder must carry incomplete sequences across chunks
// ---------------------------------------------------------------------------

async function* chunksOf(buf: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

describe("parseSSE — UTF-8 across chunk boundaries", () => {
  it("does not corrupt multi-byte characters split between chunks", async () => {
    const payload = { content: "你好世界🙂漢字カタカナ" };
    const sse = Buffer.from(`data: ${JSON.stringify(payload)}\n\n`, "utf8");

    // Every possible split point, including mid-character ones.
    for (let size = 1; size < sse.length; size++) {
      const frames = [];
      for await (const f of parseSSE(chunksOf(sse, size))) frames.push(f);
      expect(frames).toHaveLength(1);
      expect(JSON.parse(frames[0].data)).toEqual(payload);
    }
  });
});

// ---------------------------------------------------------------------------
// end-to-end: real upstream -> real proxy -> real client
// ---------------------------------------------------------------------------

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

async function boot(text: string, opts: { randomSplit?: boolean; maxSplit?: number }): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-stream-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ALLOW_PRIVATE_UPSTREAMS = "1";
  process.env.LOG_PAYLOAD_MAX_CHARS = "0";
  process.env.ADMIN_PASSWORD = "stream-integrity-test-password";
  process.env.SESSION_SECRET = "stream-integrity-test-session-secret";

  const upstream = await startFakeUpstream({ text, chunkChars: 200, seed: 7, ...opts });

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

  harness = { app, upstream, port, secret, dataDir, sqlite: c.sqlite };
  return harness;
}

/** Reassemble the assistant text a real streaming client would see. */
function streamText(port: number, secret: string, requestChars: number): Promise<{ text: string; sawDone: boolean }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ model: "svc", stream: true, messages: [{ role: "user", content: "A".repeat(requestChars) }] }));
    const req = http.request(
      {
        host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, "content-length": String(payload.length) },
      },
      (res) => {
        let text = "", buffer = "", sawDone = false;
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          buffer += c;
          let i: number;
          while ((i = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            if (!frame.startsWith("data:")) continue;
            const data = frame.slice(5).trim();
            if (data === "[DONE]") { sawDone = true; continue; }
            const delta = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content;
            if (typeof delta === "string") text += delta;
          }
        });
        res.on("end", () => resolve({ text, sawDone }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/** ASCII + CJK + emoji, so chunk boundaries land inside multi-byte sequences. */
function mixedText(chars: number): string {
  const alphabet = "abcdefghij你好世界测试代码🙂🚀漢字カタカナ";
  let s = "";
  while (s.length < chars) s += alphabet;
  return s.slice(0, chars);
}

describe("streaming relay — real sockets, byte-exact", () => {
  it("relays a large non-ASCII response unchanged (undici-sized chunks)", async () => {
    const text = mixedText(200_000);
    const h = await boot(text, {});
    const got = await streamText(h.port, h.secret, 1_000);
    expect(got.sawDone).toBe(true);
    expect(got.text).toBe(text);
  }, 60_000);

  it("relays unchanged when the upstream shreds frames at hostile byte offsets", async () => {
    const text = mixedText(50_000);
    const h = await boot(text, { randomSplit: true, maxSplit: 7 });
    const got = await streamText(h.port, h.secret, 1_000);
    expect(got.sawDone).toBe(true);
    expect(got.text).toBe(text);
  }, 60_000);

  it("relays unchanged with a very large request payload and a large response", async () => {
    const text = mixedText(500_000);
    const h = await boot(text, { randomSplit: true, maxSplit: 4096 });
    const got = await streamText(h.port, h.secret, 8_000_000);
    expect(got.sawDone).toBe(true);
    expect(got.text).toBe(text);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// wire framing: the SSE response must always tell the peer where the body ends
// ---------------------------------------------------------------------------

/** Speak raw HTTP at a chosen version and return the response head plus body. */
function rawRequest(port: number, secret: string, httpVersion: "1.0" | "1.1"): Promise<{ head: string; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ model: "svc", stream: true, messages: [{ role: "user", content: "hi" }] }));
    const head =
      `POST /v1/chat/completions HTTP/${httpVersion}\r\n` +
      `Host: 127.0.0.1:${port}\r\nAuthorization: Bearer ${secret}\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${payload.length}\r\n\r\n`;

    const sock = net.connect(port, "127.0.0.1", () => { sock.write(head); sock.write(payload); });
    let raw = "";
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      const i = raw.indexOf("\r\n\r\n");
      resolve(i === -1 ? { head: raw, body: "" } : { head: raw.slice(0, i), body: raw.slice(i + 4) });
    };
    sock.setEncoding("latin1");
    sock.on("data", (s: string) => {
      raw += s;
      // HTTP/1.1 terminates with the zero chunk; HTTP/1.0 with connection close.
      if (httpVersion === "1.1" && raw.includes("\r\n0\r\n\r\n")) done();
    });
    sock.on("close", done);
    sock.on("error", reject);
    setTimeout(done, 15_000).unref();
  });
}

describe("streaming relay — message framing", () => {
  /**
   * Regression: relay() used to hardcode `connection: keep-alive` on writeHead.
   * Node only frames the body itself when no Connection header was supplied, so
   * an HTTP/1.0 peer — which is what nginx sends by default — received a body
   * with no Transfer-Encoding, no Content-Length, and a claim that the
   * connection persists. Nothing downstream can find the end of that message.
   */
  it("frames the body for an HTTP/1.1 peer with chunked transfer encoding", async () => {
    const h = await boot("hello streaming world", {});
    const { head, body } = await rawRequest(h.port, h.secret, "1.1");
    const lower = head.toLowerCase();

    expect(lower).toContain("transfer-encoding: chunked");
    expect(body).toContain("[DONE]");
  }, 30_000);

  it("tells an HTTP/1.0 peer to read to close, never claiming keep-alive without a length", async () => {
    const h = await boot("hello streaming world", {});
    const { head, body } = await rawRequest(h.port, h.secret, "1.0");
    const lower = head.toLowerCase();

    const chunked = lower.includes("transfer-encoding: chunked");
    const hasLength = lower.includes("content-length:");
    expect(chunked).toBe(false); // HTTP/1.0 has no chunked encoding
    expect(hasLength).toBe(false); // a stream has no length up front

    // With neither, the body is delimited by the close — so the peer must be
    // told the connection closes. Advertising keep-alive here is unframeable.
    expect(lower).toContain("connection: close");
    expect(lower).not.toContain("connection: keep-alive");

    expect(body).toContain("[DONE]");
  }, 30_000);
});
