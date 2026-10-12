import crypto from "node:crypto";

/**
 * Plain `sk-` rather than a vendor-specific marker: a fair number of clients and
 * SDKs sanity-check that an API key looks like one before they will send it, and
 * they all check for this. Authentication never reads the prefix -- a presented
 * token is hashed whole and looked up -- so keys issued under an older prefix
 * keep working untouched; only newly generated ones change shape.
 */
const TOKEN_PREFIX = "sk-";
const TOKEN_SECRET_BYTES = 32;
/** Characters of the secret shown after the prefix in the display form. */
const TOKEN_DISPLAY_CHARS = 6;

export interface GeneratedToken {
  /** The full secret - shown to the user exactly once, never stored. */
  token: string;
  /** SHA-256 hash stored in the DB for lookup. */
  hash: string;
  /** Short non-secret prefix for display (e.g. "sk-abc123"). */
  prefix: string;
}

/** Create a new client token with its hash and display prefix. */
export function generateToken(): GeneratedToken {
  const secret = crypto.randomBytes(TOKEN_SECRET_BYTES).toString("base64url");
  const token = TOKEN_PREFIX + secret;
  return {
    token,
    hash: hashToken(token),
    prefix: token.slice(0, TOKEN_PREFIX.length + TOKEN_DISPLAY_CHARS),
  };
}

/** Deterministic SHA-256 hash used to look up a presented token. */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}
