import type { FastifyRequest, FastifyReply } from "fastify";
import { ROLE, type SessionPayload } from "./session";
import type { Token } from "../db/schema";
import { HTTP_STATUS } from "../util/httpStatus";
export function tokenAllowsService(token: Pick<Token, "scopeServices">, serviceId: number): boolean {
  return !Array.isArray(token.scopeServices) || token.scopeServices.length === 0 || token.scopeServices.includes(serviceId);
}
export function requireAdmin(req: FastifyRequest, reply: FastifyReply, action: string): req is FastifyRequest & { user: SessionPayload } {
  if (req.user?.role === ROLE.ADMIN) return true;
  void reply.code(HTTP_STATUS.FORBIDDEN).send({ error: `only an admin can ${action}` });
  return false;
}
