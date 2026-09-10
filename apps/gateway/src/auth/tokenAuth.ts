import type { FastifyReply, FastifyRequest } from "fastify";
import { buildErrorBody, type Family } from "@areelai/wire-format";
import { checkClientKey, extractPresentedToken, type TokenRepo } from "@areelai/user-management";

export { extractPresentedToken };

/**
 * preHandler factory: authenticate the client token and enforce enabled/expiry/
 * quota. Errors are returned in the client's wire format. The token repo is
 * injected (no global DB access).
 */
export function requireClientToken(tokens: TokenRepo, family: Family, enforceQuota = true) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const check = checkClientKey(tokens, extractPresentedToken(req.headers), enforceQuota);
    if (!check.ok) {
      await reply.code(check.status).send(buildErrorBody(family, check.status, check.message));
      return;
    }
    req.clientToken = check.token;
  };
}
