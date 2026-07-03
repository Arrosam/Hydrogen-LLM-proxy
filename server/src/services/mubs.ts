import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { modelUseBehaviors, type ModelUseBehavior } from "../db/schema";
import { isChain, parseMub, summarizeMub, type ChainPart, type MubDef } from "../core/mub/schema";
import type { StageResolver } from "../core/mub/chain";
import { mappingExists } from "./catalog";

export interface MubInput {
  name: string;
  description?: string | null;
  steps?: unknown; // raw steps_json (validated here; required on create)
  enabled?: boolean;
}

/** Thrown when a MUB's definition is structurally valid but semantically wrong
 * (unmapped pairs, duplicate/forward stage references, unknown output stage). */
export class MubValidationError extends Error {
  constructor(
    message: string,
    public invalidPairs: string[],
  ) {
    super(message);
    this.name = "MubValidationError";
  }
}

function stageRefs(parts: ChainPart[]): string[] {
  return parts.filter((p) => p.source === "stage").map((p) => (p as { name: string }).name);
}

/** Validate steps_json against the schema AND the live catalog (resilience or chain). */
export function validateMub(raw: unknown): { def: MubDef; summary: string } {
  const def = parseMub(raw); // throws ZodError on shape problems
  const invalidPairs: string[] = [];

  if (isChain(def)) {
    const names = def.stages.map((s) => s.name);
    const nameSet = new Set(names);
    if (nameSet.size !== names.length) {
      const dup = names.find((n, i) => names.indexOf(n) !== i);
      throw new MubValidationError(`duplicate stage name "${dup}"`, []);
    }
    const indexByName = new Map(names.map((n, i) => [n, i]));

    for (let i = 0; i < def.stages.length; i++) {
      const stage = def.stages[i];
      const earlier = new Set(names.slice(0, i));
      const bad = (msg: string): never => {
        throw new MubValidationError(`stage "${stage.name}": ${msg}`, []);
      };

      // Content-part stage references must point at an earlier stage.
      const partRefs = [...stageRefs(stage.system ?? []), ...stage.input.flatMap((b) => stageRefs(b.parts))];
      for (const ref of partRefs) {
        if (!earlier.has(ref)) bad(`references "${ref}", which is not an earlier stage`);
      }

      // Execution unit: a referenced resilience MUB, inline steps, or a router (neither).
      const isRouter = !stage.mub && (!stage.steps || stage.steps.length === 0);
      if (stage.mub) {
        const m = getMubByName(stage.mub);
        if (!m) bad(`references unknown MUB "${stage.mub}"`);
        else if (isChain(parseMub(m.steps))) bad(`references chain MUB "${stage.mub}" (stages must use resilience MUBs)`);
      } else if (stage.steps && stage.steps.length) {
        for (const s of stage.steps) {
          if (!mappingExists(s.model, s.provider)) invalidPairs.push(`${s.model}@${s.provider}`);
        }
      }

      // Transitions: forward-only goto; condition sanity.
      for (const t of stage.transitions ?? []) {
        if (t.goto !== "end") {
          const j = indexByName.get(t.goto);
          if (j == null) bad(`transition goto "${t.goto}" is not a stage`);
          else if (j <= i) bad(`transition goto "${t.goto}" must be a later stage (forward-only)`);
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
          if (isRouter) bad("cannot test output — a router makes no model call");
          const ref = c.stage ?? stage.name;
          const j = indexByName.get(ref);
          if (j == null) bad(`condition references unknown stage "${ref}"`);
          else if (j > i) bad(`condition references later stage "${ref}"`);
        }
      }
    }
    if (def.output && !nameSet.has(def.output)) {
      throw new MubValidationError(`output stage "${def.output}" is not a defined stage`, []);
    }
  } else {
    for (const step of def.steps) {
      if (!mappingExists(step.model, step.provider)) invalidPairs.push(`${step.model}@${step.provider}`);
    }
  }

  if (invalidPairs.length > 0) {
    throw new MubValidationError(
      `These (model, provider) pairs are not mapped in the catalog: ${invalidPairs.join(", ")}`,
      invalidPairs,
    );
  }
  return { def, summary: summarizeMub(def) };
}

export function listMubs(): ModelUseBehavior[] {
  return getDb().select().from(modelUseBehaviors).all();
}

export function getMub(id: number): ModelUseBehavior | undefined {
  return getDb().select().from(modelUseBehaviors).where(eq(modelUseBehaviors.id, id)).get();
}

export function getMubByName(name: string): ModelUseBehavior | undefined {
  return getDb().select().from(modelUseBehaviors).where(eq(modelUseBehaviors.name, name)).get();
}

/** Parse a MUB's stored definition (resilience or chain). */
export function getMubDef(mub: ModelUseBehavior): MubDef {
  return parseMub(mub.steps);
}

/** Resolve a chain stage's referenced MUB name to its resilience steps. */
export const resolveChainStage: StageResolver = (mubName) => {
  const m = getMubByName(mubName);
  if (!m || !m.enabled) return { ok: false, message: `stage references unknown or disabled MUB "${mubName}"` };
  const d = parseMub(m.steps);
  if (isChain(d)) return { ok: false, message: `stage MUB "${mubName}" is a chain; nested chains are not allowed` };
  return { ok: true, steps: d };
};

export function createMub(input: MubInput): ModelUseBehavior {
  const { def } = validateMub(input.steps);
  return getDb()
    .insert(modelUseBehaviors)
    .values({
      name: input.name,
      description: input.description ?? null,
      steps: def,
      enabled: input.enabled ?? true,
    })
    .returning()
    .get();
}

export function updateMub(id: number, input: Partial<MubInput>): ModelUseBehavior | undefined {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.steps !== undefined) {
    const { def } = validateMub(input.steps);
    patch.steps = def;
  }
  if (Object.keys(patch).length === 0) return getMub(id);
  return getDb()
    .update(modelUseBehaviors)
    .set(patch)
    .where(eq(modelUseBehaviors.id, id))
    .returning()
    .get();
}

export function deleteMub(id: number): void {
  getDb().delete(modelUseBehaviors).where(eq(modelUseBehaviors.id, id)).run();
}
