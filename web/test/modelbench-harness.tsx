/**
 * Scaffolding shared by the Model Bench characterization files: fixtures, a
 * fetch stub layered over the helpers' admin-API mock that answers the bench's
 * own `fetch` calls (the client surface and the streamed admin route) with
 * real `Response` objects, and lookups for the page's regions.
 */
import { fireEvent, screen, waitFor, type RenderResult } from "@testing-library/react";
import { expect, vi } from "vitest";
import { ModelBench } from "../src/pages/ModelBench";
import type { BenchServiceInfo, BenchTargets, ServiceCategory, Token, User } from "../src/types";
import { ADMIN, button, field, hasButton, labelEl, mockApi, renderPage, type, type Call, type MockApi, type Routes } from "./helpers";

export const JSON_HEADERS = { "content-type": "application/json" };
export const sentJson = (method: string, path: string, body: unknown) => ({ method, path, body, headers: JSON_HEADERS, credentials: "same-origin" });
export const PAGE_TITLE = "flex items-center gap-2.5 text-2xl font-semibold text-ink-100";
export const XS = "btn-ghost btn-xs";
export const SEG_ON = "btn-primary flex-1 btn-xs";
export const SEG_OFF = "btn-ghost flex-1 btn-xs";
export const HINT = "mt-1 text-xs text-ink-500";
export const DEFAULT_PROMPT = "Reply with the single word: pong.";
export const spinner = () => document.querySelector(".animate-spin");
export const errorNote = () => document.querySelector(".border-red-900\\/50.px-4");

const svc = (id: number, name: string, category: ServiceCategory, extra: Partial<BenchServiceInfo> = {}): BenchServiceInfo => ({
  id, name, enabled: true, category, kind: "model_service", valid: true, ...extra,
});
export const TARGETS: BenchTargets = {
  services: [
    svc(1, "chat-svc", "chat"), svc(2, "painter", "image", { enabled: false }), svc(3, "router", "chat", { kind: "micro_agent" }),
    svc(4, "broken", "chat", { valid: false }), svc(5, "ears", "stt"), svc(6, "embedder", "embedding"), svc(7, "ranker", "rerank"),
    svc(8, "filmer", "video"), svc(9, "speaker", "tts"), svc(10, "scanner", "ocr"),
  ],
  mappings: [
    { modelId: 1, model: "sonnet", providerId: 1, provider: "anthropic-main", upstreamModel: "claude-sonnet", families: ["anthropic"], enabled: true },
    { modelId: 1, model: "sonnet", providerId: 2, provider: "router-x", upstreamModel: "sonnet-x", families: ["openai_completion", "openai_responses"], enabled: false },
    { modelId: 2, model: "gpt", providerId: 3, provider: "openai", upstreamModel: "gpt-4o", families: ["openai_responses", "openai_completion"], enabled: true },
  ],
};
export const KEY: Token = {
  id: 1, name: "laptop", keyPrefix: "hk_abc", ownerUserId: 1, scopeServices: null, maxRequests: null, maxTokens: null,
  usedRequests: 0, usedTokens: 0, expiresAt: null, enabled: true, createdAt: 1, hasStoredKey: true,
};
export const SERVICE_1 = { kind: "service", serviceId: 1 };
export const SERVED = { model: "sonnet", provider: "anthropic-main", family: "anthropic", upstreamModel: "claude-sonnet" };
export const USER_TEXT = (text: string = DEFAULT_PROMPT) => [{ role: "user", content: [{ type: "text", text }] }];
/** The default internal chat request for service 1, with the given wire body. */
export const chatReq = (body: unknown, extra: Record<string, unknown> = {}) =>
  sentJson("POST", "/bench/chat", { target: SERVICE_1, ingress: "openai_completion", body, timeoutMs: 300000, ...extra });

/** One `fetch` the page made outside the admin-API table. */
export interface RawCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  credentials: unknown;
  /** Parsed JSON for a string body; the FormData itself for a multipart one. */
  body: unknown;
  signal: boolean;
}
export type RawHandler = (call: RawCall, init: RequestInit) => Response | Promise<Response>;
export type RawRoutes = Record<string, RawHandler>;

export interface Bench extends RenderResult {
  api: MockApi;
  rawCalls: RawCall[];
}

/**
 * Mount the page. `routes` are admin-API answers (helpers' table, keyed
 * "METHOD /path" without the prefix); `raw` are answered with a real Response
 * and keyed "METHOD <full url>", taking precedence over the table.
 */
