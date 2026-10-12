import { requireAdmin } from "../../auth/authorization";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Container } from "../../composition/container";
import { HttpToolSchema, renderToolBody, selectToolResult } from "../../execution/toolHttp";
import { HTTP_STATUS } from "../../util/httpStatus";
import { badRequest, notFound } from "./replies";

/** Repository errors that mean the tool's parameter schema was rejected. */
const SCHEMA_ERROR_PATTERN = /schema|reference/i;

/** Registered beneath the existing authenticated admin scope. */
export async function hostedToolRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!requireAdmin(req, reply, "configure hosted tools")) return reply;
  });
  /** A rejected parameter schema is the caller's mistake; anything else is rethrown. */
  const schemaRejected = (e: unknown, reply: FastifyReply, message: string): FastifyReply => {
    if (e instanceof Error && SCHEMA_ERROR_PATTERN.test(e.message)) return badRequest(reply, message);
    throw e;
  };
  const id = (params: unknown) => z.object({ id: z.coerce.number().int().positive() }).parse(params).id;
  app.get("/", () => ({ tools: c.hostedTools.list() }));
  app.post("/", (req, reply) => {
    try { return reply.code(HTTP_STATUS.CREATED).send({ tool: c.hostedTools.create(HttpToolSchema.parse(req.body)) }); }
    catch (e) { return schemaRejected(e, reply, "Invalid tool parameter schema (JSON Schema draft 7, local references only)"); }
  });
  app.patch("/:id", (req, reply) => {
    const body = HttpToolSchema.extend({ headers: HttpToolSchema.shape.headers.optional() }).parse(req.body);
    try {
      const tool = c.hostedTools.update(id(req.params), body);
      return tool ? { tool } : notFound(reply, "Tool not found");
    } catch (e) { return schemaRejected(e, reply, "Invalid tool parameter schema"); }
  });
  app.delete("/:id", req => { c.hostedTools.delete(id(req.params)); return { deleted: true }; });
  app.post("/preview", (req, reply) => {
    const body = z.object({ bodyTemplate: z.unknown(), arguments: z.record(z.unknown()), toolName: z.string(), result: z.unknown().optional(), resultPath: z.string().default("") }).parse(req.body);
    try { return { body: renderToolBody(body.bodyTemplate, { arguments: body.arguments, tool: { name: body.toolName }, call: { id: "call_preview" }, session: { id: "session_preview" } }), result: body.result === undefined ? undefined : selectToolResult(body.result, body.resultPath) }; }
    catch (e) { return badRequest(reply, (e as Error).message); }
  });
}
