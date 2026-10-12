import { MEDIA_FAMILIES, OPENAI_ENDPOINT_REMEDY, type Catalog } from "../catalog/catalog";
import type { ServiceRepo } from "../persistence/serviceRepo";
import { isAgent, isChatPipeline, isRouterStage, parseService, serviceCategory, summarizeService, type ServiceCategory, type ServiceDef } from "./definition";
import { GOTO_END, MAX_CONDITION_PATTERN } from "./agentContext";

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

        const isRouter = isRouterStage(stage);
        if (stage.service) {
          const ref = this.services.getByName(stage.service);
          if (!ref) bad(`references unknown Model Service or Micro Agent "${stage.service}"`);
          else {
            // Media passthrough services (image/video/tts/stt/embedding/rerank)
            // speak a different request shape; a stage cannot run them. Chat
            // and OCR services both run the chat pipeline, so both are fine.
            const cat = this.categoryOf(stage.service);
            if (cat && !isChatPipeline(cat as ServiceCategory)) bad(`references "${stage.service}", a ${cat} service — only chat/OCR services can run inside a Micro Agent`);
          }
        } else if (stage.steps && stage.steps.length) {
          invalidPairs.push(...this.unmappedPairs(stage.steps));
        }

        for (const t of stage.transitions ?? []) {
          if (t.goto !== GOTO_END) {
            const j = indexByName.get(t.goto);
            if (j == null) bad(`transition goto "${t.goto}" is not a stage`);
            else if (j <= i) bad(`transition goto "${t.goto}" must be a later stage (forward-only)`);
          } else if (t.output) {
            const j = indexByName.get(t.output);
            if (j == null) bad(`transition returns unknown stage "${t.output}"`);
            else if (j > i) bad(`transition returns later stage "${t.output}" (must be this or an earlier stage)`);
            else {
              if (isRouterStage(def.stages[j])) bad(`transition returns router stage "${t.output}", which produces no output`);
            }
          }
          const c = t.when;
          if (c.type === "input_matches" || c.type === "output_matches") {
            // Length-capped: these patterns run synchronously against
            // client-influenced text on the event loop, so a huge pattern is a
            // DoS hazard the compile check below cannot see. agentContext.ts
            // also refuses (never matches) anything longer at run time.
            if (c.value.length > MAX_CONDITION_PATTERN) {
              bad(`condition regex is too long (${c.value.length} chars, max ${MAX_CONDITION_PATTERN})`);
            }
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
          // An unreadable category is let through, as it is for a stage.
          this.requireModelService(o.service, "image translation (OCR)", "a Model Service", (cat) =>
            cat && !isChatPipeline(cat as ServiceCategory) ? `a ${cat} service — it must be a chat or OCR Model Service` : null);
        } else if (o.steps && o.steps.length) {
          invalidPairs.push(...this.unmappedPairs(o.steps));
        } else {
          throw new ServiceValidationError("image translation (OCR) is enabled but has no model (pick a Model Service)", []);
        }
      }

      if (def.asr) {
        const a = def.asr;
        if (a.service) {
          this.requireModelService(a.service, "audio transcription (ASR)", "an stt Model Service", (cat) =>
            cat !== "stt" ? `a ${cat ?? "chat"} service — it must be an stt (speech-to-text) Model Service` : null);
        } else if (a.steps && a.steps.length) {
          // Inline ASR steps call /audio/transcriptions directly, so they carry
          // the same OpenAI-endpoint requirement an stt service would.
          for (const st of a.steps) {
            const bad = this.requireMediaEndpoint(st.model, st.provider, "audio transcription (ASR) steps");
            if (bad) invalidPairs.push(bad);
          }
        } else {
          throw new ServiceValidationError("audio transcription (ASR) is enabled but has no model (pick an stt Model Service)", []);
        }
      }
    } else {
      const category = serviceCategory(def);
      for (const step of def.steps) {
        // Chat-pipeline categories (chat, ocr) translate, so any family works.
        if (isChatPipeline(category)) {
          invalidPairs.push(...this.unmappedPairs([step]));
          continue;
        }
        // Media passthrough categories are OpenAI-shaped routes. Validate with
        // the SAME endpoint selection the runtime uses, so a provider whose
        // primary is Anthropic but which serves an enabled OpenAI alternate
        // passes here exactly as it will succeed there.
        const media = this.requireMediaEndpoint(step.model, step.provider, `${category} services`);
        if (media) invalidPairs.push(media);
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

  /** The steps whose (model, provider) pair the catalog does not map, as `model@provider`. */
  private unmappedPairs(steps: ReadonlyArray<{ model: string; provider: string }>): string[] {
    return steps.filter((s) => !this.catalog.exists(s.model, s.provider)).map((s) => `${s.model}@${s.provider}`);
  }

  /**
   * A pre-pass reference must name a saved Model Service (`mustBe`, never a
   * Micro Agent) of a category the pre-pass can drive; `wrongCategory` words
   * what is wrong with the one it has, or returns null when it is fine.
   */
  private requireModelService(name: string, what: string, mustBe: string, wrongCategory: (category: string | null) => string | null): void {
    const row = this.services.getByName(name);
    if (!row) throw new ServiceValidationError(`${what} references unknown Model Service "${name}"`, []);
    let def: ServiceDef;
    try {
      def = this.services.def(row);
    } catch {
      // A pre-pass has to run this service, so one it cannot read is a fault of
      // the reference -- reported as such, not as the parser's own error.
      throw new ServiceValidationError(`${what} references "${name}", whose saved definition is no longer valid (open and re-save it)`, []);
    }
    if (isAgent(def)) {
      throw new ServiceValidationError(`${what} references a Micro Agent "${name}" (must be ${mustBe})`, []);
    }
    const problem = wrongCategory(this.categoryOf(name));
    if (problem) throw new ServiceValidationError(`${what} references "${name}", ${problem}`, []);
  }

  /**
   * Check that a step can reach an OpenAI-shaped endpoint, the way the media
   * controller and the ASR pre-pass resolve it at run time. Returns the pair to
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
        OPENAI_ENDPOINT_REMEDY,
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
