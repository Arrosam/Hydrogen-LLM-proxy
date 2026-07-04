import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ZodError } from "zod";
import { parse, toId } from "../../util/validate";
import {
  createMub,
  deleteMub,
  getMub,
  getMubDef,
  listMubs,
  MubValidationError,
  resolveChainStage,
  updateMub,
  validateMub,
} from "../../services/mubs";
import { isChain, summarizeMub, type MubDef } from "../../core/mub/schema";
import { runMubJson } from "../../core/proxy/run";
import { runMubChain } from "../../core/mub/chain";
import { extractUpstreamMessage } from "../../core/proxy/errors";
import { textOf, type IRRequest } from "../../core/ir";
import type { ModelUseBehavior } from "../../db/schema";

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().nullable().optional(),
  steps: z.unknown(),
  enabled: z.boolean().optional(),
});
const UpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().nullable().optional(),
  steps: z.unknown().optional(),
  enabled: z.boolean().optional(),
});

function present(m: ModelUseBehavior): Record<string, unknown> {
  let summary = "";
  try {
    summary = summarizeMub(getMubDef(m));
  } catch {
    summary = "(invalid steps)";
  }
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    steps: m.steps,
    enabled: m.enabled,
    summary,
    createdAt: m.createdAt instanceof Date ? m.createdAt.getTime() : Number(m.createdAt),
  };
}

/** Map validation errors (schema or catalog) to a 400 with a helpful message. */
function validationError(e: unknown): { status: number; body: Record<string, unknown> } | null {
  if (e instanceof MubValidationError) {
    return { status: 400, body: { error: e.message, invalidPairs: e.invalidPairs } };
  }
  if (e instanceof ZodError) {
    const msg = e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { status: 400, body: { error: `invalid steps: ${msg}` } };
  }
  return null;
}

export async function mubRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => ({ mubs: listMubs().map(present) }));

  app.post("/validate", async (req, reply) => {
    const body = (req.body ?? {}) as { steps?: unknown };
    try {
      const { def, summary } = validateMub(body.steps);
      const kind = isChain(def) ? "chain" : "resilience";
      const count = isChain(def) ? def.stages.length : def.steps.length;
      return { valid: true, summary, kind, count };
    } catch (e) {
      const mapped = validationError(e);
      if (mapped) return reply.code(200).send({ valid: false, ...mapped.body });
      throw e;
    }
  });

  app.post("/", async (req, reply) => {
    const parsed = parse(CreateSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    try {
      return reply.code(201).send({ mub: present(createMub(parsed.data)) });
    } catch (e) {
      const mapped = validationError(e);
      if (mapped) return reply.code(mapped.status).send(mapped.body);
      throw e;
    }
  });

  app.patch("/:id", async (req, reply) => {
    const id = toId((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!getMub(id)) return reply.code(404).send({ error: "not found" });
    const parsed = parse(UpdateSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    try {
      const mub = updateMub(id, parsed.data);
      return { mub: mub ? present(mub) : null };
    } catch (e) {
      const mapped = validationError(e);
      if (mapped) return reply.code(mapped.status).send(mapped.body);
      throw e;
    }
  });

  app.delete("/:id", async (req, reply) => {
    const id = toId((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: "invalid id" });
    if (!getMub(id)) return reply.code(404).send({ error: "not found" });
    deleteMub(id);
    return { ok: true };
  });

  // Dry-run: fire a small request through a MUB (saved id or ad-hoc steps).
  app.post("/test", async (req, reply) => {
    const body = (req.body ?? {}) as { mubId?: number; steps?: unknown; prompt?: string };
    let def: MubDef;
    try {
      if (body.mubId) {
        const mub = getMub(body.mubId);
        if (!mub) return reply.code(404).send({ error: "Model Service not found" });
        def = getMubDef(mub);
      } else {
        def = validateMub(body.steps).def;
      }
    } catch (e) {
      const mapped = validationError(e);
      if (mapped) return reply.code(mapped.status).send(mapped.body);
      throw e;
    }

    const ir: IRRequest = {
      requestedModel: "(dry-run)",
      messages: [{ role: "user", content: [{ type: "text", text: body.prompt || "ping" }] }],
      maxTokens: isChain(def) ? 64 : 16,
      stream: false,
    };

    const { result, path } = isChain(def)
      ? await runMubChain(ir, def, resolveChainStage)
      : await runMubJson(ir, def);
    if (result.ok) {
      return {
        ok: true,
        attemptPath: path,
        served: { model: result.value.modelName, provider: result.value.providerName },
        output: textOf(result.value.ir.content).slice(0, 500),
      };
    }
    return {
      ok: false,
      status: result.status,
      message: extractUpstreamMessage(result.errorBody) ?? result.message,
      attemptPath: path,
    };
  });
}
