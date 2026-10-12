import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { buildErrorBody, failureMessage, failureStatus } from "../core/proxy/errors";
import {
  buildHeaders,
  providerEndpoints,
  servesOpenAiMedia,
  speechUrl,
  transcriptionsUrl,
  videosUrl,
  type UpstreamProvider,
} from "../core/upstream/endpoints";
import { readMultipartField, rewriteMultipartField, upsertMultipartField } from "../core/upstream/multipart";
import { classifyError, runSteps, type AttemptResult, type RunOutput } from "../execution/steps";
import { isAgent, serviceCategory, stepOverrides, type ServiceStep, type ServiceSteps } from "../execution/definition";
import { MEDIA_FAMILIES, type ResolvedTarget } from "../catalog/catalog";
import { requireClientToken } from "../auth/tokenAuth";
import { genId, ID_PREFIX } from "../util/ids";
import { HEADER, MIME } from "../util/httpHeaders";
import { HTTP_STATUS, STATUS_UPSTREAM_FAILURE, isErrorStatus, isSuccessStatus } from "../util/httpStatus";
import type { Family } from "../core/format/family";
import type { ModelServiceRow, Token } from "../db/schema";
import type { HttpRequestInfo } from "../observability/requestLogger";
import type { Usage } from "../core/ir/usage";
import type { ProviderRepo } from "../persistence/providerRepo";
import { ZERO_USAGE } from "../core/ir/usage";
import { httpRequestInfo } from "../observability/requestLogger";
import type { AttemptFailure } from "../execution/steps";
import { abortOnClientClose } from "./delivery";
import { JsonKeepalive } from "./jsonKeepalive";
import { ENDPOINT_BY_CATEGORY, formFieldValue, mediaEndpointUrl, multipartNote, parseJsonOrText, resolutionErrorMessage, upstreamFailureMessage, type MediaCategory } from "./passthrough";
import { resolveServiceAccess } from "./serviceAccess";
import type { ProxyDeps } from "./deps";
import { ROUTE } from "./routes";
import { ERR_SERVICE_OUT_OF_SCOPE } from "./errorMessages";
import { errorMessage } from "../util/errors";

/** Every media endpoint speaks the OpenAI wire, to its client and to its upstream. */
const MEDIA_INGRESS: Family = "openai_completion";
const MEDIA_EGRESS: Family = "openai_completion";

/** The multipart field that names the service, rewritten to the upstream model. */
const MODEL_FORM_FIELD = "model";

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

/** Step override params for a passthrough body: the pairs editor's arbitrary
 * keys land in `extra` (chat-only canonical params are ignored here). */
function stepParams(step: ServiceStep): Record<string, unknown> {
  const ov = stepOverrides(step);
  return (ov?.extra as Record<string, unknown> | undefined) ?? {};
}

/** Field names safe to frame into a Content-Disposition header verbatim. */
const SAFE_FORM_FIELD = /^[A-Za-z0-9_.-]+$/;

function httpInfo(req: FastifyRequest, capture: (v: unknown) => string): HttpRequestInfo {
  // A multipart upload is already a Buffer; note its size rather than serializing
  // megabytes of binary into the log.
  return httpRequestInfo(req, capture(Buffer.isBuffer(req.body) ? multipartNote(req.body.length) : req.body));
}

/**
 * Video job ids are returned to the client with a routing suffix so polling
 * endpoints (which carry no model name) can find the provider statelessly.
 *
 * The suffix names the ENDPOINT too, not just the provider. A provider whose
 * primary is Anthropic can still serve video through a declared OpenAI
 * alternate; encoding only the provider would send the poll and the download to
 * the primary base URL -- a different host from the one holding the job.
 */
function suffixVideoId(id: string, serviceId: number, providerId: number, endpointIndex: number): string {
  return `${id}-h${serviceId}x${providerId}e${endpointIndex}`;
}

