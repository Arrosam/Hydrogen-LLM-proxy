import { FAMILIES } from "../../core/ir/params";
import type { FastifyInstance, FastifyReply } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import type { Container } from "../../composition/container";
import { buildRequest, parseRequest, serializeStream } from "../../core/format/registry";
import type { Family } from "../../core/format/family";
import { MEDIA_FAMILIES, type ResolvedTarget } from "../../catalog/catalog";
import { buildHeaders } from "../../core/upstream/endpoints";
import { extractUpstreamMessage, failureMessage, failureStatus } from "../../core/proxy/errors";
import {
  isAgent,
  isChatPipeline,
  parseService,
  serviceCategory,
  serviceThinkingFormat,
  ServiceCategorySchema,
  type ServiceCategory,
  type ServiceDef,
  serviceThinkingDelimiters,
  SERVICE_KIND,
} from "../../execution/definition";
import { withThinkingFormat, type ThinkingDelimiters, type ThinkingFormat } from "../../core/ir/thinkingFormat";
import { classifyError, ERROR_BODY_MAX_CHARS, type AttemptFailure, type AttemptRecord, type AttemptResult } from "../../execution/steps";
import type { Request as CanonicalRequest } from "../../core/ir/request";
import type { StreamEvent } from "../../core/ir/stream";
import type { Usage } from "../../core/ir/usage";
import type { ModelService } from "../../execution/modelService";
import { newAccumulator, tapStream } from "../../core/ir/stream";
import { serializeForLog } from "../../util/logPayload";
import { HEADER, MIME } from "../../util/httpHeaders";
import { HTTP_STATUS, isSuccessStatus } from "../../util/httpStatus";
import { withJsonHeartbeat } from "../jsonKeepalive";
import { openSse } from "../keepalive";
import { formFieldValue, mediaEndpointUrl, parseJsonOrText, resolutionErrorMessage, upstreamFailureMessage } from "../passthrough";
import { ERR_MODEL_SERVICE_NOT_FOUND } from "../errorMessages";
import { badRequest, parseBody } from "./replies";
import { PositiveIntSchema } from "../../util/validate";

/**
 * Model Bench: fire one request at one model and show exactly what came back.
 *
 * This is the INTERNAL half of the bench. The other half runs in the browser,
 * which posts to Hydrogen's own /v1/* endpoints with a real client token -- so
 * "what a client sees" needs no server code at all and lands in the request log
 * like any other call.
 *
 * What this half adds is the view a client cannot have: the exact body that
 * went upstream, the attempt path, and the ability to address a raw
 * (model, provider, endpoint) tuple that no Model Service wraps -- the proxy
 * surface only accepts saved service names, by design, so a mapping cannot be
 * probed there at all.
 *
 * Deliberately NOT logged and NOT metered. A bench run is diagnosis, not
 * traffic: mixing probes into the request log would corrupt the numbers the
 * dashboard draws, and the proxy transport is right there for anyone who wants
 * the run recorded.
 *
 * A raw target makes exactly ONE attempt. Retries and fallback are a Model
 * Service's job and they are what a bench is trying to see past: a chain that
 * silently succeeds on step 3 answers "does the service work", not "does this
 * model work".
 */

const BENCH_TIMEOUT_MIN_MS = 1_000;
const BENCH_TIMEOUT_MAX_MS = 3_600_000;
/** Upstream timeout of a raw-target or media run that names none. */
const BENCH_DEFAULT_TIMEOUT_MS = 300_000;
/** Heartbeat interval of a buffered bench run; fixed, not the operator's ping setting. */
const BENCH_PING_INTERVAL_MS = 10_000;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_MEDIA_TYPE_LENGTH = 120;
const MULTIPART_BOUNDARY_RANDOM_BYTES = 12;

const FamilySchema = z.enum(FAMILIES);

const TargetSchema = z.discriminatedUnion("kind", [
  /** A saved Model Service or Micro Agent, run exactly as production runs it. */
  z.object({ kind: z.literal("service"), serviceId: PositiveIntSchema }),
  /**
   * One mapping, addressed directly. `providerFormat` picks WHICH of the
   * provider's endpoints to speak to, which is the whole point of naming it
   * separately from the wire the bench itself speaks: openai-in/anthropic-out
   * is a translation path worth being able to aim at on purpose.
   */
  z.object({
    kind: z.literal("raw"),
    model: z.string().min(1),
    provider: z.string().min(1),
    providerFormat: FamilySchema,
  }),
]);

