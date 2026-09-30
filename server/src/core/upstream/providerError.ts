import type { StreamEvent } from "../ir/stream";

export interface ProviderFailure {
  message: string;
  status: number;
  retryable: boolean;
}

/** Normalize provider error envelopes without treating deterministic rejection
 * as an opaque, retryable 502. Never include the whole upstream payload. */
export function providerFailure(value: unknown): ProviderFailure {
  const error = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const code = String(error.type ?? error.code ?? "").toLowerCase();
  const supplied = Number(error.status ?? error.status_code);
  const status = Number.isInteger(supplied) && supplied >= 400 && supplied <= 599 ? supplied
    : /rate_limit|too_many_requests/.test(code) ? 429
    : /overload|unavailable|server_error|internal_error/.test(code) ? 503
    : /authentication|invalid_api_key/.test(code) ? 401
    : /permission|forbidden/.test(code) ? 403
    : /invalid_request|invalid_argument|bad_request|validation|context_length|not_found|billing|insufficient_quota/.test(code) ? 400 : 502;
  const message = typeof error.message === "string" && error.message ? error.message.slice(0, 2000)
    : typeof value === "string" && value ? value.slice(0, 2000) : "Upstream reported an in-stream error";
  return { message, status, retryable: status === 429 || status >= 500 && status !== 502 };
}

export function providerErrorEvent(value: unknown, usage?: Extract<StreamEvent, { type: "finish" }>["usage"]): Extract<StreamEvent, { type: "finish" }> {
  const failure = providerFailure(value);
  return { type: "finish", stopReason: null, error: failure.message, failure, usage, incomplete: true };
}
