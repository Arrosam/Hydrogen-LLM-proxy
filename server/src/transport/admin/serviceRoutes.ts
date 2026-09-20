import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { requireAdmin } from "../../auth/authorization";
import type { Container } from "../../composition/container";
import { buildRequest } from "../../core/format/registry";
import { textOf, type ImagePart } from "../../core/ir/content";
import { failureMessage } from "../../core/proxy/errors";
import type { ModelServiceRow } from "../../db/schema";
import { buildOcrRequest, parseOcrResults } from "../../execution/agentContext";
import { AgentOcrSchema, isAgent, isChatPipeline, serviceCategory, summarizeService, type AgentOcr, type ServiceDef } from "../../execution/definition";
import type { ModelService } from "../../execution/modelService";
import { ServiceValidationError } from "../../execution/serviceValidator";
import { asMillis } from "../../util/time";
import { idParam, parse } from "../../util/validate";
import { withJsonHeartbeat } from "../jsonKeepalive";

// --- services ---------------------------------------------------------------

const ServiceCreate = z.object({
  toolIds: z.array(z.number().int().positive()).max(64).optional(),
  name: z.string().min(1).max(120),
  description: z.string().nullable().optional(),
  steps: z.unknown(),
  enabled: z.boolean().optional(),
});
const ServiceUpdate = z.object({
  toolIds: z.array(z.number().int().positive()).max(64).optional(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().nullable().optional(),
  steps: z.unknown().optional(),
  enabled: z.boolean().optional(),
});

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
  if (e instanceof ServiceValidationError) return { status: 400, body: { error: e.message, invalidPairs: e.invalidPairs } };
  if (e instanceof ZodError) {
    const msg = e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { status: 400, body: { error: `invalid steps: ${msg}` } };
  }
  return null;
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
      if (mapped) return reply.code(200).send({ valid: false, ...mapped.body });
      throw e;
    }
  });

  app.post("/", async (req, reply) => {
    const parsed = parse(ServiceCreate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    if (parsed.data.toolIds !== undefined && !requireAdmin(req, reply, "bind hosted tools")) return;
    try {
      const { def } = c.validator.validate(parsed.data.steps);
      if (parsed.data.toolIds?.length && !isChatPipeline(serviceCategory(def))) return reply.code(400).send({ error: "Hosted tools require a chat service" });
      const row = c.db.transaction(() => {
        const row = c.services.create({ name: parsed.data.name, description: parsed.data.description, definition: def, enabled: parsed.data.enabled });
        if (parsed.data.toolIds) c.hostedTools.bind(row.id, parsed.data.toolIds);
        return row;
      });
      return reply.code(201).send({ service: presentService(c, row) });
    } catch (e) {
      const mapped = serviceValidationError(e);
      if (mapped) return reply.code(mapped.status).send(mapped.body);
      throw e;
    }
  });

  app.patch("/:id", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!c.services.get(id)) return reply.code(404).send({ error: "not found" });
    const parsed = parse(ServiceUpdate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    if (parsed.data.toolIds !== undefined && !requireAdmin(req, reply, "bind hosted tools")) return;
    try {
      const patch: { name?: string; description?: string | null; definition?: ServiceDef; enabled?: boolean } = {
        name: parsed.data.name,
        description: parsed.data.description,
        enabled: parsed.data.enabled,
      };
      if (parsed.data.steps !== undefined) patch.definition = c.validator.validate(parsed.data.steps).def;
      const effective = patch.definition ?? c.services.def(c.services.get(id)!);
      if ((parsed.data.toolIds ?? c.hostedTools.boundIds(id)).length && !isChatPipeline(serviceCategory(effective))) return reply.code(400).send({ error: "Hosted tools require a chat service" });
      const row = c.db.transaction(() => {
        const row = c.services.update(id, patch);
        if (parsed.data.toolIds) c.hostedTools.bind(id, parsed.data.toolIds);
        return row;
      });
      return { service: row ? presentService(c, row) : null };
    } catch (e) {
      const mapped = serviceValidationError(e);
      if (mapped) return reply.code(mapped.status).send(mapped.body);
      throw e;
    }
  });

  app.delete("/:id", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!c.services.get(id)) return reply.code(404).send({ error: "not found" });
    c.services.delete(id);
    return { ok: true };
  });

  // Dry-run: fire a small request through a service (saved id or ad-hoc steps).
  app.post("/test", async (req, reply) => {
    const body = (req.body ?? {}) as { serviceId?: number; steps?: unknown; prompt?: string };
    let def: ServiceDef;
    try {
      if (body.serviceId) {
        const row = c.services.get(body.serviceId);
        if (!row) return reply.code(404).send({ error: "Model Service not found" });
        def = c.services.def(row);
      } else {
        def = c.validator.validate(body.steps).def;
      }
    } catch (e) {
      const mapped = serviceValidationError(e);
      if (mapped) return reply.code(mapped.status).send(mapped.body);
      throw e;
    }

    // The dry-run fires a chat request; media categories speak other shapes.
    if (!isChatPipeline(serviceCategory(def))) {
      return reply.code(400).send({ error: `dry-run supports chat-pipeline services only (this is a ${serviceCategory(def)} service)` });
    }

    const { executor } = c.factory.buildDef(def);
    const request = buildRequest("openai_completion", {
      requestedService: "(dry-run)",
      messages: [{ role: "user", content: [{ type: "text", text: body.prompt || "ping" }] }],
      params: { maxTokens: isAgent(def) ? 64 : 16 },
      stream: false,
    });
    // A dry-run against a slow chain can outlive intermediary idle timeouts
    // (Cloudflare 524s a silent origin at ~100s); heartbeat while it runs.
    // Failures already travel in-body ({ok:false}), so committing 200 early
    // changes nothing semantically.
    return withJsonHeartbeat(reply, c.config.jsonCommitGraceMs, 10_000, async () => {
      const outcome = await executor.invoke(request);
      if (outcome.result.ok) {
        const v = outcome.result.value;
        return { ok: true, attemptPath: outcome.attemptPath, served: { model: v.modelName, provider: v.providerName }, output: textOf(v.response.content).slice(0, 500) };
      }
      return { ok: false, status: outcome.result.status, message: failureMessage(outcome.result), attemptPath: outcome.attemptPath };
    });
  });

  // Dry-run the OCR pre-pass: send one test image through an OCR config and
  // return what the model actually said. The config comes from the editor
  // (possibly unsaved). The image cache is bypassed by construction -- the OCR
  // service is invoked directly, so the test always measures the model.
  app.post("/test-ocr", async (req, reply) => {
    const parsed = parse(OcrTestSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    let ocr: AgentOcr;
    try {
      ocr = AgentOcrSchema.parse(parsed.data.ocr);
    } catch (e) {
      const mapped = serviceValidationError(e);
      if (mapped) return reply.code(mapped.status).send(mapped.body);
      throw e;
    }

    // Resolve the OCR model exactly the way the Micro Agent pre-pass does.
    let executor: ModelService;
    if (ocr.service) {
      const r = c.factory.resolve(ocr.service);
      if (!r.ok) return reply.code(400).send({ error: r.message });
      if (r.isAgent) return reply.code(400).send({ error: `OCR reference "${ocr.service}" must be a Model Service, not a Micro Agent` });
      executor = r.executor;
    } else if (ocr.steps && ocr.steps.length) {
      try {
        const { def } = c.validator.validate({ timeoutMs: ocr.timeoutMs ?? 60_000, steps: ocr.steps });
        executor = c.factory.buildDef(def).executor;
      } catch (e) {
        const mapped = serviceValidationError(e);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw e;
      }
    } else {
      return reply.code(400).send({ error: "image translation (OCR) is enabled but has no model configured" });
    }

    const image: ImagePart = {
      type: "image",
      source: { kind: "base64", mediaType: parsed.data.image.mediaType, data: parsed.data.image.data },
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
    return withJsonHeartbeat(reply, c.config.jsonCommitGraceMs, 10_000, async () => {
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
          raw: raw.slice(0, 20_000),
          attemptPath: outcome.attemptPath,
        };
      }
      return { ok: false, status: outcome.result.status, message: failureMessage(outcome.result), latencyMs, attemptPath: outcome.attemptPath };
    });
  });
}