const ChatSchema = z.object({
  target: TargetSchema,
  /** The wire the bench speaks: `body` is parsed as this, and the answer is
   * rendered back into it. */
  ingress: FamilySchema,
  body: z.record(z.unknown()),
  timeoutMs: z.number().int().min(BENCH_TIMEOUT_MIN_MS).max(BENCH_TIMEOUT_MAX_MS).optional(),
});

const MediaSchema = z.object({
  target: TargetSchema,
  category: ServiceCategorySchema,
  body: z.record(z.unknown()),
  /** For `stt`: the recording to transcribe, as base64. Assembled into a
   * multipart form here so the bench page can post plain JSON. */
  file: z
    .object({
      name: z.string().min(1).max(MAX_FILE_NAME_LENGTH),
      mediaType: z.string().min(1).max(MAX_MEDIA_TYPE_LENGTH),
      data: z.string().min(1),
    })
    .optional(),
  timeoutMs: z.number().int().min(BENCH_TIMEOUT_MIN_MS).max(BENCH_TIMEOUT_MAX_MS).optional(),
});

type Target = z.infer<typeof TargetSchema>;

/** What the bench reports about where a run actually landed. */
interface Served {
  model: string;
  provider: string;
  family: Family;
  upstreamModel: string;
  url: string;
}

function served(t: ResolvedTarget, url: string): Served {
  return { model: t.modelName, provider: t.providerName, family: t.family, upstreamModel: t.upstreamModel, url };
}

/** Where a saved service's own executor landed. It reports no URL. */
function servedByService(v: { modelName: string; providerName: string; family: Family; upstreamModel: string }): Served {
  return { model: v.modelName, provider: v.providerName, family: v.family, upstreamModel: v.upstreamModel, url: "" };
}

/** A saved service row, parsed, or a reply-shaped error. */
function loadService(
  c: Container,
  id: number,
): { ok: true; def: ServiceDef; name: string } | { ok: false; status: number; message: string } {
  const row = c.services.get(id);
  if (!row) return { ok: false, status: HTTP_STATUS.NOT_FOUND, message: ERR_MODEL_SERVICE_NOT_FOUND };
  try {
    return { ok: true, def: parseService(row.definition), name: row.name };
  } catch {
    return { ok: false, status: HTTP_STATUS.BAD_REQUEST, message: `"${row.name}" has an invalid definition` };
  }
}

