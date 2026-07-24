import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Family } from "../core/format/family";
import { parseRequest, serializeStream } from "../core/format/registry";
import { buildErrorBody, buildErrorFrame, failureMessage, failureStatus, pingFrame } from "../core/proxy/errors";
import {
  newAccumulator,
  tapStream,
  withoutReasoning,
  type StreamAccumulator,
} from "../core/ir/stream";
import { ZERO_USAGE, type Usage } from "../core/ir/usage";
import type { AttemptFailure } from "../execution/steps";
import type { StreamValue } from "../execution/outcome";
import { isChatPipeline, serviceCategory } from "../execution/definition";
import { requireClientToken } from "../auth/tokenAuth";
import { genId } from "../util/ids";
import { asMillis } from "../util/time";
import type { ModelServiceRow, Token } from "../db/schema";
import type { HttpRequestInfo } from "../observability/requestLogger";
import { ProgressRecorder } from "../observability/progressRecorder";
import type { ProxyDeps } from "./deps";

interface RequestCtx {
  traceId: string;
  token: Token;
  service: ModelServiceRow;
  serviceName: string;
  http: HttpRequestInfo;
  started: number;
  ingress: Family;
}

function httpInfo(req: FastifyRequest): HttpRequestInfo {
  const [path, query = ""] = req.url.split("?");
  return { method: req.method, path, query, headers: req.headers as Record<string, unknown>, body: req.body };
}

