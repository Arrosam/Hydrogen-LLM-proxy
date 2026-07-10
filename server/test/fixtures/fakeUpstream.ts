import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A real OpenAI-compatible upstream provider, on a real TCP socket, for
 * end-to-end proxy tests.
 *
 * The rest of the suite drives the proxy through Fastify's `app.inject()`, which
 * never opens a socket. Anything that depends on real chunk boundaries, real
 * backpressure, connection resets, or wall-clock latency is invisible there.
 * This fixture exists to cover that gap, so point a provider's `baseUrl` at
 * `upstream.baseUrl` and drive the proxy over loopback.
 *
 * It can:
 *   - stream a given assistant text as SSE (`text`, `chunkChars`)
 *   - shred the SSE byte stream at arbitrary offsets, including mid-character
 *     (`randomSplit`, `maxSplit`) — deterministic, seeded
 *   - stall before responding (`ttfbMs`) and between writes (`delayMs`)
 *   - fail the first N attempts with a chosen status, so retry/step-advance
 *     paths run for real (`failFirst`)
 *   - drop the connection mid-stream without a terminator (`truncateAfterChars`)
 *
 * `upstream.requests` counts the attempts it saw, and `upstream.bodies` holds
 * each parsed request body — handy for asserting what the proxy actually sent.
 *
 * Example:
 *   const upstream = await startFakeUpstream({
 *     text: "hello",
 *     failFirst: { attempts: 2, status: 503 },
 *     ttfbMs: 200,
 *   });
 *   providers.create({ name: "fake", type: "openai_completion", baseUrl: upstream.baseUrl });
 *   // ... drive the proxy, then:
 *   expect(upstream.requests).toBe(3);
 *   await upstream.close();
 *
 * Requires ALLOW_PRIVATE_UPSTREAMS=1 so the SSRF guard permits 127.0.0.1.
 */
export interface FakeUpstreamOptions {
  /** The exact assistant text the upstream emits, split into content deltas. */
  text: string;
  /** Characters per SSE content delta. Default 200. */
  chunkChars?: number;
  /** Write the SSE bytes in pseudo-random raw chunks instead of one buffer. */
  randomSplit?: boolean;
  /** Upper bound on bytes per raw socket write when `randomSplit` is set. Default 1024. */
  maxSplit?: number;
  /** Seed for the deterministic splitter. Default 1. */
  seed?: number;
  /** Delay before the response headers are written (time to first byte). */
  ttfbMs?: number;
  /** Delay between raw socket writes, simulating a slow generation. */
  delayMs?: number;
  /** Fail the first N attempts with `status`, so the proxy's retry rules run. */
  failFirst?: { attempts: number; status: number; body?: unknown };
  /** Emit this many characters, then destroy the socket — no finish_reason, no [DONE]. */
  truncateAfterChars?: number;
}

export interface FakeUpstream {
  /** Provider baseUrl — `${baseUrl}/chat/completions` is the endpoint. */
  baseUrl: string;
  /** Number of upstream attempts received so far. */
  readonly requests: number;
  /** Parsed request body of every attempt, in order. */
  readonly bodies: unknown[];
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

function chunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "up", ...payload })}\n\n`;
}

/** The full SSE body: role delta, content deltas, finish_reason + usage, [DONE]. */
function sseBody(text: string, chunkChars: number, truncateAfterChars?: number): { bytes: Buffer; truncated: boolean } {
  const emit = truncateAfterChars ?? text.length;
  const parts: string[] = [chunk({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })];
  for (let i = 0; i < emit; i += chunkChars) {
    parts.push(chunk({ choices: [{ index: 0, delta: { content: text.slice(i, Math.min(i + chunkChars, emit)) }, finish_reason: null }] }));
  }
  if (truncateAfterChars === undefined) {
    parts.push(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
    parts.push("data: [DONE]\n\n");
  }
  return { bytes: Buffer.from(parts.join(""), "utf8"), truncated: truncateAfterChars !== undefined };
}

export async function startFakeUpstream(opts: FakeUpstreamOptions): Promise<FakeUpstream> {
  const chunkChars = opts.chunkChars ?? 200;
  const maxSplit = opts.maxSplit ?? 1024;
  const rnd = prng(opts.seed ?? 1);
  const { bytes, truncated } = sseBody(opts.text, chunkChars, opts.truncateAfterChars);

  const state = { requests: 0, bodies: [] as unknown[] };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (raw += c));
    req.on("end", () => {
      void (async () => {
        state.requests += 1;
        try { state.bodies.push(JSON.parse(raw)); } catch { state.bodies.push(raw); }

        if (opts.ttfbMs) await sleep(opts.ttfbMs);

        const fail = opts.failFirst;
        if (fail && state.requests <= fail.attempts) {
          const body = JSON.stringify(fail.body ?? { error: { message: `injected failure ${state.requests}/${fail.attempts}` } });
          res.writeHead(fail.status, { "content-type": "application/json" }).end(body);
          return;
        }

        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });

        if (!opts.randomSplit && !opts.delayMs) {
          if (truncated) { res.write(bytes); setTimeout(() => res.socket?.destroy(), 30); }
          else res.end(bytes);
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
        if (truncated) setTimeout(() => res.socket?.destroy(), 30);
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
