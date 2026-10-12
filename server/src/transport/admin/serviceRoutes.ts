import type { FastifyInstance, FastifyReply } from "fastify";
import { z, ZodError } from "zod";
import { requireAdmin } from "../../auth/authorization";
import type { Container } from "../../composition/container";
import { buildRequest } from "../../core/format/registry";
import { textOf, type ImagePart } from "../../core/ir/content";
import { failureMessage } from "../../core/proxy/errors";
import type { ModelServiceRow } from "../../db/schema";
import { buildOcrRequest, parseOcrResults } from "../../execution/agentContext";
import { AgentOcrSchema, DEFAULT_SERVICE_TIMEOUT_MS, isAgent, isChatPipeline, serviceCategory, summarizeService, type AgentOcr, type ServiceDef } from "../../execution/definition";
import type { ModelService } from "../../execution/modelService";
import { ServiceValidationError } from "../../execution/serviceValidator";
import { asMillis } from "../../util/time";
import { HTTP_STATUS } from "../../util/httpStatus";
import { withJsonHeartbeat } from "../jsonKeepalive";
import { ERR_MODEL_SERVICE_NOT_FOUND } from "../errorMessages";
import { MAX_NAME_LENGTH } from "../limits";
import { PositiveIntSchema, formatZodIssues } from "../../util/validate";
import { badRequest, loadById, notFound, parseBody } from "./replies";

/** Hosted tools one service may bind. */
const MAX_TOOLS_PER_SERVICE = 64;
/** Output budget of a dry-run request: a Micro Agent needs room for its stages. */
const DRY_RUN_MAX_TOKENS_AGENT = 64;
const DRY_RUN_MAX_TOKENS_SERVICE = 16;
/** Characters of the dry-run answer returned to the editor. */
const DRY_RUN_OUTPUT_PREVIEW_CHARS = 500;
/** Characters of the raw OCR answer returned to the editor. */
const OCR_RAW_PREVIEW_CHARS = 20_000;
/** Heartbeat interval of a dry-run; fixed, not the operator's ping setting. */
const DRY_RUN_PING_INTERVAL_MS = 10_000;

const ACTION_BIND_HOSTED_TOOLS = "bind hosted tools";
const ERR_HOSTED_TOOLS_NEED_CHAT = "Hosted tools require a chat service";

// --- services ---------------------------------------------------------------

const ServiceCreate = z.object({
  toolIds: z.array(PositiveIntSchema).max(MAX_TOOLS_PER_SERVICE).optional(),
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  description: z.string().nullable().optional(),
  steps: z.unknown(),
  enabled: z.boolean().optional(),
});
const ServiceUpdate = ServiceCreate.partial();

function presentService(c: Container, m: ModelServiceRow): Record<string, unknown> {
  let summary = "";
  try {
    summary = summarizeService(c.services.def(m));
  } catch {
    summary = "(invalid steps)";
  }
  return { id: m.id, name: m.name, description: m.description, steps: m.definition, enabled: m.enabled, summary, createdAt: asMillis(m.createdAt), toolIds: c.hostedTools?.boundIds(m.id) ?? [] };
}

