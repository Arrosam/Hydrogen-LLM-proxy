import type { FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { getConfig } from "../context";
import { MS_PER_SECOND } from "../util/time";

export const SESSION_COOKIE = "hydrogen_session";
/** Path the session cookie is set on; clearing it must name the same path. */
export const SESSION_COOKIE_PATH = "/";

/** Dashboard user roles (the values of the users.role column). */
export const ROLE = { ADMIN: "admin", MANAGER: "manager" } as const;

/** Shared by the session preHandler and the auth routes. */
export const ERR_UNAUTHORIZED = "unauthorized";

export interface SessionPayload {
  uid: number;
  /** Setup-only sessions cannot become privileged after another session changes the password. */
  passwordChangeOnly?: boolean;
  username: string;
  role: "admin" | "manager";
  /** Issued-at, seconds since epoch (set by jwt on sign; present after verify).
   * Used to reject sessions minted before an instance-wide invalidation. */
  iat?: number;
}

/**
 * `ttlMs` is the session lifetime in force when the session is issued: the
 * runtime setting (settings.sessionTtlMs(), which itself falls back to the
 * boot-time value) where a caller has it, the boot-time SESSION_TTL otherwise.
 */
export function signSession(payload: SessionPayload, ttlMs: number = getConfig().sessionTtlMs): string {
  return jwt.sign(payload, getConfig().sessionSecret, {
    expiresIn: Math.floor(ttlMs / MS_PER_SECOND),
  });
}

export function verifySession(token: string): SessionPayload | null {
  try {
    const decoded = jwt.verify(token, getConfig().sessionSecret) as jwt.JwtPayload;
    if (typeof decoded.uid !== "number") return null;
    return {
      uid: decoded.uid,
      passwordChangeOnly: decoded.passwordChangeOnly === true,
      username: String(decoded.username),
      role: decoded.role === ROLE.ADMIN ? ROLE.ADMIN : ROLE.MANAGER,
      iat: typeof decoded.iat === "number" ? decoded.iat : undefined,
    };
  } catch {
    return null;
  }
}

/** Resolve whether the session cookie should carry the Secure flag. */
export function resolveCookieSecure(isHttps: boolean): boolean {
  switch (getConfig().cookieSecure) {
    case "true":
      return true;
    case "false":
      return false;
    default:
      return isHttps; // "auto"
  }
}

export function cookieOptions(secure: boolean, ttlMs: number = getConfig().sessionTtlMs): {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: SESSION_COOKIE_PATH,
    maxAge: Math.floor(ttlMs / MS_PER_SECOND),
  };
}

/** Sign `payload` and set it as the session cookie on `reply`; the token and
 * the cookie expire together, after `ttlMs`. */
export function issueSessionCookie(req: { protocol: string }, reply: FastifyReply, payload: SessionPayload, ttlMs?: number): void {
  reply.setCookie(SESSION_COOKIE, signSession(payload, ttlMs), cookieOptions(resolveCookieSecure(req.protocol === "https"), ttlMs));
}

/** Clear the session cookie; names the path it was set on, or it would stay. */
export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: SESSION_COOKIE_PATH });
}
