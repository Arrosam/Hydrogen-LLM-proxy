import { eq } from "drizzle-orm";
import type { DB } from "../db";
import { models, type Model } from "../db/schema";

export interface ModelInput {
  name: string;
  description?: string | null;
  enabled?: boolean;
}

/** Internal model catalog. Models are served to clients only through services. */
export class ModelRepo {
  constructor(private readonly db: DB) {}

  list(): Model[] {
    return this.db.select().from(models).all();
  }

  get(id: number): Model | undefined {
    return this.db.select().from(models).where(eq(models.id, id)).get();
  }

  getByName(name: string): Model | undefined {
    return this.db.select().from(models).where(eq(models.name, name)).get();
  }

  create(input: ModelInput): Model {
    return this.db
      .insert(models)
      .values({ name: input.name, description: input.description ?? null, enabled: input.enabled ?? true })
      .returning()
      .get();
  }

  update(id: number, input: Partial<ModelInput>): Model | undefined {
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (Object.keys(patch).length === 0) return this.get(id);
    return this.db.update(models).set(patch).where(eq(models.id, id)).returning().get();
  }

  delete(id: number): void {
    this.db.delete(models).where(eq(models.id, id)).run();
  }
}
