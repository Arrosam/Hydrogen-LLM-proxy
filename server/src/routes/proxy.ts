import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { addUsage, reasoningOf, textOf, ZERO_USAGE, type Family, type IRRequest, type IRUsage } from "../core/ir";
import { ingressAdapterFor } from "../core/formats";
import { buildErrorBody, extractUpstreamMessage, failureMessage, failureStatus } from "../core/proxy/errors";
import { runServiceBuffered, runServiceStream, type JsonSuccess, type StreamSuccess } from "../core/proxy/run";
import { runServiceDef } from "../core/proxy/invoke";
import { countAttempts, isStreamPlan, runAgent, type AgentStreamPlan, type ServiceCall } from "../core/agents/engine";
import { isAgent, type AgentDef, type ServiceDef, type ServiceSteps } from "../core/services/schema";
import {
  parseUpstreamStream,
  serializeClientStream,
  streamFromIRResponse,
  tapStream,
  type StreamAccumulator,
} from "../core/formats/stream";
import { getServiceByName, getServiceDef, resolveAgentStage } from "../services/services";
import { listServices } from "../services/services";
import { incrementUsage } from "../services/tokens";
import { insertLog } from "../services/logs";
import { getConfig } from "../context";
import { requireClientToken } from "../auth/tokenAuth";
import { serializeForLog } from "../util/logPayload";
import { asMillis } from "../util/time";
import type { AttemptFailure } from "../core/services/engine";
import type { ModelService, Token } from "../db/schema";
import { buildHeaders, embeddingsUrl, postJson } from "../core/upstream";
import { resolveMapping } from "../services/catalog";

interface LogParams {
  token: Token | null;
  service: ModelService | null;
  serviceName: string | null;
  ingress: Family;
  egress: Family | null;
  streaming: boolean;
  httpStatus: number;
  usage?: IRUsage;
  latencyMs: number;
  attempts?: number;
  /** Flat AttemptRecord[] for a Model Service; ServiceCall[] for a Micro Agent. */
  attemptPath?: unknown;
  requestBody?: unknown;
  responseBody?: unknown;
  error?: string | null;
}

function recordLog(p: LogParams): void {
  const max = getConfig().logPayloadMaxChars;
  const usage = p.usage ?? ZERO_USAGE;
  insertLog({
    tokenId: p.token?.id ?? null,
    serviceId: p.service?.id ?? null,
    serviceName: p.serviceName,
    ingressFormat: p.ingress,
    egressFormat: p.egress,
    streaming: p.streaming,
    httpStatus: p.httpStatus,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    latencyMs: p.latencyMs,
    attempts: p.attempts ?? 0,
    attemptPath: p.attemptPath ?? [],
    requestPayload: p.requestBody !== undefined ? serializeForLog(p.requestBody, max) : null,
    responsePayload:
      p.responseBody !== undefined && p.responseBody !== null
        ? serializeForLog(p.responseBody, max)
        : null,
    error: p.error ?? null,
  });
}

function replyError(reply: FastifyReply, family: Family, status: number, message: string): FastifyReply {
  return reply.code(status).send(buildErrorBody(family, status, message));
}

function tokenAllowsService(token: Token, serviceId: number): boolean {
  const scope = token.scopeServices;
  if (!Array.isArray(scope) || scope.length === 0) return true; // unscoped = all
  return scope.includes(serviceId);
}

/** Per-request context threaded through the run/stream/log helpers. */
interface RequestCtx {
  token: Token;
  service: ModelService;
  serviceName: string;
  body: unknown;
  started: number;
}

/** Log a failed run, count the request against the token, and answer in the client's format. */
function replyFailure(
  reply: FastifyReply,
  ingress: Family,
  ctx: RequestCtx,
  failure: AttemptFailure,
  o: { streaming: boolean; attemptPath?: unknown; attempts?: number },
): FastifyReply {
  const status = failureStatus(failure);
  const message = failureMessage(failure);
  recordLog({
    token: ctx.token, service: ctx.service, serviceName: ctx.serviceName, ingress, egress: null,
    streaming: o.streaming, httpStatus: status, latencyMs: Date.now() - ctx.started,
    attempts: o.attempts, attemptPath: o.attemptPath, requestBody: ctx.body, error: message,
  });
  incrementUsage(ctx.token.id, 1, 0);
  return reply.code(status).send(buildErrorBody(ingress, status, message));
}

