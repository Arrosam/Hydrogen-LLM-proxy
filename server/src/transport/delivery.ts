import type { FastifyReply } from "fastify";
import type { Socket } from "node:net";

/** Arm before send/end. A stream that fails or a peer that closes before finish
 * is not a delivered success; after finish, watch for a transport reset. */
export function observeDelivery(reply: FastifyReply, record: (failed: boolean, reason?: string) => void, amend: (reason: string) => void): void {
  const raw = reply.raw, socket = raw.socket;
  let settled = false;
  const settle = (failed: boolean, reason?: string) => {
    if (settled) return;
    settled = true;
    raw.off("finish", onFinish); raw.off("close", onClose); raw.off("error", onError);
    try { record(failed, reason); } catch { /* bookkeeping cannot escape an HTTP event listener */ }
    if (!failed && socket && !socket.destroyed) watchSocket(socket, amend);
  };
  const onFinish = () => settle(false);
  const onClose = () => settle(!raw.writableFinished, "connection closed before the response was fully sent");
  const onError = () => settle(true, "response delivery failed");
  raw.once("finish", onFinish); raw.once("close", onClose); raw.once("error", onError);
}
function watchSocket(socket: Socket, amend: (reason: string) => void): void {
  let settled = false;
  const done = (failed: boolean) => {
    if (settled) return; settled = true;
    clearTimeout(timer); socket.off("error", onError); socket.off("close", onClose); socket.off("data", onData);
    if (failed) { try { amend("connection reset after the response was written; delivery not confirmed"); } catch { /* optional late evidence */ } }
  };
  const onError = () => done(true), onClose = (hadError: boolean) => done(hadError), onData = () => done(false);
  const timer = setTimeout(() => done(false), 15_000); timer.unref();
  socket.once("error", onError); socket.once("close", onClose); socket.once("data", onData);
}
