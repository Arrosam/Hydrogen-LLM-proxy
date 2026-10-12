/** HTTP status codes the proxy sends, compares against or maps. */
const STATUS_TABLE = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  /** Anthropic's "overloaded" status. */
  OVERLOADED: 529,
};

// Typed as plain numbers (not literal types) so a status variable seeded from
// the table can still be reassigned.
export const HTTP_STATUS: Readonly<typeof STATUS_TABLE> = STATUS_TABLE;

/** The client went away before the answer was delivered (nginx convention). */
export const STATUS_CLIENT_CLOSED = 499;

/** The status the proxy assigns to an upstream failure it detected itself. */
export const STATUS_UPSTREAM_FAILURE = HTTP_STATUS.BAD_GATEWAY;

const SUCCESS_STATUS_MIN = 200;
const SUCCESS_STATUS_END = 300;
const ERROR_STATUS_MIN = 400;
const SERVER_ERROR_STATUS_MIN = 500;

/** 2xx. */
export function isSuccessStatus(status: number): boolean {
  return status >= SUCCESS_STATUS_MIN && status < SUCCESS_STATUS_END;
}

/** 4xx or 5xx. */
export function isErrorStatus(status: number): boolean {
  return status >= ERROR_STATUS_MIN;
}

/** 5xx. */
export function isServerErrorStatus(status: number): boolean {
  return status >= SERVER_ERROR_STATUS_MIN;
}
