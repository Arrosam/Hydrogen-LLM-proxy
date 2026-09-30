import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../../auth/authorization";
import type { Container } from "../../composition/container";
import { idParam, parse } from "../../util/validate";

// --- users ------------------------------------------------------------------

const RoleSchema = z.enum(["admin", "manager"]);
const UserCreate = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(8, "password must be at least 8 characters"),
  role: RoleSchema.default("manager"),
  enabled: z.boolean().optional(),
});
const UserUpdate = z.object({ role: RoleSchema.optional(), enabled: z.boolean().optional(), password: z.string().min(8).optional() });

/** User management is admin-only in its entirety: managers cannot even list
 * accounts. (A manager still changes their own password via /auth.) */
export async function userRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/", async (req, reply) => {
    if (!requireAdmin(req, reply, "view users")) return reply;
    return { users: c.users.list().map((u) => c.users.toPublic(u)) };
  });

  app.post("/", async (req, reply) => {
    if (!requireAdmin(req, reply, "create users")) return reply;
    const parsed = parse(UserCreate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    if (c.users.getByUsername(parsed.data.username)) return reply.code(409).send({ error: "username already exists" });
    const user = await c.users.create(parsed.data);
    return reply.code(201).send({ user: c.users.toPublic(user) });
  });

  app.patch("/:id", async (req, reply) => {
    if (!requireAdmin(req, reply, "modify users")) return reply;
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    const target = c.users.get(id);
    if (!target) return reply.code(404).send({ error: "not found" });
    const parsed = parse(UserUpdate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    if (req.user.uid === id && parsed.data.enabled === false) {
      return reply.code(400).send({ error: "you cannot deactivate your own account" });
    }
    if ((parsed.data.role === "manager" || parsed.data.enabled === false) && target.role === "admin") {
      const admins = c.users.list().filter((u) => u.role === "admin" && u.enabled);
      if (admins.length <= 1 && admins[0]?.id === id) {
        return reply.code(400).send({ error: "cannot deactivate or demote the last admin" });
      }
    }
    const user = await c.users.update(id, parsed.data);
    return { user: user ? c.users.toPublic(user) : null };
  });

  app.delete("/:id", async (req, reply) => {
    if (!requireAdmin(req, reply, "delete users")) return reply;
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    const target = c.users.get(id);
    if (!target) return reply.code(404).send({ error: "not found" });
    if (target.role === "admin") {
      const admins = c.users.list().filter((u) => u.role === "admin");
      if (admins.length <= 1) return reply.code(400).send({ error: "cannot delete the last admin" });
    }
    if (req.user.uid === id) return reply.code(400).send({ error: "cannot delete your own account" });
    c.users.delete(id);
    return { ok: true };
  });
}
