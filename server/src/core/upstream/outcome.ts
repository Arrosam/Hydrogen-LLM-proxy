import type { Response } from "../ir/response";
import type { StreamEvent } from "../ir/stream";

/** How an upstream attempt failed: an HTTP status, a timeout, or a transport error. */
export type FailureKind = "http" | "timeout" | "error";

export interface SendFailure {
  ok: false;
  /** HTTP status, or 0 for a transport/timeout/config error. */
  status: number;
  kind: FailureKind;
  message: string;
  /** The upstream error body (parsed JSON when possible), for logging. */
  body?: unknown;
}

/** A completed, buffered response. */
export interface SendSuccess {
  ok: true;
  response: Response;
}

export type SendResult = SendSuccess | SendFailure;

/** A committed live stream: the upstream returned 2xx headers and canonical events. */
export interface RelaySuccess {
  ok: true;
  status: number;
  events: AsyncGenerator<StreamEvent>;
}

export type RelayResult = RelaySuccess | SendFailure;
