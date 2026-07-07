import type { Family } from "../format/family";
import type { AttemptFailure } from "../../execution/steps";

/** HTTP status a failed run maps to: the upstream's 4xx/5xx, else 502. */
export function failureStatus(f: AttemptFailure): number {
  return f.status >= 400 ? f.status : 502;
}

/** Human-readable message for a failed run (upstream body over transport message). */
export function failureMessage(f: AttemptFailure): string {
  return extractUpstreamMessage(f.errorBody) ?? f.message;
}

/** Try to extract a human message from an upstream error body. */
export function extractUpstreamMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return typeof body === "string" && body ? body.slice(0, 500) : null;
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

/** Build an error response body in the client's wire format. */
export function buildErrorBody(family: Family, status: number, message: string): Record<string, unknown> {
  if (family === "anthropic") {
    return { type: "error", error: { type: anthropicErrorType(status), message } };
  }
  return { error: { message, type: openaiErrorType(status), code: null, param: null } };
}

function openaiErrorType(status: number): string {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  if (status >= 400) return "invalid_request_error";
  return "api_error";
}

function anthropicErrorType(status: number): string {
  switch (status) {
    case 400:
      return "invalid_request_error";
    case 401:
      return "authentication_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 429:
      return "rate_limit_error";
    case 529:
      return "overloaded_error";
    default:
      return status >= 500 ? "api_error" : "invalid_request_error";
  }
}
