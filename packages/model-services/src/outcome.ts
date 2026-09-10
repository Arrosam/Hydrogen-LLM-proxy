import type { Family } from "@areelai/wire-format";
import type { Response } from "@areelai/wire-format";
import type { StreamEvent } from "@areelai/wire-format";
import type { AttemptResult } from "./steps.js";

/** A successful buffered run: the response plus which target actually served it. */
export interface InvokeValue {
  response: Response;
  family: Family;
  upstreamModel: string;
  providerName: string;
  modelName: string;
  /** The exact body sent upstream (overrides + translation applied), for logging. */
  upstreamRequest: Record<string, unknown>;
}

/** A successful streaming run: a committed live event stream from the winning target. */
export interface StreamValue {
  events: AsyncGenerator<StreamEvent>;
  family: Family;
  upstreamModel: string;
  providerName: string;
  modelName: string;
  upstreamRequest: Record<string, unknown>;
  /** True when the effective thinking level is "disabled": drop reasoning on relay. */
  dropReasoning: boolean;
}

/**
 * The uniform result of running any service. A Micro Agent presents the same
 * shape as a Model Service (Liskov), so a caller gets one result and one
 * loggable attempt path without branching on the kind.
 */
export interface Invocation {
  /** Usage consumed before a failed orchestrated invocation. */
  usage?: import("@areelai/wire-format").Usage;
  result: AttemptResult<InvokeValue>;
  /** AttemptRecord[] for a Model Service; ServiceCall[] for a Micro Agent. */
  attemptPath: unknown;
  attempts: number;
}

export interface StreamInvocation {
  result: AttemptResult<StreamValue>;
  attemptPath: unknown;
  attempts: number;
}
