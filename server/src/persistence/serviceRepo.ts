import type { DB } from "../db";
import { modelServices, type ModelServiceRow } from "../db/schema";
import { pickDefined, TableRepo } from "./tableRepo";
import { isAgent, parseService, SERVICE_KIND, type ServiceDef } from "../execution/definition";

export interface ServiceRecordInput {
  name: string;
  description?: string | null;
  /** An already-validated service definition. */
  definition: ServiceDef;
  enabled?: boolean;
}

/** The stored `kind` discriminator of a definition. */
function serviceKind(def: ServiceDef): ModelServiceRow["kind"] {
  return isAgent(def) ? SERVICE_KIND.MICRO_AGENT : SERVICE_KIND.MODEL_SERVICE;
}

/** Model Services / Micro Agents: the only entities exposed to clients. */
export class ServiceRepo extends TableRepo<typeof modelServices> {
  constructor(db: DB) {
    super(db, modelServices);
  }

  getByName(name: string): ModelServiceRow | undefined {
    return this.findBy(modelServices.name, name);
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
        kind: serviceKind(input.definition),
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
    const patch: Partial<typeof modelServices.$inferInsert> = pickDefined(input, ["name", "description", "enabled", "definition"]);
    if (input.definition !== undefined) patch.kind = serviceKind(input.definition);
    return this.patch(id, patch);
  }
}
