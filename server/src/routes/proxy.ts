import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { textOf, type Family, type IRRequest, type IRUsage } from "../core/ir";
import { adapterFor } from "../core/formats";
import { buildErrorBody, extractUpstreamMessage } from "../core/proxy/errors";
import { runMubJson, runMubStream } from "../core/proxy/run";
import { runMubChain } from "../core/mub/chain";
import { isChain, type ChainDef, type MubDef, type MubSteps } from "../core/mub/schema";
import {
  parseUpstreamStream,
  serializeClientStream,
  streamFromIRResponse,
  tapStream,
  type StreamAccumulator,
} from "../core/formats/stream";
import { getMubByName, getMubDef, resolveChainStage } from "../services/mubs";
import { listMubs } from "../services/mubs";
import { incrementUsage } from "../services/tokens";
import { insertLog } from "../services/logs";
import { getConfig } from "../context";
import { requireClientToken } from "../auth/tokenAuth";
import { serializeForLog } from "../util/logPayload";
import type { AttemptRecord } from "../core/mub/engine";
import type { ModelUseBehavior, Token } from "../db/schema";
import { buildHeaders, embeddingsUrl, postJson } from "../core/upstream";
import { resolveMapping } from "../services/catalog";

const ZERO_USAGE: IRUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

interface LogParams {
  token: Token | null;
  mub: ModelUseBehavior | null;
  mubName: string | null;
  ingress: Family;
  egress: Family | null;
  streaming: boolean;
  httpStatus: number;
  usage?: IRUsage;
  latencyMs: number;
  attempts?: number;
  attemptPath?: AttemptRecord[];
  requestBody?: unknown;
  responseBody?: unknown;
  error?: string | null;
}

