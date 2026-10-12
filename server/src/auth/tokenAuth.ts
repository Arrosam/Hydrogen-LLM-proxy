import type { FastifyReply, FastifyRequest } from "fastify";
import type { Family } from "../core/format/family";
import { buildErrorBody } from "../core/proxy/errors";
import type { TokenRepo } from "../persistence/tokenRepo";
import type { Token } from "../db/schema";
import { HEADER } from "../util/httpHeaders";
import { HTTP_STATUS } from "../util/httpStatus";
import { asMillisOrNull } from "../util/time";

/** Authorization scheme prefix, compared against the lower-cased header value. */
const BEARER_PREFIX = "bearer ";

/** Which of its own limits a client token has run into, as of `now`. */
export function tokenStatus(
  token: Pick<Token, "expiresAt" | "maxRequests" | "usedRequests" | "maxTokens" | "usedTokens">,
  now: number = Date.now(),
): { expired: boolean; requestsExceeded: boolean; tokensExceeded: boolean } {
  const expiresAt = asMillisOrNull(token.expiresAt);
  return {
    expired: expiresAt != null && expiresAt < now,
    requestsExceeded: token.maxRequests != null && token.usedRequests >= token.maxRequests,
    tokensExceeded: token.maxTokens != null && token.usedTokens >= token.maxTokens,
  };
}

/** Extract a presented API key from either OpenAI or Anthropic style headers. */
function extractPresentedToken(req: FastifyRequest): string | null {
  const auth = req.headers[HEADER.AUTHORIZATION];
  if (typeof auth === "string" && auth.toLowerCase().startsWith(BEARER_PREFIX)) {
    return auth.slice(BEARER_PREFIX.length).trim();
  }
  const xApiKey = req.headers[HEADER.X_API_KEY];
  if (typeof xApiKey === "string" && xApiKey) return xApiKey.trim();
  return null;
}

/**
 * preHandler factory: authenticate the client token and enforce enabled/expiry/
 * quota. Errors are returned in the client's wire format. The token repo is
 * injected (no global DB access).
 */
export function requireClientToken(tokens: TokenRepo, family: Family, enforceQuota = true) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const fail = (status: number, message: string) => reply.code(status).send(buildErrorBody(family, status, message));

    const presented = extractPresentedToken(req);
    if (!presented) return void (await fail(HTTP_STATUS.UNAUTHORIZED, "Missing API key."));

    const token = tokens.authenticate(presented);
    if (!token || !token.enabled) return void (await fail(HTTP_STATUS.UNAUTHORIZED, "Invalid API key."));

    const status = tokenStatus(token);
    if (status.expired) return void (await fail(HTTP_STATUS.UNAUTHORIZED, "API key has expired."));
    if (enforceQuota && status.requestsExceeded) {
      return void (await fail(HTTP_STATUS.TOO_MANY_REQUESTS, "API key request quota exceeded."));
    }
    if (enforceQuota && status.tokensExceeded) {
      return void (await fail(HTTP_STATUS.TOO_MANY_REQUESTS, "Token usage quota exceeded."));
    }

    req.clientToken = token;
  };
}
