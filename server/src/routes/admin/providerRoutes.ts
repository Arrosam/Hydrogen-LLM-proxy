import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse, toId } from "../../util/validate";
import {
  createProvider,
  deleteProvider,
  getProvider,
  listProviders,
  testProviderConnection,
  toPublicProvider,
  updateProvider,
} from "../../services/providers";

const TypeSchema = z.enum(["openai", "anthropic", "openai_compatible"]);
const HeadersSchema = z.record(z.string()).nullable().optional();

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  type: TypeSchema,
  baseUrl: z.string().url(),
  apiKey: z.string().nullable().optional(),
  extraHeaders: HeadersSchema,
  enabled: z.boolean().optional(),
});

const UpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  type: TypeSchema.optional(),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().nullable().optional(),
  extraHeaders: HeadersSchema,
  enabled: z.boolean().optional(),
});

export async function providerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => ({ providers: listProviders().map(toPublicProvider) }));

  app.post("/", async (req, reply) => {
    const parsed = parse(CreateSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const provider = createProvider(parsed.data);
    return reply.code(201).send({ provider: toPublicProvider(provider) });
  });

  app.patch("/:id", async (req, reply) => {
    const id = toId((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!getProvider(id)) return reply.code(404).send({ error: "not found" });
    const parsed = parse(UpdateSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const provider = updateProvider(id, parsed.data);
    return { provider: provider ? toPublicProvider(provider) : null };
  });

  app.delete("/:id", async (req, reply) => {
    const id = toId((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!getProvider(id)) return reply.code(404).send({ error: "not found" });
    deleteProvider(id);
    return { ok: true };
  });

  app.post("/:id/test", async (req, reply) => {
    const id = toId((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    const provider = getProvider(id);
    if (!provider) return reply.code(404).send({ error: "not found" });
    const result = await testProviderConnection(provider);
    return result;
  });
}