function sendSse(reply: FastifyReply, gen: AsyncGenerator<string>): FastifyReply {
  reply.header("content-type", "text/event-stream; charset=utf-8");
  reply.header("cache-control", "no-cache, no-transform");
  reply.header("connection", "keep-alive");
  reply.header("x-accel-buffering", "no");
  return reply.send(Readable.from(gen));
}

interface RelayOpts {
  /** Request payload to log; defaults to the client body. A Model Service passes
   * the actual upstream request (step overrides + translation applied). */
  requestBody?: unknown;
  /** Usage accumulated before this stream (a Micro Agent's buffered stages). */
  baseUsage?: IRUsage;
  attempts: number;
  attemptPath: unknown;
  /** Runs just before the log is written, with the stream's outcome. */
  onFinish?: (o: {
    status: number;
    streamUsage: IRUsage;
    responseBody: Record<string, unknown>;
    error: string | null;
  }) => void;
}

/** Relay an upstream SSE stream to the client, tapping it for the request log. */
function relayStream(
  reply: FastifyReply,
  ingress: Family,
  ctx: RequestCtx,
  value: StreamSuccess,
  opts: RelayOpts,
): FastifyReply {
  const acc: StreamAccumulator = { stopReason: null, text: "", reasoning: "", toolCalls: [], upstreamModel: "", incomplete: false };
  const events = tapStream(parseUpstreamStream(value.family, value.body), acc);
  const outGen = serializeClientStream(ingress, events, { model: ctx.serviceName });

  async function* streamAndLog(): AsyncGenerator<string> {
    let streamError: string | null = null;
    try {
      for await (const chunk of outGen) yield chunk;
    } catch (e) {
      streamError = e instanceof Error ? e.message : String(e);
    } finally {
      const streamUsage = acc.usage ?? ZERO_USAGE;
      const usage = addUsage(opts.baseUsage ?? ZERO_USAGE, streamUsage);
      const responseBody: Record<string, unknown> = {
        streamed: true, role: "assistant", content: acc.text, stop_reason: acc.stopReason, usage,
      };
      if (acc.reasoning) responseBody.reasoning = acc.reasoning;
      if (acc.toolCalls.length) responseBody.tool_calls = acc.toolCalls;
      // The stream committed to the client on 2xx headers, so a truncation
      // can't be retried here (unlike buffered stage calls) -- but it is
      // recorded as a 502 with the real (partial) usage, never a green 0-token
      // "success", so truncating upstreams are visible.
      let error = streamError;
      let status = 200;
      if (streamError) status = 499;
      else if (acc.incomplete) {
        status = 502;
        error = "upstream stream ended before completion (truncated)";
        responseBody.incomplete = true;
      }
      opts.onFinish?.({ status, streamUsage, responseBody, error });
      recordLog({
        token: ctx.token, service: ctx.service, serviceName: ctx.serviceName, ingress, egress: value.family,
        streaming: true, httpStatus: status, usage, latencyMs: Date.now() - ctx.started,
        attempts: opts.attempts, attemptPath: opts.attemptPath,
        requestBody: opts.requestBody ?? ctx.body, responseBody, error,
      });
      incrementUsage(ctx.token.id, 1, usage.totalTokens);
    }
  }
  return sendSse(reply, streamAndLog());
}
/** Shared handler for /v1/chat/completions (openai) and /v1/messages (anthropic). */
async function handleChat(req: FastifyRequest, reply: FastifyReply, ingress: Family): Promise<unknown> {
  const token = req.clientToken!;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const adapter = ingressAdapterFor(ingress);

  let ir: IRRequest;
  try {
    ir = adapter.requestToIR(body);
  } catch {
    return replyError(reply, ingress, 400, "Invalid request body.");
  }

  const serviceName = ir.requestedModel;
  if (!serviceName) return replyError(reply, ingress, 400, "Missing 'model' (must be a Model Service or Micro Agent name).");

  const service = getServiceByName(serviceName);
  if (!service || !service.enabled) {
    recordLog({
      token, service: null, serviceName, ingress, egress: null, streaming: ir.stream,
      httpStatus: 404, latencyMs: 0, requestBody: body, error: `unknown model '${serviceName}'`,
    });
    return replyError(
      reply, ingress, 404,
      `Model '${serviceName}' not found. The 'model' field must be a Model Service or Micro Agent name.`,
    );
  }

  if (!tokenAllowsService(token, service.id)) {
    recordLog({
      token, service, serviceName, ingress, egress: null, streaming: ir.stream,
      httpStatus: 403, latencyMs: 0, requestBody: body, error: "service out of token scope",
    });
    return replyError(reply, ingress, 403, `This token is not allowed to use '${serviceName}'.`);
  }

  const started = Date.now();
  let def: ServiceDef;
  try {
    def = getServiceDef(service);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    recordLog({
      token, service, serviceName, ingress, egress: null, streaming: ir.stream, httpStatus: 500,
      latencyMs: Date.now() - started, requestBody: body, error: `invalid Model Service definition: ${message}`,
    });
    incrementUsage(token.id, 1, 0);
    return replyError(reply, ingress, 500, `Model '${serviceName}' has an invalid definition.`);
  }

  const ctx: RequestCtx = { token, service, serviceName, body, started };

  if (ir.stream) {
    if (isAgent(def)) return handleAgentStream(reply, ingress, ir, def, ctx);
    if (def.reliableStreaming) return handleReliableStream(reply, ingress, ir, def, ctx);
    return handleStream(reply, ingress, ir, def, ctx);
  }

  const run = await runServiceDef(def, ir, resolveAgentStage, [serviceName]);
  if (!run.result.ok) {
    return replyFailure(reply, ingress, ctx, run.result, {
      streaming: false, attemptPath: run.attemptPath, attempts: run.attempts,
    });
  }

  const respIR = run.result.value.ir;
  const clientBody = adapter.irToResponse(respIR, { model: serviceName });
  recordLog({
    token, service, serviceName, ingress, egress: run.result.value.family, streaming: false, httpStatus: 200,
    usage: respIR.usage, latencyMs: Date.now() - started, attempts: run.attempts, attemptPath: run.attemptPath,
    // Log the request actually sent upstream (step overrides + translation applied).
    requestBody: run.upstreamRequest ?? body, responseBody: clientBody,
  });
  incrementUsage(token.id, 1, respIR.usage.totalTokens);
  return reply.code(200).send(clientBody);
}

