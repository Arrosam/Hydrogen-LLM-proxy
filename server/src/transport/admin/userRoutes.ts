import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../../auth/authorization";
import { ROLE } from "../../auth/session";
import type { Container } from "../../composition/container";
import { HTTP_STATUS } from "../../util/httpStatus";
import { MIN_PASSWORD_LENGTH } from "../limits";
import { badRequest, conflict, loadById, parseBody } from "./replies";

const MAX_USERNAME_LENGTH = 64;

// --- users ------------------------------------------------------------------

const RoleSchema = z.enum([ROLE.ADMIN, ROLE.MANAGER]);
const PasswordSchema = z.string().min(MIN_PASSWORD_LENGTH, `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
const UserCreate = z.object({
  username: z.string().min(1).max(MAX_USERNAME_LENGTH),
  password: PasswordSchema,
  role: RoleSchema.default(ROLE.MANAGER),
  enabled: z.boolean().optional(),
});
const UserUpdate = z.object({ role: RoleSchema.optional(), enabled: z.boolean().optional(), password: PasswordSchema.optional() });

/** User management is admin-only in its entirety: managers cannot even list
 * accounts. (A manager still changes their own password via /auth.) */
export async function userRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/", async (req, reply) => {
    if (!requireAdmin(req, reply, "view users")) return reply;
    return { users: c.users.list().map((u) => c.users.toPublic(u)) };
  });

  app.post("/", async (req, reply) => {
    if (!requireAdmin(req, reply, "create users")) return reply;
    const data = parseBody(UserCreate, req, reply);
    if (!data) return reply;
    if (c.users.getByUsername(data.username)) return conflict(reply, "username already exists");
    const user = await c.users.create(data);
    return reply.code(HTTP_STATUS.CREATED).send({ user: c.users.toPublic(user) });
  });

  app.patch("/:id", async (req, reply) => {
    if (!requireAdmin(req, reply, "modify users")) return reply;
    const hit = loadById(req, reply, (id) => c.users.get(id));
    if (!hit) return reply;
    const { id, row: target } = hit;
    const data = parseBody(UserUpdate, req, reply);
    if (!data) return reply;
    if (req.user.uid === id && data.enabled === false) {
      return badRequest(reply, "you cannot deactivate your own account");
    }
    if ((data.role === ROLE.MANAGER || data.enabled === false) && target.role === ROLE.ADMIN) {
      const admins = c.users.list().filter((u) => u.role === ROLE.ADMIN && u.enabled);
      if (admins.length <= 1 && admins[0]?.id === id) {
        return badRequest(reply, "cannot deactivate or demote the last admin");
      }
    }
    const user = await c.users.update(id, data);
    return { user: user ? c.users.toPublic(user) : null };
  });

  app.delete("/:id", async (req, reply) => {
    if (!requireAdmin(req, reply, "delete users")) return reply;
    const hit = loadById(req, reply, (id) => c.users.get(id));
    if (!hit) return reply;
    const { id, row: target } = hit;
    if (target.role === ROLE.ADMIN) {
      const admins = c.users.list().filter((u) => u.role === ROLE.ADMIN);
      if (admins.length <= 1) return badRequest(reply, "cannot delete the last admin");
    }
    if (req.user.uid === id) return badRequest(reply, "cannot delete your own account");
    c.users.delete(id);
    return { ok: true };
  });
}
