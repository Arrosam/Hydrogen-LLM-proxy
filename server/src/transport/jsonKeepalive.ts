import type { FastifyReply } from "fastify";
import type { OutgoingHttpHeaders } from "node:http";
import { HEADER, MIME } from "../util/httpHeaders";
import { DEFAULT_JSON_COMMIT_GRACE_MS, DEFAULT_STREAM_PING_INTERVAL_MS } from "../config/defaults";
import { endWith } from "./delivery";
import type { ProxyDeps } from "./deps";
import { CommitKeepalive, NO_BUFFER_HEADERS } from "./keepalive";

const JSON_KEEPALIVE_HEADERS = {
  [HEADER.CONTENT_TYPE]: MIME.JSON_UTF8,
  ...NO_BUFFER_HEADERS,
} as const;

/** The whitespace heartbeat: leading whitespace every JSON parser skips. */
const JSON_HEARTBEAT = "\n";

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
export class JsonKeepalive extends CommitKeepalive {
  constructor(reply: FastifyReply, graceMs: number, intervalMs: number) {
    super(reply, intervalMs);
    if (graceMs > 0) this.arm(graceMs);
  }

  /** The guard for a client-facing JSON answer, timed by the proxy's settings. */
  static forClient(reply: FastifyReply, deps: Pick<ProxyDeps, "jsonCommitGraceMs" | "streamPingIntervalMs">): JsonKeepalive {
    return new JsonKeepalive(
      reply,
      deps.jsonCommitGraceMs ?? DEFAULT_JSON_COMMIT_GRACE_MS,
      deps.streamPingIntervalMs ?? DEFAULT_STREAM_PING_INTERVAL_MS,
    );
  }

  protected headers(): OutgoingHttpHeaders {
    return JSON_KEEPALIVE_HEADERS;
  }

  protected beat(): string {
    return JSON_HEARTBEAT;
  }

  /** Finish a committed response with the handler's JSON body. Returns true
   * when it wrote (the caller must NOT also return the body to Fastify). */
  finish(body: unknown): boolean {
    this.stop();
    if (!this.committed) return false;
    endWith(this.reply.raw, () => JSON.stringify(body));
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
  } catch (error) {
    if (keepalive.finish({ error: "request failed" })) {
      reply.log.error({ err: error }, "JSON heartbeat handler failed");
      return undefined;
    }
    throw error;
  } finally {
    keepalive.stop();
  }
  return keepalive.finish(body) ? undefined : body;
}
