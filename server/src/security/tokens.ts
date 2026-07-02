import crypto from "node:crypto";

export const TOKEN_PREFIX = "sk-hproxy-";

export interface GeneratedToken {
  /** The full secret - shown to the user exactly once, never stored. */
  token: string;
  /** SHA-256 hash stored in the DB for lookup. */
  hash: string;
  /** Short non-secret prefix for display (e.g. "sk-hproxy-abc123"). */
  prefix: string;
}

/** Create a new client token with its hash and display prefix. */
export function generateToken(): GeneratedToken {
  const secret = crypto.randomBytes(32).toString("base64url");
  const token = TOKEN_PREFIX + secret;
  return {
    token,
    hash: hashToken(token),
    prefix: token.slice(0, TOKEN_PREFIX.length + 6),
  };
}

/** Deterministic SHA-256 hash used to look up a presented token. */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}
