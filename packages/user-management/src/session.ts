import jwt from "jsonwebtoken";

export const SESSION_COOKIE = "hydrogen_session";

export interface SessionPayload {
  uid: number;
  username: string;
  role: "admin" | "manager";
  /** Issued-at, seconds since epoch (set by jwt on sign; present after verify).
   * Used to reject sessions minted before an instance-wide invalidation. */
  iat?: number;
}

export interface SessionOptions {
  /** Signs the session JWT. Any long random string, at least 16 characters. */
  secret: string;
  /** How long a session stays valid. */
  ttlMs: number;
  /** Cookie Secure flag: "auto" sets it only on HTTPS requests. Default "auto". */
  cookieSecure?: "auto" | "true" | "false";
}

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
}

/**
 * Dashboard sessions: a signed JWT carried either in the session cookie or in
 * an `Authorization: Bearer` header. The same token works in both places, so a
 * script can log in through the same endpoint the console uses and drive the
 * admin API without a cookie jar.
 */
export class Sessions {
  constructor(private readonly opts: SessionOptions) {
    if (opts.secret.length < 16) throw new Error("session secret must be at least 16 characters");
  }

  get ttlMs(): number {
    return this.opts.ttlMs;
  }

  sign(payload: SessionPayload): string {
    return jwt.sign(payload, this.opts.secret, { expiresIn: Math.floor(this.opts.ttlMs / 1000) });
  }

  verify(token: string): SessionPayload | null {
    try {
      const decoded = jwt.verify(token, this.opts.secret) as jwt.JwtPayload;
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
  resolveCookieSecure(isHttps: boolean): boolean {
    switch (this.opts.cookieSecure ?? "auto") {
      case "true":
        return true;
      case "false":
        return false;
      default:
        return isHttps; // "auto"
    }
  }

  cookieOptions(secure: boolean): SessionCookieOptions {
    return {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: Math.floor(this.opts.ttlMs / 1000),
    };
  }
}

/** The session token presented on a request: the bearer header first, then the cookie. */
export function extractSessionToken(
  headers: Record<string, string | string[] | undefined>,
  cookies: Record<string, string | undefined> | undefined,
): string | null {
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  const c = cookies?.[SESSION_COOKIE];
  return c ? c : null;
}