export async function benchRoutes(app: FastifyInstance, c: Container): Promise<void> {
  /**
   * Everything the target picker offers, in one call: the saved services with
   * their category and kind, and every enabled mapping with the endpoint
   * families it can actually reach. The families come from the provider's own
   * endpoint list narrowed by the mapping, so the picker cannot offer a
   * combination that would resolve to nothing.
   */
  app.get("/targets", async () => {
    const services = c.services.list().map((row) => {
      let category: ServiceCategory = "chat";
      let kind: "model_service" | "micro_agent" = SERVICE_KIND.MODEL_SERVICE;
      let valid = true;
      try {
        const def = parseService(row.definition);
        category = serviceCategory(def);
        kind = isAgent(def) ? SERVICE_KIND.MICRO_AGENT : SERVICE_KIND.MODEL_SERVICE;
      } catch {
        valid = false;
      }
      return { id: row.id, name: row.name, enabled: row.enabled, category, kind, valid };
    });

    const providers = c.providers.list();
    const models = c.models.list();
    const byId = new Map(providers.map((p) => [p.id, p]));
    const modelById = new Map(models.map((m) => [m.id, m]));

    const mappings = c.mappings.list().map((m) => {
      const provider = byId.get(m.providerId);
      const model = modelById.get(m.modelId);
      // Which endpoints this mapping may use, in the catalog's own order.
      const families: Family[] = [];
      if (provider) {
        const enabled = m.families && m.families.length ? m.families : [provider.type];
        const all: Family[] = [provider.type, ...(provider.altEndpoints ?? []).map((e) => e.type)];
        for (const f of all) if (enabled.includes(f) && !families.includes(f)) families.push(f);
        if (!families.length) families.push(provider.type);
      }
      return {
        modelId: m.modelId,
        model: model?.name ?? "",
        providerId: m.providerId,
        provider: provider?.name ?? "",
        upstreamModel: m.upstreamModel,
        families,
        enabled: m.enabled && (model?.enabled ?? false) && (provider?.enabled ?? false),
      };
    });

    return { services, mappings };
  });

  // --- chat pipeline -------------------------------------------------------

  app.post("/chat", async (req, reply) => {
    const data = parseBody(ChatSchema, req, reply);
    if (!data) return reply;
    const { target, ingress, body, timeoutMs } = data;

    let request: CanonicalRequest;
    try {
      request = parseRequest(ingress, body);
    } catch (e) {
      return badRequest(reply, `body is not a valid ${ingress} request: ${(e as Error).message}`);
    }
    const streaming = request.stream;

    // The service name a client would have sent. Echoed back as the response's
    // `model` so the rendered body looks like the one a client would receive.
    let label = "(bench)";
    // A saved service shapes its client's thinking the way it always does, so
    // the bench shows the real answer rather than a canonical one. A raw tuple
    // belongs to no service and therefore has no format to apply.
    let thinkingFormat: ThinkingFormat = "original";
    let thinkingDelimiters: ThinkingDelimiters | undefined;
    if (target.kind === "service") {
      const loaded = loadService(c, target.serviceId);
      if (!loaded.ok) return reply.code(loaded.status).send({ error: loaded.message });
      if (!isChatPipeline(serviceCategory(loaded.def))) {
        return badRequest(reply, `"${loaded.name}" is a ${serviceCategory(loaded.def)} service; bench it from the media panel`);
      }
      label = loaded.name;
      thinkingFormat = serviceThinkingFormat(loaded.def);
      thinkingDelimiters = serviceThinkingDelimiters(loaded.def);
    } else {
      label = `${target.model}@${target.provider}`;
    }

    if (streaming) return runChatStream(c, reply, target, ingress, request, label, thinkingFormat, thinkingDelimiters, timeoutMs);

    // A slow chain can outlive an intermediary's idle timeout (Cloudflare 524s
    // a silent origin at ~100s); failures travel in-body, so committing 200
    // early to heartbeat costs nothing semantically.
    return withJsonHeartbeat(reply, c.config.jsonCommitGraceMs, BENCH_PING_INTERVAL_MS, async () => {
      const started = Date.now();
      const run = await runChat(c, target, request, timeoutMs);
      const latencyMs = Date.now() - started;
      if (!run.result.ok) {
        return {
          ok: false,
          status: failureStatus(run.result),
          message: failureMessage(run.result),
          latencyMs,
          attemptPath: run.attemptPath,
          upstreamRequest: run.upstreamRequest ?? null,
        };
      }
      const v = run.result.value;
      return {
        ok: true,
        status: HTTP_STATUS.OK,
        latencyMs,
        served: v.served,
        upstreamRequest: v.upstreamRequest,
        response: v.response.withThinkingFormat(thinkingFormat, thinkingDelimiters).render(ingress, label, { thinkingFormat }),
        thinkingFormat,
        usage: v.response.usage,
        attemptPath: run.attemptPath,
      };
    });
  });

  // --- media passthrough ---------------------------------------------------

  app.post("/media", async (req, reply) => {
    const data = parseBody(MediaSchema, req, reply);
    if (!data) return reply;
    const { target, category, body, file, timeoutMs } = data;
    if (isChatPipeline(category)) {
      return badRequest(reply, `"${category}" is a chat-pipeline category; bench it from the chat panel`);
    }
    if (category === "stt" && !file) {
      return badRequest(reply, "speech-to-text needs an audio file");
    }

    let steps: { model: string; provider: string; providerFormat?: Family } | null = null;
    if (target.kind === "service") {
      const loaded = loadService(c, target.serviceId);
      if (!loaded.ok) return reply.code(loaded.status).send({ error: loaded.message });
      if (isAgent(loaded.def)) {
        return badRequest(reply, `"${loaded.name}" is a Micro Agent; it has no media endpoint`);
      }
      const actual = serviceCategory(loaded.def);
      if (actual !== category) {
        return badRequest(reply, `"${loaded.name}" is a ${actual} service, not ${category}`);
      }
      // One shot at the first step: see the note at the top of this file.
      const first = loaded.def.steps[0];
      steps = { model: first.model, provider: first.provider };
    } else {
      steps = { model: target.model, provider: target.provider, providerFormat: target.providerFormat };
    }

    // Every media route is OpenAI-shaped; an Anthropic endpoint serves none of
    // them. A chosen provider format is therefore INTERSECTED with the media
    // set rather than used as-is -- picking "anthropic" here would otherwise
    // resolve happily and then POST an embeddings body at an Anthropic base
    // URL, which fails as a 404 from somewhere the operator never aimed at.
    if (steps.providerFormat && !MEDIA_FAMILIES.includes(steps.providerFormat)) {
      return badRequest(reply, `${category} is an OpenAI-shaped endpoint; a ${steps.providerFormat} endpoint does not serve it`);
    }
    const allowed = steps.providerFormat ? [steps.providerFormat] : MEDIA_FAMILIES;
    const res = c.catalog.resolveWithin(steps.model, steps.provider, allowed);
    if (!res.ok) {
      return badRequest(reply, resolutionErrorMessage(steps.model, steps.provider, res.error,
        `${steps.model}@${steps.provider} has no ${steps.providerFormat ?? "OpenAI-compatible"} endpoint enabled for ${category}`));
    }
    const t = res.target;
    const url = mediaEndpointUrl(category, t.upstream);
    const timeout = timeoutMs ?? BENCH_DEFAULT_TIMEOUT_MS;

    return withJsonHeartbeat(reply, c.config.jsonCommitGraceMs, BENCH_PING_INTERVAL_MS, async () => {
      const started = Date.now();
      try {
        if (category === "stt") return await runTranscription(c, t, url, body, file!, timeout, started);
        if (category === "tts") return await runSpeech(c, t, url, body, timeout, started);

        const upstreamRequest = { ...body, model: t.upstreamModel };
        const r = await c.transport.postJson(url, buildHeaders(t.upstream), upstreamRequest, { timeoutMs: timeout, proxy: t.upstream.proxy });
        const latencyMs = Date.now() - started;
        if (isSuccessStatus(r.status)) {
          return { ok: true, status: r.status, latencyMs, served: served(t, url), upstreamRequest, response: r.json ?? r.text };
        }
        return {
          ok: false,
          status: r.status,
          latencyMs,
          message: upstreamFailureMessage(r.status, r.json ?? r.text),
          served: served(t, url),
          upstreamRequest,
          response: r.json ?? r.text,
        };
      } catch (e) {
        const cls = classifyError(e);
        return { ok: false, status: 0, latencyMs: Date.now() - started, message: cls.message, served: served(t, url) };
      }
    });
  });
}

