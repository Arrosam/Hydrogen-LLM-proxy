import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { buildErrorBody, extractUpstreamMessage, failureMessage, failureStatus } from "../core/proxy/errors";
import { buildHeaders, embeddingsUrl, imagesUrl, rerankUrl, speechUrl, transcriptionsUrl, videosUrl, type UpstreamProvider } from "../core/upstream/endpoints";
import { readMultipartField, rewriteMultipartField } from "../core/upstream/multipart";
import { classifyError, runSteps, type AttemptResult, type RunOutput } from "../execution/steps";
import { isAgent, serviceCategory, stepOverrides, type ServiceCategory, type ServiceStep, type ServiceSteps } from "../execution/definition";
import type { ResolvedTarget } from "../catalog/catalog";
import { requireClientToken } from "../auth/tokenAuth";
import { genId } from "../util/ids";
import type { ModelServiceRow, Token } from "../db/schema";
import type { HttpRequestInfo } from "../observability/requestLogger";
import type { Usage } from "../core/ir/usage";
import type { ProviderRepo } from "../persistence/providerRepo";
import type { ProxyDeps } from "./deps";

/**
 * Client-facing endpoints for the non-chat service categories. Each is an
 * OpenAI-style passthrough: the request body goes to the provider's matching
 * endpoint with `model` swapped to the mapped upstream name (plus any step
 * override parameters), and the step chain's retry/fallback rules apply.
 *
 * These services are deliberately NOT reachable from Micro Agents — the
 * validator and the runtime resolver both reject the reference.
 */
export interface MediaDeps extends ProxyDeps {
  providers: ProviderRepo;
}

type MediaCategory = Exclude<ServiceCategory, "chat" | "ocr">;

const ENDPOINT_BY_CATEGORY: Record<MediaCategory, string> = {
  embedding: "/v1/embeddings",
  rerank: "/v1/rerank",
  image: "/v1/images/generations",
  video: "/v1/videos",
  tts: "/v1/audio/speech",
  stt: "/v1/audio/transcriptions",
};

function mediaUrl(category: MediaCategory, p: UpstreamProvider): string {
  switch (category) {
    case "embedding": return embeddingsUrl(p);
    case "rerank": return rerankUrl(p);
    case "image": return imagesUrl(p);
    case "video": return videosUrl(p);
    case "tts": return speechUrl(p);
    case "stt": return transcriptionsUrl(p);
  }
}

/** Step override params for a passthrough body: the pairs editor's arbitrary
 * keys land in `extra` (chat-only canonical params are ignored here). */
function stepParams(step: ServiceStep): Record<string, unknown> {
  const ov = stepOverrides(step);
  return (ov?.extra as Record<string, unknown> | undefined) ?? {};
}

function httpInfo(req: FastifyRequest): HttpRequestInfo {
  const [path, query = ""] = req.url.split("?");
  const body = Buffer.isBuffer(req.body) ? `(multipart ${req.body.length} bytes)` : req.body;
  return { method: req.method, path, query, headers: req.headers as Record<string, unknown>, body };
}

function tokenAllowsService(token: Token, serviceId: number): boolean {
  const scope = token.scopeServices;
  if (!Array.isArray(scope) || scope.length === 0) return true;
  return scope.includes(serviceId);
}

/** Video job ids are returned to the client with a routing suffix so polling
 * endpoints (which carry no model name) can find the provider statelessly. */
function suffixVideoId(id: string, serviceId: number, providerId: number): string {
  return `${id}-h${serviceId}x${providerId}`;
}

function parseVideoId(id: string): { upstreamId: string; serviceId: number; providerId: number } | null {
  const m = /^(.+)-h(\d+)x(\d+)$/.exec(id);
  if (!m) return null;
  return { upstreamId: m[1], serviceId: Number(m[2]), providerId: Number(m[3]) };
}

interface MediaHit {
  status: number;
  json: unknown;
  text: string;
  target: ResolvedTarget;
  sentBody: unknown;
}

export class MediaController {
  constructor(private readonly deps: MediaDeps) {}

  register(app: FastifyInstance): void {
    const pre = { preHandler: requireClientToken(this.deps.tokens, "openai_completion") };
    app.post("/v1/embeddings", pre, (req, reply) => this.handleJson(req, reply, "embedding"));
    app.post("/v1/rerank", pre, (req, reply) => this.handleJson(req, reply, "rerank"));
    app.post("/v1/images/generations", pre, (req, reply) => this.handleJson(req, reply, "image"));
    app.post("/v1/videos", pre, (req, reply) => this.handleJson(req, reply, "video"));
    app.post("/v1/audio/speech", pre, (req, reply) => this.handleSpeech(req, reply));
    app.post("/v1/audio/transcriptions", pre, (req, reply) => this.handleTranscription(req, reply));
    app.get("/v1/videos/:id", pre, (req, reply) => this.handleVideoGet(req, reply, false));
    app.get("/v1/videos/:id/content", pre, (req, reply) => this.handleVideoGet(req, reply, true));
  }

