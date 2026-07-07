import jwt from "jsonwebtoken";
import { getConfig } from "../context";

export const SESSION_COOKIE = "hydrogen_session";

export interface SessionPayload {
  uid: number;
  username: string;
  role: "admin" | "manager";
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