// --- chat execution ---------------------------------------------------------

interface ChatValue {
  response: import("../../core/ir/response").Response;
  served: Served;
  upstreamRequest: Record<string, unknown>;
}

interface ChatRun {
  result: AttemptResult<ChatValue>;
  attemptPath: unknown;
  upstreamRequest?: Record<string, unknown>;
}

/** A saved service's executor, exactly as production builds it. The route has
 * already loaded the row. */
function serviceExecutor(c: Container, serviceId: number): ModelService {
  return c.factory.forRow(c.services.get(serviceId)!).executor;
}

/** A saved service keeps its own timeout unless the bench names one. */
function serviceOptions(timeoutMs: number | undefined): { timeoutMs?: number } {
  return timeoutMs ? { timeoutMs } : {};
}

/** Resolve a raw tuple to the one endpoint it names. `advice` is appended to
 * the missing-endpoint message (the buffered run gives some, the streamed run
 * none). */
function resolveRaw(
  c: Container,
  target: Extract<Target, { kind: "raw" }>,
  advice: string,
): { ok: true; target: ResolvedTarget } | { ok: false; message: string } {
  const res = c.catalog.resolveWithin(target.model, target.provider, [target.providerFormat], target.providerFormat);
  if (res.ok) return res;
  return {
    ok: false,
    message: resolutionErrorMessage(target.model, target.provider, res.error,
      `${target.model}@${target.provider} has no ${target.providerFormat} endpoint enabled${advice}`),
  };
}

