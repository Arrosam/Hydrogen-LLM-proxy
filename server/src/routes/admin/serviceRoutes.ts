import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ZodError } from "zod";
import { parse, toId } from "../../util/validate";
import {
  createService,
  deleteService,
  getService,
  getServiceDef,
  listServices,
  ServiceValidationError,
  resolveAgentStage,
  updateService,
  validateService,
} from "../../services/services";
import { isAgent, summarizeService, type ServiceDef } from "../../core/services/schema";
import { runServiceJson } from "../../core/proxy/run";
import { runAgent } from "../../core/agents/engine";
import { extractUpstreamMessage } from "../../core/proxy/errors";
import { textOf, type IRRequest } from "../../core/ir";
import type { ModelService } from "../../db/schema";

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().nullable().optional(),
  steps: z.unknown(),
  enabled: z.boolean().optional(),
});
const UpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().nullable().optional(),
  steps: z.unknown().optional(),
  enabled: z.boolean().optional(),
});

function present(m: ModelService): Record<string, unknown> {
  let summary = "";
  try {
    summary = summarizeService(getServiceDef(m));
  } catch {
    summary = "(invalid steps)";
  }
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    steps: m.steps,
    enabled: m.enabled,
    summary,
    createdAt: m.createdAt instanceof Date ? m.createdAt.getTime() : Number(m.createdAt),
  };
}

/** Map validation errors (schema or catalog) to a 400 with a helpful message. */
function validationError(e: unknown): { status: number; body: Record<string, unknown> } | null {
  if (e instanceof ServiceValidationError) {
    return { status: 400, body: { error: e.message, invalidPairs: e.invalidPairs } };
  }
  if (e instanceof ZodError) {
    const msg = e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { status: 400, body: { error: `invalid steps: ${msg}` } };
  }
  return null;
}

export async function serviceRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => ({ services: listServices().map(present) }));

  app.post("/validate", async (req, reply) => {
    const body = (req.body ?? {}) as { steps?: unknown };
    try {
      const { def, summary } = validateService(body.steps);
      const kind = isAgent(def) ? "agent" : "resilience";
      const count = isAgent(def) ? def.stages.length : def.steps.length;
      return { valid: true, summary, kind, count };
    } catch (e) {
      const mapped = validationError(e);
      if (mapped) return reply.code(200).send({ valid: false, ...mapped.body });
      throw e;
    }
  });

  app.post("/", async (req, reply) => {
    const parsed = parse(CreateSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    try {
      return reply.code(201).send({ service: present(createService(parsed.data)) });
    } catch (e) {
      const mapped = validationError(e);
      if (mapped) return reply.code(mapped.status).send(mapped.body);
      throw e;
    }
  });

  app.patch("/:id", async (req, reply) => {
    const id = toId((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!getService(id)) return reply.code(404).send({ error: "not found" });
    const parsed = parse(UpdateSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    try {
      const service = updateService(id, parsed.data);
      return { service: service ? present(service) : null };
    } catch (e) {
      const mapped = validationError(e);
      if (mapped) return reply.code(mapped.status).send(mapped.body);
      throw e;
    }
  });

  app.delete("/:id", async (req, reply) => {
    const id = toId((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!getService(id)) return reply.code(404).send({ error: "not found" });
    deleteService(id);
    return { ok: true };
  });

  // Dry-run: fire a small request through a service (saved id or ad-hoc steps).
  app.post("/test", async (req, reply) => {
    const body = (req.body ?? {}) as { serviceId?: number; steps?: unknown; prompt?: string };
    let def: ServiceDef;
    try {
      if (body.serviceId) {
        const service = getService(body.serviceId);
        if (!service) return reply.code(404).send({ error: "Model Service not found" });
        def = getServiceDef(service);
      } else {
        def = validateService(body.steps).def;
      }
    } catch (e) {
      const mapped = validationError(e);
      if (mapped) return reply.code(mapped.status).send(mapped.body);
      throw e;
    }

    const ir: IRRequest = {
      requestedModel: "(dry-run)",
      messages: [{ role: "user", content: [{ type: "text", text: body.prompt || "ping" }] }],
      maxTokens: isAgent(def) ? 64 : 16,
      stream: false,
    };

    const { result, path } = isAgent(def)
      ? await runAgent(ir, def, resolveAgentStage)
      : await runServiceJson(ir, def);
    if (result.ok) {
      return {
        ok: true,
        attemptPath: path,
        served: { model: result.value.modelName, provider: result.value.providerName },
        output: textOf(result.value.ir.content).slice(0, 500),
      };
    }
    return {
      ok: false,
      status: result.status,
      message: extractUpstreamMessage(result.errorBody) ?? result.message,
      attemptPath: path,
    };
  });
}