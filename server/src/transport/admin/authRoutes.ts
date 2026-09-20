import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../../auth/middleware";
import { cookieOptions, resolveCookieSecure, SESSION_COOKIE, signSession } from "../../auth/session";
import type { Container } from "../../composition/container";
import { parse } from "../../util/validate";

// --- auth -------------------------------------------------------------------

const LoginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });
const ChangePasswordSchema = z.object({
  newPassword: z.string().min(8, "new password must be at least 8 characters"),
  currentPassword: z.string().optional(),
});

export async function authRoutes(app: FastifyInstance, c: Container, sessionGuard: ReturnType<typeof requireSession>): Promise<void> {
  app.get("/setup-info", async () => {
    return { initial: null };
  });

  app.post("/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = parse(LoginSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const user = await c.users.verifyLogin(parsed.data.username, parsed.data.password);
    if (!user) return reply.code(401).send({ error: "invalid credentials" });
    const token = signSession({ uid: user.id, username: user.username, role: user.role, passwordChangeOnly: user.mustChangePassword });
    reply.setCookie(SESSION_COOKIE, token, cookieOptions(resolveCookieSecure(req.protocol === "https")));
    return { user: c.users.toPublic(user) };
  });

  app.post("/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/me", { preHandler: sessionGuard }, async (req, reply) => {
    const user = req.user ? c.users.get(req.user.uid) : undefined;
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    return { user: c.users.toPublic(user) };
  });

  app.post("/change-password", { preHandler: sessionGuard }, async (req, reply) => {
    const parsed = parse(ChangePasswordSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const result = await c.users.changeOwnPassword(req.user!.uid, parsed.data.newPassword, parsed.data.currentPassword);
    if (result === "not_found") return reply.code(404).send({ error: "user not found" });
    if (result === "wrong_current") return reply.code(400).send({ error: "current password is incorrect" });
    const user = c.users.get(req.user!.uid);
    if (user) {
      const token = signSession({ uid: user.id, username: user.username, role: user.role });
      reply.setCookie(SESSION_COOKIE, token, cookieOptions(resolveCookieSecure(req.protocol === "https")));
    }
    return { user: user ? c.users.toPublic(user) : null };
  });
}
