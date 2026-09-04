import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { parse } from "../util/validate";
import type { Container } from "../composition/container";
import { buildRequest, parseRequest, serializeStream } from "../core/format/registry";
import type { Family } from "../core/format/family";
import { MEDIA_FAMILIES, type ResolvedTarget } from "../catalog/catalog";
import {
  buildHeaders,
  embeddingsUrl,
  imagesUrl,
  rerankUrl,
  speechUrl,
  transcriptionsUrl,
  videosUrl,
} from "../core/upstream/endpoints";
import { extractUpstreamMessage, failureMessage, failureStatus } from "../core/proxy/errors";
import {
  isAgent,
  isChatPipeline,
  parseService,
  serviceCategory,
  serviceThinkingFormat,
  ServiceCategorySchema,
  type ServiceCategory,
  type ServiceDef,
} from "../execution/definition";
import { withThinkingFormat, type ThinkingFormat } from "../core/ir/thinkingFormat";
import { classifyError, type AttemptRecord, type AttemptResult } from "../execution/steps";
import type { Request as CanonicalRequest } from "../core/ir/request";
import { newAccumulator, tapStream } from "../core/ir/stream";
import { serializeForLog } from "../util/logPayload";
import { withJsonHeartbeat } from "./jsonKeepalive";

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

const FamilySchema = z.enum(["openai_completion", "anthropic", "openai_responses"]);

const TargetSchema = z.discriminatedUnion("kind", [
  /** A saved Model Service or Micro Agent, run exactly as production runs it. */
  z.object({ kind: z.literal("service"), serviceId: z.number().int().positive() }),
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
  timeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
});

