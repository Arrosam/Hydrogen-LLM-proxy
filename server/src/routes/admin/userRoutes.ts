import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse, toId } from "../../util/validate";
import {
  createUser,
  deleteUser,
  getUser,
  getUserByUsername,
  listUsers,
  toPublicUser,
  updateUser,
} from "../../services/users";

const RoleSchema = z.enum(["admin", "manager"]);

const CreateSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(8, "password must be at least 8 characters"),
  role: RoleSchema.default("manager"),
  enabled: z.boolean().optional(),
});

const UpdateSchema = z.object({
  role: RoleSchema.optional(),
  enabled: z.boolean().optional(),
  password: z.string().min(8).optional(),
});

/**
 * Managers may do everything except issue tokens; to avoid privilege
 * escalation they still cannot create/modify/delete admin accounts.
 */
export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (req) => {
    void req;
    return { users: listUsers().map(toPublicUser) };
  });

  app.post("/", async (req, reply) => {
    const parsed = parse(CreateSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const actor = req.user!;
    if (parsed.data.role === "admin" && actor.role !== "admin") {
      return reply.code(403).send({ error: "only an admin can create admin users" });
    }
    if (getUserByUsername(parsed.data.username)) {
      return reply.code(409).send({ error: "username already exists" });
    }
    const user = await createUser(parsed.data);
    return reply.code(201).send({ user: toPublicUser(user) });
  });

  app.patch("/:id", async (req, reply) => {
    const id = toId((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    const target = getUser(id);
    if (!target) return reply.code(404).send({ error: "not found" });

    const parsed = parse(UpdateSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const actor = req.user!;

    if (actor.role !== "admin") {
      if (target.role === "admin") {
        return reply.code(403).send({ error: "managers cannot modify admin users" });
      }
      if (parsed.data.role === "admin") {
        return reply.code(403).send({ error: "managers cannot promote users to admin" });
      }
    }

    // You cannot deactivate your own account.
    if (actor.uid === id && parsed.data.enabled === false) {
      return reply.code(400).send({ error: "you cannot deactivate your own account" });
    }

    // Prevent demoting/disabling the last remaining admin.
    if ((parsed.data.role === "manager" || parsed.data.enabled === false) && target.role === "admin") {
      const admins = listUsers().filter((u) => u.role === "admin" && u.enabled);
      if (admins.length <= 1 && admins[0]?.id === id) {
        return reply.code(400).send({ error: "cannot deactivate or demote the last admin" });
      }
    }

    const user = await updateUser(id, parsed.data);
    return { user: user ? toPublicUser(user) : null };
  });

  app.delete("/:id", async (req, reply) => {
    const id = toId((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    const target = getUser(id);
    if (!target) return reply.code(404).send({ error: "not found" });
    const actor = req.user!;

    if (actor.role !== "admin" && target.role === "admin") {
      return reply.code(403).send({ error: "managers cannot delete admin users" });
    }
    if (target.role === "admin") {
      const admins = listUsers().filter((u) => u.role === "admin");
      if (admins.length <= 1) return reply.code(400).send({ error: "cannot delete the last admin" });
    }
    if (actor.uid === id) return reply.code(400).send({ error: "cannot delete your own account" });

    deleteUser(id);
    return { ok: true };
  });
}
