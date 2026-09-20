import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../../auth/authorization";
import type { Container } from "../../composition/container";
import { idParam, parse } from "../../util/validate";

// --- tokens -----------------------------------------------------------------

const TokenCreate = z.object({
  name: z.string().min(1).max(120),
  scopeServices: z.array(z.number().int().positive()).nullable().optional(),
  maxRequests: z.number().int().positive().nullable().optional(),
  maxTokens: z.number().int().positive().nullable().optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
});
const TokenUpdate = TokenCreate.partial();

export async function tokenRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/", async () => ({ tokens: c.tokens.list().map((t) => c.tokens.toPublic(t)) }));

  app.post("/", async (req, reply) => {
    if (!requireAdmin(req, reply, "issue API keys")) return reply;
    const parsed = parse(TokenCreate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const { token, secret } = c.tokens.create({ ...parsed.data, ownerUserId: req.user.uid });
    return reply.code(201).send({ token: c.tokens.toPublic(token), secret });
  });

  // Re-reveal an issued key. Admin-gated like issuing; tokens from before the
  // secret was stored (hash-only) have nothing to reveal. A POST rather than a
  // GET so the secret cannot be collected from an intermediate's access log.
  app.post("/:id/secret", async (req, reply) => {
    if (!requireAdmin(req, reply, "reveal API keys")) return reply;
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!c.tokens.get(id)) return reply.code(404).send({ error: "not found" });
    const secret = c.tokens.revealSecret(id);
    if (secret == null) return reply.code(409).send({ error: "key issued before stored keys; revoke and reissue to make it copyable" });
    return { secret };
  });

  // Mutations are admin-gated like issuing and revealing: a token's scope and
  // enabled flag decide who can spend which provider, so altering or revoking
  // someone else's key is not a manager-level action.
  app.patch("/:id", async (req, reply) => {
    if (!requireAdmin(req, reply, "modify API keys")) return reply;
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!c.tokens.get(id)) return reply.code(404).send({ error: "not found" });
    const parsed = parse(TokenUpdate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const token = c.tokens.update(id, parsed.data);
    return { token: token ? c.tokens.toPublic(token) : null };
  });

  app.delete("/:id", async (req, reply) => {
    if (!requireAdmin(req, reply, "delete API keys")) return reply;
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!c.tokens.get(id)) return reply.code(404).send({ error: "not found" });
    c.tokens.delete(id);
    return { ok: true };
  });
}
