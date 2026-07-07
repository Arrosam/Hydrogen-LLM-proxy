import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
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

    if (request.stream) {
      const outcome = await executor.stream(request);
      if (!outcome.result.ok) {
        return this.replyFailure(reply, ctx, outcome.result, { streaming: true, attemptPath: outcome.attemptPath, attempts: outcome.attempts });
      }
      return this.relay(reply, ctx, outcome.result.value, { attempts: outcome.attempts, attemptPath: outcome.attemptPath });
    }

    const outcome = await executor.invoke(request);
    if (!outcome.result.ok) {
      return this.replyFailure(reply, ctx, outcome.result, { streaming: false, attemptPath: outcome.attemptPath, attempts: outcome.attempts });
    }

    const value = outcome.result.value;
    const clientBody = value.response.render(ingress, serviceName);
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
    this.deps.logger.record({
      traceId: ctx.traceId, tokenId: ctx.token.id, serviceId: ctx.service.id, requestedService: ctx.serviceName,
      ingress: ctx.ingress, streaming: o.streaming, httpStatus: status, http: ctx.http,
      latencyMs: Date.now() - ctx.started, attempts: o.attempts, attemptPath: o.attemptPath, error: message,
    });
    this.deps.usage.record(ctx.token.id, 0);
    return reply.code(status).send(buildErrorBody(ctx.ingress, status, message));
  }

  /** Relay a canonical event stream to the client, tapping it for the request log. */
  private relay(reply: FastifyReply, ctx: RequestCtx, value: StreamValue, o: { attempts: number; attemptPath: unknown }): FastifyReply {
    const acc: StreamAccumulator = newAccumulator();
    const events = value.dropReasoning ? withoutReasoning(value.events) : value.events;
    const outGen = serializeStream(ctx.ingress, tapStream(events, acc), { model: ctx.serviceName });

    const self = this;
    async function* streamAndLog(): AsyncGenerator<string> {
      let streamError: string | null = null;
      try {
        for await (const chunk of outGen) yield chunk;
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
        else if (acc.incomplete) {
          status = 502;
          error = "upstream stream ended before completion (truncated)";
          responseBody.incomplete = true;
        }
        self.deps.logger.record({
          traceId: ctx.traceId, tokenId: ctx.token.id, serviceId: ctx.service.id, requestedService: ctx.serviceName,
          servedModel: value.modelName, servedProvider: value.providerName,
          ingress: ctx.ingress, egress: value.family, streaming: true, httpStatus: status, http: ctx.http,
          upstreamRequest: value.upstreamRequest,
          responseBody, usage, latencyMs: Date.now() - ctx.started, attempts: o.attempts, attemptPath: o.attemptPath, error,
        });
        self.deps.usage.record(ctx.token.id, usage.totalTokens);
      }
    }

    reply.header("content-type", "text/event-stream; charset=utf-8");
    reply.header("cache-control", "no-cache, no-transform");
    reply.header("connection", "keep-alive");
    reply.header("x-accel-buffering", "no");
    return reply.send(Readable.from(streamAndLog()));
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
