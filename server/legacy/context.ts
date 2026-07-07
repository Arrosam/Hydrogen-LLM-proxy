import type { AppConfig } from "./config";

let _config: AppConfig | null = null;

export function setConfig(c: AppConfig): void {
  _config = c;
}

export function getConfig(): AppConfig {
  if (!_config) throw new Error("Config not loaded. Call setConfig() during bootstrap.");
  return _config;
}

// In-memory cache of the admin-managed trusted-upstream allowlist. Loaded from
// the DB at boot and refreshed when an admin edits it, so the SSRF guard (which
// lives in core/ and must not import the DB layer) can read it synchronously.
let _upstreamAllowlist: string[] = [];

export function setUpstreamAllowlist(list: string[]): void {
  _upstreamAllowlist = list;
}

export function getUpstreamAllowlist(): string[] {
  return _upstreamAllowlist;
}