/** The run of a raw tuple that resolved to no endpoint: nothing was sent, so
 * the buffered and the streamed report describe the same failure. */
function unresolvedRaw(
  target: Extract<Target, { kind: "raw" }>,
  message: string,
): { result: AttemptFailure; attemptPath: AttemptRecord[] } {
  return { result: { ok: false, status: 0, kind: "error", message }, attemptPath: [rawAttempt(target, 0, 0, "error", message)] };
}

/** How a raw tuple's single attempt is sent, buffered or streamed. */
function rawSendOptions(t: ResolvedTarget, timeoutMs: number | undefined) {
  return {
    upstreamModel: t.upstreamModel,
    url: t.url,
    headers: t.headers,
    providerMaxOutputTokens: t.providerMaxOutputTokens,
    timeoutMs: timeoutMs ?? BENCH_DEFAULT_TIMEOUT_MS,
    proxy: t.upstream.proxy,
  };
}

/** Buffered run: a saved service through its own executor, a raw tuple through
 * one direct send. */
async function runChat(
  c: Container,
  target: Target,
  request: CanonicalRequest,
  timeoutMs: number | undefined,
): Promise<ChatRun> {
  if (target.kind === "service") {
    const inv = await serviceExecutor(c, target.serviceId).invoke(request, undefined, serviceOptions(timeoutMs));
    if (!inv.result.ok) return { result: inv.result, attemptPath: inv.attemptPath };
    const v = inv.result.value;
    return {
      result: { ok: true, value: { response: v.response, served: servedByService(v), upstreamRequest: v.upstreamRequest } },
      attemptPath: inv.attemptPath,
    };
  }

  const started = Date.now();
  const raw = resolveRaw(c, target, " (add it to the provider, then enable it on the mapping)");
  if (!raw.ok) return unresolvedRaw(target, raw.message);
  const t = raw.target;
  const sent = await buildRequest(t.family, request.data()).send(c.transport, rawSendOptions(t, timeoutMs));
  const latencyMs = Date.now() - started;
  if (!sent.ok) {
    return {
      result: { ok: false, status: sent.status, kind: sent.kind, message: sent.message, errorBody: sent.body },
      attemptPath: [rawAttempt(target, sent.status, latencyMs, sent.kind, sent.message, sent.body)],
      upstreamRequest: sent.sentBody,
    };
  }
  return {
    result: { ok: true, value: { response: sent.response, served: served(t, t.url), upstreamRequest: sent.sentBody } },
    attemptPath: [rawAttempt(target, HTTP_STATUS.OK, latencyMs, "ok")],
  };
}

/**
 * Streamed run. The frames are exactly what a client of `ingress` would
 * receive, so a bench of a streaming path shows the real wire and not a
 * summary of it. One extra frame follows the terminal one, carrying what only
 * this side can see (where it landed, what went upstream, the attempt path);
 * `event: bench` is not part of any client protocol, so nothing but the bench
 * page will read it.
 */
