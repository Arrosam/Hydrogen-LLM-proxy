import { eq } from "drizzle-orm";
import type { DB } from "../db";
import { settings } from "../db/schema";

const ALLOWLIST_KEY = "upstream_allowlist";

/**
 * Key/value settings, plus an in-memory cache of the SSRF-guard allowlist so the
 * guard can read it synchronously (injected as `() => settings.allowlist()`).
 */
export class SettingsRepo {
  private allowlistCache: string[];

  constructor(private readonly db: DB) {
    this.allowlistCache = this.readAllowlist();
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
}
