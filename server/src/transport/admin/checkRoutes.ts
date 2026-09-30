import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../composition/container";
import { parse } from "../../util/validate";

// --- check (public, API-key-authenticated) ----------------------------------

const CheckSchema = z.object({ apiKey: z.string().min(1) });

/** Public endpoint: given an API key, return its live status without requiring
 * a dashboard session. The key is authenticated the same way a proxy request
 * would be, so expired/disabled/quota-exceeded keys are reported honestly. */
export async function checkRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.post("/check", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = parse(CheckSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const token = c.tokens.authenticate(parsed.data.apiKey);
    if (!token || !token.enabled) return reply.code(401).send({ error: "invalid or disabled API key" });
    const now = Date.now();
    const expiresAt = token.expiresAt instanceof Date ? token.expiresAt.getTime() : token.expiresAt;
    const expired = expiresAt != null && expiresAt < now;
    const requestsExceeded = token.maxRequests != null && token.usedRequests >= token.maxRequests;
    const tokensExceeded = token.maxTokens != null && token.usedTokens >= token.maxTokens;
    reply.header("Cache-Control", "no-store");
    req.log.info({ tokenId: token.id, valid: !expired && !requestsExceeded && !tokensExceeded }, "API key self-service status check");
    const publicKey = c.tokens.toPublic(token);
    return {
      key: { name: publicKey.name, enabled: publicKey.enabled, maxRequests: publicKey.maxRequests, maxTokens: publicKey.maxTokens,
        usedRequests: publicKey.usedRequests, usedTokens: publicKey.usedTokens, expiresAt: publicKey.expiresAt, createdAt: publicKey.createdAt,
        scopeServiceCount: publicKey.scopeServices?.length ?? 0 },
      status: {
        valid: !expired && !requestsExceeded && !tokensExceeded,
        expired,
        requestsExceeded,
        tokensExceeded,
        checkedAt: now,
      },
    };
  });
}
