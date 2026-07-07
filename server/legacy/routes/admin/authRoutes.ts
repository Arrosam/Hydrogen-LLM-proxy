import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse } from "../../util/validate";
import {
  changeOwnPassword,
  getInitialCredentialHint,
  toPublicUser,
  verifyLogin,
  getUser,
} from "../../services/users";
import { DEFAULT_ADMIN_PASSWORD } from "../../db/bootstrap";
import { cookieOptions, resolveCookieSecure, SESSION_COOKIE, signSession } from "../../auth/session";
import { requireSession } from "../../auth/middleware";

const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const ChangePasswordSchema = z.object({
  newPassword: z.string().min(8, "new password must be at least 8 characters"),
  currentPassword: z.string().optional(),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Public: lets the login page hint the initial credentials on a fresh install.
  app.get("/setup-info", async () => {
    const hint = getInitialCredentialHint();
    return {
      initial: hint ? { username: hint.username, password: DEFAULT_ADMIN_PASSWORD } : null,
    };
  });

  app.post("/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = parse(LoginSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });

    const user = await verifyLogin(parsed.data.username, parsed.data.password);
    if (!user) return reply.code(401).send({ error: "invalid credentials" });

    const token = signSession({ uid: user.id, username: user.username, role: user.role });
    reply.setCookie(SESSION_COOKIE, token, cookieOptions(resolveCookieSecure(req.protocol === "https")));
    return { user: toPublicUser(user) };
  });

  app.post("/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/me", { preHandler: requireSession }, async (req, reply) => {
    const user = req.user ? getUser(req.user.uid) : undefined;
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    return { user: toPublicUser(user) };
  });

  app.post("/change-password", { preHandler: requireSession }, async (req, reply) => {
    const parsed = parse(ChangePasswordSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const result = await changeOwnPassword(
      req.user!.uid,
      parsed.data.newPassword,
      parsed.data.currentPassword,
    );
    if (result === "not_found") return reply.code(404).send({ error: "user not found" });
    if (result === "wrong_current") return reply.code(400).send({ error: "current password is incorrect" });
    const user = getUser(req.user!.uid);
    return { user: user ? toPublicUser(user) : null };
  });
}
