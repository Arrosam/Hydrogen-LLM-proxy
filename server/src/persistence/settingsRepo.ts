import { eq } from "drizzle-orm";
import type { DB } from "../db";
import { settings } from "../db/schema";

const ALLOWLIST_KEY = "upstream_allowlist";
const UI_LANGUAGE_KEY = "ui_language";
const LOG_PAYLOAD_MAX_CHARS_KEY = "log_payload_max_chars";
const SIMULATED_STREAMING_TOKEN_RATE_KEY = "simulated_streaming_token_rate";
const ALLOW_PRIVATE_UPSTREAMS_KEY = "allow_private_upstreams";
const SESSION_TTL_KEY = "session_ttl";

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
    } = {
      allowPrivate: false,
      logPayloadMaxChars: 100_000,
      simulatedStreamingTokenRate: 2000,
      sessionTtlMs: 12 * 60 * 60 * 1000,
    },
  ) {
    this.allowlistCache = this.readAllowlist();
    this.allowPrivateCache = this.readAllowPrivate();
  }

  get(key: string): string | undefined {
    return this.db.select().from(settings).where(eq(settings.key, key)).get()?.value;
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
    return /^(1|true|yes|on)$/i.test(raw.trim());
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
    return this.get(UI_LANGUAGE_KEY) ?? "en";
  }

  setUiLanguage(lang: string): void {
    this.set(UI_LANGUAGE_KEY, lang);
  }

  logPayloadMaxChars(): number {
    const raw = this.get(LOG_PAYLOAD_MAX_CHARS_KEY);
    if (raw == null) return this.defaults.logPayloadMaxChars;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && Number.isInteger(n) ? n : this.defaults.logPayloadMaxChars;
  }

  setLogPayloadMaxChars(n: number): void {
    this.set(LOG_PAYLOAD_MAX_CHARS_KEY, String(n));
  }

  simulatedStreamingTokenRate(): number {
    const raw = this.get(SIMULATED_STREAMING_TOKEN_RATE_KEY);
    if (raw == null) return this.defaults.simulatedStreamingTokenRate;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? n : this.defaults.simulatedStreamingTokenRate;
  }

  setSimulatedStreamingTokenRate(n: number): void {
    this.set(SIMULATED_STREAMING_TOKEN_RATE_KEY, String(n));
  }

  sessionTtlMs(): number {
    const raw = this.get(SESSION_TTL_KEY);
    if (raw == null) return this.defaults.sessionTtlMs;
    const ms = parseDurationToMs(raw);
    return ms ?? this.defaults.sessionTtlMs;
  }

  setSessionTtlMs(ms: number): void {
    this.set(SESSION_TTL_KEY, `${Math.round(ms / 1000)}s`);
  }

  /** Snapshot of every runtime-overridable env setting (for the settings UI). */
  runtimeEnv(): {
    allowPrivateUpstreams: boolean;
    logPayloadMaxChars: number;
    simulatedStreamingTokenRate: number;
    sessionTtlMs: number;
  } {
    return {
      allowPrivateUpstreams: this.allowPrivate(),
      logPayloadMaxChars: this.logPayloadMaxChars(),
      simulatedStreamingTokenRate: this.simulatedStreamingTokenRate(),
      sessionTtlMs: this.sessionTtlMs(),
    };
  }
}

/** Parse a human duration string ("12h", "30m", "3600s", "2d") to ms. Returns null if unparseable. */
export function parseDurationToMs(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = (m[2] ?? "s").toLowerCase();
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return n * mult[unit];
}
