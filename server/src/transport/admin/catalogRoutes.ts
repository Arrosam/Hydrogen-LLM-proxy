import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../composition/container";
import { FAMILIES } from "../../core/ir/params";
import { idParam, parse } from "../../util/validate";

// --- catalog (models + mappings) --------------------------------------------

const ModelCreate = z.object({ name: z.string().min(1).max(120), description: z.string().nullable().optional(), enabled: z.boolean().optional() });
const ModelUpdate = ModelCreate.partial();
const FamiliesSchema = z.array(z.enum(FAMILIES)).max(FAMILIES.length).nullable().optional();
const MappingCreate = z.object({
  modelId: z.number().int().positive(),
  providerId: z.number().int().positive(),
  upstreamModel: z.string().min(1),
  families: FamiliesSchema,
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
});
const MappingUpdate = z.object({ upstreamModel: z.string().min(1).optional(), families: FamiliesSchema, priority: z.number().int().optional(), enabled: z.boolean().optional() });

export async function catalogRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/models", async () => ({ models: c.models.list() }));
  app.post("/models", async (req, reply) => {
    const parsed = parse(ModelCreate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    return reply.code(201).send({ model: c.models.create(parsed.data) });
  });
  app.patch("/models/:id", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!c.models.get(id)) return reply.code(404).send({ error: "not found" });
    const parsed = parse(ModelUpdate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    return { model: c.models.update(id, parsed.data) };
  });
  app.delete("/models/:id", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!c.models.get(id)) return reply.code(404).send({ error: "not found" });
    c.models.delete(id);
    return { ok: true };
  });

  /** Every provider's discovered model list, for the mapping picker. Providers
   * are few, so one call beats a request per provider. */
  app.get("/provider-models", async () => ({ providerModels: c.providerModels.grouped() }));

  app.get("/mappings", async () => ({ mappings: c.mappings.list() }));
  app.post("/mappings", async (req, reply) => {
    const parsed = parse(MappingCreate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const { modelId, providerId } = parsed.data;
    if (!c.models.get(modelId)) return reply.code(400).send({ error: "model not found" });
    if (!c.providers.get(providerId)) return reply.code(400).send({ error: "provider not found" });
    if (c.mappings.listForModel(modelId).some((m) => m.providerId === providerId)) {
      return reply.code(409).send({ error: "this model is already mapped to that provider" });
    }
    return reply.code(201).send({ mapping: c.mappings.create(parsed.data) });
  });
  app.patch("/mappings/:id", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    const parsed = parse(MappingUpdate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const mapping = c.mappings.update(id, parsed.data);
    if (!mapping) return reply.code(404).send({ error: "not found" });
    return { mapping };
  });
  app.delete("/mappings/:id", async (req, reply) => {
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    c.mappings.delete(id);
    return { ok: true };
  });
}
