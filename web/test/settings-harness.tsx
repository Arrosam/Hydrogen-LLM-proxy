/**
 * Shared scaffolding for the two Settings test files: the default answers of
 * every endpoint the page loads on mount, and lookups scoped to one card.
 */
import { act, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import { Settings } from "../src/pages/Settings";
import { ADMIN, button, classes, mockApi, openModal, renderPage, type MockApi, type Routes } from "./helpers";

export const JSON_HEADERS = { "content-type": "application/json" };
export const sentJson = (method: string, path: string, body: unknown) => ({ method, path, body, headers: JSON_HEADERS, credentials: "same-origin" });
export const sentBare = (method: string, path: string) => ({ method, path, body: undefined, headers: {}, credentials: "same-origin" });
export const MIB = 1024 * 1024;
export const SPIN = "bi bi-arrow-repeat animate-spin";
export const ERROR_NOTE = "flex items-center gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300";
export const SPINNER = "flex items-center justify-center gap-2 py-16 text-ink-400";
export const offline = () => { throw new TypeError("offline"); };

export const STATUS = {
  current: "2.1.6", latest: "2.1.6", updateAvailable: false, releaseUrl: null as string | null, releaseNotes: null, publishedAt: null as string | null,
  prerelease: false, checkedAt: 1, runtime: "docker", restartSupported: false,
};
export const NEWER = { ...STATUS, latest: "2.2.0", updateAvailable: true, releaseUrl: "https://github.com/example/hydrogen/releases/v2.2.0" };
export const UPGRADABLE = { ...NEWER, restartSupported: true };
export const ENV = {
  allowPrivateUpstreams: false, logPayloadMaxChars: 20000, simulatedStreamingTokenRate: 50, sessionTtlMs: 86_400_000, promptCacheTtlMinutes: 5,
  env: { nodeEnv: "production", port: 3000, host: "0.0.0.0", dataDir: "/var/lib/hydrogen/data", adminUsername: "root", cookieSecure: "auto" },
};
export const ENV_BODY = { allowPrivateUpstreams: false, logPayloadMaxChars: 20000, simulatedStreamingTokenRate: 50, sessionTtlMs: 86_400_000, promptCacheTtlMinutes: 5 };
export const CACHE = { maxBytes: 64 * MIB, entries: 1234, usedBytes: 1.5 * MIB };
export const BASE: Routes = {
  "GET /update/check": STATUS,
  "GET /settings/log-retention": { days: 30 },
  "GET /settings/response-retention": { days: 14 },
  "GET /settings/image-cache": CACHE,
  "GET /settings/upstream-allowlist": { entries: ["10.0.0.0/8", "nas.local"] },
  "GET /settings/env": ENV,
  "GET /settings/version": { version: "2.1.6" },
};

export const UPDATE = "About & updates";
export const LANGUAGE = "UI language";
export const BACKUP = "Backup & restore";
export const RETENTION = "Log retention";
export const RESPONSES = "Responses and tool session history";
export const IMAGE_CACHE = "OCR image cache";
export const ALLOWLIST = "Trusted private upstreams";
export const RUNTIME = "Runtime environment";

/** Let every already-answered request reach the screen (the mock answers in microtasks). */
export const flush = () => act(async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); });
export const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
export const setup = async (routes: Routes = {}) => {
  const api = mockApi({ ...BASE, ...routes }, ADMIN);
  const view = await renderPage(<Settings />);
  return { api, ...view };
};
export const loaded = async (routes: Routes = {}) => {
  const r = await setup(routes);
  await flush();
  return r;
};
/** The card (or the Responses section) under this heading; never an open dialog. */
export const card = (title: string): HTMLElement => {
  const h = [...document.querySelectorAll("h2, h3")].find((e) => e.textContent === title);
  if (!h) throw new Error(`card(): no card "${title}"`);
  return h.closest(".card") as HTMLElement;
};
/** One of the two boxes inside the backup card. */
export const box = (title: string): HTMLElement => [...document.querySelectorAll("h4")].find((e) => e.textContent === title)!.closest(".rounded-lg") as HTMLElement;
export const input = (title: string): HTMLInputElement => card(title).querySelector("input")!;
export const icon = (btn: Element) => classes(btn.querySelector("i"));
export const gets = (api: MockApi, path: string) => api.sent("GET", path).length;
export const confirmWith = (title: string) => { fireEvent.click(button("Confirm", openModal(title))); };
