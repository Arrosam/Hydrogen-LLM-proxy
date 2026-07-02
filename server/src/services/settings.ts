import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { settings } from "../db/schema";
import { setUpstreamAllowlist } from "../context";

const ALLOWLIST_KEY = "upstream_allowlist";

/** Read the persisted trusted-upstream allowlist from the settings table. */
export function readUpstreamAllowlist(): string[] {
  const row = getDb().select().from(settings).where(eq(settings.key, ALLOWLIST_KEY)).get();
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Persist the allowlist and refresh the in-memory cache the guard reads. */
export function writeUpstreamAllowlist(list: string[]): void {
  const value = JSON.stringify(list);
  getDb()
    .insert(settings)
    .values({ key: ALLOWLIST_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
  setUpstreamAllowlist(list);
}

/** Load the persisted allowlist into the in-memory cache (called at boot). */
export function loadUpstreamAllowlist(): void {
  setUpstreamAllowlist(readUpstreamAllowlist());
}
