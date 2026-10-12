import type { FastifyReply } from "fastify";
import type { ServerResponse } from "node:http";
import type { Socket } from "node:net";

/** How long to wait for a response's 'finish' before assuming it was delivered. */
const RESPONSE_FLUSH_GUARD_MS = 5_000;
/** How long a socket is watched after 'finish' for evidence the delivery failed. */
const DELIVERY_WATCH_WINDOW_MS = 15_000;

/**
 * Resolve once the response has actually finished writing, or false if the
 * connection died first.
 *
 * `res.write()` returning true only means the bytes reached the kernel, so a
 * relay loop can run to completion — and report success — over a connection the
 * peer has already abandoned. Waiting for 'finish' is what distinguishes a
 * delivered response from one that evaporated in the socket buffer.
 *
 * A peer that stops reading without closing would otherwise hold the log row
 * hostage, so the wait is bounded; on expiry we assume what the old code always
 * assumed, that the write succeeded.
 *
 * Arm this BEFORE calling end(): 'finish' can be emitted synchronously from it.
 */
export function responseFlushed(raw: ServerResponse, guardMs = RESPONSE_FLUSH_GUARD_MS): Promise<boolean> {
  if (raw.writableFinished) return Promise.resolve(true);
  if (raw.destroyed) return Promise.resolve(false);
  return new Promise((resolve) => {
    const settle = (delivered: boolean): void => {
      clearTimeout(timer);
      raw.off("finish", onFinish);
      raw.off("close", onClose);
      raw.off("error", onError);
      resolve(delivered);
    };
    const onFinish = (): void => settle(true);
    const onClose = (): void => settle(raw.writableFinished === true);
    const onError = (): void => settle(false);
    const timer = setTimeout(() => settle(true), guardMs);
    timer.unref?.();
    raw.once("finish", onFinish);
    raw.once("close", onClose);
    raw.once("error", onError);
  });
}

/**
 * Watch a client socket AFTER its response finished writing, and report whether
 * the peer disproves delivery.
 *
 * 'finish' means every byte reached the kernel's send buffer — for a response
 * small enough to fit there (a few hundred KB to a few MB), it fires instantly
 * even when the peer has stopped reading, and the log records a 200 the client
 * never received. The disproof arrives moments later on the socket itself:
 *   - 'error' / 'close' with hadError: the peer reset while unacknowledged data
 *     was still in flight — delivery failed.
 *   - inbound 'data': the peer sent its next request, which means it consumed
 *     our response — delivery confirmed.
 *   - clean 'close': a peer that closes with unread data in its receive queue
 *     resets instead of FIN-ing, so a graceful close implies it read everything.
 *   - window expiry: no evidence either way; assume delivered, as before.
 */
export function watchDelivery(socket: Socket, onFailed: (reason: string) => void, windowMs = DELIVERY_WATCH_WINDOW_MS): void {
  if (socket.destroyed) return;
  const done = (failed: string | null): void => {
    clearTimeout(timer);
    socket.off("error", onError);
    socket.off("close", onClose);
    socket.off("data", onData);
    if (failed) onFailed(failed);
  };
  const onError = (e: Error): void => done(`connection reset after the response was written (${e.message}); delivery not confirmed`);
  const onClose = (hadError: boolean): void =>
    done(hadError ? "connection reset after the response was written; delivery not confirmed" : null);
  const onData = (): void => done(null);
  const timer = setTimeout(() => done(null), windowMs);
  timer.unref?.();
  socket.on("error", onError);
  socket.on("close", onClose);
  socket.on("data", onData);
}

/**
 * Abort `controller` when the client abandons the connection before the
 * response finished: nobody will receive the answer, so every further retry
 * only burns quota — and the log row must end up saying 499, not 200.
 */
export function abortOnClientClose(reply: FastifyReply, controller: AbortController = new AbortController()): AbortController {
  reply.raw.once("close", () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller;
}

/**
 * Write the last chunk of an already-committed response and end it. The chunk
 * is rendered only when the response can still take it. Nothing here throws: a
 * connection that died first (or a chunk that fails to render) is left to the
 * caller's delivery accounting, `responseFlushed`.
 */
export function endWith(raw: ServerResponse, render: () => string): void {
  try {
    if (!raw.destroyed && !raw.writableEnded) {
      raw.write(render());
      raw.end();
    }
  } catch { /* the connection died first */ }
}

/** Backpressure: resolve when a full write buffer drains, or the response closes. */
export function drained(raw: ServerResponse): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      raw.off("drain", done);
      raw.off("close", done);
      resolve();
    };
    raw.once("drain", done);
    raw.once("close", done);
  });
}
