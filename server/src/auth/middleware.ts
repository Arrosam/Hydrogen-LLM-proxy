import type { FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE, verifySession, type SessionPayload } from "./session";
import type { UserRepo } from "../persistence/userRepo";
import type { Token } from "../db/schema";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionPayload;
    clientToken?: Token;
  }
}

/**
 * preHandler factory: require a valid dashboard session cookie. The JWT proves
 * identity, but its role/enabled claims may be stale or forged, so the live user
 * is re-fetched (the DB is the source of truth for authorization). The user repo
 * is injected.
 */
export function requireSession(users: UserRepo) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const raw = req.cookies?.[SESSION_COOKIE];
    const session = raw ? verifySession(raw) : null;
    if (!session) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    const user = users.get(session.uid);
    if (!user || !user.enabled) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    req.user = { uid: user.id, username: user.username, role: user.role };
  };
}