export async function setup(routes: Routes = {}, raw: RawRoutes = {}, me: User = ADMIN): Promise<Bench> {
  const api = mockApi({
    "GET /bench/targets": TARGETS,
    "GET /tokens": { tokens: [KEY] },
    "POST /bench/chat": { ok: true, status: 200, latencyMs: 5 },
    "POST /bench/media": { ok: true, status: 200, latencyMs: 5 },
    ...routes,
  }, me);
  const admin = globalThis.fetch;
  const rawCalls: RawCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const handler = raw[`${method} ${url}`];
    if (!handler) return admin(input, init);
    const call: RawCall = {
      url, method,
      headers: (init.headers ?? {}) as Record<string, string>,
      credentials: init.credentials,
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
      signal: init.signal != null,
    };
    rawCalls.push(call);
    return handler(call, init);
  }));
  const view = await renderPage(<ModelBench />);
  return { api, rawCalls, ...view };
}
export async function loaded(routes: Routes = {}, raw: RawRoutes = {}, me: User = ADMIN): Promise<Bench> {
  const r = await setup(routes, raw, me);
  // The header is there from the first paint; the form arrives with the targets.
  await waitFor(() => expect(r.container.querySelector(".card")).not.toBeNull());
  return r;
}

const SSE_HEADERS = { "content-type": "text/event-stream" };
export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: JSON_HEADERS });
/** A finished SSE answer delivered in exactly these chunks. */
export function sse(chunks: Array<string | Uint8Array>, status = 200): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(typeof ch === "string" ? enc.encode(ch) : ch);
      c.close();
    },
  });
  return new Response(stream, { status, headers: SSE_HEADERS });
}
/** Frames as one well-formed SSE body. */
export const sseOf = (frames: string[], status = 200): Response => sse([frames.map((f) => `${f}\n\n`).join("")], status);
/** An SSE answer the test feeds by hand; it errors like a real fetch when the request is aborted. */
export function liveSse(): { handler: RawHandler; push: (text: string) => void; close: () => void } {
  const enc = new TextEncoder();
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
  return {
    handler: (_call, init) => {
      init.signal?.addEventListener("abort", () => ctl.error(new DOMException("The operation was aborted.", "AbortError")));
      return new Response(stream, { headers: SSE_HEADERS });
    },
    push: (text) => ctl.enqueue(enc.encode(text)),
    close: () => ctl.close(),
  };
}

// --- regions -----------------------------------------------------------------

export const sel = (label: string): HTMLSelectElement => field<HTMLSelectElement>(label);
export const options = (s: HTMLSelectElement): string[] => [...s.options].map((o) => o.text);
/** The card under one of the two request-side section headings. */
export const section = (title: string): HTMLElement =>
  [...document.querySelectorAll("h3")].find((h) => h.textContent === title)!.closest(".card") as HTMLElement;
export const secret = (): HTMLInputElement => document.querySelector('input[type="password"]') as HTMLInputElement;
export const fileInput = (): HTMLInputElement => document.querySelector('input[type="file"]') as HTMLInputElement;
export const attachmentRows = (): HTMLLIElement[] => [...section("Request").querySelectorAll("li")];
export const paramsBox = (): HTMLElement => labelEl("Extra parameters").parentElement as HTMLElement;
export const paramRows = (): HTMLElement[] => [...paramsBox().querySelectorAll<HTMLElement>(".space-y-1\\.5 > div")];
export const paramValues = (): string[][] => paramRows().map((r) => [...r.querySelectorAll("input")].map((i) => i.value));
export function addParam(key: string, value: string): void {
  fireEvent.click(button("Add parameter"));
  const [k, v] = [...paramRows().at(-1)!.querySelectorAll("input")];
  type(k, key);
  type(v, value);
}
export const bodyPanel = (): HTMLElement => section("Request body (exactly what will be sent)");
export const resultCard = (): HTMLElement | null => document.querySelector(".card.space-y-4");
export const blockTitles = (): string[] => [...resultCard()!.querySelectorAll("h4")].map((h) => h.textContent ?? "");
/** A collapsible JSON block of the result, by its heading. */
export function block(title: string): HTMLElement {
  const h = [...document.querySelectorAll("h4")].find((e) => e.textContent === title);
  if (!h) throw new Error(`block(): no block "${title}"`);
  return h.closest("button")!.parentElement!.parentElement as HTMLElement;
}
export const pretty = (v: unknown): string => JSON.stringify(v, null, 2);

export const file = (name: string, mediaType: string, bytes: number[]): File => new File([new Uint8Array(bytes)], name, { type: mediaType });
export async function attach(...files: File[]): Promise<void> {
  fireEvent.change(fileInput(), { target: { files } });
  await screen.findByText(files.at(-1)!.name);
}

/** Press Send and wait for the outcome of that run. */
export async function send(): Promise<HTMLElement> {
  fireEvent.click(button("Send"));
  await waitFor(() => {
    expect(resultCard()).not.toBeNull();
    expect(hasButton("Send")).toBe(true);
  });
  return resultCard()!;
}
/** Press Send and return the admin-API call that run made to `path`. */
export async function sendTo(api: MockApi, path = "/bench/chat"): Promise<Call> {
  const before = api.sent("POST", path).length;
  await send();
  expect(api.sent("POST", path)).toHaveLength(before + 1);
  return api.sent("POST", path)[before];
}
/** Switch to the proxy transport with a pasted key. */
export function viaProxy(): void {
  fireEvent.click(button("Proxy chain"));
  type(secret(), "hk_test");
}
export const pick = (serviceId: number): void => type(sel("Model Service"), String(serviceId));
