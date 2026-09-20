import type { AppConfig } from "./config";

let _config: AppConfig | null = null;

export function setConfig(c: AppConfig): void {
  _config = c;
}

export function getConfig(): AppConfig {
  if (!_config) throw new Error("Config not loaded. Call setConfig() during bootstrap.");
  return _config;
}
