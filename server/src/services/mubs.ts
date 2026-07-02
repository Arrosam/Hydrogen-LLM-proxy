import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { modelUseBehaviors, type ModelUseBehavior } from "../db/schema";
import { parseMubSteps, summarizeMub, type MubSteps } from "../core/mub/schema";
import { mappingExists } from "./catalog";

export interface MubInput {
  name: string;
  description?: string | null;
  steps?: unknown; // raw steps_json (validated here; required on create)
  enabled?: boolean;
}

/** Thrown when a MUB's steps reference an unmapped (model, provider) pair. */
export class MubValidationError extends Error {
  constructor(
    message: string,
    public invalidPairs: string[],
  ) {
    super(message);
    this.name = "MubValidationError";
  }
}

/** Validate steps_json against the schema AND the live catalog. */
export function validateSteps(rawSteps: unknown): { steps: MubSteps; summary: string } {
  const steps = parseMubSteps(rawSteps); // throws ZodError on shape problems
  const invalidPairs: string[] = [];
  for (const step of steps.steps) {
    if (!mappingExists(step.model, step.provider)) {
      invalidPairs.push(`${step.model}@${step.provider}`);
    }
  }
  if (invalidPairs.length > 0) {
    throw new MubValidationError(
      `These (model, provider) pairs are not mapped in the catalog: ${invalidPairs.join(", ")}`,
      invalidPairs,
    );
  }
  return { steps, summary: summarizeMub(steps) };
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

export function getMubSteps(mub: ModelUseBehavior): MubSteps {
  return parseMubSteps(mub.steps);
}

export function createMub(input: MubInput): ModelUseBehavior {
  const { steps } = validateSteps(input.steps);
  return getDb()
    .insert(modelUseBehaviors)
    .values({
      name: input.name,
      description: input.description ?? null,
      steps,
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
    const { steps } = validateSteps(input.steps);
    patch.steps = steps;
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
