/** Rate-limit window shared by the global limiter and the per-route overrides. */
export const RATE_LIMIT_WINDOW = "1 minute";
/** Requests per window for any route without its own limit. */
export const DEFAULT_RATE_LIMIT_MAX = 100;
/** Login attempts per window. */
export const LOGIN_RATE_LIMIT_MAX = 10;
/** Upstream key checks per window. */
export const KEY_CHECK_RATE_LIMIT_MAX = 30;