function tokenAllowsService(token: Token, serviceId: number): boolean {
  const scope = token.scopeServices;
  if (!Array.isArray(scope) || scope.length === 0) return true; // unscoped = all
  return scope.includes(serviceId);
}

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
function responseFlushed(raw: ServerResponse, guardMs = 5_000): Promise<boolean> {
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

// Do NOT set `connection` here. Node only frames the body itself when the user
// has not supplied a Connection header: forcing "keep-alive" made it skip that
// logic, and an HTTP/1.0 peer (nginx's default proxy_http_version) then
// received a body with no Transfer-Encoding, no Content-Length, and a claim
// that the connection persists — a message whose end cannot be found.
const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
} as const;

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
class SseKeepalive {
  committed = false;
  private readonly graceTimer: NodeJS.Timeout;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly reply: FastifyReply,
    private readonly family: Family,
    graceMs: number,
    private readonly intervalMs: number,
  ) {
    this.graceTimer = setTimeout(() => this.commit(), graceMs);
    this.graceTimer.unref?.();
  }

  private commit(): void {
    const raw = this.reply.raw;
    if (this.committed || raw.destroyed || raw.headersSent) return;
    this.reply.hijack();
    raw.writeHead(200, SSE_HEADERS);
    this.committed = true;
    raw.write(pingFrame(this.family));
    this.pingTimer = setInterval(() => {
      if (raw.destroyed || raw.writableEnded) {
        this.stop();
        return;
      }
      raw.write(pingFrame(this.family));
    }, this.intervalMs);
    this.pingTimer.unref?.();
  }

  /** The outcome has arrived: stop the grace/ping timers. */
  stop(): void {
    clearTimeout(this.graceTimer);
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
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
function watchDelivery(socket: Socket, onFailed: (reason: string) => void, windowMs = 15_000): void {
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

/** The client-facing proxy: parse -> resolve service -> invoke/stream -> log. */
export class ProxyController {
  constructor(private readonly deps: ProxyDeps) {}

  register(app: FastifyInstance): void {
    const { tokens } = this.deps;
    app.post("/v1/chat/completions", { preHandler: requireClientToken(tokens, "openai_completion") }, (req, reply) =>
      this.handleChat(req, reply, "openai_completion"),
    );
    app.post("/v1/messages", { preHandler: requireClientToken(tokens, "anthropic") }, (req, reply) =>
      this.handleChat(req, reply, "anthropic"),
    );
    app.post("/v1/responses", { preHandler: requireClientToken(tokens, "openai_responses") }, (req, reply) =>
      this.handleChat(req, reply, "openai_responses"),
    );
    app.get(
      "/v1/models",
      {
        preHandler: (req: FastifyRequest, reply: FastifyReply) => {
          const family: Family = req.headers["anthropic-version"] ? "anthropic" : "openai_completion";
          return requireClientToken(tokens, family)(req, reply);
        },
      },
      (req) => this.handleListModels(req),
    );
  }

  private replyError(reply: FastifyReply, family: Family, status: number, message: string): FastifyReply {
    return reply.code(status).send(buildErrorBody(family, status, message));
  }

  private async handleChat(req: FastifyRequest, reply: FastifyReply, ingress: Family): Promise<unknown> {
    const token = req.clientToken!;
    const http = httpInfo(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    let request;
    try {
      request = parseRequest(ingress, body);
    } catch {
      return this.replyError(reply, ingress, 400, "Invalid request body.");
    }

    const serviceName = request.requestedService;
    if (!serviceName) {
      return this.replyError(reply, ingress, 400, "Missing 'model' (must be a Model Service or Micro Agent name).");
    }

    const traceId = genId("trace");
    const service = this.deps.services.getByName(serviceName);
    if (!service || !service.enabled) {
      this.deps.logger.record({
        traceId, tokenId: token.id, serviceId: null, requestedService: serviceName, ingress, streaming: request.stream,
        httpStatus: 404, http, latencyMs: 0, error: `unknown model '${serviceName}'`,
      });
      return this.replyError(reply, ingress, 404, `Model '${serviceName}' not found. The 'model' field must be a Model Service or Micro Agent name.`);
    }

    if (!tokenAllowsService(token, service.id)) {
      this.deps.logger.record({
        traceId, tokenId: token.id, serviceId: service.id, requestedService: serviceName, ingress, streaming: request.stream,
        httpStatus: 403, http, latencyMs: 0, error: "service out of token scope",
      });
      return this.replyError(reply, ingress, 403, `This token is not allowed to use '${serviceName}'.`);
    }

    // Media passthrough categories (image/tts/embedding/...) have their own
    // endpoints; the chat pipeline serves chat and ocr services.
    try {
      const category = serviceCategory(this.deps.services.def(service));
      if (!isChatPipeline(category)) {
        this.deps.logger.record({
          traceId, tokenId: token.id, serviceId: service.id, requestedService: serviceName, ingress, streaming: request.stream,
          httpStatus: 400, http, latencyMs: 0, error: `'${serviceName}' is a ${category} service`,
        });
        return this.replyError(reply, ingress, 400, `'${serviceName}' is a ${category} service; use its dedicated endpoint instead of chat.`);
      }
    } catch { /* an unparsable definition falls through to the 500 below */ }

    const started = Date.now();
    let executor;
    try {
      executor = this.deps.factory.forRow(service).executor;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.logger.record({
        traceId, tokenId: token.id, serviceId: service.id, requestedService: serviceName, ingress, streaming: request.stream,
        httpStatus: 500, http, latencyMs: Date.now() - started, error: `invalid Model Service definition: ${message}`,
      });
      this.deps.usage.record(token.id, 0);
      return this.replyError(reply, ingress, 500, `Model '${serviceName}' has an invalid definition.`);
    }

    const ctx: RequestCtx = { traceId, token, service, serviceName, http, started, ingress };
    // Register the request for real-time progress monitoring.
    this.deps.activeRequests.start({ traceId, tokenId: token.id, serviceId: service.id, serviceName, ingress, streaming: request.stream });
    const prog = new ProgressRecorder(this.deps.activeRequests, traceId);
    prog.record("init", "request.received", `request received: ${ingress} -> ${serviceName}`, { streaming: request.stream });
    prog.record("init", "request.parsed", "request body parsed and service resolved");

    // A client that abandons the connection aborts the upstream work: nobody
    // will receive the answer, so every further retry only burns quota — and
    // the log row must end up saying 499, not 200.
    const clientGone = new AbortController();
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) clientGone.abort();
    });

    if (request.stream) {
      // Keep bytes flowing while the executor works: commit the SSE response
      // after the grace window and ping until the outcome arrives.
      const keepalive = new SseKeepalive(
        reply, ingress,
        this.deps.streamCommitGraceMs ?? 2_500,
        this.deps.streamPingIntervalMs ?? 10_000,
      );
      const outcome = await executor.stream(request, undefined, { progress: prog, signal: clientGone.signal });
      keepalive.stop();
      if (!outcome.result.ok) {
        if (clientGone.signal.aborted) return this.replyClientGone(reply, ctx, true, outcome);
        if (keepalive.committed) {
          // The 200 is already on the wire; the failure travels in-stream.
          return this.replyFailureInStream(reply, ctx, outcome.result, { attemptPath: outcome.attemptPath, attempts: outcome.attempts });
        }
        this.deps.activeRequests.finish(traceId, failureStatus(outcome.result), failureMessage(outcome.result));
        return this.replyFailure(reply, ctx, outcome.result, { streaming: true, attemptPath: outcome.attemptPath, attempts: outcome.attempts });
      }
      this.relay(reply, ctx, outcome.result.value, { attempts: outcome.attempts, attemptPath: outcome.attemptPath, committed: keepalive.committed });
      return; // relay hijacks the reply and writes asynchronously
    }

    const outcome = await executor.invoke(request, undefined, { progress: prog, signal: clientGone.signal });
    if (!outcome.result.ok) {
      if (clientGone.signal.aborted) return this.replyClientGone(reply, ctx, false, outcome);
      this.deps.activeRequests.finish(traceId, failureStatus(outcome.result), failureMessage(outcome.result));
      return this.replyFailure(reply, ctx, outcome.result, { streaming: false, attemptPath: outcome.attemptPath, attempts: outcome.attempts });
    }

    const value = outcome.result.value;
    const clientBody = value.response.render(ingress, serviceName);
    // Deliver first, then log what actually happened: writing the 200 row
    // before send() is how a response nobody received was recorded as success.
    const socket = reply.raw.socket;
    const settled = responseFlushed(reply.raw);
    reply.code(200).send(clientBody);
    const flushed = await settled;
    const status = flushed ? 200 : 499;
    const error = flushed ? null : "connection closed before the response was fully sent";
    prog.record("done", "request.complete", `request completed in ${Date.now() - started}ms`, { httpStatus: status });
    this.deps.activeRequests.finish(traceId, status, error ?? undefined);
    this.deps.logger.record({
      traceId, tokenId: token.id, serviceId: service.id, requestedService: serviceName,
      servedModel: value.modelName, servedProvider: value.providerName,
      ingress, egress: value.family, streaming: false, httpStatus: status, http,
      upstreamRequest: value.upstreamRequest,
      responseBody: clientBody, usage: value.response.usage, latencyMs: Date.now() - started,
      attempts: outcome.attempts, attemptPath: outcome.attemptPath, error,
    });
    // The upstream consumed these tokens whether or not the delivery landed.
    this.deps.usage.record(token.id, value.response.usage.totalTokens);
    if (status === 200 && socket) {
      watchDelivery(socket, (reason) => {
        this.deps.logger.amendDeliveryFailure(traceId, reason);
        this.deps.activeRequests.amendCompleted(traceId, 499, reason);
      });
    }
    return reply;
  }

  /** The client hung up while the upstream work was still running; the work was
   * aborted and there is no one left to answer. Log 499 and release the reply. */
  private replyClientGone(
    reply: FastifyReply,
    ctx: RequestCtx,
    streaming: boolean,
    o: { attemptPath: unknown; attempts: number },
  ): undefined {
    const error = "client disconnected before the response could be sent; upstream work aborted";
    this.deps.activeRequests.finish(ctx.traceId, 499, error);
    this.deps.logger.record({
      traceId: ctx.traceId, tokenId: ctx.token.id, serviceId: ctx.service.id, requestedService: ctx.serviceName,
      ingress: ctx.ingress, streaming, httpStatus: 499, http: ctx.http,
      latencyMs: Date.now() - ctx.started, attempts: o.attempts, attemptPath: o.attemptPath, error,
    });
    this.deps.usage.record(ctx.token.id, 0);
    // The connection is already dead — detach Fastify and close it out.
    reply.hijack();
    try { reply.raw.destroy(); } catch { /* already closed */ }
    return undefined;
  }

  /** The last attempt's retry context, appended to the logged error so the
   * log carries the full diagnosis trail. */
  private retrySuffix(attemptPath: unknown): string {
    const lastAttempt = (attemptPath as Array<{ retry?: { reason: string; retryIndex: number; delayMs: number; suppressed: boolean } }>)?.slice(-1)[0];
    return lastAttempt?.retry
      ? ` [retry#${lastAttempt.retry.retryIndex} delay=${lastAttempt.retry.delayMs}ms suppressed=${lastAttempt.retry.suppressed}: ${lastAttempt.retry.reason}]`
      : "";
  }

  /**
   * A failure on a streaming request whose 200 was already committed by the
   * keep-alive: the error is delivered as the protocol's in-stream error event
   * (Anthropic-style `error` event / OpenAI error chunk) with no terminator
   * after it, so it cannot read as a completed answer. The log row keeps the
   * SEMANTIC status (503, 502, ...) so failures stay countable and filterable
   * even though the wire status was 200.
   */
  private replyFailureInStream(
    reply: FastifyReply,
    ctx: RequestCtx,
    failure: AttemptFailure,
    o: { attemptPath: unknown; attempts: number },
  ): void {
    const status = failureStatus(failure);
    const message = failureMessage(failure);
    const raw = reply.raw;
    try {
      if (!raw.destroyed && !raw.writableEnded) {
        raw.write(buildErrorFrame(ctx.ingress, status, message));
        raw.end();
      }
    } catch { /* the connection died first; the log below still tells the truth */ }
    this.deps.logger.record({
      traceId: ctx.traceId, tokenId: ctx.token.id, serviceId: ctx.service.id, requestedService: ctx.serviceName,
      ingress: ctx.ingress, streaming: true, httpStatus: status, http: ctx.http,
      latencyMs: Date.now() - ctx.started, attempts: o.attempts, attemptPath: o.attemptPath,
      error: `${message}${this.retrySuffix(o.attemptPath)} (delivered as in-stream error event)`,
    });
    this.deps.usage.record(ctx.token.id, 0);
    this.deps.activeRequests.finish(ctx.traceId, status, message);
  }

  private replyFailure(
    reply: FastifyReply,
    ctx: RequestCtx,
    failure: AttemptFailure,
    o: { streaming: boolean; attemptPath: unknown; attempts: number },
  ): FastifyReply {
    const status = failureStatus(failure);
    const message = failureMessage(failure);
    // When the failure was retried (e.g. 499), append the last retry context so
    // the log + client-facing error carry the full diagnosis trail.
    const detailedError = message + this.retrySuffix(o.attemptPath);
    this.deps.logger.record({
      traceId: ctx.traceId, tokenId: ctx.token.id, serviceId: ctx.service.id, requestedService: ctx.serviceName,
      ingress: ctx.ingress, streaming: o.streaming, httpStatus: status, http: ctx.http,
      latencyMs: Date.now() - ctx.started, attempts: o.attempts, attemptPath: o.attemptPath, error: detailedError,
    });
    this.deps.usage.record(ctx.token.id, 0);
    return reply.code(status).send(buildErrorBody(ctx.ingress, status, message));
  }

  /** Relay a canonical event stream to the client, tapping it for the request log.
   * Hijacks the Fastify reply so lifecycle hooks do not race with the async
   * writer, then writes each SSE chunk directly to the raw response and flushes
   * immediately. The log records exactly what the accumulator saw from the
   * upstream, and a disconnect is detected via write errors so the log status
   * reflects delivery failure. */
  private relay(reply: FastifyReply, ctx: RequestCtx, value: StreamValue, o: { attempts: number; attemptPath: unknown; committed?: boolean }): void {
    const acc: StreamAccumulator = newAccumulator();
    const events = value.dropReasoning ? withoutReasoning(value.events) : value.events;
    const outGen = serializeStream(ctx.ingress, tapStream(events, acc), { model: ctx.serviceName });

    const raw = reply.raw;
    if (!o.committed) {
      // Hijack the reply so Fastify does not interfere with our raw SSE writes.
      // Without this, Fastify's lifecycle hooks (onSend, preSerialization, etc.)
      // can race with the async writer below, causing truncated responses.
      // (When the keep-alive already committed the response, both happened.)
      reply.hijack();
      raw.writeHead(200, SSE_HEADERS);
    }

    // Start an async writer that drains the generator into the raw response.
    // Using raw.write + raw.flush (instead of Readable.from) avoids the
    // internal Readable highWaterMark buffer that can hold unflushed chunks
    // when the client disconnects mid-stream.
    (async () => {
      let streamError: string | null = null;
      let clientDisconnected = false;
      try {
        for await (const chunk of outGen) {
          if (raw.destroyed || raw.writableEnded) {
            clientDisconnected = true;
            break;
          }
          const ok = raw.write(chunk);
          // Flush immediately so the chunk reaches the client (not buffered).
          const flushable = raw as unknown as { flush?: () => void };
          if (typeof flushable.flush === "function") flushable.flush();
          // Apply backpressure: wait for 'drain' if the internal buffer is full.
          if (!ok && !raw.destroyed) {
            await new Promise<void>((resolve) => {
              const onDrain = (): void => { raw.off("close", onClose); resolve(); };
              const onClose = (): void => { raw.off("drain", onDrain); resolve(); };
              raw.once("drain", onDrain);
              raw.once("close", onClose);
            });
          }
          if (raw.destroyed) {
            clientDisconnected = true;
            break;
          }
        }
      } catch (e) {
        streamError = e instanceof Error ? e.message : String(e);
      } finally {
        // Capture the socket now: Node detaches it from the response on finish,
        // and the delivery watch below needs it after that point.
        const socket = raw.socket;
        // Terminate the response before anything else: the client must not wait
        // on database I/O, and a throwing logger must not leave the stream open.
        const settled = responseFlushed(raw);
        if (!raw.writableEnded && !raw.destroyed) {
          // The upstream died after we committed 200, so the answer we relayed
          // is short. Ending cleanly here would hand the client a well-formed
          // HTTP message it would read as complete. Abort instead: an unfinished
          // chunked body is an error in every HTTP client.
          const answerIsShort = streamError !== null || acc.incomplete;
          try {
            if (answerIsShort) raw.destroy();
            else raw.end();
          } catch { /* already closed */ }
        }
        // Only now can we tell whether the client actually got the response.
        const flushed = await settled;

        const usage: Usage = acc.usage ?? ZERO_USAGE;
        const responseBody: Record<string, unknown> = {
          streamed: true, role: "assistant", content: acc.text, stop_reason: acc.stopReason, usage,
        };
        if (acc.reasoning) responseBody.reasoning = acc.reasoning;
        if (acc.toolCalls.length) responseBody.tool_calls = acc.toolCalls;
        let error = streamError;
        let status = 200;
        if (streamError) status = 499;
        else if (clientDisconnected) {
          status = 499;
          error = "client disconnected before stream completed";
        }
        else if (acc.incomplete) {
          status = 502;
          error = "upstream stream ended before completion (truncated)";
          responseBody.incomplete = true;
        }
        else if (!flushed) {
          // Every byte was written, but the connection died before they left
          // the machine. Reporting 200 here is what hid this failure.
          status = 499;
          error = "connection closed before the response was fully sent";
        }
        this.deps.logger.record({
          traceId: ctx.traceId, tokenId: ctx.token.id, serviceId: ctx.service.id, requestedService: ctx.serviceName,
          servedModel: value.modelName, servedProvider: value.providerName,
          ingress: ctx.ingress, egress: value.family, streaming: true, httpStatus: status, http: ctx.http,
          upstreamRequest: value.upstreamRequest,
          responseBody, usage, latencyMs: Date.now() - ctx.started, attempts: o.attempts, attemptPath: o.attemptPath, error,
        });
        this.deps.usage.record(ctx.token.id, usage.totalTokens);
        // Mark the active request as finished (streaming relay end).
        this.deps.activeRequests.finish(ctx.traceId, status, error ?? undefined);
        // A 200 at this point still only means "handed to the kernel". Keep
        // watching the socket: if the peer resets it before sending anything
        // else, the tail of the response never arrived — demote the row to 499
        // so the log stops claiming a delivery that did not happen.
        if (status === 200 && socket) {
          watchDelivery(socket, (reason) => {
            this.deps.logger.amendDeliveryFailure(ctx.traceId, reason);
            this.deps.activeRequests.amendCompleted(ctx.traceId, 499, reason);
          });
        }
      }
    })();
  }

  private handleListModels(req: FastifyRequest): unknown {
    const isAnthropic = typeof req.headers["anthropic-version"] === "string";
    const services = this.deps.services.list().filter((m) => m.enabled);
    const created = (m: ModelServiceRow): number => asMillis(m.createdAt);

    if (isAnthropic) {
      return {
        data: services.map((m) => ({ type: "model", id: m.name, display_name: m.name, created_at: new Date(created(m)).toISOString() })),
        has_more: false,
        first_id: services[0]?.name ?? null,
        last_id: services[services.length - 1]?.name ?? null,
      };
    }
    return {
      object: "list",
      data: services.map((m) => ({ id: m.name, object: "model", created: Math.floor(created(m) / 1000), owned_by: "hydrogen" })),
    };
  }
}