function recordLog(p: LogParams): void {
  const max = getConfig().logPayloadMaxChars;
  const usage = p.usage ?? ZERO_USAGE;
  insertLog({
    tokenId: p.token?.id ?? null,
    mubId: p.mub?.id ?? null,
    mubName: p.mubName,
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
    // Serialized to VALID JSON within the char budget (long string fields are
    // shortened rather than cutting the JSON mid-structure) so the log viewer
    // can always render a formatted transcript.
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

function tokenAllowsMub(token: Token, mubId: number): boolean {
  const scope = token.scopeMubs;
  if (!Array.isArray(scope) || scope.length === 0) return true; // unscoped = all
  return scope.includes(mubId);
}

/** Shared handler for /v1/chat/completions (openai) and /v1/messages (anthropic). */
async function handleChat(req: FastifyRequest, reply: FastifyReply, ingress: Family): Promise<unknown> {
  const token = req.clientToken!;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const adapter = adapterFor(ingress);

  let ir: IRRequest;
  try {
    ir = adapter.requestToIR(body);
  } catch {
    return replyError(reply, ingress, 400, "Invalid request body.");
  }

  const mubName = ir.requestedModel;
  if (!mubName) return replyError(reply, ingress, 400, "Missing 'model' (must be a MUB name).");

  const mub = getMubByName(mubName);
  if (!mub || !mub.enabled) {
    recordLog({
      token, mub: null, mubName, ingress, egress: null, streaming: ir.stream,
      httpStatus: 404, latencyMs: 0, requestBody: body, error: `unknown model '${mubName}'`,
    });
    return replyError(
      reply, ingress, 404,
      `Model '${mubName}' not found. The 'model' field must be a Model Use Behavior name.`,
    );
  }

  if (!tokenAllowsMub(token, mub.id)) {
    recordLog({
      token, mub, mubName, ingress, egress: null, streaming: ir.stream,
      httpStatus: 403, latencyMs: 0, requestBody: body, error: "mub out of token scope",
    });
    return replyError(reply, ingress, 403, `This token is not allowed to use '${mubName}'.`);
  }

  const started = Date.now();
  let def: MubDef;
  try {
    def = getMubDef(mub);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    recordLog({
      token, mub, mubName, ingress, egress: null, streaming: ir.stream, httpStatus: 500,
      latencyMs: Date.now() - started, requestBody: body, error: `invalid MUB definition: ${message}`,
    });
    incrementUsage(token.id, 1, 0);
    return replyError(reply, ingress, 500, `Model '${mubName}' has an invalid definition.`);
  }

  if (ir.stream) {
    if (isChain(def)) return handleChainStream(reply, ingress, ir, def, { token, mub, mubName, body, started });
    return handleStream(reply, ingress, ir, def, { token, mub, mubName, body, started });
  }

  const { result, path } = isChain(def)
    ? await runMubChain(ir, def, resolveChainStage, [mubName])
    : await runMubJson(ir, def);
  const latencyMs = Date.now() - started;

  if (!result.ok) {
    const status = result.status >= 400 ? result.status : 502;
    const message = extractUpstreamMessage(result.errorBody) ?? result.message;
    recordLog({
      token, mub, mubName, ingress, egress: null, streaming: false, httpStatus: status,
      latencyMs, attempts: path.length, attemptPath: path, requestBody: body, error: message,
    });
    incrementUsage(token.id, 1, 0);
    return reply.code(status).send(buildErrorBody(ingress, status, message));
  }

  const respIR = result.value.ir;
  const clientBody = adapter.irToResponse(respIR, { model: mubName });
  recordLog({
    token, mub, mubName, ingress, egress: result.value.family, streaming: false, httpStatus: 200,
    usage: respIR.usage, latencyMs, attempts: path.length, attemptPath: path,
    requestBody: body, responseBody: clientBody,
  });
  incrementUsage(token.id, 1, respIR.usage.totalTokens);
  return reply.code(200).send(clientBody);
}

interface StreamCtx {
  token: Token;
  mub: ModelUseBehavior;
  mubName: string;
  body: unknown;
  started: number;
}

function sendSse(reply: FastifyReply, gen: AsyncGenerator<string>): FastifyReply {
  reply.header("content-type", "text/event-stream; charset=utf-8");
  reply.header("cache-control", "no-cache, no-transform");
  reply.header("connection", "keep-alive");
  reply.header("x-accel-buffering", "no");
  return reply.send(Readable.from(gen));
}

/** Streaming for a resilience MUB: relay the upstream SSE, tapping it for the log. */
async function handleStream(
  reply: FastifyReply,
  ingress: Family,
  ir: IRRequest,
  def: MubSteps,
  ctx: StreamCtx,
): Promise<unknown> {
  const { result, path } = await runMubStream(ir, def);

  if (!result.ok) {
    const status = result.status >= 400 ? result.status : 502;
    const message = extractUpstreamMessage(result.errorBody) ?? result.message;
    recordLog({
      token: ctx.token, mub: ctx.mub, mubName: ctx.mubName, ingress, egress: null, streaming: true,
      httpStatus: status, latencyMs: Date.now() - ctx.started, attempts: path.length,
      attemptPath: path, requestBody: ctx.body, error: message,
    });
    incrementUsage(ctx.token.id, 1, 0);
    return reply.code(status).send(buildErrorBody(ingress, status, message));
  }

  const acc: StreamAccumulator = { stopReason: null, text: "", toolCalls: [], upstreamModel: "" };
  const events = tapStream(parseUpstreamStream(result.value.family, result.value.body), acc);
  const outGen = serializeClientStream(ingress, events, { model: ctx.mubName });
  const egress = result.value.family;

  async function* streamAndLog(): AsyncGenerator<string> {
    let streamError: string | null = null;
    try {
      for await (const chunk of outGen) yield chunk;
    } catch (e) {
      streamError = e instanceof Error ? e.message : String(e);
    } finally {
      const usage = acc.usage ?? ZERO_USAGE;
      const responseBody: Record<string, unknown> = {
        streamed: true, role: "assistant", content: acc.text, stop_reason: acc.stopReason, usage,
      };
      if (acc.toolCalls.length) responseBody.tool_calls = acc.toolCalls;
      recordLog({
        token: ctx.token, mub: ctx.mub, mubName: ctx.mubName, ingress, egress, streaming: true,
        httpStatus: streamError ? 499 : 200, usage, latencyMs: Date.now() - ctx.started,
        attempts: path.length, attemptPath: path, requestBody: ctx.body, responseBody, error: streamError,
      });
      incrementUsage(ctx.token.id, 1, usage.totalTokens);
    }
  }

  return sendSse(reply, streamAndLog());
}

/**
 * Streaming for a chain: run the decision tree buffered (routing needs each
 * stage's full output), then emit the final result as a single-shot SSE stream.
 */
async function handleChainStream(
  reply: FastifyReply,
  ingress: Family,
  ir: IRRequest,
  chain: ChainDef,
  ctx: StreamCtx,
): Promise<unknown> {
  const { result, path } = await runMubChain(ir, chain, resolveChainStage, [ctx.mubName]);

  if (!result.ok) {
    const status = result.status >= 400 ? result.status : 502;
    const message = extractUpstreamMessage(result.errorBody) ?? result.message;
    recordLog({
      token: ctx.token, mub: ctx.mub, mubName: ctx.mubName, ingress, egress: null, streaming: true,
      httpStatus: status, latencyMs: Date.now() - ctx.started, attempts: path.length,
      attemptPath: path, requestBody: ctx.body, error: message,
    });
    incrementUsage(ctx.token.id, 1, 0);
    return reply.code(status).send(buildErrorBody(ingress, status, message));
  }

  const respIR = result.value.ir;
  const responseBody: Record<string, unknown> = {
    streamed: true, role: "assistant", content: textOf(respIR.content),
    stop_reason: respIR.stopReason, usage: respIR.usage,
  };
  recordLog({
    token: ctx.token, mub: ctx.mub, mubName: ctx.mubName, ingress, egress: result.value.family,
    streaming: true, httpStatus: 200, usage: respIR.usage, latencyMs: Date.now() - ctx.started,
    attempts: path.length, attemptPath: path, requestBody: ctx.body, responseBody,
  });
  incrementUsage(ctx.token.id, 1, respIR.usage.totalTokens);

  return sendSse(reply, streamFromIRResponse(ingress, respIR, { model: ctx.mubName }));
}

/** GET /v1/models - lists MUBs as the available models. */
function handleListModels(req: FastifyRequest): unknown {
  const isAnthropic = typeof req.headers["anthropic-version"] === "string";
  const mubs = listMubs().filter((m) => m.enabled);
  const created = (m: ModelUseBehavior) =>
    m.createdAt instanceof Date ? m.createdAt.getTime() : Number(m.createdAt);

  if (isAnthropic) {
    return {
      data: mubs.map((m) => ({
        type: "model",
        id: m.name,
        display_name: m.name,
        created_at: new Date(created(m)).toISOString(),
      })),
      has_more: false,
      first_id: mubs[0]?.name ?? null,
      last_id: mubs[mubs.length - 1]?.name ?? null,
    };
  }
  return {
    object: "list",
    data: mubs.map((m) => ({
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
  const mubName = String(body.model ?? "");
  const mub = getMubByName(mubName);
  if (!mub || !mub.enabled) return replyError(reply, "openai", 404, `Model '${mubName}' not found.`);
  if (!tokenAllowsMub(token, mub.id)) {
    return replyError(reply, "openai", 403, `This token is not allowed to use '${mubName}'.`);
  }

  const def = getMubDef(mub);
  if (isChain(def)) {
    return replyError(reply, "openai", 400, "Embeddings are not supported for chain MUBs.");
  }
  const first = def.steps[0];
  const res = resolveMapping(first.model, first.provider);
  if (!res.ok || !res.mapping) {
    return replyError(reply, "openai", 502, `No usable upstream for '${mubName}'.`);
  }
  if (res.mapping.family !== "openai") {
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
    token, mub, mubName, ingress: "openai", egress: "openai", streaming: false, httpStatus: r.status,
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

  app.post("/v1/embeddings", { preHandler: requireClientToken("openai") }, (req, reply) =>
    handleEmbeddings(req, reply),
  );

  const modelsAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const family: Family = req.headers["anthropic-version"] ? "anthropic" : "openai";
    return requireClientToken(family)(req, reply);
  };
  app.get("/v1/models", { preHandler: modelsAuth }, (req) => handleListModels(req));
}
