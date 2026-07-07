import type { Catalog } from "../catalog/catalog";
import type { ServiceRepo } from "../persistence/serviceRepo";
import { isAgent, parseService, summarizeService, type ServiceDef } from "./definition";

/**
 * Thrown when a definition is structurally valid (passes the zod schema) but
 * semantically wrong: unmapped (model, provider) pairs, duplicate/forward stage
 * references, an unknown output stage, or a bad OCR reference.
 */
export class ServiceValidationError extends Error {
  constructor(
    message: string,
    public invalidPairs: string[],
  ) {
    super(message);
    this.name = "ServiceValidationError";
  }
}

/** Validates a service definition against the schema AND the live catalog. */
export class ServiceValidator {
  constructor(
    private readonly catalog: Catalog,
    private readonly services: ServiceRepo,
  ) {}

  validate(raw: unknown): { def: ServiceDef; summary: string } {
    const def = parseService(raw); // throws ZodError on shape problems
    const invalidPairs: string[] = [];

    if (isAgent(def)) {
      const names = def.stages.map((s) => s.name);
      const nameSet = new Set(names);
      if (nameSet.size !== names.length) {
        const dup = names.find((n, i) => names.indexOf(n) !== i);
        throw new ServiceValidationError(`duplicate stage name "${dup}"`, []);
      }
      const indexByName = new Map(names.map((n, i) => [n, i]));

      for (let i = 0; i < def.stages.length; i++) {
        const stage = def.stages[i];
        const earlier = new Set(names.slice(0, i));
        const bad = (msg: string): never => {
          throw new ServiceValidationError(`stage "${stage.name}": ${msg}`, []);
        };

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

        const isRouter = !stage.service && (!stage.steps || stage.steps.length === 0);
        if (stage.service) {
          if (!this.services.getByName(stage.service)) bad(`references unknown Model Service or Micro Agent "${stage.service}"`);
        } else if (stage.steps && stage.steps.length) {
          for (const s of stage.steps) {
            if (!this.catalog.exists(s.model, s.provider)) invalidPairs.push(`${s.model}@${s.provider}`);
          }
        }

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
              const targetIsRouter = !target.service && (!target.steps || target.steps.length === 0);
              if (targetIsRouter) bad(`transition returns router stage "${t.output}", which produces no output`);
            }
          }
          const c = t.when;
          if (c.type === "input_matches" || c.type === "output_matches") {
            try {
              new RegExp(c.value);
            } catch {
              bad(`invalid regex "${c.value}"`);
            }
          }
          if (c.type === "output_contains" || c.type === "output_matches") {
            if (isRouter) bad("cannot test output -- a router makes no model call");
            const ref = c.stage ?? stage.name;
            const j = indexByName.get(ref);
            if (j == null) bad(`condition references unknown stage "${ref}"`);
            else if (j > i) bad(`condition references later stage "${ref}"`);
          }
        }
      }
      if (def.output && !nameSet.has(def.output)) {
        throw new ServiceValidationError(`output stage "${def.output}" is not a defined stage`, []);
      }

      if (def.ocr) {
        const o = def.ocr;
        if (o.service) {
          const m = this.services.getByName(o.service);
          if (!m) throw new ServiceValidationError(`image translation (OCR) references unknown Model Service "${o.service}"`, []);
          if (isAgent(this.services.def(m))) {
            throw new ServiceValidationError(`image translation (OCR) references a Micro Agent "${o.service}" (must be a Model Service)`, []);
          }
        } else if (o.steps && o.steps.length) {
          for (const s of o.steps) {
            if (!this.catalog.exists(s.model, s.provider)) invalidPairs.push(`${s.model}@${s.provider}`);
          }
        } else {
          throw new ServiceValidationError("image translation (OCR) is enabled but has no model (pick a Model Service)", []);
        }
      }
    } else {
      for (const step of def.steps) {
        if (!this.catalog.exists(step.model, step.provider)) invalidPairs.push(`${step.model}@${step.provider}`);
      }
    }

    if (invalidPairs.length > 0) {
      throw new ServiceValidationError(
        `These (model, provider) pairs are not mapped in the catalog: ${invalidPairs.join(", ")}`,
        invalidPairs,
      );
    }
    return { def, summary: summarizeService(def) };
  }
}
