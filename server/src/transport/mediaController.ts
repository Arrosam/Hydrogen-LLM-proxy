import { tokenAllowsService } from "../auth/authorization";
import { observeDelivery } from "./delivery";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { readBoundedBody, MAX_ERROR_BODY_BYTES } from "../core/upstream/body";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { buildErrorBody, extractUpstreamMessage, failureMessage, failureStatus } from "../core/proxy/errors";
import {
  buildHeaders,
  embeddingsUrl,
  imagesUrl,
  providerEndpoints,
  rerankUrl,
  servesOpenAiMedia,
  speechUrl,
  systemOneUrl,
  transcriptionsUrl,
  videosUrl,
  type UpstreamProvider,
} from "../core/upstream/endpoints";
import { readMultipartField, rewriteMultipartField, upsertMultipartField } from "../core/upstream/multipart";
import { classifyError, runSteps, type AttemptResult, type RunOutput } from "../execution/steps";
import { isAgent, serviceCategory, stepOverrides, type ServiceCategory, type ServiceStep, type ServiceSteps } from "../execution/definition";
import { MEDIA_FAMILIES, type ResolvedTarget } from "../catalog/catalog";
import { requireClientToken } from "../auth/tokenAuth";
import { genId } from "../util/ids";
import type { ModelServiceRow, Token } from "../db/schema";
import { bestEffortLogger, type HttpRequestInfo } from "../observability/requestLogger";
import type { Usage } from "../core/ir/usage";
import type { ProviderRepo } from "../persistence/providerRepo";
import { JsonKeepalive } from "./jsonKeepalive";
import type { ProxyDeps } from "./deps";

/**
 * Client-facing endpoints for the non-chat service categories. Each is a
 * JSON/media passthrough: the request body goes to the provider's matching
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
  classification: "/v1/systemone",
  image: "/v1/images/generations",
  video: "/v1/videos",
  tts: "/v1/audio/speech",
  stt: "/v1/audio/transcriptions",
};

function mediaUrl(category: MediaCategory, p: UpstreamProvider, suffix: "" | "/batch" = ""): string {
  switch (category) {
    case "embedding": return embeddingsUrl(p);
    case "rerank": return rerankUrl(p);
    case "classification": return systemOneUrl(p, suffix);
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

/** Field names safe to frame into a Content-Disposition header verbatim. */
const SAFE_FORM_FIELD = /^[A-Za-z0-9_.-]+$/;

/** A step-override value as a multipart text field: scalars go in plain (a
 * quoted "en" would not be a language), structured values as JSON. */
