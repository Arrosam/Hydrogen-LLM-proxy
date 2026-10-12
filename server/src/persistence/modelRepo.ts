import type { DB } from "../db";
import { models, type Model } from "../db/schema";
import { pickDefined, TableRepo } from "./tableRepo";

export interface ModelInput {
  name: string;
  description?: string | null;
  enabled?: boolean;
}

/** Internal model catalog. Models are served to clients only through services. */
export class ModelRepo extends TableRepo<typeof models> {
  constructor(db: DB) {
    super(db, models);
  }

  getByName(name: string): Model | undefined {
    return this.findBy(models.name, name);
  }

  create(input: ModelInput): Model {
    return this.db
      .insert(models)
      .values({ name: input.name, description: input.description ?? null, enabled: input.enabled ?? true })
      .returning()
      .get();
  }

  update(id: number, input: Partial<ModelInput>): Model | undefined {
    return this.patch(id, pickDefined(input, ["name", "description", "enabled"]));
  }
}