/** Streaming for a Model Service: relay the upstream SSE, tapping it for the log. */
async function handleStream(
  reply: FastifyReply,
  ingress: Family,
  ir: IRRequest,
  def: ServiceSteps,
  ctx: RequestCtx,
): Promise<unknown> {
  const { result, path } = await runServiceStream(ir, def);
  if (!result.ok) {
    return replyFailure(reply, ingress, ctx, result, { streaming: true, attemptPath: path, attempts: path.length });
  }
  return relayStream(reply, ingress, ctx, result.value, {
    requestBody: result.value.upstreamRequest, attempts: path.length, attemptPath: path,
  });
}

/** Log a fully-buffered result and replay it to the client as a fake stream.
 * Shared by reliable-streaming Model Services and buffered agent runs. */
function replayBuffered(
  reply: FastifyReply,
  ingress: Family,
  ctx: RequestCtx,
  value: JsonSuccess,
  o: { attemptPath: unknown; attempts: number; requestBody: unknown },
): FastifyReply {
  const respIR = value.ir;
  const reasoning = reasoningOf(respIR.content);
  const responseBody: Record<string, unknown> = {
    streamed: true, role: "assistant", content: textOf(respIR.content),
    ...(reasoning ? { reasoning } : {}),
    stop_reason: respIR.stopReason, usage: respIR.usage,
  };
  recordLog({
    token: ctx.token, service: ctx.service, serviceName: ctx.serviceName, ingress, egress: value.family,
    streaming: true, httpStatus: 200, usage: respIR.usage, latencyMs: Date.now() - ctx.started,
    attempts: o.attempts, attemptPath: o.attemptPath, requestBody: o.requestBody, responseBody,
  });
  incrementUsage(ctx.token.id, 1, respIR.usage.totalTokens);
  return sendSse(reply, streamFromIRResponse(ingress, respIR, { model: ctx.serviceName }));
}

/** Reliable streaming for a Model Service: stream the upstream response and
 * buffer it (a truncated stream retries under the step's rules), then replay
 * the complete result. Streaming the upstream (rather than a plain
 * non-streaming request) is essential to capture reasoning from providers that
 * only emit it on streams. The client gets a complete response or a clean 502 --
 * never a partial stream -- at the cost of first-token latency. */