  private replyError(reply: FastifyReply, status: number, message: string): FastifyReply {
    return reply.code(status).send(buildErrorBody("openai_completion", status, message));
  }

  /** Resolve + authorize the target service for a category, or reply an error. */
  private loadService(
    reply: FastifyReply,
    token: Token,
    serviceName: string,
    category: MediaCategory,
  ): { service: ModelServiceRow; def: ServiceSteps } | null {
    if (!serviceName) {
      this.replyError(reply, 400, "Missing 'model' (must be a Model Service name).");
      return null;
    }
    const service = this.deps.services.getByName(serviceName);
    if (!service || !service.enabled) {
      this.replyError(reply, 404, `Model '${serviceName}' not found.`);
      return null;
    }
    if (!tokenAllowsService(token, service.id)) {
      this.replyError(reply, 403, `This token is not allowed to use '${serviceName}'.`);
      return null;
    }
    let def;
    try {
      def = this.deps.services.def(service);
    } catch {
      this.replyError(reply, 500, `Model '${serviceName}' has an invalid definition.`);
      return null;
    }
    if (isAgent(def)) {
      this.replyError(reply, 400, `'${serviceName}' is a Micro Agent; this endpoint serves ${category} Model Services only.`);
      return null;
    }
    const actual = serviceCategory(def);
    if (actual !== category) {
      // chat AND ocr services live on the chat endpoints.
      const hint = actual === "chat" || actual === "ocr" ? "/v1/chat/completions" : ENDPOINT_BY_CATEGORY[actual as MediaCategory];
      this.replyError(reply, 400, `'${serviceName}' is a ${actual} service; call it via ${hint}.`);
      return null;
    }
    return { service, def };
  }

  /** Run the step chain, one passthrough send per attempt. */
  private run(
    def: ServiceSteps,
    category: MediaCategory,
    signal: AbortSignal,
    send: (step: ServiceStep, target: ResolvedTarget) => Promise<AttemptResult<MediaHit>>,
  ): Promise<RunOutput<MediaHit>> {
    return runSteps<MediaHit>(def, async (step) => {
      const res = this.deps.catalog.resolve(step.model, step.provider);
      if (!res.ok) {
        return { ok: false, status: 0, kind: "error", message: `mapping ${step.model}@${step.provider}: ${res.error}` };
      }
      if (res.target.family === "anthropic") {
        return { ok: false, status: 0, kind: "error", message: `${category} passthrough requires an OpenAI-compatible provider (got Anthropic '${step.provider}')` };
      }
      try {
        return await send(step, res.target);
      } catch (e) {
        const c = classifyError(e);
        return { ok: false, status: 0, kind: c.kind, message: c.message };
      }
    }, { signal });
  }

  private record(
    ctx: { traceId: string; token: Token; service: ModelServiceRow; serviceName: string; http: HttpRequestInfo; started: number },
    outcome: RunOutput<MediaHit>,
    httpStatus: number,
    usage: Usage,
    upstreamRequest: unknown,
  ): void {
    const ok = outcome.result.ok;
    const target = ok ? (outcome.result as { value: MediaHit }).value.target : null;
    this.deps.logger.record({
      traceId: ctx.traceId, tokenId: ctx.token.id, serviceId: ctx.service.id, requestedService: ctx.serviceName,
      servedModel: target?.modelName ?? null, servedProvider: target?.providerName ?? null,
      ingress: "openai_completion", egress: "openai_completion", streaming: false,
      httpStatus, http: ctx.http,
      upstreamRequest: typeof upstreamRequest === "string" ? { note: upstreamRequest } : (upstreamRequest as Record<string, unknown> | null),
      responseBody: ok ? { ok: true } : ((outcome.result as { errorBody?: unknown }).errorBody as Record<string, unknown> | undefined) ?? null,
      usage, latencyMs: Date.now() - ctx.started,
      attempts: outcome.path.length, attemptPath: outcome.path,
      error: ok ? null : failureMessage(outcome.result),
    });
    this.deps.usage.record(ctx.token.id, usage.totalTokens);
  }

