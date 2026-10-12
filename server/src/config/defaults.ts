import { BYTES_PER_MIB } from "./limits";
import { MS_PER_HOUR } from "../util/time";

/**
 * Defaults of the operator-tunable settings. Each is the env default in
 * config/index.ts and the fallback wherever the setting is read without one.
 */
export const DEFAULT_LOG_PAYLOAD_MAX_CHARS = 100_000;
/** Tokens per second of a simulated (replayed) stream. */
export const DEFAULT_SIMULATED_STREAMING_TOKEN_RATE = 2000;
export const DEFAULT_PROMPT_CACHE_TTL_MINUTES = 30;
export const DEFAULT_IMAGE_CACHE_MAX_BYTES = 64 * BYTES_PER_MIB;
/** The SESSION_TTL env default, and the same duration in milliseconds. */
export const DEFAULT_SESSION_TTL = "12h";
export const DEFAULT_SESSION_TTL_MS = 12 * MS_PER_HOUR;
export const DEFAULT_STREAM_COMMIT_GRACE_MS = 2_500;
export const DEFAULT_STREAM_PING_INTERVAL_MS = 10_000;
export const DEFAULT_JSON_COMMIT_GRACE_MS = 30_000;
