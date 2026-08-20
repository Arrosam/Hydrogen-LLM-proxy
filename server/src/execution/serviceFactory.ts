import type { ModelServiceRow } from "../db/schema";
import type { ServiceRepo } from "../persistence/serviceRepo";
import { isAgent, isChatPipeline, parseService, serviceCategory, type ServiceDef } from "./definition";
import { ModelService, type ServiceDeps } from "./modelService";
import { MicroAgent, type MicroAgentDeps, type ResolveResult, type ServiceResolver } from "./microAgent";
import type { OcrCacheStore } from "./ocrCache";

/**
 * Builds a runnable executor (ModelService or MicroAgent) from a saved service.
 * It is the concrete {@link ServiceResolver} a Micro Agent uses to resolve a
 * named stage/OCR reference, and it hands itself to every MicroAgent it builds
 * so nested agents resolve recursively.
 */
export class ServiceFactory implements ServiceResolver {
  constructor(
    private readonly services: ServiceRepo,
    private readonly deps: ServiceDeps,
    private readonly logMaxChars: number | (() => number),
    /** Image-description cache for the OCR pre-pass; omitted = no caching. */
    private readonly ocrCache: OcrCacheStore | null = null,
  ) {}

  private microDeps(): MicroAgentDeps {
    return { ...this.deps, resolver: this, logMaxChars: this.logMaxChars, ocrCache: this.ocrCache };
  }

  /** Build an executor from an already-parsed definition (e.g. an ad-hoc dry-run). */
  buildDef(def: ServiceDef): { executor: ModelService; isAgent: boolean } {
    return isAgent(def)
      ? { executor: new MicroAgent(def, this.microDeps()), isAgent: true }
      : { executor: new ModelService(def, this.deps), isAgent: false };
  }

  /** Build the top-level executor for a saved service. Throws ZodError on a bad definition. */
  forRow(row: ModelServiceRow): { executor: ModelService; isAgent: boolean } {
    return this.buildDef(parseService(row.definition));
  }

  /** Resolve an stt-category Model Service to its raw step chain (the ASR
   * pre-pass drives the transcriptions endpoint itself; there is no chat
   * executor to build). */
  sttDef(name: string): { ok: true; def: import("./definition").ServiceSteps } | { ok: false; message: string } {
    const row = this.services.getByName(name);
    if (!row || !row.enabled) {
      return { ok: false, message: `audio transcription (ASR) references unknown or disabled Model Service "${name}"` };
    }
    try {
      const def = parseService(row.definition);
      if (isAgent(def)) return { ok: false, message: `audio transcription (ASR) references a Micro Agent "${name}" (must be an stt Model Service)` };
      if (serviceCategory(def) !== "stt") {
        return { ok: false, message: `audio transcription (ASR) references "${name}", a ${serviceCategory(def)} service — it must be an stt (speech-to-text) Model Service` };
      }
      return { ok: true, def };
    } catch {
      return { ok: false, message: `"${name}" has an invalid definition` };
    }
  }

  resolve(name: string): ResolveResult {
    const row = this.services.getByName(name);
    if (!row || !row.enabled) {
      return { ok: false, message: `references unknown or disabled Model Service or Micro Agent "${name}"` };
    }
    try {
      const def = parseService(row.definition);
      // The save-time validator rejects this too, but the referenced service
      // can change category after the agent was saved — re-check at runtime.
      const category = serviceCategory(def);
      if (!isChatPipeline(category)) {
        return { ok: false, message: `"${name}" is a ${category} service and cannot run inside a Micro Agent` };
      }
      const { executor, isAgent: agent } = this.buildDef(def);
      return { ok: true, executor, isAgent: agent };
    } catch {
      return { ok: false, message: `"${name}" has an invalid definition` };
    }
  }
}
