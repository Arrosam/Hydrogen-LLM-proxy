import type { FastifyRequest, FastifyReply } from "fastify";
import type { SessionPayload } from "./session";
import type { Token } from "../db/schema";
export function tokenAllowsService(token: Pick<Token, "scopeServices">, serviceId: number): boolean {
  return !Array.isArray(token.scopeServices) || token.scopeServices.length === 0 || token.scopeServices.includes(serviceId);
}
export function requireAdmin(req: FastifyRequest, reply: FastifyReply, action: string): req is FastifyRequest & { user: SessionPayload } {
  if (req.user?.role === "admin") return true;
  void reply.code(403).send({ error: `only an admin can ${action}` });
  return false;
}
