import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { modelUseBehaviors, type ModelUseBehavior } from "../db/schema";
import { isChain, parseMub, summarizeMub, type MubDef } from "../core/mub/schema";
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

      // Context blocks: stage-output refs must be earlier; tool args must be JSON.
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

      // Execution unit: a referenced MUB (resilience or a nested Micro Agent),
      // inline steps, or a router (neither). Cycles among Micro Agents are caught
      // at run time by the chain engine.
      const isRouter = !stage.mub && (!stage.steps || stage.steps.length === 0);
      if (stage.mub) {
        const m = getMubByName(stage.mub);
        if (!m) bad(`references unknown Model Service or Micro Agent "${stage.mub}"`);
      } else if (stage.steps && stage.steps.length) {
        for (const s of stage.steps) {
          if (!mappingExists(s.model, s.provider)) invalidPairs.push(`${s.model}@${s.provider}`);
        }
      }

      // Transitions: forward-only goto; a return "output" must name a stage that
      // has already run and produces a value; condition sanity.
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
            const targetIsRouter = !target.mub && (!target.steps || target.steps.length === 0);
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

    // OCR pre-pass: must call a model (a resilience MUB or inline steps), never a router.
    if (def.ocr) {
      const o = def.ocr;
      if (o.mub) {
        const m = getMubByName(o.mub);
        if (!m) throw new MubValidationError(`image translation (OCR) references unknown Model Service "${o.mub}"`, []);
        if (isChain(parseMub(m.steps))) {
          throw new MubValidationError(`image translation (OCR) references a Micro Agent "${o.mub}" (must be a Model Service)`, []);
        }
      } else if (o.steps && o.steps.length) {
        for (const s of o.steps) {
          if (!mappingExists(s.model, s.provider)) invalidPairs.push(`${s.model}@${s.provider}`);
        }
      } else {
        throw new MubValidationError("image translation (OCR) is enabled but has no model (pick a Model Service)", []);
      }
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

/** Resolve a MUB name (stage or OCR ref) to its definition: a resilience MUB or
 * a nested Micro Agent (chain). Cycle/depth guards live in the chain engine. */
export const resolveChainStage: StageResolver = (mubName) => {
  const m = getMubByName(mubName);
  if (!m || !m.enabled) return { ok: false, message: `references unknown or disabled Model Service or Micro Agent "${mubName}"` };
  let d;
  try {
    d = parseMub(m.steps);
  } catch {
    return { ok: false, message: `"${mubName}" has an invalid definition` };
  }
  if (isChain(d)) return { ok: true, kind: "chain", chain: d };
  return { ok: true, kind: "resilience", steps: d };
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
