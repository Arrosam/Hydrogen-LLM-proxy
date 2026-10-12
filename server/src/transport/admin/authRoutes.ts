import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../../auth/middleware";
import { clearSessionCookie, ERR_UNAUTHORIZED, issueSessionCookie } from "../../auth/session";
import type { Container } from "../../composition/container";
import { HTTP_STATUS } from "../../util/httpStatus";
import { MIN_PASSWORD_LENGTH } from "../limits";
import { LOGIN_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW } from "../rateLimits";
import { badRequest, notFound, parseBody } from "./replies";

// --- auth -------------------------------------------------------------------

const LoginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });
const ChangePasswordSchema = z.object({
  newPassword: z.string().min(MIN_PASSWORD_LENGTH, `new password must be at least ${MIN_PASSWORD_LENGTH} characters`),
  currentPassword: z.string().optional(),
});

export async function authRoutes(app: FastifyInstance, c: Container, sessionGuard: ReturnType<typeof requireSession>): Promise<void> {
  app.get("/setup-info", async () => {
    return { initial: null };
  });

  app.post("/login", { config: { rateLimit: { max: LOGIN_RATE_LIMIT_MAX, timeWindow: RATE_LIMIT_WINDOW } } }, async (req, reply) => {
    const data = parseBody(LoginSchema, req, reply);
    if (!data) return reply;
    const user = await c.users.verifyLogin(data.username, data.password);
    if (!user) return reply.code(HTTP_STATUS.UNAUTHORIZED).send({ error: "invalid credentials" });
    issueSessionCookie(req, reply, { uid: user.id, username: user.username, role: user.role, passwordChangeOnly: user.mustChangePassword }, c.settings.sessionTtlMs());
    return { user: c.users.toPublic(user) };
  });

  app.post("/logout", async (_req, reply) => {
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/me", { preHandler: sessionGuard }, async (req, reply) => {
    const user = req.user ? c.users.get(req.user.uid) : undefined;
    if (!user) return reply.code(HTTP_STATUS.UNAUTHORIZED).send({ error: ERR_UNAUTHORIZED });
    return { user: c.users.toPublic(user) };
  });

  app.post("/change-password", { preHandler: sessionGuard }, async (req, reply) => {
    const data = parseBody(ChangePasswordSchema, req, reply);
    if (!data) return reply;
    const result = await c.users.changeOwnPassword(req.user!.uid, data.newPassword, data.currentPassword);
    if (result === "not_found") return notFound(reply, "user not found");
    if (result === "wrong_current") return badRequest(reply, "current password is incorrect");
    const user = c.users.get(req.user!.uid);
    if (user) issueSessionCookie(req, reply, { uid: user.id, username: user.username, role: user.role }, c.settings.sessionTtlMs());
    return { user: user ? c.users.toPublic(user) : null };
  });
}
