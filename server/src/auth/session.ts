import jwt from "jsonwebtoken";
import { getConfig } from "../context";

export const SESSION_COOKIE = "hydrogen_session";

export interface SessionPayload {
  uid: number;
  username: string;
  role: "admin" | "manager";
  /** Issued-at, seconds since epoch (set by jwt on sign; present after verify).
   * Used to reject sessions minted before an instance-wide invalidation. */
  iat?: number;
}

export function signSession(payload: SessionPayload): string {
  const cfg = getConfig();
  return jwt.sign(payload, cfg.sessionSecret, {
    expiresIn: Math.floor(cfg.sessionTtlMs / 1000),
  });
}

export function verifySession(token: string): SessionPayload | null {
  try {
    const decoded = jwt.verify(token, getConfig().sessionSecret) as jwt.JwtPayload;
    if (typeof decoded.uid !== "number") return null;
    return {
      uid: decoded.uid,
      username: String(decoded.username),
      role: decoded.role === "admin" ? "admin" : "manager",
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

export function cookieOptions(secure: boolean): {
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
    maxAge: Math.floor(getConfig().sessionTtlMs / 1000),
  };
}