async function runChatStream(
  c: Container,
  reply: FastifyReply,
  target: Target,
  ingress: Family,
  request: CanonicalRequest,
  label: string,
  thinkingFormat: ThinkingFormat,
  thinkingDelimiters: ThinkingDelimiters | undefined,
  timeoutMs: number | undefined,
): Promise<void> {
  const started = Date.now();
  // The proxy's own SSE setup: hijacked, and with no Connection header of its
  // own (see SSE_HEADERS for why forcing one breaks an HTTP/1.0 peer).
  openSse(reply);

  // Write the client-shaped frames. Usage only exists on the terminal event,
  // which is consumed by the serializer on its way to the client. Tap it in
  // passing, or the bench reports no tokens at all for a streamed run -- no
  // counts, no cached share, no thinking tokens -- while the buffered run
  // beside it shows all three.
  const pipe = async (events: AsyncGenerator<StreamEvent>): Promise<Usage | undefined> => {
    const acc = newAccumulator();
    const shaped = tapStream(withThinkingFormat(events, thinkingFormat, thinkingDelimiters), acc);
    for await (const frame of serializeStream(ingress, shaped, { model: label, thinkingFormat })) reply.raw.write(frame);
    return acc.usage;
  };

  /** Relay the run and report what the trailing `bench` frame carries. */
  const run = async (): Promise<Record<string, unknown>> => {
    if (target.kind === "service") {
      const inv = await serviceExecutor(c, target.serviceId).stream(request, undefined, serviceOptions(timeoutMs));
      if (!inv.result.ok) {
        return {
          ok: false,
          status: failureStatus(inv.result),
          message: failureMessage(inv.result),
          latencyMs: Date.now() - started,
          attemptPath: inv.attemptPath,
        };
      }
      const v = inv.result.value;
      const usage = await pipe(v.events);
      return {
        ok: true,
        status: HTTP_STATUS.OK,
        latencyMs: Date.now() - started,
        served: servedByService(v),
        upstreamRequest: v.upstreamRequest,
        usage,
        attemptPath: inv.attemptPath,
      };
    }

    const raw = resolveRaw(c, target, "");
    if (!raw.ok) {
      const unresolved = unresolvedRaw(target, raw.message);
      return { ok: false, status: failureStatus(unresolved.result), message: raw.message, latencyMs: Date.now() - started, attemptPath: unresolved.attemptPath };
    }
    const t = raw.target;
    const relayed = await buildRequest(t.family, request.data()).relay(c.transport, rawSendOptions(t, timeoutMs));
    if (!relayed.ok) {
      return {
        ok: false,
        status: relayed.status,
        message: extractUpstreamMessage(relayed.body) ?? relayed.message,
        latencyMs: Date.now() - started,
        served: served(t, t.url),
        upstreamRequest: relayed.sentBody,
        attemptPath: [rawAttempt(target, relayed.status, Date.now() - started, relayed.kind, relayed.message, relayed.body)],
      };
    }
    const usage = await pipe(relayed.events);
    return {
      ok: true,
      status: relayed.status,
      latencyMs: Date.now() - started,
      served: served(t, t.url),
      upstreamRequest: relayed.sentBody,
      usage,
      attemptPath: [rawAttempt(target, HTTP_STATUS.OK, Date.now() - started, "ok")],
    };
  };

  let report: Record<string, unknown>;
  try {
    report = await run();
  } catch (e) {
    report = { ok: false, status: 0, message: classifyError(e).message, latencyMs: Date.now() - started };
  }
  reply.raw.write(`event: bench\ndata: ${JSON.stringify(report)}\n\n`);
  reply.raw.end();
}

/** A raw target makes one attempt; it is still reported as an attempt path so
 * the bench page renders a service run and a raw run with the same component. */
function rawAttempt(
  target: Extract<Target, { kind: "raw" }>,
  status: number,
  latencyMs: number,
  kind: AttemptRecord["kind"],
  error?: string,
  errorBody?: unknown,
): AttemptRecord {
  const upstreamError = extractUpstreamMessage(errorBody) ?? undefined;
  return {
    step: 1,
    attempt: 1,
    model: target.model,
    provider: target.provider,
    status,
    kind,
    latencyMs,
    ...(error ? { error } : {}),
    ...(upstreamError ? { upstreamError } : {}),
    ...(errorBody != null ? { errorBody: serializeForLog(errorBody, ERROR_BODY_MAX_CHARS) } : {}),
  };
}

// --- media execution --------------------------------------------------------

/** TTS answers with audio bytes. They come back base64 with their content type
 * so the bench page can play them and offer a download -- a bench that could
 * only say "200 OK, 41kB" would not tell you whether the voice was right. */
