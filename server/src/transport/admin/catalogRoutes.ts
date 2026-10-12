import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../composition/container";
import { FAMILIES } from "../../core/ir/params";
import { HTTP_STATUS } from "../../util/httpStatus";
import { MAX_NAME_LENGTH } from "../limits";
import { badRequest, conflict, loadById, notFound, parseBody, requireId } from "./replies";
import { PositiveIntSchema } from "../../util/validate";

// --- catalog (models + mappings) --------------------------------------------

const ModelCreate = z.object({ name: z.string().min(1).max(MAX_NAME_LENGTH), description: z.string().nullable().optional(), enabled: z.boolean().optional() });
const ModelUpdate = ModelCreate.partial();
const FamiliesSchema = z.array(z.enum(FAMILIES)).max(FAMILIES.length).nullable().optional();
const MappingCreate = z.object({
  modelId: PositiveIntSchema,
  providerId: PositiveIntSchema,
  upstreamModel: z.string().min(1),
  families: FamiliesSchema,
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
});
const MappingUpdate = MappingCreate.omit({ modelId: true, providerId: true }).partial();

export async function catalogRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/models", async () => ({ models: c.models.list() }));
  app.post("/models", async (req, reply) => {
    const data = parseBody(ModelCreate, req, reply);
    if (!data) return reply;
    return reply.code(HTTP_STATUS.CREATED).send({ model: c.models.create(data) });
  });
  app.patch("/models/:id", async (req, reply) => {
    const hit = loadById(req, reply, (id) => c.models.get(id));
    if (!hit) return reply;
    const data = parseBody(ModelUpdate, req, reply);
    if (!data) return reply;
    return { model: c.models.update(hit.id, data) };
  });
  app.delete("/models/:id", async (req, reply) => {
    const hit = loadById(req, reply, (id) => c.models.get(id));
    if (!hit) return reply;
    c.models.delete(hit.id);
    return { ok: true };
  });

  /** Every provider's discovered model list, for the mapping picker. Providers
   * are few, so one call beats a request per provider. */
  app.get("/provider-models", async () => ({ providerModels: c.providerModels.grouped() }));

  app.get("/mappings", async () => ({ mappings: c.mappings.list() }));
  app.post("/mappings", async (req, reply) => {
    const data = parseBody(MappingCreate, req, reply);
    if (!data) return reply;
    const { modelId, providerId } = data;
    if (!c.models.get(modelId)) return badRequest(reply, "model not found");
    if (!c.providers.get(providerId)) return badRequest(reply, "provider not found");
    if (c.mappings.listForModel(modelId).some((m) => m.providerId === providerId)) {
      return conflict(reply, "this model is already mapped to that provider");
    }
    return reply.code(HTTP_STATUS.CREATED).send({ mapping: c.mappings.create(data) });
  });
  app.patch("/mappings/:id", async (req, reply) => {
    const id = requireId(req, reply);
    if (!id) return reply;
    const data = parseBody(MappingUpdate, req, reply);
    if (!data) return reply;
    const mapping = c.mappings.update(id, data);
    if (!mapping) return notFound(reply);
    return { mapping };
  });
  app.delete("/mappings/:id", async (req, reply) => {
    const id = requireId(req, reply);
    if (!id) return reply;
    c.mappings.delete(id);
    return { ok: true };
  });
}
