import { eq } from "drizzle-orm";
import type { DB } from "../db";
import { modelServices, type ModelServiceRow } from "../db/schema";
import { isAgent, parseService, type ServiceDef } from "../execution/definition";

export interface ServiceRecordInput {
  name: string;
  description?: string | null;
  /** An already-validated service definition. */
  definition: ServiceDef;
  enabled?: boolean;
}

/** Model Services / Micro Agents: the only entities exposed to clients. */
export class ServiceRepo {
  constructor(private readonly db: DB) {}

  list(): ModelServiceRow[] {
    return this.db.select().from(modelServices).all();
  }

  get(id: number): ModelServiceRow | undefined {
    return this.db.select().from(modelServices).where(eq(modelServices.id, id)).get();
  }

  getByName(name: string): ModelServiceRow | undefined {
    return this.db.select().from(modelServices).where(eq(modelServices.name, name)).get();
  }

  /** Parse a row's stored definition (throws ZodError if it is invalid). */
  def(row: ModelServiceRow): ServiceDef {
    return parseService(row.definition);
  }

  create(input: ServiceRecordInput): ModelServiceRow {
    return this.db
      .insert(modelServices)
      .values({
        name: input.name,
        description: input.description ?? null,
        kind: isAgent(input.definition) ? "micro_agent" : "model_service",
        definition: input.definition,
        enabled: input.enabled ?? true,
      })
      .returning()
      .get();
  }

  update(
    id: number,
    input: { name?: string; description?: string | null; definition?: ServiceDef; enabled?: boolean },
  ): ModelServiceRow | undefined {
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.definition !== undefined) {
      patch.definition = input.definition;
      patch.kind = isAgent(input.definition) ? "micro_agent" : "model_service";
    }
    if (Object.keys(patch).length === 0) return this.get(id);
    return this.db.update(modelServices).set(patch).where(eq(modelServices.id, id)).returning().get();
  }

  delete(id: number): void {
    this.db.delete(modelServices).where(eq(modelServices.id, id)).run();
  }
}
