import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Socket } from "node:net";
import type { Family } from "../core/format/family";
import { parseRequest, serializeStream } from "../core/format/registry";
import { buildErrorBody, buildErrorFrame, failureMessage, failureStatus } from "../core/proxy/errors";
import {
  newAccumulator,
  tapStream,
  withoutReasoning,
  type StreamAccumulator,
} from "../core/ir/stream";
import { ZERO_USAGE, type Usage } from "../core/ir/usage";
import { missingAnswerReason, requireAnswer } from "../core/ir/answer";
import type { AttemptFailure } from "../execution/steps";
import type { StreamValue } from "../execution/outcome";
import { isChatPipeline, serviceCategory, serviceThinkingDelimiters, serviceThinkingFormat } from "../execution/definition";
import { withThinkingFormat, type ThinkingDelimiters, type ThinkingFormat } from "../core/ir/thinkingFormat";
import { tokenAllowsService } from "../auth/authorization";
import { requireClientToken } from "../auth/tokenAuth";
import { genId, ID_PREFIX } from "../util/ids";
import { asMillis, MS_PER_SECOND } from "../util/time";
import { HEADER } from "../util/httpHeaders";
import { HTTP_STATUS, STATUS_CLIENT_CLOSED, STATUS_UPSTREAM_FAILURE } from "../util/httpStatus";
import { DEFAULT_STREAM_COMMIT_GRACE_MS, DEFAULT_STREAM_PING_INTERVAL_MS } from "../config/defaults";
import type { ModelServiceRow, Token } from "../db/schema";
import { httpRequestInfo, type HttpRequestInfo, type LogParams } from "../observability/requestLogger";
import { ProgressRecorder } from "../observability/progressRecorder";
import { abortOnClientClose, drained, endWith, responseFlushed, watchDelivery } from "./delivery";
import { collectForwardHeaders } from "./forwardHeaders";
import { JsonKeepalive } from "./jsonKeepalive";
import { openSse } from "./keepalive";
import { resolveServiceAccess } from "./serviceAccess";
import { SseKeepalive } from "./sseKeepalive";
import { errorMessage } from "../util/errors";
import type { ProxyDeps } from "./deps";
import { ROUTE } from "./routes";
import { ERR_SERVICE_OUT_OF_SCOPE } from "./errorMessages";

const ERR_CONNECTION_CLOSED_BEFORE_SENT = "connection closed before the response was fully sent";

/** What every request-log row of one request repeats. Before the service is
 * resolved there is no row to name and no clock running yet. */
interface LogCtx {
  traceId: string;
  token: Token;
  service: ModelServiceRow | null;
  serviceName: string;
  http: HttpRequestInfo;
  ingress: Family;
  started?: number;
}

interface RequestCtx extends LogCtx {
  service: ModelServiceRow;
  started: number;
  /** How this service presents thinking to its client (ir/thinkingFormat.ts). */
  thinkingFormat: ThinkingFormat;
  /** Literal thinking boundaries this service declares, when its upstream's
   * model does not delimit its trace in a shape the scanner recognises. */
  thinkingDelimiters?: ThinkingDelimiters;
}

/**
 * Snapshot the client request for the log, serializing the body immediately and
 * then releasing it.
 *
 * `req.body` is cleared deliberately: Fastify holds the request object for as
 * long as the reply lives, which on a hijacked streaming response is the whole
 * relay. Nothing downstream reads it — the canonical request has already been
 * parsed out of it — so the only thing that reference achieved was keeping the
 * parsed conversation alive until the log row was written.
 */
function httpInfo(req: FastifyRequest, capture: (v: unknown) => string): HttpRequestInfo {
  const info = httpRequestInfo(req, capture(req.body));
  (req as { body?: unknown }).body = undefined;
  return info;
}

/** The client-facing proxy: parse -> resolve service -> invoke/stream -> log. */
export class ProxyController {
  constructor(private readonly deps: ProxyDeps, private readonly stateful?: {
    accepts(body: unknown, family: Family): boolean;
    create(req: FastifyRequest, reply: FastifyReply, family: Family): Promise<unknown>;
  }) {}

