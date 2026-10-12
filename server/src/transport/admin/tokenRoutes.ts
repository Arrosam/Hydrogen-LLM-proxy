import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../../auth/authorization";
import type { Container } from "../../composition/container";
import { HTTP_STATUS } from "../../util/httpStatus";
import { MAX_NAME_LENGTH } from "../limits";
import { conflict, loadById, parseBody } from "./replies";
import { PositiveIntSchema } from "../../util/validate";

// --- tokens -----------------------------------------------------------------

const TokenCreate = z.object({
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  scopeServices: z.array(PositiveIntSchema).nullable().optional(),
  maxRequests: PositiveIntSchema.nullable().optional(),
  maxTokens: PositiveIntSchema.nullable().optional(),
  expiresAt: PositiveIntSchema.nullable().optional(),
  enabled: z.boolean().optional(),
});
const TokenUpdate = TokenCreate.partial();

export async function tokenRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/", async () => ({ tokens: c.tokens.list().map((t) => c.tokens.toPublic(t)) }));

  app.post("/", async (req, reply) => {
    if (!requireAdmin(req, reply, "issue API keys")) return reply;
    const data = parseBody(TokenCreate, req, reply);
    if (!data) return reply;
    const { token, secret } = c.tokens.create({ ...data, ownerUserId: req.user.uid });
    return reply.code(HTTP_STATUS.CREATED).send({ token: c.tokens.toPublic(token), secret });
  });

  // Re-reveal an issued key. Admin-gated like issuing; tokens from before the
  // secret was stored (hash-only) have nothing to reveal. A POST rather than a
  // GET so the secret cannot be collected from an intermediate's access log.
  app.post("/:id/secret", async (req, reply) => {
    if (!requireAdmin(req, reply, "reveal API keys")) return reply;
    const hit = loadById(req, reply, (id) => c.tokens.get(id));
    if (!hit) return reply;
    const secret = c.tokens.revealSecret(hit.id);
    if (secret == null) return conflict(reply, "key issued before stored keys; revoke and reissue to make it copyable");
    return { secret };
  });

  // Mutations are admin-gated like issuing and revealing: a token's scope and
  // enabled flag decide who can spend which provider, so altering or revoking
  // someone else's key is not a manager-level action.
  app.patch("/:id", async (req, reply) => {
    if (!requireAdmin(req, reply, "modify API keys")) return reply;
    const hit = loadById(req, reply, (id) => c.tokens.get(id));
    if (!hit) return reply;
    const data = parseBody(TokenUpdate, req, reply);
    if (!data) return reply;
    const token = c.tokens.update(hit.id, data);
    return { token: token ? c.tokens.toPublic(token) : null };
  });

  app.delete("/:id", async (req, reply) => {
    if (!requireAdmin(req, reply, "delete API keys")) return reply;
    const hit = loadById(req, reply, (id) => c.tokens.get(id));
    if (!hit) return reply;
    c.tokens.delete(hit.id);
    return { ok: true };
  });
}