async function runSpeech(
  c: Container,
  t: ResolvedTarget,
  url: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  started: number,
): Promise<Record<string, unknown>> {
  const upstreamRequest = { ...body, model: t.upstreamModel };
  const r = await c.transport.postStream(url, buildHeaders(t.upstream), upstreamRequest, { timeoutMs, proxy: t.upstream.proxy });
  const chunks: Buffer[] = [];
  for await (const chunk of r.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  const buf = Buffer.concat(chunks);
  const latencyMs = Date.now() - started;
  const contentType = typeof r.headers[HEADER.CONTENT_TYPE] === "string" ? (r.headers[HEADER.CONTENT_TYPE] as string) : MIME.OCTET_STREAM;
  if (isSuccessStatus(r.status)) {
    return {
      ok: true, status: r.status, latencyMs, served: served(t, url), upstreamRequest,
      audio: { mediaType: contentType, bytes: buf.length, base64: buf.toString("base64") },
    };
  }
  const errJson = parseJsonOrText(buf.toString("utf8"));
  return {
    ok: false, status: r.status, latencyMs, served: served(t, url), upstreamRequest,
    message: upstreamFailureMessage(r.status, errJson),
    response: errJson,
  };
}

/**
 * Build the multipart form an OpenAI-shaped transcriptions endpoint expects.
 * The bench page posts JSON with the recording base64-encoded, so the browser
 * side stays one plain fetch and the framing lives here.
 *
 * The boundary is randomized per form: with a fixed, guessable boundary, a
 * client-supplied field VALUE containing the boundary could forge additional
 * parts in the request sent upstream. Field names, the file name and the file's
 * media type are framed verbatim into part header lines, so CRLF (and, inside a
 * quoted value, quotes) are stripped from them too.
 */
function transcriptionForm(
  fields: Record<string, unknown>,
  file: { name: string; mediaType: string; data: string },
): { body: Buffer; contentType: string } {
  const boundary = `----HydrogenBench-${crypto.randomBytes(MULTIPART_BOUNDARY_RANDOM_BYTES).toString("hex")}`;
  const delimiter = `--${boundary}`;
  const parts: Buffer[] = [];
  for (const [rawKey, v] of Object.entries(fields)) {
    if (v == null) continue;
    const k = rawKey.replace(/["\r\n]/g, "");
    if (!k) continue;
    parts.push(Buffer.from(`${delimiter}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${formFieldValue(v)}\r\n`, "utf8"));
  }
  parts.push(
    Buffer.from(
      `${delimiter}\r\nContent-Disposition: form-data; name="file"; filename="${file.name.replace(/["\r\n]/g, "")}"\r\n` +
        `Content-Type: ${file.mediaType.replace(/[\r\n]/g, "")}\r\n\r\n`,
      "utf8",
    ),
  );
  parts.push(Buffer.from(file.data, "base64"));
  parts.push(Buffer.from(`\r\n${delimiter}--\r\n`, "utf8"));
  return { body: Buffer.concat(parts), contentType: `${MIME.MULTIPART_FORM_DATA}; boundary=${boundary}` };
}

async function runTranscription(
  c: Container,
  t: ResolvedTarget,
  url: string,
  body: Record<string, unknown>,
  file: { name: string; mediaType: string; data: string },
  timeoutMs: number,
  started: number,
): Promise<Record<string, unknown>> {
  const fields = { ...body, model: t.upstreamModel };
  const form = transcriptionForm(fields, file);
  const headers = buildHeaders(t.upstream);
  headers[HEADER.CONTENT_TYPE] = form.contentType;
  if (!c.transport.postRaw) {
    return { ok: false, status: 0, latencyMs: 0, message: "this transport cannot post a multipart form" };
  }
  const r = await c.transport.postRaw(url, headers, form.body, { timeoutMs, proxy: t.upstream.proxy });
  const latencyMs = Date.now() - started;
  const upstreamRequest = { ...fields, file: `(${file.name}, ${file.mediaType}, ${Buffer.from(file.data, "base64").length} bytes)` };
  if (isSuccessStatus(r.status)) {
    return { ok: true, status: r.status, latencyMs, served: served(t, url), upstreamRequest, response: r.json ?? r.text };
  }
  return {
    ok: false, status: r.status, latencyMs, served: served(t, url), upstreamRequest,
    message: upstreamFailureMessage(r.status, r.json ?? r.text),
    response: r.json ?? r.text,
  };
}