const MediaSchema = z.object({
  target: TargetSchema,
  category: ServiceCategorySchema,
  body: z.record(z.unknown()),
  /** For `stt`: the recording to transcribe, as base64. Assembled into a
   * multipart form here so the bench page can post plain JSON. */
  file: z
    .object({
      name: z.string().min(1).max(255),
      mediaType: z.string().min(1).max(120),
      data: z.string().min(1),
    })
    .optional(),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
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

/** A saved service row, parsed, or a reply-shaped error. */
function loadService(
  c: Container,
  id: number,
): { ok: true; def: ServiceDef; name: string } | { ok: false; status: number; message: string } {
  const row = c.services.get(id);
  if (!row) return { ok: false, status: 404, message: "Model Service not found" };
  try {
    return { ok: true, def: parseService(row.definition), name: row.name };
  } catch {
    return { ok: false, status: 400, message: `"${row.name}" has an invalid definition` };
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
      let kind: "model_service" | "micro_agent" = "model_service";
      let valid = true;
      try {
        const def = parseService(row.definition);
        category = serviceCategory(def);
        kind = isAgent(def) ? "micro_agent" : "model_service";
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
    const parsed = parse(ChatSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const { target, ingress, body, timeoutMs } = parsed.data;

    let request: CanonicalRequest;
    try {
      request = parseRequest(ingress, body);
    } catch (e) {
      return reply.code(400).send({ error: `body is not a valid ${ingress} request: ${(e as Error).message}` });
    }
    const streaming = request.stream;

    // The service name a client would have sent. Echoed back as the response's
    // `model` so the rendered body looks like the one a client would receive.
    let label = "(bench)";
    // A saved service shapes its client's thinking the way it always does, so
    // the bench shows the real answer rather than a canonical one. A raw tuple
    // belongs to no service and therefore has no format to apply.
    let thinkingFormat: ThinkingFormat = "original";
    if (target.kind === "service") {
      const loaded = loadService(c, target.serviceId);
      if (!loaded.ok) return reply.code(loaded.status).send({ error: loaded.message });
      if (!isChatPipeline(serviceCategory(loaded.def))) {
        return reply
          .code(400)
          .send({ error: `"${loaded.name}" is a ${serviceCategory(loaded.def)} service; bench it from the media panel` });
      }
      label = loaded.name;
      thinkingFormat = serviceThinkingFormat(loaded.def);
    } else {
      label = `${target.model}@${target.provider}`;
    }

    if (streaming) return runChatStream(c, reply, target, ingress, request, label, thinkingFormat, timeoutMs);

    // A slow chain can outlive an intermediary's idle timeout (Cloudflare 524s
    // a silent origin at ~100s); failures travel in-body, so committing 200
    // early to heartbeat costs nothing semantically.
    return withJsonHeartbeat(reply, c.config.jsonCommitGraceMs, 10_000, async () => {
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
        status: 200,
        latencyMs,
        served: v.served,
        upstreamRequest: v.upstreamRequest,
        response: v.response.withThinkingFormat(thinkingFormat).render(ingress, label, { thinkingFormat }),
        thinkingFormat,
        usage: v.response.usage,
        attemptPath: run.attemptPath,
      };
    });
  });

  // --- media passthrough ---------------------------------------------------

  app.post("/media", async (req, reply) => {
    const parsed = parse(MediaSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const { target, category, body, file, timeoutMs } = parsed.data;
    if (isChatPipeline(category)) {
      return reply.code(400).send({ error: `"${category}" is a chat-pipeline category; bench it from the chat panel` });
    }
    if (category === "stt" && !file) {
      return reply.code(400).send({ error: "speech-to-text needs an audio file" });
    }

    let steps: { model: string; provider: string; providerFormat?: Family } | null = null;
    if (target.kind === "service") {
      const loaded = loadService(c, target.serviceId);
      if (!loaded.ok) return reply.code(loaded.status).send({ error: loaded.message });
      if (isAgent(loaded.def)) {
        return reply.code(400).send({ error: `"${loaded.name}" is a Micro Agent; it has no media endpoint` });
      }
      const actual = serviceCategory(loaded.def);
      if (actual !== category) {
        return reply.code(400).send({ error: `"${loaded.name}" is a ${actual} service, not ${category}` });
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
      return reply.code(400).send({
        error: `${category} is an OpenAI-shaped endpoint; a ${steps.providerFormat} endpoint does not serve it`,
      });
    }
    const allowed = steps.providerFormat ? [steps.providerFormat] : MEDIA_FAMILIES;
    const res = c.catalog.resolveWithin(steps.model, steps.provider, allowed);
    if (!res.ok) {
      const message =
        res.error === "no_endpoint_in_family"
          ? `${steps.model}@${steps.provider} has no ${steps.providerFormat ?? "OpenAI-compatible"} endpoint enabled for ${category}`
          : `mapping ${steps.model}@${steps.provider}: ${res.error}`;
      return reply.code(400).send({ error: message });
    }
    const t = res.target;
    const url = mediaUrl(category, t);
    const timeout = timeoutMs ?? 300_000;

    return withJsonHeartbeat(reply, c.config.jsonCommitGraceMs, 10_000, async () => {
      const started = Date.now();
      try {
        if (category === "stt") return await runTranscription(c, t, url, body, file!, timeout, started);
        if (category === "tts") return await runSpeech(c, t, url, body, timeout, started);

        const upstreamRequest = { ...body, model: t.upstreamModel };
        const r = await c.transport.postJson(url, buildHeaders(t.upstream), upstreamRequest, { timeoutMs: timeout });
        const latencyMs = Date.now() - started;
        if (r.status >= 200 && r.status < 300) {
          return { ok: true, status: r.status, latencyMs, served: served(t, url), upstreamRequest, response: r.json ?? r.text };
        }
        return {
          ok: false,
          status: r.status,
          latencyMs,
          message: extractUpstreamMessage(r.json ?? r.text) ?? `upstream ${r.status}`,
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
  response: import("../core/ir/response").Response;
  served: Served;
  upstreamRequest: Record<string, unknown>;
}

interface ChatRun {
  result: AttemptResult<ChatValue>;
  attemptPath: unknown;
  upstreamRequest?: Record<string, unknown>;
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
    const row = c.services.get(target.serviceId)!;
    const { executor } = c.factory.forRow(row);
    const inv = await executor.invoke(request, undefined, timeoutMs ? { timeoutMs } : {});
    if (!inv.result.ok) return { result: inv.result, attemptPath: inv.attemptPath };
    const v = inv.result.value;
    return {
      result: {
        ok: true,
        value: {
          response: v.response,
          served: { model: v.modelName, provider: v.providerName, family: v.family, upstreamModel: v.upstreamModel, url: "" },
          upstreamRequest: v.upstreamRequest,
        },
      },
      attemptPath: inv.attemptPath,
    };
  }

  const started = Date.now();
  const res = c.catalog.resolveWithin(target.model, target.provider, [target.providerFormat], target.providerFormat);
  if (!res.ok) {
    const message =
      res.error === "no_endpoint_in_family"
        ? `${target.model}@${target.provider} has no ${target.providerFormat} endpoint enabled (add it to the provider, then enable it on the mapping)`
        : `mapping ${target.model}@${target.provider}: ${res.error}`;
    return { result: { ok: false, status: 0, kind: "error", message }, attemptPath: [rawAttempt(target, 0, 0, "error", message)] };
  }
  const t = res.target;
  const egress = buildRequest(t.family, request.data());
  const sent = await egress.send(c.transport, {
    upstreamModel: t.upstreamModel,
    url: t.url,
    headers: t.headers,
    providerMaxOutputTokens: t.providerMaxOutputTokens,
    timeoutMs: timeoutMs ?? 300_000,
  });
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
    attemptPath: [rawAttempt(target, 200, latencyMs, "ok")],
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
  timeoutMs: number | undefined,
): Promise<void> {
  const started = Date.now();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const meta = (payload: Record<string, unknown>): void => {
    reply.raw.write(`event: bench\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    if (target.kind === "service") {
      const row = c.services.get(target.serviceId)!;
      const { executor } = c.factory.forRow(row);
      const inv = await executor.stream(request, undefined, timeoutMs ? { timeoutMs } : {});
      if (!inv.result.ok) {
        meta({
          ok: false,
          status: failureStatus(inv.result),
          message: failureMessage(inv.result),
          latencyMs: Date.now() - started,
          attemptPath: inv.attemptPath,
        });
        reply.raw.end();
      return;
      }
      const v = inv.result.value;
      // Usage only exists on the terminal event, which is consumed by the
      // serializer on its way to the client. Tap it in passing, or the bench
      // reports no tokens at all for a streamed run -- no counts, no cached
      // share, no thinking tokens -- while the buffered run beside it shows
      // all three.
      const acc = newAccumulator();
      const shaped = tapStream(withThinkingFormat(v.events, thinkingFormat), acc);
      for await (const frame of serializeStream(ingress, shaped, { model: label, thinkingFormat })) reply.raw.write(frame);
      meta({
        ok: true,
        status: 200,
        latencyMs: Date.now() - started,
        served: { model: v.modelName, provider: v.providerName, family: v.family, upstreamModel: v.upstreamModel, url: "" },
        upstreamRequest: v.upstreamRequest,
        usage: acc.usage,
        attemptPath: inv.attemptPath,
      });
      reply.raw.end();
      return;
    }

    const res = c.catalog.resolveWithin(target.model, target.provider, [target.providerFormat], target.providerFormat);
    if (!res.ok) {
      const message =
        res.error === "no_endpoint_in_family"
          ? `${target.model}@${target.provider} has no ${target.providerFormat} endpoint enabled`
          : `mapping ${target.model}@${target.provider}: ${res.error}`;
      meta({ ok: false, status: 0, message, latencyMs: Date.now() - started, attemptPath: [rawAttempt(target, 0, 0, "error", message)] });
      reply.raw.end();
      return;
    }
    const t = res.target;
    const egress = buildRequest(t.family, request.data());
    const relayed = await egress.relay(c.transport, {
      upstreamModel: t.upstreamModel,
      url: t.url,
      headers: t.headers,
      providerMaxOutputTokens: t.providerMaxOutputTokens,
      timeoutMs: timeoutMs ?? 300_000,
    });
    if (!relayed.ok) {
      meta({
        ok: false,
        status: relayed.status,
        message: extractUpstreamMessage(relayed.body) ?? relayed.message,
        latencyMs: Date.now() - started,
        served: served(t, t.url),
        upstreamRequest: relayed.sentBody,
        attemptPath: [rawAttempt(target, relayed.status, Date.now() - started, relayed.kind, relayed.message, relayed.body)],
      });
      reply.raw.end();
      return;
    }
    const acc = newAccumulator();
    const shaped = tapStream(withThinkingFormat(relayed.events, thinkingFormat), acc);
    for await (const frame of serializeStream(ingress, shaped, { model: label, thinkingFormat })) {
      reply.raw.write(frame);
    }
    meta({
      ok: true,
      status: relayed.status,
      latencyMs: Date.now() - started,
      served: served(t, t.url),
      upstreamRequest: relayed.sentBody,
      usage: acc.usage,
      attemptPath: [rawAttempt(target, 200, Date.now() - started, "ok")],
    });
    reply.raw.end();
      return;
  } catch (e) {
    const cls = classifyError(e);
    meta({ ok: false, status: 0, message: cls.message, latencyMs: Date.now() - started });
    reply.raw.end();
      return;
  }
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
    ...(errorBody != null ? { errorBody: serializeForLog(errorBody, 8_000) } : {}),
  };
}

// --- media execution --------------------------------------------------------

function mediaUrl(category: ServiceCategory, t: ResolvedTarget): string {
  switch (category) {
    case "embedding": return embeddingsUrl(t.upstream);
    case "rerank": return rerankUrl(t.upstream);
    case "image": return imagesUrl(t.upstream);
    case "video": return videosUrl(t.upstream);
    case "tts": return speechUrl(t.upstream);
    case "stt": return transcriptionsUrl(t.upstream);
    default: return "";
  }
}

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
  const r = await c.transport.postStream(url, buildHeaders(t.upstream), upstreamRequest, { timeoutMs });
  const chunks: Buffer[] = [];
  for await (const chunk of r.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  const buf = Buffer.concat(chunks);
  const latencyMs = Date.now() - started;
  const contentType = typeof r.headers["content-type"] === "string" ? (r.headers["content-type"] as string) : "application/octet-stream";
  if (r.status >= 200 && r.status < 300) {
    return {
      ok: true, status: r.status, latencyMs, served: served(t, url), upstreamRequest,
      audio: { mediaType: contentType, bytes: buf.length, base64: buf.toString("base64") },
    };
  }
  let errJson: unknown;
  const text = buf.toString("utf8");
  try { errJson = text ? JSON.parse(text) : undefined; } catch { errJson = text; }
  return {
    ok: false, status: r.status, latencyMs, served: served(t, url), upstreamRequest,
    message: extractUpstreamMessage(errJson) ?? `upstream ${r.status}`,
    response: errJson,
  };
}

const MULTIPART_BOUNDARY = "----HydrogenBench";

/** Build the multipart form an OpenAI-shaped transcriptions endpoint expects.
 * The bench page posts JSON with the recording base64-encoded, so the browser
 * side stays one plain fetch and the framing lives here. */
function transcriptionForm(
  fields: Record<string, unknown>,
  file: { name: string; mediaType: string; data: string },
): Buffer {
  const parts: Buffer[] = [];
  const boundary = `--${MULTIPART_BOUNDARY}`;
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    const value = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
    parts.push(Buffer.from(`${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${value}\r\n`, "utf8"));
  }
  parts.push(
    Buffer.from(
      `${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name.replace(/["\r\n]/g, "")}"\r\n` +
        `Content-Type: ${file.mediaType}\r\n\r\n`,
      "utf8",
    ),
  );
  parts.push(Buffer.from(file.data, "base64"));
  parts.push(Buffer.from(`\r\n${boundary}--\r\n`, "utf8"));
  return Buffer.concat(parts);
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
  headers["content-type"] = `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`;
  if (!c.transport.postRaw) {
    return { ok: false, status: 0, latencyMs: 0, message: "this transport cannot post a multipart form" };
  }
  const r = await c.transport.postRaw(url, headers, form, { timeoutMs });
  const latencyMs = Date.now() - started;
  const upstreamRequest = { ...fields, file: `(${file.name}, ${file.mediaType}, ${Buffer.from(file.data, "base64").length} bytes)` };
  if (r.status >= 200 && r.status < 300) {
    return { ok: true, status: r.status, latencyMs, served: served(t, url), upstreamRequest, response: r.json ?? r.text };
  }
  return {
    ok: false, status: r.status, latencyMs, served: served(t, url), upstreamRequest,
    message: extractUpstreamMessage(r.json ?? r.text) ?? `upstream ${r.status}`,
    response: r.json ?? r.text,
  };
}
