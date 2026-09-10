import type { Token } from "./schema.js";
import type { TokenRepo } from "./tokenRepo.js";

/** Extract a presented API key from either OpenAI or Anthropic style headers. */
export function extractPresentedToken(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const xApiKey = headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey) return xApiKey.trim();
  return null;
}

export type ClientKeyCheck =
  | { ok: true; token: Token }
  | { ok: false; status: 401 | 429; message: string };

/**
 * Authenticate a presented client key and enforce enabled/expiry/quota. The
 * caller renders the failure in whatever wire format its client speaks.
 */
export function checkClientKey(tokens: Pick<TokenRepo, "authenticate">, presented: string | null, enforceQuota = true): ClientKeyCheck {
  if (!presented) return { ok: false, status: 401, message: "Missing API key." };
  const token = tokens.authenticate(presented);
  if (!token || !token.enabled) return { ok: false, status: 401, message: "Invalid API key." };
  const expiresAt = token.expiresAt instanceof Date ? token.expiresAt.getTime() : token.expiresAt;
  if (expiresAt != null && expiresAt < Date.now()) return { ok: false, status: 401, message: "API key has expired." };
  if (enforceQuota && token.maxRequests != null && token.usedRequests >= token.maxRequests) {
    return { ok: false, status: 429, message: "API key request quota exceeded." };
  }
  if (enforceQuota && token.maxTokens != null && token.usedTokens >= token.maxTokens) {
    return { ok: false, status: 429, message: "Token usage quota exceeded." };
  }
  return { ok: true, token };
}

export interface KeyStatus {
  valid: boolean;
  expired: boolean;
  requestsExceeded: boolean;
  tokensExceeded: boolean;
  checkedAt: number;
}

/** The live status of a key, as the public Key Check page reports it. */
export function keyStatus(token: Token, now = Date.now()): KeyStatus {
  const expiresAt = token.expiresAt instanceof Date ? token.expiresAt.getTime() : token.expiresAt;
  const expired = expiresAt != null && expiresAt < now;
  const requestsExceeded = token.maxRequests != null && token.usedRequests >= token.maxRequests;
  const tokensExceeded = token.maxTokens != null && token.usedTokens >= token.maxTokens;
  return { valid: !expired && !requestsExceeded && !tokensExceeded, expired, requestsExceeded, tokensExceeded, checkedAt: now };
}

/** Whether a token's service scope admits a service id (an empty scope admits all). */
export function tokenAllowsService(token: Pick<Token, "scopeServices">, serviceId: number): boolean {
  const scope = token.scopeServices;
  if (!Array.isArray(scope) || scope.length === 0) return true;
  return scope.includes(serviceId);
}
