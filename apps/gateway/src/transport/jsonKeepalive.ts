import type { FastifyReply } from "fastify";

const JSON_KEEPALIVE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
} as const;

/**
 * Dead-air guard for a NON-streaming request. A slow upstream (an OCR/vision
 * answer routinely takes minutes) produces total silence on a JSON response,
 * and intermediaries kill silent connections long before it finishes —
 * Cloudflare returns its 524 at ~100s, so behind it every slow answer was lost
 * even when the upstream succeeded. After the grace window this commits the
 * 200 and writes whitespace heartbeats into the body until the outcome
 * arrives: leading whitespace is valid JSON that every parser skips, the same
 * technique Anthropic's own API uses for long non-streaming requests. The
 * cost, exactly as with the SSE keep-alive: a failure slower than the grace
 * window is delivered as an error JSON body on the committed 200, while the
 * log keeps the semantic status. graceMs <= 0 disables the guard.
 *
 * Used by the proxy's non-streaming chat path AND the dashboard's dry-run
 * endpoints (service test, OCR test), which wait synchronously on the same
 * slow upstreams.
 */
export class JsonKeepalive {
  committed = false;
  private graceTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly reply: FastifyReply,
    graceMs: number,
    private readonly intervalMs: number,
  ) {
    if (graceMs <= 0) return;
    this.graceTimer = setTimeout(() => this.commit(), graceMs);
    this.graceTimer.unref?.();
  }

  private commit(): void {
    const raw = this.reply.raw;
    if (this.committed || raw.destroyed || raw.headersSent) return;
    this.reply.hijack();
    raw.writeHead(200, JSON_KEEPALIVE_HEADERS);
    this.committed = true;
    raw.write("\n");
    this.pingTimer = setInterval(() => {
      if (raw.destroyed || raw.writableEnded) {
        this.stop();
        return;
      }
      raw.write("\n");
    }, this.intervalMs);
    this.pingTimer.unref?.();
  }

  /** The outcome has arrived: stop the grace/ping timers. */
  stop(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** Finish a committed response with the handler's JSON body. Returns true
   * when it wrote (the caller must NOT also return the body to Fastify). */
  finish(body: unknown): boolean {
    if (!this.committed) return false;
    const raw = this.reply.raw;
    try {
      if (!raw.destroyed && !raw.writableEnded) {
        raw.write(JSON.stringify(body));
        raw.end();
      }
    } catch { /* the connection died first */ }
    return true;
  }
}

/**
 * Run a slow JSON handler under a whitespace heartbeat. If the grace window
 * expired mid-run, the committed response is finished with the body and
 * `undefined` is returned (the reply is hijacked); otherwise the body is
 * returned for Fastify to send normally with its usual 200.
 */
export async function withJsonHeartbeat<T>(
  reply: FastifyReply,
  graceMs: number,
  intervalMs: number,
  run: () => Promise<T>,
): Promise<T | undefined> {
  const keepalive = new JsonKeepalive(reply, graceMs, intervalMs);
  let body: T;
  try {
    body = await run();
  } finally {
    keepalive.stop();
  }
  return keepalive.finish(body) ? undefined : body;
}
