import type { FastifyReply } from "fastify";
import type { OutgoingHttpHeaders } from "node:http";
import type { Family } from "../core/format/family";
import { pingFrame } from "../core/proxy/errors";
import { CommitKeepalive, SSE_HEADERS } from "./keepalive";

/**
 * Dead-air guard for a streaming request. A buffering executor (Micro Agent,
 * Reliable Streaming) — or a slow upstream first token — can be silent for
 * minutes, and every intermediary and client kills a silent connection long
 * before that: the answer then arrives at a connection nobody is listening to,
 * and the log records a 200 the client never saw. After a short grace window
 * this commits the SSE response and emits protocol keep-alive frames until the
 * outcome arrives, so bytes are always flowing. The cost: a failure slower than
 * the grace window must be delivered as an in-stream error event instead of an
 * HTTP status (a fast failure still gets its real status).
 */
export class SseKeepalive extends CommitKeepalive {
  constructor(
    reply: FastifyReply,
    private readonly family: Family,
    graceMs: number,
    intervalMs: number,
  ) {
    super(reply, intervalMs);
    this.arm(graceMs);
  }

  protected headers(): OutgoingHttpHeaders {
    return SSE_HEADERS;
  }

  protected beat(): string {
    return pingFrame(this.family);
  }
}
