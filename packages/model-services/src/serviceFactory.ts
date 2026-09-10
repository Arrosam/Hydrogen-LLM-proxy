import type { ModelServiceRow } from "./schema.js";
import type { ServiceRepo } from "./serviceRepo.js";
import { isChatPipeline, isStepChain, parseService, serviceCategory, type ServiceDef } from "./definition.js";
import { ModelService, type ServiceDeps } from "./modelService.js";
import type { ResolveResult, ServiceResolver } from "./resolver.js";
import { requireKind, serviceKind } from "./kinds.js";
import type { HostedToolRepo } from "./hostedToolRepo.js";
import { HostedToolService } from "./hostedToolService.js";

/**
 * Builds a runnable executor from a saved service: a ModelService for a step
 * chain, or whatever the registered handler builds for any other kind. It is
 * the concrete {@link ServiceResolver} an orchestrating kind (a Micro Agent)
 * uses to resolve a named stage reference, and it hands itself to every
 * handler it builds through so nested references resolve recursively.
 */
export class ServiceFactory implements ServiceResolver {
  constructor(
    private readonly services: ServiceRepo,
    private readonly deps: ServiceDeps,
    private readonly logMaxChars: number | (() => number),
    private readonly hostedTools: HostedToolRepo | null = null,
  ) {}

  /** Build an executor from an already-parsed definition (e.g. an ad-hoc dry-run). */
  buildDef(def: ServiceDef): { executor: ModelService; isAgent: boolean } {
    if (isStepChain(def)) return { executor: new ModelService(def, this.deps), isAgent: false };
    const handler = requireKind(def.kind);
    return {
      executor: handler.build(def, { deps: this.deps, resolver: this, logMaxChars: this.logMaxChars }),
      isAgent: true,
    };
  }

  /** Build the top-level executor for a saved service. Throws ZodError on a bad definition. */
  forRow(row: ModelServiceRow): { executor: ModelService; isAgent: boolean } {
    return this.buildDef(parseService(row.definition));
  }

  /** Include nested references when choosing the stateful hosted-tool route. */
  hasHostedTools(row: ModelServiceRow, visited = new Set<number>()): boolean {
    if (visited.has(row.id) || !row.enabled) return false;
    visited.add(row.id);
    if (this.hostedTools?.forService(row.id).length) return true;
    let def: ServiceDef;
    try { def = parseService(row.definition); } catch { return false; }
    if (isStepChain(def)) return false;
    const names = serviceKind(def.kind)?.references(def) ?? [];
    return names.some(name => {
      const child = this.services.getByName(name);
      return child ? this.hasHostedTools(child, visited) : false;
    });
  }

  /** Resolve an stt-category Model Service to its raw step chain (the ASR
   * pre-pass drives the transcriptions endpoint itself; there is no chat
   * executor to build). */
  sttDef(name: string): { ok: true; def: import("./definition.js").ServiceSteps } | { ok: false; message: string } {
    const row = this.services.getByName(name);
    if (!row || !row.enabled) {
      return { ok: false, message: `audio transcription (ASR) references unknown or disabled Model Service "${name}"` };
    }
    try {
      const def = parseService(row.definition);
      if (!isStepChain(def)) return { ok: false, message: `audio transcription (ASR) references "${name}", a ${def.kind} (must be an stt Model Service)` };
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
      // can change category after the reference was saved — re-check at runtime.
      const category = serviceCategory(def);
      if (!isChatPipeline(category)) {
        return { ok: false, message: `"${name}" is a ${category} service and cannot run inside a Micro Agent` };
      }
      const { executor, isAgent: agent } = this.buildDef(def);
      const tools = this.hostedTools?.forService(row.id) ?? [];
      return { ok: true, executor: tools.length ? new HostedToolService(executor, this.deps, tools, def.hostedTools) : executor, isAgent: agent };
    } catch {
      return { ok: false, message: `"${name}" has an invalid definition` };
    }
  }
}