async function handleReliableStream(
  reply: FastifyReply,
  ingress: Family,
  ir: IRRequest,
  def: ServiceSteps,
  ctx: RequestCtx,
): Promise<unknown> {
  const { result, path } = await runServiceBuffered(ir, def);
  if (!result.ok) {
    return replyFailure(reply, ingress, ctx, result, { streaming: true, attemptPath: path, attempts: path.length });
  }
  return replayBuffered(reply, ingress, ctx, result.value, {
    attemptPath: path, attempts: path.length, requestBody: result.value.upstreamRequest,
  });
}
/** Streaming for an agent: routing needs each stage's full output, so earlier
 * stages run buffered -- but the terminal Model Service (nothing routes after
 * it) is streamed directly so the client gets real token-by-token output,
 * through nested Micro Agents too. Only when the returned output is decided by
 * a transition (or agent.output points at an earlier stage) does the agent
 * finish buffered and emit the result as a fake stream. With reliableStreaming
 * on, the terminal stage is never streamed directly -- the whole agent runs
 * buffered (every stage streams its upstream and buffers, retrying a truncated
 * stream) and the complete result is replayed. */
async function handleAgentStream(
  reply: FastifyReply,
  ingress: Family,
  ir: IRRequest,
  agent: AgentDef,
  ctx: RequestCtx,
): Promise<unknown> {
  const outcome = agent.reliableStreaming
    ? await runAgent(ir, agent, resolveAgentStage, [ctx.serviceName])
    : await runAgent(ir, agent, resolveAgentStage, [ctx.serviceName], { streamTerminal: true });
  if (isStreamPlan(outcome)) return streamTerminalStage(reply, ingress, outcome, ctx);

  const { result, calls } = outcome;
  const attempts = countAttempts(calls);

  if (!result.ok) {
    return replyFailure(reply, ingress, ctx, result, { streaming: true, attemptPath: calls, attempts });
  }

  return replayBuffered(reply, ingress, ctx, result.value, { attemptPath: calls, attempts, requestBody: ctx.body });
}

/** Stream an agent's terminal Model Service directly to the client. The calls
 * made so far are already logged in plan.calls; the terminal service's own
 * call entry is appended to plan.container (nested inside any wrapping Micro
 * Agent entries) and finalized when the stream ends. */
async function streamTerminalStage(
  reply: FastifyReply,
  ingress: Family,
  plan: AgentStreamPlan,
  ctx: RequestCtx,
): Promise<unknown> {
  const startedTerminal = Date.now();
  const { result, path } = await runServiceStream(plan.stageIR, plan.steps);

  const terminalCall: ServiceCall = {
    stage: plan.stageName,
    service: plan.service ?? "(inline)",
    kind: "service",
    status: 0,
    latencyMs: 0,
    attempts: path,
    // The request actually sent upstream (thinking overrides + translation
    // applied); plan.request is the pre-translation IR, used only on failure.
    request: result.ok ? serializeForLog(result.value.upstreamRequest, getConfig().logPayloadMaxChars) : plan.request,
  };
  plan.container.push(terminalCall);
  const finalize = (status: number, error?: string): void => {
    terminalCall.status = status;
    terminalCall.latencyMs = Date.now() - startedTerminal;
    if (error) terminalCall.error = error;
    for (const p of plan.pending) {
      p.call.status = status;
      p.call.latencyMs = Date.now() - p.startedAt;
      if (error) p.call.error = error;
    }
  };

  if (!result.ok) {
    finalize(result.status, failureMessage(result));
    return replyFailure(reply, ingress, ctx, result, {
      streaming: true, attemptPath: plan.calls, attempts: countAttempts(plan.calls),
    });
  }

  terminalCall.streamed = true;
  for (const p of plan.pending) p.call.streamed = true;

  return relayStream(reply, ingress, ctx, result.value, {
    // Top-level request stays the client body; the terminal stage's own upstream
    // request is recorded on its ServiceCall entry (terminalCall.request).
    baseUsage: plan.usage,
    attempts: countAttempts(plan.calls),
    attemptPath: plan.calls,
    onFinish: ({ status, streamUsage, responseBody, error }) => {
      terminalCall.usage = streamUsage;
      terminalCall.response = serializeForLog(responseBody, getConfig().logPayloadMaxChars);
      finalize(status, error ?? undefined);
    },
  });
}

