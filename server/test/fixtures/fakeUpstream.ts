import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A real OpenAI-compatible upstream provider, on a real TCP socket, for
 * end-to-end proxy tests.
 *
 * The rest of the suite drives the proxy through Fastify's `app.inject()`, which
 * never opens a socket. Anything that depends on real chunk boundaries, real
 * backpressure, connection resets, message framing, or wall-clock latency is
 * invisible there. This fixture exists to cover that gap: point a provider's
 * `baseUrl` at `upstream.baseUrl` and drive the proxy over loopback.
 *
 * It answers both shapes the proxy speaks:
 *   - `"stream": true`  -> SSE, split into content deltas
 *   - `"stream": false` -> one chat completion JSON body (Micro Agent stages,
 *     and any non-streaming call)
 * and, when the request carries an image, it answers with the JSON array the
 * OCR pre-pass expects.
 *
 * `script` drives one behaviour per attempt, so retry and step-advance paths run
 * against real failures. Once the script is exhausted every further attempt
 * succeeds, which is how you assert "the Nth retry delivers the whole answer".
 *
 * Requires ALLOW_PRIVATE_UPSTREAMS=1 so the SSRF guard permits 127.0.0.1.
 */

/** What the upstream does on one attempt. */
export type UpstreamBehavior =
  /** A complete, correct response. */
  | { kind: "ok" }
  /** An HTTP error before any body (429/500/503/...). */
  | { kind: "status"; status: number; body?: unknown }
  /** Emit part of the answer, then end cleanly — no finish_reason, no [DONE]. */
  | { kind: "truncate"; afterChars: number }
  /** Emit part of the answer, then destroy the socket mid-flight. */
  | { kind: "reset"; afterChars: number }
  /** Destroy the socket before sending any response headers. */
  | { kind: "hangup" }
  /** 200 with a body that cannot be parsed. */
  | { kind: "garbage" }
  /** Stall before responding, to trip the proxy's timeout. */
  | { kind: "hang"; ms: number };

export interface FakeUpstreamOptions {
  /** The exact assistant text a successful attempt returns. */
  text: string;
  /** Characters per SSE content delta. Default 200. */
  chunkChars?: number;
  /** One behaviour per attempt, in order. Attempts past the end succeed. */
  script?: UpstreamBehavior[];
  /** Write the SSE bytes in pseudo-random raw chunks (splits frames + UTF-8). */
  randomSplit?: boolean;
  /** Upper bound on bytes per raw socket write when `randomSplit` is set. */
  maxSplit?: number;
  /** Seed for the deterministic splitter. Default 1. */
  seed?: number;
  /** Delay before every response (time to first byte). */
  ttfbMs?: number;
  /** Delay between raw socket writes, simulating slow generation. */
  delayMs?: number;
  /** Text each image resolves to in the OCR pre-pass. Default "OCR TEXT <n>". */
  ocrText?: (imageIndex: number) => string;
}

export interface FakeUpstream {
  /** Provider baseUrl — `${baseUrl}/chat/completions` is the endpoint. */
  baseUrl: string;
  /** Attempts received so far, across every service and stage. */
  readonly requests: number;
  /** Parsed request body of every attempt, in order. */
  readonly bodies: unknown[];
  /** Attempts that carried an image (i.e. the OCR pre-pass). */
  readonly ocrRequests: number;
  close: () => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** xorshift32 — deterministic, so a failing split reproduces exactly. */
function prng(seed: number): () => number {
  let x = seed || 0x9e3779b9;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0xffffffff;
  };
}

function sseChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "up", ...payload })}\n\n`;
}

/** SSE for `text`. `upTo` < text.length means: no finish_reason, no [DONE]. */
function sseBody(text: string, chunkChars: number, upTo: number): Buffer {
  const parts: string[] = [sseChunk({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })];
  for (let i = 0; i < upTo; i += chunkChars) {
    parts.push(sseChunk({ choices: [{ index: 0, delta: { content: text.slice(i, Math.min(i + chunkChars, upTo)) }, finish_reason: null }] }));
  }
  if (upTo >= text.length) {
    parts.push(sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
    parts.push("data: [DONE]\n\n");
  }
  return Buffer.from(parts.join(""), "utf8");
}

function jsonBody(content: string): string {
  return JSON.stringify({
    id: "c", object: "chat.completion", created: 1, model: "up",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
}

/** Does this request carry an image? Then it is the OCR pre-pass. */
function countImages(raw: string): number {
  return (raw.match(/"image_url"/g) ?? []).length;
}

export async function startFakeUpstream(opts: FakeUpstreamOptions): Promise<FakeUpstream> {
  const chunkChars = opts.chunkChars ?? 200;
  const maxSplit = opts.maxSplit ?? 1024;
  const rnd = prng(opts.seed ?? 1);
  const script = opts.script ?? [];
  const ocrText = opts.ocrText ?? ((i: number) => `OCR TEXT ${i + 1}`);

  const state = { requests: 0, bodies: [] as unknown[], ocrRequests: 0 };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (raw += c));
    req.on("end", () => {
      void (async () => {
        const attempt = state.requests++;
        let parsed: { stream?: unknown } = {};
        try { parsed = JSON.parse(raw) as { stream?: unknown }; state.bodies.push(parsed); } catch { state.bodies.push(raw); }

        const images = countImages(raw);
        if (images > 0) state.ocrRequests += 1;

        const behavior: UpstreamBehavior = script[attempt] ?? { kind: "ok" };
        if (behavior.kind === "hang") { await sleep(behavior.ms); }
        else if (opts.ttfbMs) { await sleep(opts.ttfbMs); }

        if (behavior.kind === "hangup") { res.socket?.destroy(); return; }

        if (behavior.kind === "status") {
          res.writeHead(behavior.status, { "content-type": "application/json" })
            .end(JSON.stringify(behavior.body ?? { error: { message: `injected ${behavior.status} on attempt ${attempt + 1}` } }));
          return;
        }

        // The OCR pre-pass expects one result object per image.
        const answer = images > 0
          ? JSON.stringify(Array.from({ length: images }, (_, i) => ({ index: i + 1, image: ocrText(i) })))
          : opts.text;

        if (parsed.stream !== true) {
          if (behavior.kind === "garbage") { res.writeHead(200, { "content-type": "application/json" }).end("not json at all"); return; }
          const body = jsonBody(answer);
          if (behavior.kind === "truncate") { res.writeHead(200, { "content-type": "application/json" }).end(body.slice(0, Math.floor(body.length / 2))); return; }
          if (behavior.kind === "reset") {
            res.writeHead(200, { "content-type": "application/json" });
            res.write(body.slice(0, Math.floor(body.length / 2)));
            setTimeout(() => res.socket?.destroy(), 20);
            return;
          }
          res.writeHead(200, { "content-type": "application/json" }).end(body);
          return;
        }

        // Streaming.
        if (behavior.kind === "garbage") {
          res.writeHead(200, { "content-type": "text/event-stream" }).end("data: {not json}\n\n");
          return;
        }
        const upTo = behavior.kind === "truncate" || behavior.kind === "reset"
          ? Math.min(behavior.afterChars, answer.length)
          : answer.length;
        const bytes = sseBody(answer, chunkChars, upTo);

        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });

        if (!opts.randomSplit && !opts.delayMs) {
          if (behavior.kind === "reset") { res.write(bytes); setTimeout(() => res.socket?.destroy(), 20); return; }
          res.end(bytes);
          return;
        }
        let off = 0;
        while (off < bytes.length) {
          const n = opts.randomSplit ? Math.max(1, Math.floor(rnd() * maxSplit)) : 16 * 1024;
          const slice = bytes.subarray(off, Math.min(off + n, bytes.length));
          off += slice.length;
          if (res.destroyed) return;
          if (!res.write(slice)) await new Promise<void>((r) => res.once("drain", () => r()));
          if (opts.delayMs) await sleep(opts.delayMs);
        }
        if (behavior.kind === "reset") setTimeout(() => res.socket?.destroy(), 20);
        else res.end();
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    get requests() { return state.requests; },
    get bodies() { return state.bodies; },
    get ocrRequests() { return state.ocrRequests; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