  register(app: FastifyInstance): void {
    const { tokens } = this.deps;
    app.post(ROUTE.CHAT_COMPLETIONS, { preHandler: requireClientToken(tokens, "openai_completion") }, (req, reply) =>
      this.handleChat(req, reply, "openai_completion"),
    );
    app.post(ROUTE.MESSAGES, { preHandler: requireClientToken(tokens, "anthropic") }, (req, reply) =>
      this.handleChat(req, reply, "anthropic"),
    );
    app.post(ROUTE.RESPONSES, { preHandler: requireClientToken(tokens, "openai_responses") }, (req, reply) =>
      this.handleChat(req, reply, "openai_responses"),
    );
    app.get(
      ROUTE.MODELS,
      {
        preHandler: (req: FastifyRequest, reply: FastifyReply) => {
          const family: Family = req.headers[HEADER.ANTHROPIC_VERSION] ? "anthropic" : "openai_completion";
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
    if (this.stateful?.accepts(req.body, ingress)) return this.stateful.create(req, reply, ingress);
    const token = req.clientToken!;
    // Take the local reference BEFORE httpInfo clears req.body, then let it go as
    // soon as the canonical request exists: from that point the parsed wire shape
    // is dead weight, and on a streaming call it would otherwise stay live for
    // the length of the whole relay.
    let body: Record<string, unknown> | null = (req.body ?? {}) as Record<string, unknown>;
    const http = httpInfo(req, (v) => this.deps.logger.capture(v));

    let request;
    try {
      request = parseRequest(ingress, body);
    } catch {
      return this.replyError(reply, ingress, HTTP_STATUS.BAD_REQUEST, "Invalid request body.");
    }
    body = null;

    const serviceName = request.requestedService;
    if (!serviceName) {
      return this.replyError(reply, ingress, HTTP_STATUS.BAD_REQUEST, "Missing 'model' (must be a Model Service or Micro Agent name).");
    }

    // Reject what cannot be honored rather than silently narrowing it: only
    // choices[0] would survive translation, which is worse than an honest 400.
    if ((request.params.n ?? 1) > 1) {
      return this.replyError(reply, ingress, HTTP_STATUS.BAD_REQUEST, "n > 1 is not supported through this proxy; send one request per completion.");
    }

    // Carry allowlisted client feature headers to same-family upstreams
    // (anthropic-beta feature flags, attribution headers). Auth never forwards.
    const fwd = collectForwardHeaders(req.headers, ingress, { joinRepeated: true, keepEmpty: false });
    if (Object.keys(fwd).length) request.params.forwardHeaders = { family: ingress, headers: fwd };

    const traceId = genId(ID_PREFIX.TRACE);
    const streaming = request.stream;
    const access = resolveServiceAccess(token, this.deps.services.getByName(serviceName), (row) => this.deps.services.def(row));
    const pre: LogCtx = { traceId, token, service: "service" in access ? access.service : null, serviceName, http, ingress };
    // A request refused before any upstream work: one log row, no quota spent.
    const refuse = (status: number, logged: string, message: string): FastifyReply => {
      this.logOutcome(pre, streaming, status, logged);
      return this.replyError(reply, ingress, status, message);
    };
    if (!access.ok && access.reason === "unknown") {
      return refuse(HTTP_STATUS.NOT_FOUND, `unknown model '${serviceName}'`, `Model '${serviceName}' not found. The 'model' field must be a Model Service or Micro Agent name.`);
    }
    if (!access.ok && access.reason === "forbidden") {
      return refuse(HTTP_STATUS.FORBIDDEN, ERR_SERVICE_OUT_OF_SCOPE, `This API key is not allowed to use '${serviceName}'.`);
    }
    const service = access.service;

    // Media passthrough categories (image/tts/embedding/...) have their own
    // endpoints; the chat pipeline serves chat and ocr services. An unparsable
    // definition is not answered here: building the executor below fails on it
    // the same way, and that is where its 500 is logged.
    let thinkingFormat: ThinkingFormat = "original";
    let thinkingDelimiters: ThinkingDelimiters | undefined;
    if (access.ok) {
      const category = serviceCategory(access.def);
      if (!isChatPipeline(category)) {
        return refuse(HTTP_STATUS.BAD_REQUEST, `'${serviceName}' is a ${category} service`, `'${serviceName}' is a ${category} service; use its dedicated endpoint instead of chat.`);
      }
      thinkingFormat = serviceThinkingFormat(access.def);
      thinkingDelimiters = serviceThinkingDelimiters(access.def);
    }

    const started = Date.now();
    const ctx: RequestCtx = { ...pre, service, started, thinkingFormat, thinkingDelimiters };
    let executor;
    try {
      executor = this.deps.factory.forRow(service).executor;
    } catch (e) {
      this.logFailure(ctx, streaming, HTTP_STATUS.INTERNAL_SERVER_ERROR, `invalid Model Service definition: ${errorMessage(e)}`);
      return this.replyError(reply, ingress, HTTP_STATUS.INTERNAL_SERVER_ERROR, `Model '${serviceName}' has an invalid definition.`);
    }

    // Register the request for real-time progress monitoring.
    this.deps.activeRequests.start({ traceId, tokenId: token.id, serviceId: service.id, serviceName, ingress, streaming: request.stream });
    try {
      const prog = new ProgressRecorder(this.deps.activeRequests, traceId);
      prog.record("init", "request.received", `request received: ${ingress} -> ${serviceName}`, { streaming: request.stream });
      prog.record("init", "request.parsed", "request body parsed and service resolved");

      const clientGone = abortOnClientClose(reply);

      if (request.stream) {
        // Keep bytes flowing while the executor works: commit the SSE response
        // after the grace window and ping until the outcome arrives.
        const keepalive = new SseKeepalive(
          reply, ingress,
          this.deps.streamCommitGraceMs ?? DEFAULT_STREAM_COMMIT_GRACE_MS,
          this.deps.streamPingIntervalMs ?? DEFAULT_STREAM_PING_INTERVAL_MS,
        );
        const outcome = await executor.stream(request, undefined, { progress: prog, signal: clientGone.signal }).finally(() => keepalive.stop());
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

      // Keep bytes flowing on the JSON response too: an OCR/vision answer can
      // take minutes, and a silent connection dies at the first intermediary.
      const jsonKeepalive = JsonKeepalive.forClient(reply, this.deps);
      const outcome = await executor.invoke(request, undefined, { progress: prog, signal: clientGone.signal }).finally(() => jsonKeepalive.stop());
      jsonKeepalive.stop();
      if (!outcome.result.ok) {
        if (clientGone.signal.aborted) return this.replyClientGone(reply, ctx, false, outcome);
        this.deps.activeRequests.finish(traceId, failureStatus(outcome.result), failureMessage(outcome.result));
        if (jsonKeepalive.committed) {
          // The 200 (and heartbeat whitespace) is already on the wire; the
          // failure travels as the error JSON body.
          return this.replyFailureInBody(reply, ctx, outcome.result, { attemptPath: outcome.attemptPath, attempts: outcome.attempts });
        }
        return this.replyFailure(reply, ctx, outcome.result, { streaming: false, attemptPath: outcome.attemptPath, attempts: outcome.attempts });
      }

      const value = outcome.result.value;
      // Capture the exact wire body sent upstream NOW and drop the reference.
      // Rendering it produced a complete second copy of the conversation -- every
      // base64 image in it -- and the delivery below can take a long time for a
      // slow client. The size-bounded string is all the request log ever needed,
      // so the full body has no reason to stay live across the send.
      const upstreamPayload = this.deps.logger.capture(value.upstreamRequest);
      value.upstreamRequest = {};
      // Shape the client's copy: lift a `<think>` block out of the answer, inline
      // it into the answer, or drop it. `original` returns the same object.
      const shapedResponse = value.response.withThinkingFormat(thinkingFormat, thinkingDelimiters);
      const emptyReason = missingAnswerReason(value.response.content, value.response.stopReason) ??
        missingAnswerReason(shapedResponse.content, shapedResponse.stopReason);
      const clientBody = emptyReason ? buildErrorBody(ingress, STATUS_UPSTREAM_FAILURE, emptyReason)
        : shapedResponse.render(ingress, serviceName, { thinkingFormat });
      // Deliver first, then log what actually happened: writing the 200 row
      // before send() is how a response nobody received was recorded as success.
      const socket = reply.raw.socket;
      const settled = responseFlushed(reply.raw);
      // When the keep-alive committed, headers + whitespace are already sent:
      // it appends the JSON document and ends (a connection that died first is
      // reported by responseFlushed).
      if (!jsonKeepalive.finish(clientBody)) reply.code(emptyReason ? STATUS_UPSTREAM_FAILURE : HTTP_STATUS.OK).send(clientBody);
      const flushed = await settled;
      const status = flushed ? (emptyReason ? STATUS_UPSTREAM_FAILURE : HTTP_STATUS.OK) : STATUS_CLIENT_CLOSED;
      const error = flushed ? emptyReason ?? null : ERR_CONNECTION_CLOSED_BEFORE_SENT;
      prog.record("done", "request.complete", `request completed in ${Date.now() - started}ms`, { httpStatus: status });
      this.deps.activeRequests.finish(traceId, status, error ?? undefined);
      this.logOutcome(ctx, false, status, error, {
        servedModel: value.modelName, servedProvider: value.providerName, egress: value.family,
        upstreamPayload,
        responseBody: emptyReason ? { ...clientBody, upstream_response: value.response.toLogPayload() } : clientBody,
        usage: value.response.usage, attempts: outcome.attempts, attemptPath: outcome.attemptPath,
      });
      // The upstream consumed these tokens whether or not the delivery landed.
      this.deps.usage.record(token.id, value.response.usage.totalTokens);
      if (status === HTTP_STATUS.OK && socket) this.demoteOnLateReset(socket, traceId);
      return reply;
    } catch (error) {
      this.deps.activeRequests.finish(traceId, HTTP_STATUS.INTERNAL_SERVER_ERROR, errorMessage(error));
      if (reply.raw.headersSent && !reply.raw.writableEnded) reply.raw.destroy();
      throw error;
    }
  }

  /** Write the request-log row of one request. The fields every row repeats
   * come from `ctx`; `extra` carries what only some outcomes have. */
  private logOutcome(ctx: LogCtx, streaming: boolean, httpStatus: number, error: string | null, extra: Partial<LogParams> = {}): void {
    this.deps.logger.record({
      traceId: ctx.traceId, tokenId: ctx.token.id, serviceId: ctx.service?.id ?? null, requestedService: ctx.serviceName,
      ingress: ctx.ingress, streaming, httpStatus, http: ctx.http,
      latencyMs: ctx.started == null ? 0 : Date.now() - ctx.started, error,
      ...extra,
    });
  }

  /** Log a request that reached its service and produced no answer. It still
   * spends one request of the key's quota (and no tokens). */
  private logFailure(ctx: RequestCtx, streaming: boolean, httpStatus: number, error: string, o: { attempts?: number; attemptPath?: unknown } = {}): void {
    this.logOutcome(ctx, streaming, httpStatus, error, { attempts: o.attempts, attemptPath: o.attemptPath });
    this.deps.usage.record(ctx.token.id, 0);
  }

  /** A 200 only means "handed to the kernel". Keep watching the socket: if the
   * peer resets it before sending anything else, the tail of the response
   * never arrived — demote the row to 499 so the log stops claiming a delivery
   * that did not happen. */
  private demoteOnLateReset(socket: Socket, traceId: string): void {
    watchDelivery(socket, (reason) => {
      this.deps.logger.amendDeliveryFailure(traceId, reason);
      this.deps.activeRequests.amendCompleted(traceId, STATUS_CLIENT_CLOSED, reason);
    });
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
    this.deps.activeRequests.finish(ctx.traceId, STATUS_CLIENT_CLOSED, error);
    this.logFailure(ctx, streaming, STATUS_CLIENT_CLOSED, error, o);
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
    // If the connection died first, the log below still tells the truth.
    endWith(reply.raw, () => buildErrorFrame(ctx.ingress, status, message));
    this.logFailure(ctx, true, status, `${message}${this.retrySuffix(o.attemptPath)} (delivered as in-stream error event)`, o);
    this.deps.activeRequests.finish(ctx.traceId, status, message);
  }

  /**
   * A failure on a NON-streaming request whose 200 was already committed by the
   * JSON keep-alive: the error is delivered as the protocol's error JSON body
   * (the only channel left on a committed response). The log row keeps the
   * SEMANTIC status, exactly like the SSE variant above. The caller has already
   * finished the active-request entry.
   */
  private replyFailureInBody(
    reply: FastifyReply,
    ctx: RequestCtx,
    failure: AttemptFailure,
    o: { attemptPath: unknown; attempts: number },
  ): void {
    const status = failureStatus(failure);
    const message = failureMessage(failure);
    // If the connection died first, the log below still tells the truth.
    endWith(reply.raw, () => JSON.stringify(buildErrorBody(ctx.ingress, status, message)));
    this.logFailure(ctx, false, status, `${message}${this.retrySuffix(o.attemptPath)} (delivered as error body after keep-alive commit)`, o);
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
    this.logFailure(ctx, o.streaming, status, message + this.retrySuffix(o.attemptPath), o);
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
    const validated = requireAnswer(value.events);
    const events = value.dropReasoning ? withoutReasoning(validated) : validated;
    // Shaped BEFORE the tap, so the log records the copy the client actually
    // received rather than a canonical form it never saw.
    const shaped = withThinkingFormat(events, ctx.thinkingFormat, ctx.thinkingDelimiters);
    const outGen = serializeStream(ctx.ingress, tapStream(requireAnswer(shaped), acc), {
      model: ctx.serviceName,
      thinkingFormat: ctx.thinkingFormat,
    });

    // Capture the upstream body now and drop it. The log row for a stream is
    // written when the last chunk has been relayed, which can be minutes later;
    // until this changed, the full translated conversation stayed live that whole
    // time for no purpose other than being serialized at the end.
    const upstreamPayload = this.deps.logger.capture(value.upstreamRequest);
    value.upstreamRequest = {};

    const raw = reply.raw;
    // When the keep-alive already committed the response, it is open already.
    if (!o.committed) openSse(reply);

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
          if (!ok && !raw.destroyed) await drained(raw);
          if (raw.destroyed) {
            clientDisconnected = true;
            break;
          }
        }
      } catch (e) {
        streamError = errorMessage(e);
        // A client that hung up aborts the upstream read, which surfaces here as
        // a throw too. Only a response the client had already abandoned is the
        // client's doing; anything else is the upstream failing mid-stream.
        clientDisconnected = raw.destroyed;
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
            if (acc.error) {
              raw.write(buildErrorFrame(ctx.ingress, STATUS_UPSTREAM_FAILURE, acc.error));
              raw.end();
            } else if (answerIsShort) raw.destroy();
            else raw.end();
          } catch { /* already closed */ }
        }
        // Only now can we tell whether the client actually got the response.
        const flushed = await settled;

        const usage: Usage = acc.usage ?? { ...ZERO_USAGE, incomplete: true };
        const responseBody: Record<string, unknown> = {
          streamed: true, role: "assistant", content: acc.text, stop_reason: acc.stopReason, usage,
        };
        if (acc.reasoning) responseBody.reasoning = acc.reasoning;
        if (acc.toolCalls.length) responseBody.tool_calls = acc.toolCalls;
        let error = streamError;
        let status = HTTP_STATUS.OK;
        if (clientDisconnected) {
          status = STATUS_CLIENT_CLOSED;
          error = streamError ?? "client disconnected before stream completed";
        }
        // The client is still connected: the stream broke on the upstream side,
        // exactly like the clean truncation below.
        else if (streamError) status = STATUS_UPSTREAM_FAILURE;
        else if (acc.incomplete) {
          status = STATUS_UPSTREAM_FAILURE;
          error = acc.error ?? "upstream stream ended before completion (truncated)";
          responseBody.incomplete = true;
          if (acc.error) responseBody.error = acc.error;
        }
        else if (!flushed) {
          // Every byte was written, but the connection died before they left
          // the machine. Reporting 200 here is what hid this failure.
          status = STATUS_CLIENT_CLOSED;
          error = ERR_CONNECTION_CLOSED_BEFORE_SENT;
        }
        this.logOutcome(ctx, true, status, error, {
          servedModel: value.modelName, servedProvider: value.providerName, egress: value.family,
          upstreamPayload, responseBody, usage, attempts: o.attempts, attemptPath: o.attemptPath,
        });
        this.deps.usage.record(ctx.token.id, usage.totalTokens);
        // Mark the active request as finished (streaming relay end).
        this.deps.activeRequests.finish(ctx.traceId, status, error ?? undefined);
        if (status === HTTP_STATUS.OK && socket) this.demoteOnLateReset(socket, ctx.traceId);
      }
    })()
      // This writer is deliberately not awaited (the relay hands the client its
      // bytes as they arrive). Everything above is inside try/finally, but a
      // throw from the finally's own bookkeeping -- a log write on a full disk,
      // say -- would otherwise be an unhandled rejection and kill the whole
      // process, turning one request's failure into an outage for every client.
      .catch((e: unknown) => {
        try {
          reply.log.error({ err: e }, "stream relay bookkeeping failed");
        } catch {
          /* nothing left to report it with */
        }
      });
  }

  private handleListModels(req: FastifyRequest): unknown {
    const isAnthropic = typeof req.headers[HEADER.ANTHROPIC_VERSION] === "string";
    // Only what this key may call: a name it would be refused on is not "available".
    const token = req.clientToken!;
    const services = this.deps.services.list().filter((m) => m.enabled && tokenAllowsService(token, m.id));
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
      data: services.map((m) => ({ id: m.name, object: "model", created: Math.floor(created(m) / MS_PER_SECOND), owned_by: "hydrogen" })),
    };
  }
}
