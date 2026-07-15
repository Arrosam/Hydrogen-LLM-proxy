import type { ModelServiceRow } from "../db/schema";
import type { ServiceRepo } from "../persistence/serviceRepo";
import { isAgent, parseService, type ServiceDef } from "./definition";
import { ModelService, type ServiceDeps } from "./modelService";
import { MicroAgent, type MicroAgentDeps, type ResolveResult, type ServiceResolver } from "./microAgent";

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
  ) {}

  private microDeps(): MicroAgentDeps {
    return { ...this.deps, resolver: this, logMaxChars: this.logMaxChars };
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

  resolve(name: string): ResolveResult {
    const row = this.services.getByName(name);
    if (!row || !row.enabled) {
      return { ok: false, message: `references unknown or disabled Model Service or Micro Agent "${name}"` };
    }
    try {
      const { executor, isAgent: agent } = this.forRow(row);
      return { ok: true, executor, isAgent: agent };
    } catch {
      return { ok: false, message: `"${name}" has an invalid definition` };
    }
  }
}
