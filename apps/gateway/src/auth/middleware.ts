import type { FastifyReply, FastifyRequest } from "fastify";
import { extractSessionToken, type SessionPayload, type Sessions, type Token, type UserRepo } from "@areelai/user-management";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionPayload;
    clientToken?: Token;
  }
}

/**
 * preHandler factory: require a valid dashboard session, presented either as
 * the session cookie or as an `Authorization: Bearer` header (the same token
 * works in both places, so scripts need no cookie jar). The JWT proves
 * identity, but its role/enabled claims may be stale or forged, so the live
 * user is re-fetched (the DB is the source of truth for authorization).
 *
 * `sessionFloorMs` returns an instance-wide cutoff: any session issued before it
 * is rejected even if otherwise valid. A restore replaces the whole users table,
 * so a still-valid JWT would otherwise rebind by uid to whatever account now
 * holds that id -- bumping the floor invalidates every session at once.
 */
export function requireSession(users: UserRepo, sessions: Sessions, sessionFloorMs: () => number = () => 0) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const raw = extractSessionToken(req.headers, req.cookies);
    const session = raw ? sessions.verify(raw) : null;
    if (!session) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    // jwt iat is whole seconds. Kill every session issued in the floor's second
    // or earlier (<=, not <): a restore and a victim's login can fall in the same
    // second, and the security guarantee is that NO pre-restore session survives.
    // The floor is 0 until a restore sets it, so live sessions are untouched.
    const floorSec = Math.floor(sessionFloorMs() / 1000);
    if (floorSec > 0 && session.iat != null && session.iat <= floorSec) {
      await reply.code(401).send({ error: "session expired, please sign in again" });
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