function formFieldValue(v: unknown): string {
  if (typeof v === "string") return v;
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function httpInfo(req: FastifyRequest, capture: (v: unknown) => string): HttpRequestInfo {
  const [path, query = ""] = req.url.split("?");
  // A multipart upload is already a Buffer; note its size rather than serializing
  // megabytes of binary into the log.
  const body = Buffer.isBuffer(req.body) ? `(multipart ${req.body.length} bytes)` : req.body;
  return { method: req.method, path, query, headers: req.headers as Record<string, unknown>, bodyPayload: capture(body) };
}


/**
 * Video job ids carry an HMAC-authenticated routing suffix bound to the creating
 * token. Polling endpoints find the provider statelessly without trusting any
 * client-supplied routing or sharing a capability across token owners.
 *
 * The suffix names the ENDPOINT too, not just the provider. A provider whose
 * primary is Anthropic can still serve video through a declared OpenAI
 * alternate; encoding only the provider would send the poll and the download to
 * the primary base URL -- a different host from the one holding the job.
 */
function suffixVideoId(id: string, serviceId: number, providerId: number, endpointIndex: number, tokenId: number, key: string): string {
  const route = `${id}-h${serviceId}x${providerId}e${endpointIndex}t${tokenId}`;
  const mac = createHmac("sha256", key).update("hydrogen-video-v1\0" + route).digest("base64url");
  return `${route}s${mac}`;
}

function parseVideoId(id: string, tokenId: number, key: string): { upstreamId: string; serviceId: number; providerId: number; endpointIndex: number } | null {
  const m = /^(.+)-h(\d+)x(\d+)e(\d+)t(\d+)s([A-Za-z0-9_-]{43})$/.exec(id);
  if (!m || Number(m[5]) !== tokenId) return null;
  const route = id.slice(0, -44);
  const expected = createHmac("sha256", key).update("hydrogen-video-v1\0" + route).digest();
  const supplied = Buffer.from(m[6], "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  return { upstreamId: m[1], serviceId: Number(m[2]), providerId: Number(m[3]), endpointIndex: Number(m[4]) };
}

interface MediaHit {
  status: number;
  json: unknown;
  text: string;
  target: ResolvedTarget;
  sentBody: unknown;
}

export class MediaController {
  private readonly videoKey: string;
  constructor(private readonly deps: MediaDeps) {
    this.deps = { ...deps, logger: bestEffortLogger(deps.logger) };
    this.videoKey = deps.videoSigningKey ?? randomBytes(32).toString("base64url");
  }

  private async withWork(req: FastifyRequest, run: () => Promise<unknown>): Promise<unknown> {
    const release = this.deps.requestGate?.acquire();
    const releaseQuota = req.quotaLease?.retain();
    try { return await run(); } finally { release?.(); releaseQuota?.(); }
  }

  register(app: FastifyInstance): void {
    const pre = { preHandler: requireClientToken(this.deps.tokens, "openai_completion") };
    app.post("/v1/embeddings", pre, (req, reply) => this.withWork(req, () => this.handleJson(req, reply, "embedding")));
    app.post("/v1/rerank", pre, (req, reply) => this.withWork(req, () => this.handleJson(req, reply, "rerank")));
    app.post("/v1/systemone", pre, (req, reply) => this.withWork(req, () => this.handleJson(req, reply, "classification")));
    // Laya's optional batched-state extension; not emulated for Jev providers.
    app.post("/v1/systemone/batch", pre, (req, reply) => this.withWork(req, () => this.handleJson(req, reply, "classification", "/batch")));
    app.post("/v1/images/generations", pre, (req, reply) => this.withWork(req, () => this.handleJson(req, reply, "image")));
    app.post("/v1/videos", pre, (req, reply) => this.withWork(req, () => this.handleJson(req, reply, "video")));
    app.post("/v1/audio/speech", pre, (req, reply) => this.withWork(req, () => this.handleSpeech(req, reply)));
    app.post("/v1/audio/transcriptions", pre, (req, reply) => this.withWork(req, () => this.handleTranscription(req, reply)));
    const videoRead = { preHandler: requireClientToken(this.deps.tokens, "openai_completion", false) };
    app.get("/v1/videos/:id", videoRead, (req, reply) => this.handleVideoGet(req, reply, false));
    app.get("/v1/videos/:id/content", videoRead, (req, reply) => this.handleVideoGet(req, reply, true));
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
      // JSON/Bearer passthroughs use the OpenAI endpoint families (including
      // Jev/Laya's non-chat System One wire). Enabled alternates qualify even
      // when the provider's primary is Anthropic.
      const res = this.deps.catalog.resolveWithin(step.model, step.provider, MEDIA_FAMILIES);
      if (!res.ok) {
        const message =
          res.error === "no_endpoint_in_family"
            ? `${category} passthrough requires an OpenAI-compatible endpoint: ${step.model}@${step.provider} has none enabled (add an OpenAI alternate endpoint to the provider and enable it on the mapping)`
            : `mapping ${step.model}@${step.provider}: ${res.error}`;
        return { ok: false, status: 0, kind: "error", message };
      }
      try {
        return await send(step, res.target);
      } catch (e) {
        const c = classifyError(e);
        return { ok: false, status: 0, kind: c.kind, message: c.message };
      }
    }, { signal });
  }

  private recordOnDelivery(reply: FastifyReply, ctx: Parameters<MediaController["record"]>[0], outcome: RunOutput<MediaHit>, status: number, usage: Usage, sent: unknown, body?: unknown): void {
    observeDelivery(reply, (failed, reason) => {
      this.record(ctx, outcome, failed ? 499 : status, usage, sent, body, failed ? reason : undefined);
    }, reason => { this.deps.logger.amendDeliveryFailure(ctx.traceId, reason); });
  }

  private record(
    ctx: { traceId: string; token: Token; service: ModelServiceRow; serviceName: string; http: HttpRequestInfo; started: number },
    outcome: RunOutput<MediaHit>,
    httpStatus: number,
    usage: Usage,
    upstreamRequest: unknown,
    /** What to store as the log's response body. Defaults to a bare success
     * marker, because an embeddings vector or a base64 image is bulk rather
     * than evidence — a category whose body IS the answer passes it. */
    loggedResponse?: unknown,
    deliveryError?: string,
  ): void {
    const ok = outcome.result.ok;
    const target = ok ? (outcome.result as { value: MediaHit }).value.target : null;
    // Charge upstream usage independently of whether evidence can be persisted.
    this.deps.usage.record(ctx.token.id, usage.totalTokens);
    this.deps.logger.record({
      traceId: ctx.traceId, tokenId: ctx.token.id, serviceId: ctx.service.id, requestedService: ctx.serviceName,
      servedModel: target?.modelName ?? null, servedProvider: target?.providerName ?? null,
      ingress: "openai_completion", egress: "openai_completion", streaming: false,
      httpStatus, http: ctx.http,
      upstreamPayload:
        upstreamRequest == null
          ? null
          : this.deps.logger.capture(typeof upstreamRequest === "string" ? { note: upstreamRequest } : upstreamRequest),
      responseBody: ok
        ? (loggedResponse ?? { ok: true })
        : ((outcome.result as { errorBody?: unknown }).errorBody as Record<string, unknown> | undefined) ?? null,
      usage, latencyMs: Date.now() - ctx.started,
      attempts: outcome.path.length, attemptPath: outcome.path,
      error: deliveryError ?? (ok ? null : failureMessage(outcome.result)),
    });
  }

  private abortOnClientClose(reply: FastifyReply): AbortSignal {
    const gone = new AbortController();
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) gone.abort();
    });
    return gone.signal;
  }

  /** JSON-in/JSON-out categories: embedding, rerank, classification, image, video (create). */
  private async handleJson(req: FastifyRequest, reply: FastifyReply, category: MediaCategory, suffix: "" | "/batch" = ""): Promise<unknown> {
    const token = req.clientToken!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const serviceName = String(body.model ?? "");
    const loaded = this.loadService(reply, token, serviceName, category);
    if (!loaded) return reply;
    const { service, def } = loaded;

    const ctx = { traceId: genId("trace"), token, service, serviceName, http: httpInfo(req, (v) => this.deps.logger.capture(v)), started: Date.now() };
    const signal = this.abortOnClientClose(reply);
    let lastSent: unknown = null;

    // Image/video generation can take minutes of silence; heartbeat whitespace
    // so intermediaries (Cloudflare's ~100s 524) don't kill the wait.
    const keepalive = new JsonKeepalive(reply, this.deps.jsonCommitGraceMs ?? 30_000, this.deps.streamPingIntervalMs ?? 10_000);
    const outcome = await this.run(def, category, signal, async (step, target) => {
      const upstreamBody = { ...body, ...stepParams(step), model: target.upstreamModel };
      lastSent = upstreamBody;
      const r = await this.deps.transport.postJson(mediaUrl(category, target.upstream, suffix), buildHeaders(target.upstream), upstreamBody, {
        timeoutMs: def.timeoutMs, signal, proxy: target.upstream.proxy,
      });
      if (r.status >= 200 && r.status < 300) {
        return { ok: true, value: { status: r.status, json: r.json, text: r.text, target, sentBody: upstreamBody } };
      }
      return { ok: false, status: r.status, kind: "http", message: extractUpstreamMessage(r.json) ?? `upstream ${r.status}`, errorBody: r.json ?? r.text };
    });
    keepalive.stop();

    if (!outcome.result.ok) {
      const status = failureStatus(outcome.result);
      this.record(ctx, outcome, status, zeroUsage(), lastSent);
      const errBody = buildErrorBody("openai_completion", status, failureMessage(outcome.result));
      if (keepalive.finish(errBody)) return;
      return reply.code(status).send(errBody);
    }

    const hit = outcome.result.value;
    let json = hit.json as Record<string, unknown> | undefined;
    if (category === "video" && json && typeof json.id === "string") {
      json = { ...json, id: suffixVideoId(json.id, service.id, hit.target.providerId, hit.target.endpointIndex, token.id, this.videoKey) };
    }
    // Typed answers are the result, not bulk data like vectors/base64 images.
    this.recordOnDelivery(reply, ctx, outcome, hit.status, usageFrom(category, json, suffix === "/batch"), hit.sentBody,
      category === "classification" ? json ?? hit.text : undefined);
    if (keepalive.finish(json ?? hit.text)) return;
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

    const ctx = { traceId: genId("trace"), token, service, serviceName, http: httpInfo(req, (v) => this.deps.logger.capture(v)), started: Date.now() };
    const signal = this.abortOnClientClose(reply);
    let lastSent: unknown = null;
    let stream: import("node:stream").Readable | null = null;
    let streamHeaders: Record<string, string | string[] | undefined> = {};

    const outcome = await this.run(def, "tts", signal, async (step, target) => {
      const upstreamBody = { ...body, ...stepParams(step), model: target.upstreamModel };
      lastSent = upstreamBody;
      const r = await this.deps.transport.postStream(speechUrl(target.upstream), buildHeaders(target.upstream), upstreamBody, {
        timeoutMs: def.timeoutMs, signal, proxy: target.upstream.proxy,
      });
      if (r.status >= 200 && r.status < 300) {
        stream = r.body;
        streamHeaders = r.headers;
        return { ok: true, value: { status: r.status, json: undefined, text: "", target, sentBody: upstreamBody } };
      }
      // Drain the error body so the failure carries the upstream message.
      let text = "";
      try { text = await readBoundedBody(r.body, MAX_ERROR_BODY_BYTES, true); }
      catch { /* connection died mid-error; the status is enough */ }
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
    this.recordOnDelivery(reply, ctx, outcome, hit.status, zeroUsage(), hit.sentBody);
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

    const ctx = { traceId: genId("trace"), token, service, serviceName: serviceName!, http: httpInfo(req, (v) => this.deps.logger.capture(v)), started: Date.now() };
    const signal = this.abortOnClientClose(reply);

    // Transcribing a long recording is slow and silent; heartbeat like the
    // other JSON-out categories. (TTS streams binary audio, so it cannot.)
    const keepalive = new JsonKeepalive(reply, this.deps.jsonCommitGraceMs ?? 30_000, this.deps.streamPingIntervalMs ?? 10_000);
    const outcome = await this.run(def, "stt", signal, async (step, target) => {
      // Overrides first, then the model rewrite, so `model` always lands on the
      // mapped upstream name — the precedence the JSON passthrough gets from
      // spreading `model` last. Every attempt re-derives the form from `raw`, so
      // a retry never stacks a second copy of the overrides.
      let form = raw;
      for (const [k, v] of Object.entries(stepParams(step))) {
        if (v == null) continue;
        if (!SAFE_FORM_FIELD.test(k)) {
          return { ok: false, status: 0, kind: "error", message: `step override '${k}' is not a usable form field name` };
        }
        const set = upsertMultipartField(form, contentType, k, formFieldValue(v));
        if (!set) {
          return { ok: false, status: 0, kind: "error", message: `multipart body is not framed well enough to set '${k}'` };
        }
        form = set;
      }
      const rewritten = rewriteMultipartField(form, contentType, "model", target.upstreamModel);
      if (!rewritten) {
        return { ok: false, status: 0, kind: "error", message: "multipart body has no 'model' field to rewrite" };
      }
      const headers = buildHeaders(target.upstream);
      headers["content-type"] = String(contentType);
      const r = await this.deps.transport.postRaw(transcriptionsUrl(target.upstream), headers, rewritten, {
        timeoutMs: def.timeoutMs, signal, proxy: target.upstream.proxy,
      });
      if (r.status >= 200 && r.status < 300) {
        return { ok: true, value: { status: r.status, json: r.json, text: r.text, target, sentBody: `(multipart ${rewritten.length} bytes)` } };
      }
      return { ok: false, status: r.status, kind: "http", message: extractUpstreamMessage(r.json) ?? `upstream ${r.status}`, errorBody: r.json ?? r.text };
    });

    keepalive.stop();
    if (!outcome.result.ok) {
      const status = failureStatus(outcome.result);
      this.record(ctx, outcome, status, zeroUsage(), null);
      const errBody = buildErrorBody("openai_completion", status, failureMessage(outcome.result));
      if (keepalive.finish(errBody)) return;
      return reply.code(status).send(errBody);
    }
    const hit = outcome.result.value;
    // A transcript is one short line: the one media category where `{ ok: true }`
    // hid the only thing the log existed to show.
    this.recordOnDelivery(reply, ctx, outcome, hit.status, zeroUsage(), hit.sentBody, hit.json ?? hit.text);
    if (hit.json !== undefined) {
      if (keepalive.finish(hit.json)) return;
      return reply.code(hit.status).send(hit.json);
    }
    if (keepalive.finish(hit.text)) return;
    return reply.code(hit.status).type("text/plain; charset=utf-8").send(hit.text);
  }

  /** Video poll/download: only an authenticated owner-bound routing capability may select credentials. */
  private async handleVideoGet(req: FastifyRequest, reply: FastifyReply, content: boolean): Promise<unknown> {
    const token = req.clientToken!;
    const id = (req.params as { id: string }).id;
    const parsed = parseVideoId(id, token.id, this.videoKey);
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

    let timeoutMs: number;
    try {
      const def = this.deps.services.def(service);
      if (isAgent(def) || serviceCategory(def) !== "video") return this.replyError(reply, 403, "Video capability does not name a video service");
      const allowed = def.steps.some(step => {
        const resolved = this.deps.catalog.resolveWithin(step.model, step.provider, MEDIA_FAMILIES);
        return resolved.ok && resolved.target.providerId === provider.id && resolved.target.endpointIndex === parsed.endpointIndex;
      });
      if (!allowed) return this.replyError(reply, 403, "Video provider is no longer mapped to its service");
      timeoutMs = def.timeoutMs;
    } catch { return this.replyError(reply, 404, "Invalid video service definition"); }

    // Route back to the endpoint that created the job. Its index was encoded
    // into the id; a provider edited since then can have dropped or retyped
    // that endpoint, and both cases are a clear error rather than a guess --
    // posting a video poll at an Anthropic base URL is exactly what the id
    // suffix exists to prevent.
    const endpoint = providerEndpoints(provider).find((e) => e.index === parsed.endpointIndex);
    if (!endpoint) {
      return this.replyError(reply, 404, "The endpoint that created this video no longer exists on its provider.");
    }
    if (!servesOpenAiMedia(endpoint.type)) {
      return this.replyError(reply, 400, "The endpoint that created this video is no longer OpenAI-compatible.");
    }
    const upstream: UpstreamProvider = {
      ...this.deps.providers.toUpstream(provider),
      type: endpoint.type,
      baseUrl: endpoint.baseUrl,
    };
    const suffix = `/${encodeURIComponent(parsed.upstreamId)}${content ? "/content" : ""}`;
    const url = videosUrl(upstream, suffix);
    const headers = buildHeaders(upstream);

    if (content) {
      const r = await this.deps.transport.getStream(url, headers, { timeoutMs, signal: this.abortOnClientClose(reply), proxy: upstream.proxy });
      const contentType = r.headers["content-type"];
      if (typeof contentType === "string") reply.header("content-type", contentType);
      return reply.code(r.status).send(r.body);
    }
    const r = await this.deps.transport.getJson(url, headers, { timeoutMs, proxy: upstream.proxy });
    let json = r.json as Record<string, unknown> | undefined;
    if (r.status < 400 && json && typeof json.id === "string") {
      json = { ...json, id: suffixVideoId(json.id, service.id, provider.id, endpoint.index, token.id, this.videoKey) };
    }
    return reply.code(r.status).send(json ?? r.text);
  }
}

function zeroUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

/** Jev/Laya use input/output counters; Laya batches expose aggregate total_usage.
 * Missing/invalid upstream counters must never reduce a client's quota. */
function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Embeddings and classification report token usage; other categories have none. */
function usageFrom(category: MediaCategory, json: Record<string, unknown> | undefined, batch = false): Usage {
  if (category === "classification") {
    const raw = batch ? json?.total_usage : json?.usage;
    const u = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const promptTokens = tokenCount(u.input_tokens);
    const completionTokens = tokenCount(u.output_tokens);
    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
  }
  if (category !== "embedding") return zeroUsage();
  const u = (json?.usage ?? {}) as { prompt_tokens?: number; total_tokens?: number };
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: 0,
    totalTokens: u.total_tokens ?? u.prompt_tokens ?? 0,
  };
}
