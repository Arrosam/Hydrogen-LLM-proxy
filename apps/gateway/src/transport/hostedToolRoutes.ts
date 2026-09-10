import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../composition/container.js";
import { HttpToolSchema, renderToolBody, selectToolResult } from "@areelai/model-services";

/** Registered beneath the existing authenticated admin scope. */
export async function hostedToolRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (req.user?.role !== "admin") return reply.code(403).send({ error: "Only an admin can configure hosted tools" });
  });
  const id = (params: unknown) => z.object({ id: z.coerce.number().int().positive() }).parse(params).id;
  app.get("/", () => ({ tools: c.hostedTools.list() }));
  app.post("/", (req, reply) => {
    try { return reply.code(201).send({ tool: c.hostedTools.create(HttpToolSchema.parse(req.body)) }); }
    catch (e) { if (e instanceof Error && /schema|reference/i.test(e.message)) return reply.code(400).send({ error: "Invalid tool parameter schema (JSON Schema draft 7, local references only)" }); throw e; }
  });
  app.patch("/:id", (req, reply) => {
    const body = HttpToolSchema.extend({ headers: HttpToolSchema.shape.headers.optional() }).parse(req.body);
    try {
      const tool = c.hostedTools.update(id(req.params), body);
      return tool ? { tool } : reply.code(404).send({ error: "Tool not found" });
    } catch (e) { if (e instanceof Error && /schema|reference/i.test(e.message)) return reply.code(400).send({ error: "Invalid tool parameter schema" }); throw e; }
  });
  app.delete("/:id", req => { c.hostedTools.delete(id(req.params)); return { deleted: true }; });
  app.post("/preview", (req, reply) => {
    const body = z.object({ bodyTemplate: z.unknown(), arguments: z.record(z.unknown()), toolName: z.string(), result: z.unknown().optional(), resultPath: z.string().default("") }).parse(req.body);
    try { return { body: renderToolBody(body.bodyTemplate, { arguments: body.arguments, tool: { name: body.toolName }, call: { id: "call_preview" }, session: { id: "session_preview" } }), result: body.result === undefined ? undefined : selectToolResult(body.result, body.resultPath) }; }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
}
