import type { FastifyReply } from "fastify";
import type { z } from "zod";
import { HTTP_STATUS } from "../../util/httpStatus";
import { idParam, parse } from "../../util/validate";
import { ERR_INVALID_ID, ERR_NOT_FOUND } from "../errorMessages";

/**
 * The `{ error }` replies and request preambles the dashboard's route files
 * share. Each helper that can fail sends its own reply and returns null, so a
 * handler reads `const x = helper(...); if (!x) return reply;`.
 *
 * These are deliberately small pieces rather than a CRUD route factory: the
 * route files differ in gate placement, check order, status codes and bodies,
 * and those differences are client-visible.
 */

function sendError(reply: FastifyReply, status: number, message: string): FastifyReply {
  return reply.code(status).send({ error: message });
}

export function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return sendError(reply, HTTP_STATUS.BAD_REQUEST, message);
}

export function notFound(reply: FastifyReply, message: string = ERR_NOT_FOUND): FastifyReply {
  return sendError(reply, HTTP_STATUS.NOT_FOUND, message);
}

export function conflict(reply: FastifyReply, message: string): FastifyReply {
  return sendError(reply, HTTP_STATUS.CONFLICT, message);
}

/** The request body validated against `schema`, or null after a 400 with the
 * flattened zod issues. Only for object schemas: a parsed body is never null. */
export function parseBody<S extends z.ZodTypeAny>(schema: S, req: { body: unknown }, reply: FastifyReply): z.infer<S> | null {
  const parsed = parse(schema, req.body);
  if (parsed.ok) return parsed.data;
  void badRequest(reply, parsed.error);
  return null;
}

/** The `:id` route param, or null after a 400 "invalid id". */
export function requireId(req: { params: unknown }, reply: FastifyReply): number | null {
  const id = idParam(req);
  if (!id) void badRequest(reply, ERR_INVALID_ID);
  return id;
}

/** The `:id` route param and the row it names, or null after a 400 (bad id) or
 * a 404 (no such row). */
export function loadById<R>(
  req: { params: unknown },
  reply: FastifyReply,
  get: (id: number) => R | null | undefined,
): { id: number; row: R } | null {
  const id = requireId(req, reply);
  if (!id) return null;
  const row = get(id);
  if (!row) {
    void notFound(reply);
    return null;
  }
  return { id, row };
}
