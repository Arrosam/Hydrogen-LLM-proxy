import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Family } from "../core/format/family";
import { parseRequest, serializeStream } from "../core/format/registry";
import { buildErrorBody, extractUpstreamMessage, failureMessage, failureStatus } from "../core/proxy/errors";
import {
  newAccumulator,
  tapStream,
  withoutReasoning,
  type StreamAccumulator,
} from "../core/ir/stream";
import { ZERO_USAGE, type Usage } from "../core/ir/usage";
import type { AttemptFailure } from "../execution/steps";
import type { StreamValue } from "../execution/outcome";
import { isAgent } from "../execution/definition";
import { buildHeaders, embeddingsUrl } from "../core/upstream/endpoints";
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
    app.post("/v1/embeddings", { preHandler: requireClientToken(tokens, "openai_completion") }, (req, reply) =>
      this.handleEmbeddings(req, reply),
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

    if (request.stream) {
      const outcome = await executor.stream(request, undefined, { progress: prog });
      if (!outcome.result.ok) {
        this.deps.activeRequests.finish(traceId, failureStatus(outcome.result), failureMessage(outcome.result));
        return this.replyFailure(reply, ctx, outcome.result, { streaming: true, attemptPath: outcome.attemptPath, attempts: outcome.attempts });
      }
      this.relay(reply, ctx, outcome.result.value, { attempts: outcome.attempts, attemptPath: outcome.attemptPath });
      return; // relay hijacks the reply and writes asynchronously
    }

    const outcome = await executor.invoke(request, undefined, { progress: prog });
    if (!outcome.result.ok) {
      this.deps.activeRequests.finish(traceId, failureStatus(outcome.result), failureMessage(outcome.result));
      return this.replyFailure(reply, ctx, outcome.result, { streaming: false, attemptPath: outcome.attemptPath, attempts: outcome.attempts });
    }

    const value = outcome.result.value;
    const clientBody = value.response.render(ingress, serviceName);
    prog.record("done", "request.complete", `request completed in ${Date.now() - started}ms`, { httpStatus: 200 });
    this.deps.activeRequests.finish(traceId, 200);
    this.deps.logger.record({
      traceId, tokenId: token.id, serviceId: service.id, requestedService: serviceName,
      servedModel: value.modelName, servedProvider: value.providerName,
      ingress, egress: value.family, streaming: false, httpStatus: 200, http,
      upstreamRequest: value.upstreamRequest,
      responseBody: clientBody, usage: value.response.usage, latencyMs: Date.now() - started,
      attempts: outcome.attempts, attemptPath: outcome.attemptPath,
    });
    this.deps.usage.record(token.id, value.response.usage.totalTokens);
    return reply.code(200).send(clientBody);
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
    const lastAttempt = (o.attemptPath as Array<{ retry?: { reason: string; retryIndex: number; delayMs: number; suppressed: boolean } }>)?.slice(-1)[0];
    const retrySuffix = lastAttempt?.retry
      ? ` [retry#${lastAttempt.retry.retryIndex} delay=${lastAttempt.retry.delayMs}ms suppressed=${lastAttempt.retry.suppressed}: ${lastAttempt.retry.reason}]`
      : "";
    const detailedError = message + retrySuffix;
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
  private relay(reply: FastifyReply, ctx: RequestCtx, value: StreamValue, o: { attempts: number; attemptPath: unknown }): void {
    const acc: StreamAccumulator = newAccumulator();
    const events = value.dropReasoning ? withoutReasoning(value.events) : value.events;
    const outGen = serializeStream(ctx.ingress, tapStream(events, acc), { model: ctx.serviceName });

    // Hijack the reply so Fastify does not interfere with our raw SSE writes.
    // Without this, Fastify's lifecycle hooks (onSend, preSerialization, etc.)
    // can race with the async writer below, causing truncated responses.
    reply.hijack();

    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    });

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
        // End the response cleanly if not already ended.
        if (!raw.writableEnded) {
          try { raw.end(); } catch { /* already closed */ }
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

  private async handleEmbeddings(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const token = req.clientToken!;
    const http = httpInfo(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const serviceName = String(body.model ?? "");
    const traceId = genId("trace");

    const service = this.deps.services.getByName(serviceName);
    if (!service || !service.enabled) return this.replyError(reply, "openai_completion", 404, `Model '${serviceName}' not found.`);
    if (!tokenAllowsService(token, service.id)) {
      return this.replyError(reply, "openai_completion", 403, `This token is not allowed to use '${serviceName}'.`);
    }

    let def;
    try {
      def = this.deps.services.def(service);
    } catch {
      return this.replyError(reply, "openai_completion", 500, `Model '${serviceName}' has an invalid definition.`);
    }
    if (isAgent(def)) return this.replyError(reply, "openai_completion", 400, "Embeddings are not supported for Micro Agents.");

    const first = def.steps[0];
    const res = this.deps.catalog.resolve(first.model, first.provider);
    if (!res.ok) return this.replyError(reply, "openai_completion", 502, `No usable upstream for '${serviceName}'.`);
    if (res.target.family === "anthropic") {
      return this.replyError(reply, "openai_completion", 400, "Embeddings are only supported on OpenAI-compatible providers.");
    }

    const started = Date.now();
    const upstreamBody = { ...body, model: res.target.upstreamModel };
    const r = await this.deps.transport.postJson(
      embeddingsUrl(res.target.upstream),
      buildHeaders(res.target.upstream),
      upstreamBody,
      { timeoutMs: def.timeoutMs },
    );
    const usageObj = (r.json as { usage?: { prompt_tokens?: number; total_tokens?: number } } | undefined)?.usage;
    const usage: Usage = {
      promptTokens: usageObj?.prompt_tokens ?? 0,
      completionTokens: 0,
      totalTokens: usageObj?.total_tokens ?? usageObj?.prompt_tokens ?? 0,
    };
    this.deps.logger.record({
      traceId, tokenId: token.id, serviceId: service.id, requestedService: serviceName,
      servedModel: r.status < 400 ? res.target.modelName : null, servedProvider: r.status < 400 ? res.target.providerName : null,
      ingress: "openai_completion", egress: "openai_completion", streaming: false, httpStatus: r.status, http,
      upstreamRequest: upstreamBody,
      responseBody: r.status < 400 ? { ok: true } : r.json, usage, latencyMs: Date.now() - started,
      attempts: 1, attemptPath: [{ step: 1, attempt: 1, model: first.model, provider: first.provider, status: r.status, kind: r.status < 400 ? "ok" : "http", latencyMs: Date.now() - started }],
      error: r.status >= 400 ? extractUpstreamMessage(r.json) ?? `upstream ${r.status}` : null,
    });
    this.deps.usage.record(token.id, usage.totalTokens);
    return reply.code(r.status).send(r.json ?? {});
  }
}