  private abortOnClientClose(reply: FastifyReply): AbortSignal {
    const gone = new AbortController();
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) gone.abort();
    });
    return gone.signal;
  }

  /** JSON-in/JSON-out categories: embedding, rerank, image, video (create). */
  private async handleJson(req: FastifyRequest, reply: FastifyReply, category: MediaCategory): Promise<unknown> {
    const token = req.clientToken!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const serviceName = String(body.model ?? "");
    const loaded = this.loadService(reply, token, serviceName, category);
    if (!loaded) return reply;
    const { service, def } = loaded;

    const ctx = { traceId: genId("trace"), token, service, serviceName, http: httpInfo(req), started: Date.now() };
    const signal = this.abortOnClientClose(reply);
    let lastSent: unknown = null;

    const outcome = await this.run(def, category, signal, async (step, target) => {
      const upstreamBody = { ...body, ...stepParams(step), model: target.upstreamModel };
      lastSent = upstreamBody;
      const r = await this.deps.transport.postJson(mediaUrl(category, target.upstream), buildHeaders(target.upstream), upstreamBody, {
        timeoutMs: def.timeoutMs, signal,
      });
      if (r.status >= 200 && r.status < 300) {
        return { ok: true, value: { status: r.status, json: r.json, text: r.text, target, sentBody: upstreamBody } };
      }
      return { ok: false, status: r.status, kind: "http", message: extractUpstreamMessage(r.json) ?? `upstream ${r.status}`, errorBody: r.json ?? r.text };
    });

    if (!outcome.result.ok) {
      const status = failureStatus(outcome.result);
      this.record(ctx, outcome, status, zeroUsage(), lastSent);
      return this.replyError(reply, status, failureMessage(outcome.result));
    }

    const hit = outcome.result.value;
    let json = hit.json as Record<string, unknown> | undefined;
    if (category === "video" && json && typeof json.id === "string") {
      json = { ...json, id: suffixVideoId(json.id, service.id, hit.target.providerId) };
    }
    this.record(ctx, outcome, hit.status, usageFrom(category, json), hit.sentBody);
    return reply.code(hit.status).send(json ?? hit.text);
  }

  /** TTS: JSON in, binary audio out (streamed through). */
  private async handleSpeech(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const token = req.clientToken!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const serviceName = String(body.model ?? "");
    const loaded = this.loadService(reply, token, serviceName, "tts");
    if (!loaded) return reply;
    const { service, def } = loaded;

    const ctx = { traceId: genId("trace"), token, service, serviceName, http: httpInfo(req), started: Date.now() };
    const signal = this.abortOnClientClose(reply);
    let lastSent: unknown = null;
    let stream: import("node:stream").Readable | null = null;
    let streamHeaders: Record<string, string | string[] | undefined> = {};

    const outcome = await this.run(def, "tts", signal, async (step, target) => {
      const upstreamBody = { ...body, ...stepParams(step), model: target.upstreamModel };
      lastSent = upstreamBody;
      const r = await this.deps.transport.postStream(speechUrl(target.upstream), buildHeaders(target.upstream), upstreamBody, {
        timeoutMs: def.timeoutMs, signal,
      });
      if (r.status >= 200 && r.status < 300) {
        stream = r.body;
        streamHeaders = r.headers;
        return { ok: true, value: { status: r.status, json: undefined, text: "", target, sentBody: upstreamBody } };
      }
      // Drain the error body so the failure carries the upstream message.
      let text = "";
      try {
        for await (const chunk of r.body) text += chunk.toString();
      } catch { /* connection died mid-error; the status is enough */ }
      let errJson: unknown;
      try { errJson = text ? JSON.parse(text) : undefined; } catch { errJson = text; }
      return { ok: false, status: r.status, kind: "http", message: extractUpstreamMessage(errJson) ?? `upstream ${r.status}`, errorBody: errJson };
    });

    if (!outcome.result.ok || !stream) {
      const status = outcome.result.ok ? 502 : failureStatus(outcome.result);
      this.record(ctx, outcome, status, zeroUsage(), lastSent);
      return this.replyError(reply, status, outcome.result.ok ? "upstream returned no body" : failureMessage(outcome.result));
    }

    const hit = outcome.result.value;
    this.record(ctx, outcome, hit.status, zeroUsage(), hit.sentBody);
    const contentType = streamHeaders["content-type"];
    if (typeof contentType === "string") reply.header("content-type", contentType);
    return reply.code(hit.status).send(stream);
  }

  /** STT: multipart in (forwarded verbatim, model field rewritten), JSON out. */
  private async handleTranscription(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const token = req.clientToken!;
    const raw = req.body;
    const contentType = req.headers["content-type"];
    if (!Buffer.isBuffer(raw)) {
      return this.replyError(reply, 400, "Expected a multipart/form-data body.");
    }
    const serviceName = readMultipartField(raw, contentType, "model");
    const loaded = this.loadService(reply, token, serviceName ?? "", "stt");
    if (!loaded) return reply;
    const { service, def } = loaded;

    const ctx = { traceId: genId("trace"), token, service, serviceName: serviceName!, http: httpInfo(req), started: Date.now() };
    const signal = this.abortOnClientClose(reply);

    const outcome = await this.run(def, "stt", signal, async (_step, target) => {
      const rewritten = rewriteMultipartField(raw, contentType, "model", target.upstreamModel);
      if (!rewritten) {
        return { ok: false, status: 0, kind: "error", message: "multipart body has no 'model' field to rewrite" };
      }
      const headers = buildHeaders(target.upstream);
      headers["content-type"] = String(contentType);
      const r = await this.deps.transport.postRaw(transcriptionsUrl(target.upstream), headers, rewritten, {
        timeoutMs: def.timeoutMs, signal,
      });
      if (r.status >= 200 && r.status < 300) {
        return { ok: true, value: { status: r.status, json: r.json, text: r.text, target, sentBody: `(multipart ${rewritten.length} bytes)` } };
      }
      return { ok: false, status: r.status, kind: "http", message: extractUpstreamMessage(r.json) ?? `upstream ${r.status}`, errorBody: r.json ?? r.text };
    });

    if (!outcome.result.ok) {
      const status = failureStatus(outcome.result);
      this.record(ctx, outcome, status, zeroUsage(), null);
      return this.replyError(reply, status, failureMessage(outcome.result));
    }
    const hit = outcome.result.value;
    this.record(ctx, outcome, hit.status, zeroUsage(), hit.sentBody);
    if (hit.json !== undefined) return reply.code(hit.status).send(hit.json);
    return reply.code(hit.status).type("text/plain; charset=utf-8").send(hit.text);
  }

  /** Video poll/download: the job id's routing suffix names the provider. */
  private async handleVideoGet(req: FastifyRequest, reply: FastifyReply, content: boolean): Promise<unknown> {
    const token = req.clientToken!;
    const id = (req.params as { id: string }).id;
    const parsed = parseVideoId(id);
    if (!parsed) {
      return this.replyError(reply, 404, "Unknown video id (expected an id returned by this proxy's POST /v1/videos).");
    }
    const service = this.deps.services.get(parsed.serviceId);
    if (!service || !service.enabled) return this.replyError(reply, 404, "The service that created this video no longer exists.");
    if (!tokenAllowsService(token, service.id)) {
      return this.replyError(reply, 403, `This token is not allowed to use '${service.name}'.`);
    }
    const provider = this.deps.providers.get(parsed.providerId);
    if (!provider || !provider.enabled) return this.replyError(reply, 404, "The provider that created this video no longer exists.");

    let timeoutMs = 60_000;
    try {
      const def = this.deps.services.def(service);
      if (!isAgent(def)) timeoutMs = def.timeoutMs;
    } catch { /* keep the default */ }

    const upstream = this.deps.providers.toUpstream(provider);
    const suffix = `/${encodeURIComponent(parsed.upstreamId)}${content ? "/content" : ""}`;
    const url = videosUrl(upstream, suffix);
    const headers = buildHeaders(upstream);

    if (content) {
      const r = await this.deps.transport.getStream(url, headers, { timeoutMs, signal: this.abortOnClientClose(reply) });
      const contentType = r.headers["content-type"];
      if (typeof contentType === "string") reply.header("content-type", contentType);
      return reply.code(r.status).send(r.body);
    }
    const r = await this.deps.transport.getJson(url, headers, { timeoutMs });
    let json = r.json as Record<string, unknown> | undefined;
    if (r.status < 400 && json && typeof json.id === "string") {
      json = { ...json, id: suffixVideoId(json.id, service.id, provider.id) };
    }
    return reply.code(r.status).send(json ?? r.text);
  }
}

function zeroUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

/** Embeddings report prompt-token usage; the other categories have none. */
function usageFrom(category: MediaCategory, json: Record<string, unknown> | undefined): Usage {
  if (category !== "embedding") return zeroUsage();
  const u = (json?.usage ?? {}) as { prompt_tokens?: number; total_tokens?: number };
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: 0,
    totalTokens: u.total_tokens ?? u.prompt_tokens ?? 0,
  };
}
