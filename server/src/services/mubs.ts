import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { modelUseBehaviors, type ModelUseBehavior } from "../db/schema";
import { isChain, parseMub, summarizeMub, type ChainPart, type MubDef } from "../core/mub/schema";
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
    const seen = new Set<string>();
    for (const stage of def.stages) {
      if (seen.has(stage.name)) {
        throw new MubValidationError(`duplicate stage name "${stage.name}"`, []);
      }
      const refs = [...stageRefs(stage.system ?? []), ...stage.input.flatMap((b) => stageRefs(b.parts))];
      for (const ref of refs) {
        if (!seen.has(ref)) {
          throw new MubValidationError(
            `stage "${stage.name}" references "${ref}", which is not an earlier stage`,
            [],
          );
        }
      }
      for (const s of stage.steps) {
        if (!mappingExists(s.model, s.provider)) invalidPairs.push(`${s.model}@${s.provider}`);
      }
      seen.add(stage.name);
    }
    if (def.output && !seen.has(def.output)) {
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
