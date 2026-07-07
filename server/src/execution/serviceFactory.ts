import type { ModelServiceRow } from "../db/schema";
import type { ServiceRepo } from "../persistence/serviceRepo";
import { isAgent, parseService } from "./definition";
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
    private readonly logMaxChars: number,
  ) {}

  private microDeps(): MicroAgentDeps {
    return { ...this.deps, resolver: this, logMaxChars: this.logMaxChars };
  }

  /** Build the top-level executor for a request. Throws ZodError on a bad definition. */
  forRow(row: ModelServiceRow): { executor: ModelService; isAgent: boolean } {
    const def = parseService(row.definition);
    const agent = isAgent(def);
    return { executor: agent ? new MicroAgent(def, this.microDeps()) : new ModelService(def, this.deps), isAgent: agent };
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
