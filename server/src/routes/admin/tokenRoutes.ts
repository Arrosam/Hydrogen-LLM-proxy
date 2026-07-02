import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse, toId } from "../../util/validate";
import {
  createToken,
  deleteToken,
  getToken,
  listTokens,
  toPublicToken,
  updateToken,
} from "../../services/tokens";

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  scopeMubs: z.array(z.number().int().positive()).nullable().optional(),
  maxRequests: z.number().int().positive().nullable().optional(),
  maxTokens: z.number().int().positive().nullable().optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
});

const UpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  scopeMubs: z.array(z.number().int().positive()).nullable().optional(),
  maxRequests: z.number().int().positive().nullable().optional(),
  maxTokens: z.number().int().positive().nullable().optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
});

export async function tokenRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => ({ tokens: listTokens().map(toPublicToken) }));

  // Issuing (publishing) a token is admin-only.
  app.post("/", async (req, reply) => {
    if (req.user?.role !== "admin") {
      return reply.code(403).send({ error: "only an admin can issue tokens" });
    }
    const parsed = parse(CreateSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const { token, secret } = createToken({ ...parsed.data, ownerUserId: req.user.uid });
    // `secret` is returned exactly once and never stored in plaintext.
    return reply.code(201).send({ token: toPublicToken(token), secret });
  });

  app.patch("/:id", async (req, reply) => {
    const id = toId((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!getToken(id)) return reply.code(404).send({ error: "not found" });
    const parsed = parse(UpdateSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const token = updateToken(id, parsed.data);
    return { token: token ? toPublicToken(token) : null };
  });

  app.delete("/:id", async (req, reply) => {
    const id = toId((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!getToken(id)) return reply.code(404).send({ error: "not found" });
    deleteToken(id);
    return { ok: true };
  });
}
