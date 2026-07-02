import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse, toId } from "../../util/validate";
import {
  createModel,
  deleteModel,
  getModel,
  listModels,
  updateModel,
} from "../../services/models";
import {
  createMapping,
  deleteMapping,
  listMappings,
  listMappingsForModel,
  updateMapping,
} from "../../services/catalog";
import { getProvider } from "../../services/providers";

const ModelCreate = z.object({
  name: z.string().min(1).max(120),
  description: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});
const ModelUpdate = ModelCreate.partial();

const MappingCreate = z.object({
  modelId: z.number().int().positive(),
  providerId: z.number().int().positive(),
  upstreamModel: z.string().min(1),
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
});
const MappingUpdate = z.object({
  upstreamModel: z.string().min(1).optional(),
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
});

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  // --- models ---
  app.get("/models", async () => ({ models: listModels() }));

  app.post("/models", async (req, reply) => {
    const parsed = parse(ModelCreate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    return reply.code(201).send({ model: createModel(parsed.data) });
  });

  app.patch("/models/:id", async (req, reply) => {
    const id = toId((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!getModel(id)) return reply.code(404).send({ error: "not found" });
    const parsed = parse(ModelUpdate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    return { model: updateModel(id, parsed.data) };
  });

  app.delete("/models/:id", async (req, reply) => {
    const id = toId((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!getModel(id)) return reply.code(404).send({ error: "not found" });
    deleteModel(id);
    return { ok: true };
  });

  // --- model <-> provider mappings ---
  app.get("/mappings", async () => ({ mappings: listMappings() }));

  app.post("/mappings", async (req, reply) => {
    const parsed = parse(MappingCreate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const { modelId, providerId } = parsed.data;
    if (!getModel(modelId)) return reply.code(400).send({ error: "model not found" });
    if (!getProvider(providerId)) return reply.code(400).send({ error: "provider not found" });
    const dup = listMappingsForModel(modelId).some((m) => m.providerId === providerId);
    if (dup) return reply.code(409).send({ error: "this model is already mapped to that provider" });
    return reply.code(201).send({ mapping: createMapping(parsed.data) });
  });

  app.patch("/mappings/:id", async (req, reply) => {
    const id = toId((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    const parsed = parse(MappingUpdate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const mapping = updateMapping(id, parsed.data);
    if (!mapping) return reply.code(404).send({ error: "not found" });
    return { mapping };
  });

  app.delete("/mappings/:id", async (req, reply) => {
    const id = toId((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    deleteMapping(id);
    return { ok: true };
  });
}