function parseVideoId(
  id: string,
): { upstreamId: string; serviceId: number; providerId: number; endpointIndex: number } | null {
  // The endpoint group is optional: ids handed out before it existed always
  // came from the primary endpoint, which is index 0.
  const m = /^(.+)-h(\d+)x(\d+)(?:e(\d+))?$/.exec(id);
  if (!m) return null;
  return {
    upstreamId: m[1],
    serviceId: Number(m[2]),
    providerId: Number(m[3]),
    endpointIndex: m[4] != null ? Number(m[4]) : 0,
  };
}

/** What a media handler carries from service resolution to its log row. */
interface MediaCtx {
  traceId: string;
  token: Token;
  service: ModelServiceRow;
  serviceName: string;
  http: HttpRequestInfo;
  started: number;
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
    const pre = { preHandler: requireClientToken(this.deps.tokens, MEDIA_INGRESS) };
    app.post(ROUTE.EMBEDDINGS, pre, (req, reply) => this.handleJson(req, reply, "embedding"));
    app.post(ROUTE.RERANK, pre, (req, reply) => this.handleJson(req, reply, "rerank"));
    app.post(ROUTE.IMAGE_GENERATIONS, pre, (req, reply) => this.handleJson(req, reply, "image"));
    app.post(ROUTE.VIDEOS, pre, (req, reply) => this.handleJson(req, reply, "video"));
    app.post(ROUTE.AUDIO_SPEECH, pre, (req, reply) => this.handleSpeech(req, reply));
    app.post(ROUTE.AUDIO_TRANSCRIPTIONS, pre, (req, reply) => this.handleTranscription(req, reply));
    app.get(`${ROUTE.VIDEOS}/:id`, pre, (req, reply) => this.handleVideoGet(req, reply, false));
    app.get(`${ROUTE.VIDEOS}/:id/content`, pre, (req, reply) => this.handleVideoGet(req, reply, true));
  }

  private replyError(reply: FastifyReply, status: number, message: string): FastifyReply {
    return reply.code(status).send(buildErrorBody(MEDIA_INGRESS, status, message));
  }

  /** Resolve + authorize the target service for a category, or reply an error. */
  private loadService(
    req: FastifyRequest,
    reply: FastifyReply,
    token: Token,
    serviceName: string,
    category: MediaCategory,
  ): { service: ModelServiceRow; def: ServiceSteps } | null {
    if (!serviceName) {
      this.replyError(reply, HTTP_STATUS.BAD_REQUEST, "Missing 'model' (must be a Model Service name).");
      return null;
    }
    const access = resolveServiceAccess(token, this.deps.services.getByName(serviceName), (row) => this.deps.services.def(row));
    // A request refused once its service was named: one log row, no quota spent.
    const refuse = (status: number, logged: string, message: string): null => {
      this.refuse(req, reply, token, "service" in access ? access.service : null, serviceName, status, logged, message);
      return null;
    };
    if (!access.ok) {
      if (access.reason === "unknown") return refuse(HTTP_STATUS.NOT_FOUND, `unknown model '${serviceName}'`, `Model '${serviceName}' not found.`);
      if (access.reason === "forbidden") {
        this.refuseScope(req, reply, token, access.service, serviceName);
        return null;
      }
      return refuse(HTTP_STATUS.INTERNAL_SERVER_ERROR, `invalid Model Service definition: ${errorMessage(access.error)}`, `Model '${serviceName}' has an invalid definition.`);
    }
    const { service, def } = access;
    if (isAgent(def)) {
      return refuse(HTTP_STATUS.BAD_REQUEST, `'${serviceName}' is a Micro Agent`, `'${serviceName}' is a Micro Agent; this endpoint serves ${category} Model Services only.`);
    }
    const actual = serviceCategory(def);
    if (actual !== category) {
      // chat AND ocr services live on the chat endpoints.
      const hint = actual === "chat" || actual === "ocr" ? ROUTE.CHAT_COMPLETIONS : ENDPOINT_BY_CATEGORY[actual as MediaCategory];
      return refuse(HTTP_STATUS.BAD_REQUEST, `'${serviceName}' is a ${actual} service`, `'${serviceName}' is a ${actual} service; call it via ${hint}.`);
    }
    return { service, def };
  }

  /** Refuse a request before any upstream work, leaving one request-log row
   * (as the chat endpoints do) and spending none of the key's quota. */
  private refuse(
    req: FastifyRequest, reply: FastifyReply, token: Token, service: ModelServiceRow | null, requestedService: string,
    status: number, logged: string, message: string,
  ): FastifyReply {
    this.deps.logger.record({ traceId: genId(ID_PREFIX.REQUEST), tokenId: token.id, serviceId: service?.id ?? null, requestedService,
      ingress: MEDIA_INGRESS, streaming: false, httpStatus: status, http: httpInfo(req, value => this.deps.logger.capture(value)), latencyMs: 0, error: logged });
    return this.replyError(reply, status, message);
  }

  /** A key used outside its scope. */
  private refuseScope(req: FastifyRequest, reply: FastifyReply, token: Token, service: ModelServiceRow, shownName: string): FastifyReply {
    return this.refuse(req, reply, token, service, service.name, HTTP_STATUS.FORBIDDEN, ERR_SERVICE_OUT_OF_SCOPE, `This token is not allowed to use '${shownName}'.`);
  }

  /** Start the clock and the log context of a resolved request. */
  private begin(req: FastifyRequest, token: Token, service: ModelServiceRow, serviceName: string): MediaCtx {
    return { traceId: genId(ID_PREFIX.TRACE), token, service, serviceName, http: httpInfo(req, (v) => this.deps.logger.capture(v)), started: Date.now() };
  }

  /** A non-2xx JSON answer from the upstream, as a failed attempt. */
  private httpFailure(r: { status: number; json?: unknown; text: string }): AttemptResult<MediaHit> {
    return { ok: false, status: r.status, kind: "http", message: upstreamFailureMessage(r.status, r.json), errorBody: r.json ?? r.text };
  }

  /** Log a failed run (no usage) and answer its error body: appended to the
   * keep-alive's committed 200, or with the failure's own status. */
  private replyRunFailure(reply: FastifyReply, keepalive: JsonKeepalive, ctx: MediaCtx, outcome: RunOutput<MediaHit>, upstreamRequest: unknown): FastifyReply | undefined {
    const status = failureStatus(outcome.result as AttemptFailure);
    this.record(ctx, outcome, status, ZERO_USAGE, upstreamRequest);
    const errBody = buildErrorBody(MEDIA_INGRESS, status, failureMessage(outcome.result as AttemptFailure));
    if (keepalive.finish(errBody)) return;
    return reply.code(status).send(errBody);
  }

  /** Run the step chain, one passthrough send per attempt. */
  private run(
    def: ServiceSteps,
    category: MediaCategory,
    signal: AbortSignal,
    send: (step: ServiceStep, target: ResolvedTarget) => Promise<AttemptResult<MediaHit>>,
  ): Promise<RunOutput<MediaHit>> {
    return runSteps<MediaHit>(def, async (step) => {
      // Constrained to the OpenAI-shaped endpoints: a provider that also
      // declares one reaches it here even when its primary is Anthropic.
      const res = this.deps.catalog.resolveWithin(step.model, step.provider, MEDIA_FAMILIES);
      if (!res.ok) {
        const message = resolutionErrorMessage(step.model, step.provider, res.error,
          `${category} passthrough requires an OpenAI-compatible endpoint: ${step.model}@${step.provider} has none enabled (add an OpenAI alternate endpoint to the provider and enable it on the mapping)`);
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

  private record(
    ctx: MediaCtx,
    outcome: RunOutput<MediaHit>,
    httpStatus: number,
    usage: Usage,
    upstreamRequest: unknown,
    /** What to store as the log's response body. Defaults to a bare success
     * marker, because an embeddings vector or a base64 image is bulk rather
     * than evidence — a category whose body IS the answer passes it. */
    loggedResponse?: unknown,
  ): void {
    const ok = outcome.result.ok;
    const target = ok ? (outcome.result as { value: MediaHit }).value.target : null;
    this.deps.logger.record({
      traceId: ctx.traceId, tokenId: ctx.token.id, serviceId: ctx.service.id, requestedService: ctx.serviceName,
      servedModel: target?.modelName ?? null, servedProvider: target?.providerName ?? null,
      ingress: MEDIA_INGRESS, egress: MEDIA_EGRESS, streaming: false,
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
      error: ok ? null : failureMessage(outcome.result),
    });
    this.deps.usage.record(ctx.token.id, usage.totalTokens);
  }

  /** JSON-in/JSON-out categories: embedding, rerank, image, video (create). */
  private async handleJson(req: FastifyRequest, reply: FastifyReply, category: MediaCategory): Promise<unknown> {
    const token = req.clientToken!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const serviceName = String(body.model ?? "");
    const loaded = this.loadService(req, reply, token, serviceName, category);
    if (!loaded) return reply;
    const { service, def } = loaded;

    const ctx = this.begin(req, token, service, serviceName);
    const { signal } = abortOnClientClose(reply);
    let lastSent: unknown = null;

    // Image/video generation can take minutes of silence; heartbeat whitespace
    // so intermediaries (Cloudflare's ~100s 524) don't kill the wait.
    const keepalive = JsonKeepalive.forClient(reply, this.deps);
    const outcome = await this.run(def, category, signal, async (step, target) => {
      const upstreamBody = { ...body, ...stepParams(step), model: target.upstreamModel };
      lastSent = upstreamBody;
      const r = await this.deps.transport.postJson(mediaEndpointUrl(category, target.upstream), buildHeaders(target.upstream), upstreamBody, {
        timeoutMs: def.timeoutMs, signal, proxy: target.upstream.proxy,
      });
      if (isSuccessStatus(r.status)) {
        return { ok: true, value: { status: r.status, json: r.json, text: r.text, target, sentBody: upstreamBody } };
      }
      return this.httpFailure(r);
    });
    keepalive.stop();

    if (!outcome.result.ok) return this.replyRunFailure(reply, keepalive, ctx, outcome, lastSent);

    const hit = outcome.result.value;
    let json = hit.json as Record<string, unknown> | undefined;
    if (category === "video" && json && typeof json.id === "string") {
      json = { ...json, id: suffixVideoId(json.id, service.id, hit.target.providerId, hit.target.endpointIndex) };
    }
    this.record(ctx, outcome, hit.status, usageFrom(category, json), hit.sentBody);
    if (keepalive.finish(json ?? hit.text)) return;
    return reply.code(hit.status).send(json ?? hit.text);
  }

  /** TTS: JSON in, binary audio out (streamed through). */
  private async handleSpeech(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const token = req.clientToken!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const serviceName = String(body.model ?? "");
    const loaded = this.loadService(req, reply, token, serviceName, "tts");
    if (!loaded) return reply;
    const { service, def } = loaded;

    const ctx = this.begin(req, token, service, serviceName);
    const { signal } = abortOnClientClose(reply);
    let lastSent: unknown = null;
    let stream: import("node:stream").Readable | null = null;
    let streamHeaders: Record<string, string | string[] | undefined> = {};

    const outcome = await this.run(def, "tts", signal, async (step, target) => {
      const upstreamBody = { ...body, ...stepParams(step), model: target.upstreamModel };
      lastSent = upstreamBody;
      const r = await this.deps.transport.postStream(speechUrl(target.upstream), buildHeaders(target.upstream), upstreamBody, {
        timeoutMs: def.timeoutMs, signal, proxy: target.upstream.proxy,
      });
      if (isSuccessStatus(r.status)) {
        stream = r.body;
        streamHeaders = r.headers;
        return { ok: true, value: { status: r.status, json: undefined, text: "", target, sentBody: upstreamBody } };
      }
      // Drain the error body so the failure carries the upstream message.
      let text = "";
      try {
        for await (const chunk of r.body) text += chunk.toString();
      } catch { /* connection died mid-error; the status is enough */ }
      const errJson = parseJsonOrText(text);
      return { ok: false, status: r.status, kind: "http", message: upstreamFailureMessage(r.status, errJson), errorBody: errJson };
    });

    if (!outcome.result.ok || !stream) {
      const status = outcome.result.ok ? STATUS_UPSTREAM_FAILURE : failureStatus(outcome.result);
      this.record(ctx, outcome, status, ZERO_USAGE, lastSent);
      return this.replyError(reply, status, outcome.result.ok ? "upstream returned no body" : failureMessage(outcome.result));
    }

    const hit = outcome.result.value;
    this.record(ctx, outcome, hit.status, ZERO_USAGE, hit.sentBody);
    const contentType = streamHeaders[HEADER.CONTENT_TYPE];
    if (typeof contentType === "string") reply.header(HEADER.CONTENT_TYPE, contentType);
    return reply.code(hit.status).send(stream);
  }

  /** STT: multipart in (forwarded verbatim, model field rewritten), JSON out. */
  private async handleTranscription(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const token = req.clientToken!;
    const raw = req.body;
    const contentType = req.headers[HEADER.CONTENT_TYPE];
    if (!Buffer.isBuffer(raw)) {
      return this.replyError(reply, HTTP_STATUS.BAD_REQUEST, "Expected a multipart/form-data body.");
    }
    const serviceName = readMultipartField(raw, contentType, MODEL_FORM_FIELD);
    const loaded = this.loadService(req, reply, token, serviceName ?? "", "stt");
    if (!loaded) return reply;
    const { service, def } = loaded;

    const ctx = this.begin(req, token, service, serviceName!);
    const { signal } = abortOnClientClose(reply);

    // Transcribing a long recording is slow and silent; heartbeat like the
    // other JSON-out categories. (TTS streams binary audio, so it cannot.)
    const keepalive = JsonKeepalive.forClient(reply, this.deps);
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
      const rewritten = rewriteMultipartField(form, contentType, MODEL_FORM_FIELD, target.upstreamModel);
      if (!rewritten) {
        return { ok: false, status: 0, kind: "error", message: "multipart body has no 'model' field to rewrite" };
      }
      const headers = buildHeaders(target.upstream);
      headers[HEADER.CONTENT_TYPE] = String(contentType);
      const r = await this.deps.transport.postRaw(transcriptionsUrl(target.upstream), headers, rewritten, {
        timeoutMs: def.timeoutMs, signal, proxy: target.upstream.proxy,
      });
      if (isSuccessStatus(r.status)) {
        return { ok: true, value: { status: r.status, json: r.json, text: r.text, target, sentBody: multipartNote(rewritten.length) } };
      }
      return this.httpFailure(r);
    });

    keepalive.stop();
    if (!outcome.result.ok) return this.replyRunFailure(reply, keepalive, ctx, outcome, null);
    const hit = outcome.result.value;
    // A transcript is one short line: the one media category where `{ ok: true }`
    // hid the only thing the log existed to show.
    this.record(ctx, outcome, hit.status, ZERO_USAGE, hit.sentBody, hit.json ?? hit.text);
    if (hit.json !== undefined) {
      if (keepalive.finish(hit.json)) return;
      return reply.code(hit.status).send(hit.json);
    }
    if (keepalive.finish(hit.text)) return;
    return reply.code(hit.status).type(MIME.TEXT_UTF8).send(hit.text);
  }

  /** Video poll/download: the job id's routing suffix names the provider. */
  private async handleVideoGet(req: FastifyRequest, reply: FastifyReply, content: boolean): Promise<unknown> {
    const token = req.clientToken!;
    const id = (req.params as { id: string }).id;
    const parsed = parseVideoId(id);
    if (!parsed) {
      return this.replyError(reply, HTTP_STATUS.NOT_FOUND, `Unknown video id (expected an id returned by this proxy's POST ${ROUTE.VIDEOS}).`);
    }
    const access = resolveServiceAccess(token, this.deps.services.get(parsed.serviceId), (row) => this.deps.services.def(row));
    if (!access.ok && access.reason === "unknown") return this.replyError(reply, HTTP_STATUS.NOT_FOUND, "The service that created this video no longer exists.");
    if (!access.ok && access.reason === "forbidden") return this.refuseScope(req, reply, token, access.service, access.service.name);
    const service = access.service;
    const provider = this.deps.providers.get(parsed.providerId);
    if (!provider || !provider.enabled) return this.replyError(reply, HTTP_STATUS.NOT_FOUND, "The provider that created this video no longer exists.");

    // The id is client-supplied, so the provider it names is a claim, not a
    // fact: only a provider this service routes video to may be reached with
    // its credentials. Anything else -- another category, a Micro Agent, a
    // definition that no longer parses, a provider no step names -- cannot
    // have created the job through this service.
    const def = access.ok && !isAgent(access.def) && serviceCategory(access.def) === "video" ? access.def : null;
    if (!def || !def.steps.some((step) => step.provider === provider.name)) {
      return this.replyError(reply, HTTP_STATUS.NOT_FOUND, "The service that created this video no longer routes video to that provider.");
    }
    const timeoutMs = def.timeoutMs;

    // Route back to the endpoint that created the job. Its index was encoded
    // into the id; a provider edited since then can have dropped or retyped
    // that endpoint, and both cases are a clear error rather than a guess --
    // posting a video poll at an Anthropic base URL is exactly what the id
    // suffix exists to prevent.
    const endpoint = providerEndpoints(provider).find((e) => e.index === parsed.endpointIndex);
    if (!endpoint) {
      return this.replyError(reply, HTTP_STATUS.NOT_FOUND, "The endpoint that created this video no longer exists on its provider.");
    }
    if (!servesOpenAiMedia(endpoint.type)) {
      return this.replyError(reply, HTTP_STATUS.BAD_REQUEST, "The endpoint that created this video is no longer OpenAI-compatible.");
    }
    const upstream: UpstreamProvider = {
      ...this.deps.providers.toUpstream(provider),
      type: endpoint.type,
      baseUrl: endpoint.baseUrl,
    };
    const suffix = `/${encodeURIComponent(parsed.upstreamId)}${content ? "/content" : ""}`;
    const url = videosUrl(upstream, suffix);
    const headers = buildHeaders(upstream);

    // Both calls stop when the client goes away, like every other media call.
    const { signal } = abortOnClientClose(reply);
    if (content) {
      const r = await this.deps.transport.getStream(url, headers, { timeoutMs, signal, proxy: upstream.proxy });
      const contentType = r.headers[HEADER.CONTENT_TYPE];
      if (typeof contentType === "string") reply.header(HEADER.CONTENT_TYPE, contentType);
      return reply.code(r.status).send(r.body);
    }
    const r = await this.deps.transport.getJson(url, headers, { timeoutMs, signal, proxy: upstream.proxy });
    let json = r.json as Record<string, unknown> | undefined;
    if (!isErrorStatus(r.status) && json && typeof json.id === "string") {
      json = { ...json, id: suffixVideoId(json.id, service.id, provider.id, endpoint.index) };
    }
    return reply.code(r.status).send(json ?? r.text);
  }
}

/** Embeddings report prompt-token usage; the other categories have none. */
function usageFrom(category: MediaCategory, json: Record<string, unknown> | undefined): Usage {
  if (category !== "embedding") return ZERO_USAGE;
  const u = (json?.usage ?? {}) as { prompt_tokens?: number; total_tokens?: number };
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: 0,
    totalTokens: u.total_tokens ?? u.prompt_tokens ?? 0,
  };
}