/** GET /v1/models - lists services as the available models. */
function handleListModels(req: FastifyRequest): unknown {
  const isAnthropic = typeof req.headers["anthropic-version"] === "string";
  const services = listServices().filter((m) => m.enabled);
  const created = (m: ModelService) => asMillis(m.createdAt);

  if (isAnthropic) {
    return {
      data: services.map((m) => ({
        type: "model",
        id: m.name,
        display_name: m.name,
        created_at: new Date(created(m)).toISOString(),
      })),
      has_more: false,
      first_id: services[0]?.name ?? null,
      last_id: services[services.length - 1]?.name ?? null,
    };
  }
  return {
    object: "list",
    data: services.map((m) => ({
      id: m.name,
      object: "model",
      created: Math.floor(created(m) / 1000),
      owned_by: "hydrogen",
    })),
  };
}

/** POST /v1/embeddings - passthrough to the first step's OpenAI-compatible provider. */
async function handleEmbeddings(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const token = req.clientToken!;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const serviceName = String(body.model ?? "");
  const service = getServiceByName(serviceName);
  if (!service || !service.enabled) return replyError(reply, "openai", 404, `Model '${serviceName}' not found.`);
  if (!tokenAllowsService(token, service.id)) {
    return replyError(reply, "openai", 403, `This token is not allowed to use '${serviceName}'.`);
  }

  const def = getServiceDef(service);
  if (isAgent(def)) {
    return replyError(reply, "openai", 400, "Embeddings are not supported for Micro Agents.");
  }
  const first = def.steps[0];
  const res = resolveMapping(first.model, first.provider);
  if (!res.ok || !res.mapping) {
    return replyError(reply, "openai", 502, `No usable upstream for '${serviceName}'.`);
  }
  if (res.mapping.family === "anthropic") {
    return replyError(reply, "openai", 400, "Embeddings are only supported on OpenAI-compatible providers.");
  }

  const started = Date.now();
  const upstreamBody = { ...body, model: res.mapping.upstreamModel };
  const r = await postJson(embeddingsUrl(res.mapping.upstream), buildHeaders(res.mapping.upstream), upstreamBody, {
    timeoutMs: def.timeoutMs,
  });
  const usageObj = (r.json as { usage?: { prompt_tokens?: number; total_tokens?: number } } | undefined)?.usage;
  const usage: IRUsage = {
    promptTokens: usageObj?.prompt_tokens ?? 0,
    completionTokens: 0,
    totalTokens: usageObj?.total_tokens ?? usageObj?.prompt_tokens ?? 0,
  };
  recordLog({
    token, service, serviceName, ingress: "openai", egress: "openai", streaming: false, httpStatus: r.status,
    usage, latencyMs: Date.now() - started,
    attempts: 1,
    attemptPath: [
      { step: 1, attempt: 1, model: first.model, provider: first.provider, status: r.status, kind: r.status < 400 ? "ok" : "http", latencyMs: Date.now() - started },
    ],
    requestBody: body, responseBody: r.status < 400 ? { ok: true } : r.json,
    error: r.status >= 400 ? extractUpstreamMessage(r.json) ?? `upstream ${r.status}` : null,
  });
  incrementUsage(token.id, 1, usage.totalTokens);
  return reply.code(r.status).send(r.json ?? {});
}

export async function proxyRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/chat/completions", { preHandler: requireClientToken("openai") }, (req, reply) =>
    handleChat(req, reply, "openai"),
  );

  app.post("/v1/messages", { preHandler: requireClientToken("anthropic") }, (req, reply) =>
    handleChat(req, reply, "anthropic"),
  );

  app.post("/v1/responses", { preHandler: requireClientToken("openai_responses") }, (req, reply) =>
    handleChat(req, reply, "openai_responses"),
  );

  app.post("/v1/embeddings", { preHandler: requireClientToken("openai") }, (req, reply) =>
    handleEmbeddings(req, reply),
  );

  const modelsAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const family: Family = req.headers["anthropic-version"] ? "anthropic" : "openai";
    return requireClientToken(family)(req, reply);
  };
  app.get("/v1/models", { preHandler: modelsAuth }, (req) => handleListModels(req));
}