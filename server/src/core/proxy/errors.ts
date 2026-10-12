import type { Family } from "../format/family";
import { sseFrame } from "../ir/stream";
import { HTTP_STATUS, STATUS_UPSTREAM_FAILURE, isErrorStatus, isServerErrorStatus } from "../../util/httpStatus";

/** Max chars of a raw string error body shown to the client. */
const MAX_UPSTREAM_ERROR_CHARS = 500;

/** `error.type` values of the client-facing error bodies (OpenAI and Anthropic spellings). */
const ERROR_TYPE = {
  API: "api_error",
  AUTHENTICATION: "authentication_error",
  INVALID_REQUEST: "invalid_request_error",
  NOT_FOUND: "not_found_error",
  OVERLOADED: "overloaded_error",
  PERMISSION: "permission_error",
  RATE_LIMIT: "rate_limit_error",
  SERVER: "server_error",
} as const;

/**
 * What these mappers read of a failed attempt. Declared here, structurally,
 * rather than imported from the step engine: core does not depend on the
 * execution layer, and an `AttemptFailure` satisfies it as it is.
 */
interface FailedAttempt {
  status: number;
  message: string;
  errorBody?: unknown;
}

/** One past the last HTTP status code: nothing at or above this can be sent to a client. */
const HTTP_STATUS_END = 600;

/**
 * HTTP status a failed run maps to: the upstream's 4xx/5xx, else 502. A value
 * an upstream made up outside that range (600 and above, or not a whole
 * number) is not a status this proxy can answer with, so it is reported as
 * the upstream failure it is.
 */
export function failureStatus(f: FailedAttempt): number {
  const relayable = Number.isInteger(f.status) && isErrorStatus(f.status) && f.status < HTTP_STATUS_END;
  return relayable ? f.status : STATUS_UPSTREAM_FAILURE;
}

/** Human-readable message for a failed run (upstream body over transport message). */
export function failureMessage(f: FailedAttempt): string {
  return extractUpstreamMessage(f.errorBody) ?? f.message;
}

/** Try to extract a human message from an upstream error body. */
export function extractUpstreamMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return typeof body === "string" && body ? body.slice(0, MAX_UPSTREAM_ERROR_CHARS) : null;
  }
  const b = body as Record<string, unknown>;
  const err = b.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const m = (err as Record<string, unknown>).message;
    if (typeof m === "string") return m;
  }
  if (typeof b.message === "string") return b.message;
  return null;
}

const openAiErrorBody = (status: number, message: string): Record<string, unknown> =>
  ({ error: { message, type: openaiErrorType(status), code: null, param: null } });
const anthropicErrorBody = (status: number, message: string): Record<string, unknown> =>
  ({ type: "error", error: { type: anthropicErrorType(status), message } });

/** `event:` name of a mid-stream error frame, on the wires that name their frames. */
const ERROR_EVENT = "error";
/** An SSE comment line, which the spec requires parsers to skip. */
const COMMENT_PING_FRAME = ": ping\n\n";

/**
 * How each client wire family is told about a failure and kept alive. A
 * `Record<Family, ...>`, so a new family cannot silently inherit another's
 * shapes: it does not compile until it states its own.
 */
const CLIENT_ERROR_WIRE: Record<Family, {
  /** The error response body. */
  body(status: number, message: string): Record<string, unknown>;
  /** `event:` name of an in-stream error frame; absent on a wire whose frames are unnamed. */
  errorEvent?: string;
  /** A frame conforming clients ignore. */
  ping: string;
}> = {
  openai_completion: { body: openAiErrorBody, ping: COMMENT_PING_FRAME },
  openai_responses: { body: openAiErrorBody, errorEvent: ERROR_EVENT, ping: COMMENT_PING_FRAME },
  anthropic: { body: anthropicErrorBody, errorEvent: ERROR_EVENT, ping: sseFrame('{"type":"ping"}', "ping") },
};

/** A family outside the three keeps getting the Chat Completions shapes, as it always has. */
function clientErrorWire(family: Family): (typeof CLIENT_ERROR_WIRE)[Family] {
  return CLIENT_ERROR_WIRE[family] ?? CLIENT_ERROR_WIRE.openai_completion;
}

/** Build an error response body in the client's wire format. */
export function buildErrorBody(family: Family, status: number, message: string): Record<string, unknown> {
  return clientErrorWire(family).body(status, message);
}

/**
 * The same error as an in-stream SSE frame, for a response whose 200 has
 * already been committed (the keep-alive path). Anthropic documents mid-stream
 * `error` events and its SDKs raise on them; OpenAI SDK stream parsers raise on
 * a chunk carrying an `error` key. The frame is the terminal signal — no
 * [DONE] / message_stop follows it, so a failed run can never be mistaken for
 * a completed answer.
 */
export function buildErrorFrame(family: Family, status: number, message: string): string {
  return sseFrame(JSON.stringify(buildErrorBody(family, status, message)), clientErrorWire(family).errorEvent);
}

/**
 * A keep-alive frame that conforming clients ignore. Anthropic's wire protocol
 * has a first-class ping event (its API emits them routinely); the OpenAI
 * protocols have none, so those get an SSE comment line, which the spec
 * requires parsers to skip.
 */
export function pingFrame(family: Family): string {
  return clientErrorWire(family).ping;
}

function openaiErrorType(status: number): string {
  if (status === HTTP_STATUS.UNAUTHORIZED || status === HTTP_STATUS.FORBIDDEN) return ERROR_TYPE.AUTHENTICATION;
  if (status === HTTP_STATUS.TOO_MANY_REQUESTS) return ERROR_TYPE.RATE_LIMIT;
  if (isServerErrorStatus(status)) return ERROR_TYPE.SERVER;
  if (isErrorStatus(status)) return ERROR_TYPE.INVALID_REQUEST;
  return ERROR_TYPE.API;
}

function anthropicErrorType(status: number): string {
  switch (status) {
    case HTTP_STATUS.BAD_REQUEST:
      return ERROR_TYPE.INVALID_REQUEST;
    case HTTP_STATUS.UNAUTHORIZED:
      return ERROR_TYPE.AUTHENTICATION;
    case HTTP_STATUS.FORBIDDEN:
      return ERROR_TYPE.PERMISSION;
    case HTTP_STATUS.NOT_FOUND:
      return ERROR_TYPE.NOT_FOUND;
    case HTTP_STATUS.TOO_MANY_REQUESTS:
      return ERROR_TYPE.RATE_LIMIT;
    case HTTP_STATUS.OVERLOADED:
      return ERROR_TYPE.OVERLOADED;
    default:
      return isServerErrorStatus(status) ? ERROR_TYPE.API : ERROR_TYPE.INVALID_REQUEST;
  }
}
