import { MEDIA_FAMILIES, type Catalog } from "@areelai/supplier-management";
import { isChatPipeline, isStepChain, parseService, serviceCategory, summarizeService, type ServiceDef } from "./definition.js";
import { requireKind, type KindValidationContext, type ServiceLookup } from "./kinds.js";

/**
 * Thrown when a definition is structurally valid (passes the zod schema) but
 * semantically wrong: unmapped (model, provider) pairs, or whatever a
 * registered kind's own validation objects to (duplicate stage names, forward
 * references, a bad pre-pass reference).
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
    private readonly services: ServiceLookup,
  ) {}

  validate(raw: unknown): { def: ServiceDef; summary: string } {
    const def = parseService(raw); // throws ZodError on shape problems, UnknownServiceKindError on a foreign kind
    const invalidPairs: string[] = [];

    if (isStepChain(def)) {
      const category = serviceCategory(def);
      for (const step of def.steps) {
        // Chat-pipeline categories (chat, ocr) translate, so any family works.
        if (isChatPipeline(category)) {
          if (!this.catalog.exists(step.model, step.provider)) invalidPairs.push(`${step.model}@${step.provider}`);
          continue;
        }
        // Media passthrough categories are OpenAI-shaped routes. Validate with
        // the SAME endpoint selection the runtime uses, so a provider whose
        // primary is Anthropic but which serves an enabled OpenAI alternate
        // passes here exactly as it will succeed there.
        const media = this.requireMediaEndpoint(step.model, step.provider, `${category} services`);
        if (media) invalidPairs.push(media);
      }
    } else {
      const ctx: KindValidationContext = {
        catalog: this.catalog,
        services: this.services,
        invalidPairs,
        categoryOf: (name) => this.categoryOf(name),
        requireMediaEndpoint: (model, provider, what) => this.requireMediaEndpoint(model, provider, what),
        fail: (message) => {
          throw new ServiceValidationError(message, []);
        },
      };
      requireKind(def.kind).validate(def, ctx);
    }

    if (invalidPairs.length > 0) {
      throw new ServiceValidationError(
        `These (model, provider) pairs are not mapped in the catalog: ${invalidPairs.join(", ")}`,
        invalidPairs,
      );
    }
    return { def, summary: summarizeService(def) };
  }

  /**
   * Check that a step can reach an OpenAI-shaped endpoint, the way the media
   * passthrough and the ASR pre-pass resolve it at run time. Returns the pair to
   * report as unmapped when the catalog has no entry at all, or null when the
   * step is fine; a mapped pair with no usable endpoint throws directly, since
   * "not mapped" would be the wrong diagnosis for it.
   */
  private requireMediaEndpoint(model: string, provider: string, what: string): string | null {
    const res = this.catalog.resolveWithin(model, provider, MEDIA_FAMILIES);
    if (res.ok) return null;
    if (res.error !== "no_endpoint_in_family") return `${model}@${provider}`;
    throw new ServiceValidationError(
      `step ${model}@${provider}: ${what} require an OpenAI-compatible endpoint, and this mapping enables none ` +
        `(add an OpenAI alternate endpoint to the provider and enable it on the mapping)`,
      [],
    );
  }

  /** The category of a saved service by name, or null when it can't be read. */
  private categoryOf(name: string): string | null {
    const row = this.services.getByName(name);
    if (!row) return null;
    try {
      return serviceCategory(this.services.def(row));
    } catch {
      return null;
    }
  }
}
