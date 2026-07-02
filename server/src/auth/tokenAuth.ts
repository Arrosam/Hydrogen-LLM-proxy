import type { FastifyReply, FastifyRequest } from "fastify";
import type { Family } from "../core/ir";
import { buildErrorBody } from "../core/proxy/errors";
import { authenticateToken } from "../services/tokens";

/** Extract a presented API key from either OpenAI or Anthropic style headers. */
export function extractPresentedToken(req: FastifyRequest): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey) return xApiKey.trim();
  return null;
}

/**
 * preHandler factory: authenticate the client token and enforce enabled/expiry/
 * quota. Errors are returned in the client's wire format (openai vs anthropic).
 */
export function requireClientToken(family: Family) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const fail = (status: number, message: string) =>
      reply.code(status).send(buildErrorBody(family, status, message));

    const presented = extractPresentedToken(req);
    if (!presented) return void (await fail(401, "Missing API key."));

    const token = authenticateToken(presented);
    if (!token || !token.enabled) return void (await fail(401, "Invalid API key."));

    const expiresAt = token.expiresAt instanceof Date ? token.expiresAt.getTime() : token.expiresAt;
    if (expiresAt != null && expiresAt < Date.now()) {
      return void (await fail(401, "API key has expired."));
    }
    if (token.maxRequests != null && token.usedRequests >= token.maxRequests) {
      return void (await fail(429, "Token request quota exceeded."));
    }
    if (token.maxTokens != null && token.usedTokens >= token.maxTokens) {
      return void (await fail(429, "Token usage quota exceeded."));
    }

    req.clientToken = token;
  };
}
