import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { modelServices, type ModelService } from "../db/schema";
import { isAgent, parseService, summarizeService, type ServiceDef } from "../core/services/schema";
import type { StageResolver } from "../core/agents/engine";
import { mappingExists } from "./catalog";

export interface ServiceInput {
  name: string;
  description?: string | null;
  steps?: unknown; // raw steps_json (validated here; required on create)
  enabled?: boolean;
}

/** Thrown when a service's definition is structurally valid but semantically wrong
 * (unmapped pairs, duplicate/forward stage references, unknown output stage). */
export class ServiceValidationError extends Error {
  constructor(
    message: string,
    public invalidPairs: string[],
  ) {
    super(message);
    this.name = "ServiceValidationError";
  }
}

/** Validate steps_json against the schema AND the live catalog (resilience or agent). */
export function validateService(raw: unknown): { def: ServiceDef; summary: string } {
  const def = parseService(raw); // throws ZodError on shape problems
  const invalidPairs: string[] = [];

  if (isAgent(def)) {
    const names = def.stages.map((s) => s.name);
    const nameSet = new Set(names);
    if (nameSet.size !== names.length) {
      const dup = names.find((n, i) => names.indexOf(n) !== i);
      throw new ServiceValidationError(`duplicate stage name "${dup}"`, []);
    }
    const indexByName = new Map(names.map((n, i) => [n, i]));

    for (let i = 0; i < def.stages.length; i++) {
      const stage = def.stages[i];
      const earlier = new Set(names.slice(0, i));
      const bad = (msg: string): never => {
        throw new ServiceValidationError(`stage "${stage.name}": ${msg}`, []);
      };

      for (const b of stage.input) {
        if (b.kind === "stage_output" && !earlier.has(b.stage)) {
          bad(`references "${b.stage}", which is not an earlier stage`);
        }
        if (b.kind === "tool_turn" && b.input) {
          try {
            JSON.parse(b.input);
          } catch {
            bad(`tool turn "${b.name}" has invalid JSON arguments`);
          }
        }
      }

      const isRouter = !stage.service && (!stage.steps || stage.steps.length === 0);
      if (stage.service) {
        const m = getServiceByName(stage.service);
        if (!m) bad(`references unknown Model Service or Micro Agent "${stage.service}"`);
      } else if (stage.steps && stage.steps.length) {
        for (const s of stage.steps) {
          if (!mappingExists(s.model, s.provider)) invalidPairs.push(`${s.model}@${s.provider}`);
        }
      }

      for (const t of stage.transitions ?? []) {
        if (t.goto !== "end") {
          const j = indexByName.get(t.goto);
          if (j == null) bad(`transition goto "${t.goto}" is not a stage`);
          else if (j <= i) bad(`transition goto "${t.goto}" must be a later stage (forward-only)`);
        } else if (t.output) {
          const j = indexByName.get(t.output);
          if (j == null) bad(`transition returns unknown stage "${t.output}"`);
          else if (j > i) bad(`transition returns later stage "${t.output}" (must be this or an earlier stage)`);
          else {
            const target = def.stages[j];
            const targetIsRouter = !target.service && (!target.steps || target.steps.length === 0);
            if (targetIsRouter) bad(`transition returns router stage "${t.output}", which produces no output`);
          }
        }
        const c = t.when;
        if ((c.type === "input_matches" || c.type === "output_matches")) {
          try {
            new RegExp(c.value);
          } catch {
            bad(`invalid regex "${c.value}"`);
          }
        }
        if (c.type === "output_contains" || c.type === "output_matches") {
          if (isRouter) bad("cannot test output -- a router makes no model call");
          const ref = c.stage ?? stage.name;
          const j = indexByName.get(ref);
          if (j == null) bad(`condition references unknown stage "${ref}"`);
          else if (j > i) bad(`condition references later stage "${ref}"`);
        }
      }
    }
    if (def.output && !nameSet.has(def.output)) {
      throw new ServiceValidationError(`output stage "${def.output}" is not a defined stage`, []);
    }

    if (def.ocr) {
      const o = def.ocr;
      if (o.service) {
        const m = getServiceByName(o.service);
        if (!m) throw new ServiceValidationError(`image translation (OCR) references unknown Model Service "${o.service}"`, []);
        if (isAgent(parseService(m.steps))) {
          throw new ServiceValidationError(`image translation (OCR) references a Micro Agent "${o.service}" (must be a Model Service)`, []);
        }
      } else if (o.steps && o.steps.length) {
        for (const s of o.steps) {
          if (!mappingExists(s.model, s.provider)) invalidPairs.push(`${s.model}@${s.provider}`);
        }
      } else {
        throw new ServiceValidationError("image translation (OCR) is enabled but has no model (pick a Model Service)", []);
      }
    }
  } else {
    for (const step of def.steps) {
      if (!mappingExists(step.model, step.provider)) invalidPairs.push(`${step.model}@${step.provider}`);
    }
  }

  if (invalidPairs.length > 0) {
    throw new ServiceValidationError(
      `These (model, provider) pairs are not mapped in the catalog: ${invalidPairs.join(", ")}`,
      invalidPairs,
    );
  }
  return { def, summary: summarizeService(def) };
}

export function listServices(): ModelService[] {
  return getDb().select().from(modelServices).all();
}

export function getService(id: number): ModelService | undefined {
  return getDb().select().from(modelServices).where(eq(modelServices.id, id)).get();
}

export function getServiceByName(name: string): ModelService | undefined {
  return getDb().select().from(modelServices).where(eq(modelServices.name, name)).get();
}

/** Parse a service's stored definition (resilience or agent). */
export function getServiceDef(service: ModelService): ServiceDef {
  return parseService(service.steps);
}

/** Resolve a service name (stage or OCR ref) to its definition: a Model Service
 * or a nested Micro Agent (agent). Cycle/depth guards live in the agent engine. */
export const resolveAgentStage: StageResolver = (serviceName) => {
  const m = getServiceByName(serviceName);
  if (!m || !m.enabled) return { ok: false, message: `references unknown or disabled Model Service or Micro Agent "${serviceName}"` };
  let d;
  try {
    d = parseService(m.steps);
  } catch {
    return { ok: false, message: `"${serviceName}" has an invalid definition` };
  }
  if (isAgent(d)) return { ok: true, kind: "agent", agent: d };
  return { ok: true, kind: "resilience", steps: d };
};

export function createService(input: ServiceInput): ModelService {
  const { def } = validateService(input.steps);
  return getDb()
    .insert(modelServices)
    .values({
      name: input.name,
      description: input.description ?? null,
      steps: def,
      enabled: input.enabled ?? true,
    })
    .returning()
    .get();
}

export function updateService(id: number, input: Partial<ServiceInput>): ModelService | undefined {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.steps !== undefined) {
    const { def } = validateService(input.steps);
    patch.steps = def;
  }
  if (Object.keys(patch).length === 0) return getService(id);
  return getDb()
    .update(modelServices)
    .set(patch)
    .where(eq(modelServices.id, id))
    .returning()
    .get();
}

export function deleteService(id: number): void {
  getDb().delete(modelServices).where(eq(modelServices.id, id)).run();
}