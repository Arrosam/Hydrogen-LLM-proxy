import type { Response } from "@areelai/wire-format";
import type { StreamEvent } from "@areelai/wire-format";

import type { FailureKind } from "../steps.js";

export interface SendFailure {
  ok: false;
  /** HTTP status, or 0 for a transport/timeout/config error. */
  status: number;
  kind: FailureKind;
  message: string;
  /** The upstream error body (parsed JSON when possible), for logging. */
  body?: unknown;
  /** The exact wire body that was sent upstream, for the request log. */
  sentBody?: Record<string, unknown>;
}

/** A completed, buffered response. */
export interface SendSuccess {
  ok: true;
  response: Response;
  /** The exact wire body that was sent upstream (overrides + translation applied). */
  sentBody: Record<string, unknown>;
}

export type SendResult = SendSuccess | SendFailure;

/** A committed live stream: the upstream returned 2xx headers and canonical events. */
export interface RelaySuccess {
  ok: true;
  status: number;
  events: AsyncGenerator<StreamEvent>;
  /** The exact wire body that was sent upstream. */
  sentBody: Record<string, unknown>;
}

export type RelayResult = RelaySuccess | SendFailure;
