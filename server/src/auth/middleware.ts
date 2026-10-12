import type { FastifyReply, FastifyRequest } from "fastify";
import { ERR_UNAUTHORIZED, SESSION_COOKIE, verifySession, type SessionPayload } from "./session";
import type { UserRepo } from "../persistence/userRepo";
import type { Token } from "../db/schema";
import { ADMIN_API_PREFIX } from "../transport/routes";
import { HTTP_STATUS } from "../util/httpStatus";
import { MS_PER_SECOND } from "../util/time";

const ERR_SESSION_EXPIRED = "session expired, please sign in again";
/** The only routes a session that must change its password may call. */
const ME_ROUTE = `${ADMIN_API_PREFIX}/me`;
const CHANGE_PASSWORD_ROUTE = `${ADMIN_API_PREFIX}/change-password`;

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
 *
 * `sessionFloorMs` returns an instance-wide cutoff: any session issued before it
 * is rejected even if otherwise valid. A restore replaces the whole users table,
 * so a still-valid JWT would otherwise rebind by uid to whatever account now
 * holds that id -- bumping the floor invalidates every session at once.
 */
export function requireSession(users: UserRepo, sessionFloorMs: () => number = () => 0) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const deny = async (status: number, message: string): Promise<void> => {
      await reply.code(status).send({ error: message });
    };
    const raw = req.cookies?.[SESSION_COOKIE];
    const session = raw ? verifySession(raw) : null;
    if (!session) return deny(HTTP_STATUS.UNAUTHORIZED, ERR_UNAUTHORIZED);
    // jwt iat is whole seconds. Kill every session issued in the floor's second
    // or earlier (<=, not <): a restore and a victim's login can fall in the same
    // second, and the security guarantee is that NO pre-restore session survives.
    // The floor is 0 until a restore sets it, so live sessions are untouched.
    const floorSec = Math.floor(sessionFloorMs() / MS_PER_SECOND);
    if (floorSec > 0 && session.iat != null && session.iat <= floorSec) return deny(HTTP_STATUS.UNAUTHORIZED, ERR_SESSION_EXPIRED);
    const user = users.get(session.uid);
    if (!user || !user.enabled) return deny(HTTP_STATUS.UNAUTHORIZED, ERR_UNAUTHORIZED);
    if (user.mustChangePassword || session.passwordChangeOnly) {
      const setupRoute = req.routeOptions.url;
      if (setupRoute !== ME_ROUTE && setupRoute !== CHANGE_PASSWORD_ROUTE) return deny(HTTP_STATUS.FORBIDDEN, "password change required");
      if (session.passwordChangeOnly && !user.mustChangePassword) return deny(HTTP_STATUS.UNAUTHORIZED, ERR_SESSION_EXPIRED);
    }
    req.user = { uid: user.id, username: user.username, role: user.role };
  };
}
