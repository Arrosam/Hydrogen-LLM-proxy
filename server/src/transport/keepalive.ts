import type { FastifyReply } from "fastify";
import type { OutgoingHttpHeaders, ServerResponse } from "node:http";
import { HEADER, MIME } from "../util/httpHeaders";
import { HTTP_STATUS } from "../util/httpStatus";

/** Header values that keep intermediaries from caching or buffering a slow response. */
export const CACHE_CONTROL_NO_TRANSFORM = "no-cache, no-transform";
export const ACCEL_BUFFERING_OFF = "no";

/** The two headers every early-committed response carries, whatever its body. */
export const NO_BUFFER_HEADERS = {
  [HEADER.CACHE_CONTROL]: CACHE_CONTROL_NO_TRANSFORM,
  [HEADER.X_ACCEL_BUFFERING]: ACCEL_BUFFERING_OFF,
} as const;

// Do NOT set `connection` here. Node only frames the body itself when the user
// has not supplied a Connection header: forcing "keep-alive" made it skip that
// logic, and an HTTP/1.0 peer (nginx's default proxy_http_version) then
// received a body with no Transfer-Encoding, no Content-Length, and a claim
// that the connection persists — a message whose end cannot be found.
export const SSE_HEADERS = {
  [HEADER.CONTENT_TYPE]: MIME.EVENT_STREAM_UTF8,
  ...NO_BUFFER_HEADERS,
} as const;

/**
 * Take a reply over for raw SSE writes: hijack it, so Fastify's lifecycle
 * hooks (onSend, preSerialization, ...) cannot race with an async writer and
 * truncate the response, then commit the 200 with the SSE header set.
 */
export function openSse(reply: FastifyReply): ServerResponse {
  reply.hijack();
  reply.raw.writeHead(HTTP_STATUS.OK, SSE_HEADERS);
  return reply.raw;
}

/**
 * Dead-air guard shared by the SSE and JSON keep-alives: after a grace window
 * with no outcome, commit the 200 early and write a harmless beat on an
 * interval until `stop()`, so the connection never sits silent long enough for
 * an intermediary or the client to kill it.
 *
 * A subclass supplies the header set and the beat, and arms the guard from its
 * own constructor (the two differ in whether a zero grace disables it).
 */
export abstract class CommitKeepalive {
  committed = false;
  private graceTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  protected constructor(
    protected readonly reply: FastifyReply,
    private readonly intervalMs: number,
  ) {}

  /** Headers of the early-committed 200. */
  protected abstract headers(): OutgoingHttpHeaders;
  /** What is written at commit and on every interval after it. */
  protected abstract beat(): string;

  /** Start the grace window. */
  protected arm(graceMs: number): void {
    this.graceTimer = setTimeout(() => this.commit(), graceMs);
    this.graceTimer.unref?.();
  }

  private commit(): void {
    const raw = this.reply.raw;
    if (this.committed || raw.destroyed || raw.headersSent) return;
    this.reply.hijack();
    raw.writeHead(HTTP_STATUS.OK, this.headers());
    this.committed = true;
    raw.write(this.beat());
    this.pingTimer = setInterval(() => {
      if (raw.destroyed || raw.writableEnded) {
        this.stop();
        return;
      }
      raw.write(this.beat());
    }, this.intervalMs);
    this.pingTimer.unref?.();
  }

  /** The outcome has arrived: stop the grace/ping timers. */
  stop(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
