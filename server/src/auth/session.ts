import jwt from "jsonwebtoken";
import { createHash } from "node:crypto";
import { getConfig } from "../context";

export const SESSION_COOKIE = "hydrogen_session";

export interface SessionPayload {
  uid: number;
  username: string;
  role: "admin" | "manager";
  /** Issued-at, seconds since epoch (set by jwt on sign; present after verify).
   * Used to reject sessions minted before an instance-wide invalidation. */
  iat?: number;
  /** Opaque password + persisted revocation revision, never the password hash. */
  version?: string;
  /** A first-login session is not a dashboard authorization grant. */
  passwordChangeOnly?: boolean;
}

/** Salted argon2 hashes have high entropy. Digesting one together with a persisted
 * random revision yields an opaque JWT claim without exposing the stored hash. */
export function passwordSessionVersion(userId: number, passwordHash: string, revision: string): string {
  return createHash("sha256").update(JSON.stringify([userId, passwordHash, revision])).digest("base64url");
}

export function signSession(payload: SessionPayload, ttlMs = getConfig().sessionTtlMs): string {
  return jwt.sign(payload, getConfig().sessionSecret, {
    expiresIn: Math.max(0, Math.floor(ttlMs / 1000)),
  });
}

export function verifySession(token: string): SessionPayload | null {
  try {
    const decoded = jwt.verify(token, getConfig().sessionSecret) as jwt.JwtPayload;
    if (!Number.isSafeInteger(decoded.uid) || decoded.uid <= 0 ||
        typeof decoded.username !== "string" || !["admin", "manager"].includes(decoded.role) ||
        typeof decoded.version !== "string" || !decoded.version) return null;
    return {
      uid: decoded.uid,
      username: String(decoded.username),
      role: decoded.role === "admin" ? "admin" : "manager",
      iat: typeof decoded.iat === "number" ? decoded.iat : undefined,
      version: decoded.version,
      passwordChangeOnly: decoded.passwordChangeOnly === true,
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

export function cookieOptions(secure: boolean, ttlMs = getConfig().sessionTtlMs): {
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
    path: "/",
    maxAge: Math.max(0, Math.floor(ttlMs / 1000)),
  };
}
