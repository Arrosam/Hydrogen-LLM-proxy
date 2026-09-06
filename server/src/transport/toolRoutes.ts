import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { idParam, parse } from "../util/validate";
import type { Container } from "../composition/container";
import { grantedToolNames, parseService } from "../execution/definition";

/**
 * The Tools tab's API. Registered under /tools inside the session-guarded scope,
 * like every other admin route group.
 *
 * Writes are admin-only, matching provider API keys and proxies: a tool row
 * carries a credential and decides where this server's traffic goes, so it is
 * not a manager-level knob. Reading the list is NOT admin-gated, because the
 * Model Services and Micro Agent editors must list tools to render their grant
 * pickers, and the list has never contained a secret -- `toPublic` reports only
 * which header NAMES are configured.
 *
 * A tool row is only ever a pointer at somebody else's HTTP endpoint. Hydrogen
 * implements no tool (S1), so there is nothing here but addressing, policy and
 * a credential.
 */

const HeaderMap = z.record(z.string().min(1).max(200), z.string().max(4096));

const ToolCreate = z.object({
  name: z.string().min(1).max(120),
  /** `vocabulary` answers a client that declared that hosted tool type;
   * `freeform` is any name, declared as an ordinary function. Both may exist
   * under one name -- the wire shape of the declaration picks between them. */
  kind: z.enum(["vocabulary", "freeform"]).default("freeform"),
  description: z.string().max(4000).nullable().optional(),
  /** JSON Schema for the model-facing arguments. */
  parameters: z.record(z.string(), z.unknown()).nullable().optional(),
  endpointUrl: z.string().url(),
  /** Plaintext headers. Omitted on update = leave unchanged; null = clear. */
  headers: HeaderMap.nullable().optional(),
  policy: z.enum(["prefer_provider", "override"]).default("prefer_provider"),
  maxUses: z.number().int().min(1).max(1000).default(8),
  timeoutMs: z.number().int().min(100).max(600_000).default(30_000),
  proxyId: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
});

const ToolUpdate = ToolCreate.partial();

export async function toolRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get("/", async () => ({ tools: c.toolDefs.list().map((t) => c.toolDefs.toPublic(t)) }));

  app.post("/", async (req, reply) => {
    if (req.user?.role !== "admin") return reply.code(403).send({ error: "only an admin can create tools" });
    const parsed = parse(ToolCreate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    // A name is unique PER KIND, not globally: a hosted `web_search` and a
    // free-form tool of the same name are different tools that may coexist.
    if (c.toolDefs.getByName(parsed.data.name, parsed.data.kind)) {
      return reply.code(409).send({ error: `a ${parsed.data.kind} tool named "${parsed.data.name}" already exists` });
    }
    return { tool: c.toolDefs.toPublic(c.toolDefs.create(parsed.data)) };
  });

  app.patch("/:id", async (req, reply) => {
    if (req.user?.role !== "admin") return reply.code(403).send({ error: "only an admin can modify tools" });
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    const before = c.toolDefs.get(id);
    if (!before) return reply.code(404).send({ error: "not found" });
    const parsed = parse(ToolUpdate, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });

    const name = parsed.data.name ?? before.name;
    const kind = parsed.data.kind ?? before.kind;
    const clash = c.toolDefs.getByName(name, kind);
    if (clash && clash.id !== id) {
      return reply.code(409).send({ error: `a ${kind} tool named "${name}" already exists` });
    }
    const row = c.toolDefs.update(id, parsed.data);
    return { tool: row ? c.toolDefs.toPublic(row) : null };
  });

  app.delete("/:id", async (req, reply) => {
    if (req.user?.role !== "admin") return reply.code(403).send({ error: "only an admin can delete tools" });
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    const row = c.toolDefs.get(id);
    if (!row) return reply.code(404).send({ error: "not found" });

    // Same rule as deleting a proxy still attached to a provider: silently
    // removing a tool that services still grant would turn "the model has this
    // capability" into "it quietly does not", which is the exact failure this
    // whole feature exists to stop. Name who still grants it instead.
    const grantedBy = c.services
      .list()
      .filter((svc) => {
        // A definition that no longer parses cannot be granting anything, and
        // must not block an unrelated deletion.
        try {
          return grantedToolNames(parseService(svc.definition)).includes(row.name);
        } catch {
          return false;
        }
      })
      .map((svc) => svc.name);
    if (grantedBy.length) {
      return reply.code(409).send({
        error: `tool "${row.name}" is still granted by ${grantedBy.length} service(s): ${grantedBy.join(", ")}. Remove the grant there first.`,
        services: grantedBy,
      });
    }
    c.toolDefs.delete(id);
    return { ok: true };
  });
}
