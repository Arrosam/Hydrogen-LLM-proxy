import { and, eq } from "drizzle-orm";
import type { DB } from "../db";
import { modelProviders, type ModelProvider } from "../db/schema";
import { pickDefined, TableRepo } from "./tableRepo";

export interface MappingInput {
  modelId: number;
  providerId: number;
  upstreamModel: string;
  /** Wire families this mapping may use (of the provider's endpoints).
   * Null/empty = the provider's primary type only. */
  families?: string[] | null;
  priority?: number;
  enabled?: boolean;
}

/** Model <-> Provider mappings: the upstream model id for a (model, provider) pair. */
export class MappingRepo extends TableRepo<typeof modelProviders> {
  constructor(db: DB) {
    super(db, modelProviders);
  }

  listForModel(modelId: number): ModelProvider[] {
    return this.db.select().from(modelProviders).where(eq(modelProviders.modelId, modelId)).all();
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
        families: input.families ?? null,
        priority: input.priority ?? 0,
        enabled: input.enabled ?? true,
      })
      .returning()
      .get();
  }

  update(id: number, input: Partial<Omit<MappingInput, "modelId" | "providerId">>): ModelProvider | undefined {
    return this.patch(id, pickDefined(input, ["upstreamModel", "families", "priority", "enabled"]));
  }
}
