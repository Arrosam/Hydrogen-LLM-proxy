/**
 * Shared scaffolding for the Logs page tests: the instant both files freeze the
 * clock at, the list fixtures, and a fetch mock that answers every filter/page combination.
 */
import { act } from "@testing-library/react";
import { vi } from "vitest";
import { Logs } from "../src/pages/Logs";
import type { LogSummary, ModelService, Token, User } from "../src/types";
import { ADMIN, mockApi, renderPage, type Handler, type Routes } from "./helpers";

export const NOW = new Date(2026, 5, 1, 12, 0, 0).getTime();

export const sentBare = (method: string, path: string) => ({ method, path, body: undefined, headers: {}, credentials: "same-origin" });
export const PAGE_TITLE = "flex items-center gap-2.5 text-2xl font-semibold text-ink-100";
export const ERROR_NOTE = "flex items-center gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300";
export const MUTED_BOX = "rounded-lg border border-ink-800 bg-ink-950 px-3 py-2 text-xs text-ink-500";
export const NOT_RECORDED = "— not recorded —";
export const ROW_CHEVRON = "bi mr-1 text-ink-500";
export const spinner = (within: ParentNode = document.body) => within.querySelector(".py-16 .animate-spin");
export const errorNote = (within: ParentNode = document.body) => within.querySelector(".border-red-900\\/50.px-4");
export const text = (el: Element | null | undefined): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
/** Advance the interval clock, then let every request that can settle do so. */
export const tick = (ms = 0) => act(async () => {
  vi.advanceTimersByTime(ms);
  await new Promise((r) => setTimeout(r, 0));
});

export const service = (id: number, name: string): ModelService => ({
  id, name, description: null, steps: { timeoutMs: 60000, steps: [{ model: "sonnet", provider: "openai" }] }, enabled: true, summary: "", createdAt: id,
});
export const token = (id: number, name: string, keyPrefix: string): Token => ({
  id, name, keyPrefix, ownerUserId: 1, scopeServices: null, maxRequests: null, maxTokens: null, usedRequests: 0, usedTokens: 0,
  expiresAt: null, enabled: true, createdAt: id, hasStoredKey: true,
});
export const SERVICES = [service(10, "svc-a"), service(11, "svc-b")];
export const TOKENS = [token(1, "laptop", "hk_abc"), token(2, "ci", "hk_xyz")];

export const row = (id: number, extra: Partial<LogSummary> = {}): LogSummary => ({
  id, createdAt: NOW - 310_000, tokenId: 1, serviceId: 10, serviceName: "svc-a", ingressFormat: "openai", egressFormat: "anthropic",
  streaming: false, httpStatus: 200, promptTokens: 1200, completionTokens: 450, totalTokens: 1650, cachedInputTokens: 0,
  cacheCreationInputTokens: 0, reasoningTokens: 0, latencyMs: 812, attempts: 1, error: null, ...extra,
});
export const R1 = row(1, { streaming: true, cachedInputTokens: 300, cacheCreationInputTokens: 100, reasoningTokens: 50, attempts: 2 });
export const R2 = row(2, {
  createdAt: NOW - 7_500_000, serviceName: null, serviceId: 11, egressFormat: null, httpStatus: 500, error: "boom",
  promptTokens: 7, completionTokens: 0, totalTokens: 7, latencyMs: 15,
});
export const R3 = row(3, { createdAt: NOW - 262_800_000, serviceName: null, serviceId: 99, httpStatus: 499 });
export const R4 = row(4, { createdAt: 0, serviceName: null, serviceId: null, httpStatus: 0 });
export const ROWS = [R1, R2, R3, R4];

export interface Query { offset?: number; errorsOnly?: boolean; serviceId?: number; tokenId?: number }
/** The list URL for a filter state, parameters in the order the page writes them. */
export const logsPath = (q: Query = {}): string =>
  `/logs?limit=50&offset=${q.offset ?? 0}${q.errorsOnly ? "&errorsOnly=true" : ""}${q.serviceId != null ? `&serviceId=${q.serviceId}` : ""}${q.tokenId != null ? `&tokenId=${q.tokenId}` : ""}`;
export const FIRST = logsPath();
/** The fetch mock routes on the whole path, so answer every filter/page combination a test can reach. */
export const logRoutes = (handler: Handler): Routes => {
  const routes: Routes = {};
  for (const offset of [0, 50, 100]) for (const errorsOnly of [false, true]) for (const serviceId of [undefined, 10, 11]) for (const tokenId of [undefined, 1, 2]) {
    routes[`GET ${logsPath({ offset, errorsOnly, serviceId, tokenId })}`] = handler;
  }
  return routes;
};

export const setup = async (list: Handler = { rows: ROWS, total: ROWS.length }, routes: Routes = {}, me: User = ADMIN) => {
  const api = mockApi({ "GET /services": { services: SERVICES }, "GET /tokens": { tokens: TOKENS }, ...logRoutes(list), ...routes }, me);
  const view = await renderPage(<Logs />);
  await tick();
  const listed = () => api.calls.filter((c) => c.path.startsWith("/logs?")).map((c) => c.path);
  const table = () => view.container.querySelector("table.table");
  const pageRow = (i: number) => table()!.querySelectorAll(":scope > tbody > tr")[i] as HTMLElement;
  const selects = () => [...view.container.querySelectorAll("select")] as HTMLSelectElement[];
  const errorsOnly = () => view.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
  return { api, listed, table, pageRow, selects, errorsOnly, ...view };
};

