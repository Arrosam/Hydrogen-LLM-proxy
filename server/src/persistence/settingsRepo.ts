import { eq } from "drizzle-orm";
import type { DB } from "../db";
import { settings } from "../db/schema";
import {
  DEFAULT_IMAGE_CACHE_MAX_BYTES,
  DEFAULT_LOG_PAYLOAD_MAX_CHARS,
  DEFAULT_PROMPT_CACHE_TTL_MINUTES,
  DEFAULT_SESSION_TTL_MS,
  DEFAULT_SIMULATED_STREAMING_TOKEN_RATE,
} from "../config/defaults";
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND } from "../util/time";

export const ALLOWLIST_KEY = "upstream_allowlist";
export const UI_LANGUAGE_KEY = "ui_language";
export const LOG_PAYLOAD_MAX_CHARS_KEY = "log_payload_max_chars";
export const SIMULATED_STREAMING_TOKEN_RATE_KEY = "simulated_streaming_token_rate";
export const PROMPT_CACHE_TTL_KEY = "prompt_cache_ttl_minutes";
export const ALLOW_PRIVATE_UPSTREAMS_KEY = "allow_private_upstreams";
export const IMAGE_CACHE_MAX_BYTES_KEY = "image_cache_max_bytes";
export const SESSION_TTL_KEY = "session_ttl";
/** Instance-wide session cutoff (epoch ms): sessions issued before it are dead. */
export const SESSION_EPOCH_KEY = "session_epoch";
export const LOG_RETENTION_DAYS_KEY = "log_retention_days";
export const RESPONSE_RETENTION_DAYS_KEY = "response_retention_days";

/** Days a stored response is kept when the setting is absent or unusable. */
const DEFAULT_RESPONSE_RETENTION_DAYS = 30;
/** Largest retention the setting accepts (ten years). */
export const MAX_RETENTION_DAYS = 3650;
const DEFAULT_UI_LANGUAGE = "en";
/** The spellings of an enabled flag in a stored setting. */
const TRUTHY_FLAG_PATTERN = /^(1|true|yes|on)$/i;
/** Milliseconds per unit suffix of a duration string. A bare number is
 * milliseconds, as it is in the environment (config's SESSION_TTL); the
 * repository itself always writes a suffixed value (see setSessionTtlMs). */
const DURATION_UNIT_MS: Record<string, number> = { ms: 1, s: MS_PER_SECOND, m: MS_PER_MINUTE, h: MS_PER_HOUR, d: MS_PER_DAY };
const DEFAULT_DURATION_UNIT = "ms";

/**
 * Key/value settings, plus an in-memory cache of the SSRF-guard allowlist and
 * the allow-private flag so the guard can read them synchronously (injected as
 * `() => settings.allowlist()` / `() => settings.allowPrivate()`).
 *
 * Runtime-overridable env settings live here: an admin can change them from the
 * dashboard and they take effect without a restart (where the consuming code
 * reads them via the injected getter). Values absent from the table fall back
 * to the boot-time env default passed in at construction.
 */
export class SettingsRepo {
  private allowlistCache: string[];
  private allowPrivateCache: boolean;

  constructor(
    private readonly db: DB,
    private readonly defaults: {
      allowPrivate: boolean;
      logPayloadMaxChars: number;
      simulatedStreamingTokenRate: number;
      sessionTtlMs: number;
      imageCacheMaxBytes: number;
      promptCacheTtlMinutes: number;
    } = {
      allowPrivate: false,
      logPayloadMaxChars: DEFAULT_LOG_PAYLOAD_MAX_CHARS,
      simulatedStreamingTokenRate: DEFAULT_SIMULATED_STREAMING_TOKEN_RATE,
      sessionTtlMs: DEFAULT_SESSION_TTL_MS,
      imageCacheMaxBytes: DEFAULT_IMAGE_CACHE_MAX_BYTES,
      promptCacheTtlMinutes: DEFAULT_PROMPT_CACHE_TTL_MINUTES,
    },
  ) {
    this.allowlistCache = this.readAllowlist();
    this.allowPrivateCache = this.readAllowPrivate();
  }

  /**
   * Re-read the cached values from the table. The caches are normally kept in
   * step by the writers, so this is only for a change made behind their back --
   * a restore replaces the settings table wholesale, and a stale cache would
   * leave the SSRF guard enforcing the allowlist of the instance we just
   * overwrote.
   */
  reload(): void {
    this.allowlistCache = this.readAllowlist();
    this.allowPrivateCache = this.readAllowPrivate();
  }

  get(key: string): string | undefined {
    return this.db.select().from(settings).where(eq(settings.key, key)).get()?.value;
  }

  /**
   * An integer setting within `[min, max]`. Absent, non-integer or out of range
   * all read as `fallback`: a stored override that cannot be used never beats
   * the default.
   */
  private readInt(key: string, fallback: number, min: number, max = Infinity): number {
    const raw = this.get(key);
    if (raw == null) return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  }

  responseRetentionDays(): number {
    return this.readInt(RESPONSE_RETENTION_DAYS_KEY, DEFAULT_RESPONSE_RETENTION_DAYS, 0, MAX_RETENTION_DAYS);
  }

