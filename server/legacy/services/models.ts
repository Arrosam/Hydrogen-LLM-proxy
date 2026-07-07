import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { models, type Model } from "../db/schema";

export interface ModelInput {
  name: string;
  description?: string | null;
  enabled?: boolean;
}

export function listModels(): Model[] {
  return getDb().select().from(models).all();
}

export function getModel(id: number): Model | undefined {
  return getDb().select().from(models).where(eq(models.id, id)).get();
}

export function getModelByName(name: string): Model | undefined {
  return getDb().select().from(models).where(eq(models.name, name)).get();
}

export function createModel(input: ModelInput): Model {
  return getDb()
    .insert(models)
    .values({
      name: input.name,
      description: input.description ?? null,
      enabled: input.enabled ?? true,
    })
    .returning()
    .get();
}

export function updateModel(id: number, input: Partial<ModelInput>): Model | undefined {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (Object.keys(patch).length === 0) return getModel(id);
  return getDb().update(models).set(patch).where(eq(models.id, id)).returning().get();
}

export function deleteModel(id: number): void {
  getDb().delete(models).where(eq(models.id, id)).run();
}
