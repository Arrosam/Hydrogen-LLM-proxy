import type { ModelService } from "./modelService.js";
import type { ServiceSteps } from "./definition.js";

/** Resolves a saved service name to a runnable executor (a step chain, or any registered kind). */
export type ResolveResult =
  | { ok: true; executor: ModelService; isAgent: boolean }
  | { ok: false; message: string };

export interface ServiceResolver {
  /** Resolve an stt-category service's raw step chain for an ASR pre-pass. */
  sttDef(name: string): { ok: true; def: ServiceSteps } | { ok: false; message: string };
  resolve(name: string): ResolveResult;
}