  set(key: string, value: string): void {
    this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
  }

  /** Clear a runtime override so the env default takes over again. */
  clear(key: string): void {
    this.db.delete(settings).where(eq(settings.key, key)).run();
  }

  private readAllowlist(): string[] {
    const raw = this.get(ALLOWLIST_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  /** The cached trusted-upstream allowlist (read by the SSRF guard). */
  allowlist(): string[] {
    return this.allowlistCache;
  }

  writeAllowlist(list: string[]): void {
    this.set(ALLOWLIST_KEY, JSON.stringify(list));
    this.allowlistCache = list;
  }

  private readAllowPrivate(): boolean {
    const raw = this.get(ALLOW_PRIVATE_UPSTREAMS_KEY);
    if (raw == null) return this.defaults.allowPrivate;
    return TRUTHY_FLAG_PATTERN.test(raw.trim());
  }

  /** Whether private/loopback/LAN upstreams are permitted (env overrideable). */
  allowPrivate(): boolean {
    return this.allowPrivateCache;
  }

  writeAllowPrivate(allow: boolean): void {
    this.set(ALLOW_PRIVATE_UPSTREAMS_KEY, allow ? "true" : "false");
    this.allowPrivateCache = allow;
  }

  // --- runtime-overridable env settings -------------------------------------

  /** UI language code (e.g. "en", "zh"). Falls back to "en". */
  uiLanguage(): string {
    return this.get(UI_LANGUAGE_KEY) ?? DEFAULT_UI_LANGUAGE;
  }

  setUiLanguage(lang: string): void {
    this.set(UI_LANGUAGE_KEY, lang);
  }

  logPayloadMaxChars(): number {
    return this.readInt(LOG_PAYLOAD_MAX_CHARS_KEY, this.defaults.logPayloadMaxChars, 0);
  }

  setLogPayloadMaxChars(n: number): void {
    this.set(LOG_PAYLOAD_MAX_CHARS_KEY, String(n));
  }

  simulatedStreamingTokenRate(): number {
    return this.readInt(SIMULATED_STREAMING_TOKEN_RATE_KEY, this.defaults.simulatedStreamingTokenRate, 1);
  }

  setSimulatedStreamingTokenRate(n: number): void {
    this.set(SIMULATED_STREAMING_TOKEN_RATE_KEY, String(n));
  }

  /** Auto-planted Anthropic cache-breakpoint lifetime, minutes. Wire values are
   * 5m/1h only: <=5 renders as the 5m default, anything longer as 1h. */
  promptCacheTtlMinutes(): number {
    return this.readInt(PROMPT_CACHE_TTL_KEY, this.defaults.promptCacheTtlMinutes, 1);
  }

  setPromptCacheTtlMinutes(n: number): void {
    this.set(PROMPT_CACHE_TTL_KEY, String(n));
  }

  /**
   * Storage budget for the OCR image-description cache, in bytes. 0 turns the
   * cache off (and empties it) — every image goes to the OCR model.
   */
  imageCacheMaxBytes(): number {
    return this.readInt(IMAGE_CACHE_MAX_BYTES_KEY, this.defaults.imageCacheMaxBytes, 0);
  }

  setImageCacheMaxBytes(n: number): void {
    this.set(IMAGE_CACHE_MAX_BYTES_KEY, String(n));
  }

  sessionTtlMs(): number {
    const raw = this.get(SESSION_TTL_KEY);
    if (raw == null) return this.defaults.sessionTtlMs;
    const ms = parseDurationToMs(raw);
    return ms ?? this.defaults.sessionTtlMs;
  }

  setSessionTtlMs(ms: number): void {
    this.set(SESSION_TTL_KEY, `${Math.round(ms / MS_PER_SECOND)}s`);
  }

  /** The instance-wide session cutoff (epoch ms). 0 = no sessions invalidated. */
  sessionEpochMs(): number {
    const raw = this.get(SESSION_EPOCH_KEY);
    const n = raw != null ? Number(raw) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** Invalidate every existing session by moving the cutoff to `nowMs`. */
  bumpSessionEpoch(nowMs: number): void {
    this.set(SESSION_EPOCH_KEY, String(Math.floor(nowMs)));
  }

  /** Snapshot of every runtime-overridable env setting (for the settings UI). */
  runtimeEnv(): {
    allowPrivateUpstreams: boolean;
    logPayloadMaxChars: number;
    simulatedStreamingTokenRate: number;
    sessionTtlMs: number;
    promptCacheTtlMinutes: number;
  } {
    return {
      allowPrivateUpstreams: this.allowPrivate(),
      logPayloadMaxChars: this.logPayloadMaxChars(),
      simulatedStreamingTokenRate: this.simulatedStreamingTokenRate(),
      sessionTtlMs: this.sessionTtlMs(),
      promptCacheTtlMinutes: this.promptCacheTtlMinutes(),
    };
  }
}

/** Parse a human duration string ("12h", "30m", "3600s", "2d"; a bare number is ms) to ms. Returns null if unparseable. */
export function parseDurationToMs(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = (m[2] ?? DEFAULT_DURATION_UNIT).toLowerCase();
  return n * DURATION_UNIT_MS[unit];
}
