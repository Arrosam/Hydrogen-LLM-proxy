import { and, eq } from "drizzle-orm";
import type { DB } from "../db";
import { modelProviders, type ModelProvider } from "../db/schema";

export interface MappingInput {
  modelId: number;
  providerId: number;
  upstreamModel: string;
  priority?: number;
  enabled?: boolean;
}

/** Model <-> Provider mappings: the upstream model id for a (model, provider) pair. */
export class MappingRepo {
  constructor(private readonly db: DB) {}

  list(): ModelProvider[] {
    return this.db.select().from(modelProviders).all();
  }

  listForModel(modelId: number): ModelProvider[] {
    return this.db.select().from(modelProviders).where(eq(modelProviders.modelId, modelId)).all();
  }

  get(id: number): ModelProvider | undefined {
    return this.db.select().from(modelProviders).where(eq(modelProviders.id, id)).get();
  }

  getPair(modelId: number, providerId: number): ModelProvider | undefined {
    return this.db
      .select()
      .from(modelProviders)
      .where(and(eq(modelProviders.modelId, modelId), eq(modelProviders.providerId, providerId)))
      .get();
  }

  create(input: MappingInput): ModelProvider {
    return this.db
      .insert(modelProviders)
      .values({
        modelId: input.modelId,
        providerId: input.providerId,
        upstreamModel: input.upstreamModel,
        priority: input.priority ?? 0,
        enabled: input.enabled ?? true,
      })
      .returning()
      .get();
  }

  update(id: number, input: Partial<Omit<MappingInput, "modelId" | "providerId">>): ModelProvider | undefined {
    const patch: Record<string, unknown> = {};
    if (input.upstreamModel !== undefined) patch.upstreamModel = input.upstreamModel;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (Object.keys(patch).length === 0) return this.get(id);
    return this.db.update(modelProviders).set(patch).where(eq(modelProviders.id, id)).returning().get();
  }

  delete(id: number): void {
    this.db.delete(modelProviders).where(eq(modelProviders.id, id)).run();
  }
}
