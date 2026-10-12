import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { tokenStatus } from "../../auth/tokenAuth";
import type { Container } from "../../composition/container";
import { HTTP_STATUS } from "../../util/httpStatus";
import { KEY_CHECK_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW } from "../rateLimits";
import { parseBody } from "./replies";

// --- check (public, API-key-authenticated) ----------------------------------

// Sent with this casing; kept apart from the lower-case HEADER table.
const CACHE_CONTROL_HEADER = "Cache-Control";
const CACHE_CONTROL_NO_STORE = "no-store";

const CheckSchema = z.object({ apiKey: z.string().min(1) });

/** Public endpoint: given an API key, return its live status without requiring
 * a dashboard session. The key is authenticated the same way a proxy request
 * would be, so expired/disabled/quota-exceeded keys are reported honestly. */
export async function checkRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.post("/check", { config: { rateLimit: { max: KEY_CHECK_RATE_LIMIT_MAX, timeWindow: RATE_LIMIT_WINDOW } } }, async (req, reply) => {
    const data = parseBody(CheckSchema, req, reply);
    if (!data) return reply;
    const token = c.tokens.authenticate(data.apiKey);
    if (!token || !token.enabled) return reply.code(HTTP_STATUS.UNAUTHORIZED).send({ error: "invalid or disabled API key" });
    const now = Date.now();
    const { expired, requestsExceeded, tokensExceeded } = tokenStatus(token, now);
    const valid = !expired && !requestsExceeded && !tokensExceeded;
    reply.header(CACHE_CONTROL_HEADER, CACHE_CONTROL_NO_STORE);
    req.log.info({ tokenId: token.id, valid }, "API key self-service status check");
    const publicKey = c.tokens.toPublic(token);
    return {
      key: { name: publicKey.name, enabled: publicKey.enabled, maxRequests: publicKey.maxRequests, maxTokens: publicKey.maxTokens,
        usedRequests: publicKey.usedRequests, usedTokens: publicKey.usedTokens, expiresAt: publicKey.expiresAt, createdAt: publicKey.createdAt,
        scopeServiceCount: publicKey.scopeServices?.length ?? 0 },
      status: {
        valid,
        expired,
        requestsExceeded,
        tokensExceeded,
        checkedAt: now,
      },
    };
  });
}