const OcrTestSchema = z.object({
  ocr: z.unknown(),
  image: z.object({
    mediaType: z.string().regex(/^image\//, "mediaType must be an image/* MIME type"),
    data: z.string().min(1, "image data (base64) is required"),
  }),
});

function serviceValidationError(e: unknown): { status: number; body: Record<string, unknown> } | null {
  if (e instanceof ServiceValidationError) return { status: HTTP_STATUS.BAD_REQUEST, body: { error: e.message, invalidPairs: e.invalidPairs } };
  if (e instanceof ZodError) {
    return { status: HTTP_STATUS.BAD_REQUEST, body: { error: `invalid steps: ${formatZodIssues(e.issues)}` } };
  }
  return null;
}

/** The catch arm of a handler that validates a definition: answer with the
 * mapped 400, or rethrow what is not a validation failure. */
function replyValidationError(reply: FastifyReply, e: unknown): FastifyReply {
  const mapped = serviceValidationError(e);
  if (!mapped) throw e;
  return reply.code(mapped.status).send(mapped.body);
}

export async function serviceRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/", async () => ({ services: c.services.list().map((m) => presentService(c, m)) }));

  app.post("/validate", async (req, reply) => {
    const body = (req.body ?? {}) as { steps?: unknown };
    try {
      const { def, summary } = c.validator.validate(body.steps);
      const kind = isAgent(def) ? "agent" : "resilience";
      const count = isAgent(def) ? def.stages.length : def.steps.length;
      return { valid: true, summary, kind, count };
    } catch (e) {
      const mapped = serviceValidationError(e);
      if (mapped) return reply.code(HTTP_STATUS.OK).send({ valid: false, ...mapped.body });
      throw e;
    }
  });

  app.post("/", async (req, reply) => {
    const data = parseBody(ServiceCreate, req, reply);
    if (!data) return reply;
    if (data.toolIds !== undefined && !requireAdmin(req, reply, ACTION_BIND_HOSTED_TOOLS)) return;
    try {
      const { def } = c.validator.validate(data.steps);
      if (data.toolIds?.length && !isChatPipeline(serviceCategory(def))) return badRequest(reply, ERR_HOSTED_TOOLS_NEED_CHAT);
      const row = c.db.transaction(() => {
        const row = c.services.create({ name: data.name, description: data.description, definition: def, enabled: data.enabled });
        if (data.toolIds) c.hostedTools.bind(row.id, data.toolIds);
        return row;
      });
      return reply.code(HTTP_STATUS.CREATED).send({ service: presentService(c, row) });
    } catch (e) {
      return replyValidationError(reply, e);
    }
  });

  app.patch("/:id", async (req, reply) => {
    const hit = loadById(req, reply, (id) => c.services.get(id));
    if (!hit) return reply;
    const data = parseBody(ServiceUpdate, req, reply);
    if (!data) return reply;
    if (data.toolIds !== undefined && !requireAdmin(req, reply, ACTION_BIND_HOSTED_TOOLS)) return;
    try {
      const patch: { name?: string; description?: string | null; definition?: ServiceDef; enabled?: boolean } = {
        name: data.name,
        description: data.description,
        enabled: data.enabled,
      };
      if (data.steps !== undefined) patch.definition = c.validator.validate(data.steps).def;
      const effective = patch.definition ?? c.services.def(c.services.get(hit.id)!);
      if ((data.toolIds ?? c.hostedTools.boundIds(hit.id)).length && !isChatPipeline(serviceCategory(effective))) return badRequest(reply, ERR_HOSTED_TOOLS_NEED_CHAT);
      const row = c.db.transaction(() => {
        const row = c.services.update(hit.id, patch);
        if (data.toolIds) c.hostedTools.bind(hit.id, data.toolIds);
        return row;
      });
      return { service: row ? presentService(c, row) : null };
    } catch (e) {
      return replyValidationError(reply, e);
    }
  });

  app.delete("/:id", async (req, reply) => {
    const hit = loadById(req, reply, (id) => c.services.get(id));
    if (!hit) return reply;
    c.services.delete(hit.id);
    return { ok: true };
  });

  // Dry-run: fire a small request through a service (saved id or ad-hoc steps).
  app.post("/test", async (req, reply) => {
    const body = (req.body ?? {}) as { serviceId?: number; steps?: unknown; prompt?: string };
    let def: ServiceDef;
    try {
      if (body.serviceId) {
        const row = c.services.get(body.serviceId);
        if (!row) return notFound(reply, ERR_MODEL_SERVICE_NOT_FOUND);
        def = c.services.def(row);
      } else {
        def = c.validator.validate(body.steps).def;
      }
    } catch (e) {
      return replyValidationError(reply, e);
    }

    // The dry-run fires a chat request; media categories speak other shapes.
    if (!isChatPipeline(serviceCategory(def))) {
      return badRequest(reply, `dry-run supports chat-pipeline services only (this is a ${serviceCategory(def)} service)`);
    }

    const { executor } = c.factory.buildDef(def);
    const request = buildRequest("openai_completion", {
      requestedService: "(dry-run)",
      messages: [{ role: "user", content: [{ type: "text", text: body.prompt || "ping" }] }],
      params: { maxTokens: isAgent(def) ? DRY_RUN_MAX_TOKENS_AGENT : DRY_RUN_MAX_TOKENS_SERVICE },
      stream: false,
    });
    // A dry-run against a slow chain can outlive intermediary idle timeouts
    // (Cloudflare 524s a silent origin at ~100s); heartbeat while it runs.
    // Failures already travel in-body ({ok:false}), so committing 200 early
    // changes nothing semantically.
    return withJsonHeartbeat(reply, c.config.jsonCommitGraceMs, DRY_RUN_PING_INTERVAL_MS, async () => {
      const outcome = await executor.invoke(request);
      if (outcome.result.ok) {
        const v = outcome.result.value;
        return { ok: true, attemptPath: outcome.attemptPath, served: { model: v.modelName, provider: v.providerName }, output: textOf(v.response.content).slice(0, DRY_RUN_OUTPUT_PREVIEW_CHARS) };
      }
      return { ok: false, status: outcome.result.status, message: failureMessage(outcome.result), attemptPath: outcome.attemptPath };
    });
  });

  // Dry-run the OCR pre-pass: send one test image through an OCR config and
  // return what the model actually said. The config comes from the editor
  // (possibly unsaved). The image cache is bypassed by construction -- the OCR
  // service is invoked directly, so the test always measures the model.
  app.post("/test-ocr", async (req, reply) => {
    const data = parseBody(OcrTestSchema, req, reply);
    if (!data) return reply;
    let ocr: AgentOcr;
    try {
      ocr = AgentOcrSchema.parse(data.ocr);
    } catch (e) {
      return replyValidationError(reply, e);
    }

    // Resolve the OCR model exactly the way the Micro Agent pre-pass does.
    let executor: ModelService;
    if (ocr.service) {
      const r = c.factory.resolve(ocr.service);
      if (!r.ok) return badRequest(reply, r.message);
      if (r.isAgent) return badRequest(reply, `OCR reference "${ocr.service}" must be a Model Service, not a Micro Agent`);
      executor = r.executor;
    } else if (ocr.steps && ocr.steps.length) {
      try {
        const { def } = c.validator.validate({ timeoutMs: ocr.timeoutMs ?? DEFAULT_SERVICE_TIMEOUT_MS, steps: ocr.steps });
        executor = c.factory.buildDef(def).executor;
      } catch (e) {
        return replyValidationError(reply, e);
      }
    } else {
      return badRequest(reply, "image translation (OCR) is enabled but has no model configured");
    }

    const image: ImagePart = {
      type: "image",
      source: { kind: "base64", mediaType: data.image.mediaType, data: data.image.data },
    };
    const parent = buildRequest("openai_completion", {
      requestedService: "(ocr-test)",
      messages: [{ role: "user", content: [image] }],
      params: {},
      stream: false,
    });
    const ocrReq = buildOcrRequest(parent, [image], ocr);

    // OCR models routinely take 60-180s per attempt; without bytes on the
    // wire, Cloudflare answers the panel with a 524 at ~100s while the test
    // keeps running. Heartbeat until the outcome arrives — failures already
    // travel in-body ({ok:false}), so the early 200 commit costs nothing.
    return withJsonHeartbeat(reply, c.config.jsonCommitGraceMs, DRY_RUN_PING_INTERVAL_MS, async () => {
      const started = Date.now();
      const outcome = await executor.invoke(ocrReq, undefined, ocr.timeoutMs ? { timeoutMs: ocr.timeoutMs } : {});
      const latencyMs = Date.now() - started;
      if (outcome.result.ok) {
        const v = outcome.result.value;
        const raw = v.response.text();
        // Index 1 of the OCR output contract; empty when the model ignored it.
        const [description] = parseOcrResults(raw, 1);
        return {
          ok: true,
          served: { model: v.modelName, provider: v.providerName },
          latencyMs,
          usage: v.response.usage,
          description,
          raw: raw.slice(0, OCR_RAW_PREVIEW_CHARS),
          attemptPath: outcome.attemptPath,
        };
      }
      return { ok: false, status: outcome.result.status, message: failureMessage(outcome.result), latencyMs, attemptPath: outcome.attemptPath };
    });
  });
}
