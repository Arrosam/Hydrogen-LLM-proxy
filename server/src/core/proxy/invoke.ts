import type { IRRequest } from "../ir";
import type { AttemptResult } from "../services/engine";
import { isAgent, type ServiceDef } from "../services/schema";
import { countAttempts, runAgent, type StageResolver } from "../agents/engine";
import { runServiceJson, type JsonSuccess } from "./run";

/**
 * Uniform outcome of running any service definition buffered. A Micro Agent
 * presents the same interface as a Model Service: callers get one result and
 * one loggable attempt path without branching on the kind.
 */
export interface ServiceRun {
  result: AttemptResult<JsonSuccess>;
  /** AttemptRecord[] for a Model Service; ServiceCall[] for a Micro Agent. */
  attemptPath: unknown;
  attempts: number;
}

/** Run a Model Service or Micro Agent to completion (non-streaming). */
export async function runServiceDef(
  def: ServiceDef,
  ir: IRRequest,
  resolve: StageResolver,
  stack: string[] = [],
): Promise<ServiceRun> {
  if (isAgent(def)) {
    const { result, calls } = await runAgent(ir, def, resolve, stack);
    return { result, attemptPath: calls, attempts: countAttempts(calls) };
  }
  const { result, path } = await runServiceJson(ir, def);
  return { result, attemptPath: path, attempts: path.length };
}
