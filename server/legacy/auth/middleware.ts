import type { FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE, verifySession, type SessionPayload } from "./session";
import { getUser } from "../services/users";
import type { Token } from "../db/schema";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionPayload;
    clientToken?: Token;
  }
}

/** preHandler: require a valid dashboard session cookie. */
export async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = req.cookies?.[SESSION_COOKIE];
  const session = raw ? verifySession(raw) : null;
  if (!session) {
    await reply.code(401).send({ error: "unauthorized" });
    return;
  }
  // The JWT proves identity, but its role/enabled claims may be stale (role
  // changed after issuance) or forged (leaked SESSION_SECRET). Re-fetch the
  // live user so the DB is the source of truth for authorization.
  const user = getUser(session.uid);
  if (!user || !user.enabled) {
    await reply.code(401).send({ error: "unauthorized" });
    return;
  }
  req.user = { uid: user.id, username: user.username, role: user.role };
}
