/**
 * Shared scaffolding for the characterization tests: a recording fetch mock
 * routed by "METHOD /path", the provider stack the real app mounts (see
 * src/main.tsx), and DOM lookups that survive a refactor which keeps the
 * visible result but changes how a label is wired to its control.
 */
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { fireEvent, render, screen, waitFor, type RenderResult } from "@testing-library/react";
import { expect, vi } from "vitest";
import { ToastProvider } from "../src/components/Toast";
import { AuthProvider, useAuth } from "../src/auth";
import { I18nProvider } from "../src/lib/i18n";
import type { User } from "../src/types";

export const API_PREFIX = "/admin/api";

export interface Call {
  method: string;
  path: string;
  /** Parsed JSON body; undefined when the request carried none. */
  body: unknown;
  headers: Record<string, string>;
  credentials: unknown;
}

/** A non-2xx answer. A string body is sent verbatim (not JSON-encoded). */
export class HttpFail {
  constructor(public status: number, public body: unknown) {}
}
export const fail = (status: number, body?: unknown): HttpFail => new HttpFail(status, body);

/** A fixed answer, or a function of the parsed request body (may be async or throw). */
export type Handler = unknown | ((body: unknown, call: Call) => unknown);
export type Routes = Record<string, Handler>;

export interface MockApi {
  calls: Call[];
  /** Replace or add a route after installation. */
  on: (route: string, handler: Handler) => void;
  /** Calls matching a method and path, in order. */
  sent: (method: string, path: string) => Call[];
  /** Every non-GET call, in order. */
  mutations: () => Call[];
}

export const ADMIN: User = { id: 1, username: "root", role: "admin", enabled: true, mustChangePassword: false, createdAt: 1_700_000_000_000 };
export const MANAGER: User = { id: 2, username: "mia", role: "manager", enabled: true, mustChangePassword: false, createdAt: 1_700_000_100_000 };

/**
 * Install a fetch mock. Routes the caller does not supply answer 404 with a
 * recognisable error, except the two the providers themselves call on mount:
 * `/me` (401 unless `user` is given) and `/settings/ui-language` (English).
 */
export function mockApi(routes: Routes = {}, user: User | null = null): MockApi {
  const table: Routes = {
    "GET /me": user ? { user } : fail(401, { error: "unauthorized" }),
    "GET /settings/ui-language": { language: "en" },
    ...routes,
  };
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const path = url.startsWith(API_PREFIX) ? url.slice(API_PREFIX.length) : url;
    const call: Call = {
      method,
      path,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
      credentials: init?.credentials,
    };
    calls.push(call);
    const key = `${method} ${path}`;
    const handler = key in table ? table[key] : fail(404, { error: `no mock for ${key}` });
    const result: unknown = typeof handler === "function" ? await (handler as (b: unknown, c: Call) => unknown)(call.body, call) : handler;
    const status = result instanceof HttpFail ? result.status : 200;
    const payload = result instanceof HttpFail ? result.body : result;
    const text = payload === undefined ? "" : typeof payload === "string" && result instanceof HttpFail ? payload : JSON.stringify(payload);
    return { ok: status >= 200 && status < 300, status, text: async () => text } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    on: (route, handler) => { table[route] = handler; },
    sent: (method, path) => calls.filter((c) => c.method === method && c.path === path),
    mutations: () => calls.filter((c) => c.method !== "GET"),
  };
}

/** Shows who the AuthProvider currently holds, so a test can observe login/logout. */
export function AuthProbe() {
  const { user, loading } = useAuth();
  return <output data-testid="auth-probe">{loading ? "loading" : user ? `${user.username}:${user.role}:${user.mustChangePassword ? "must-change" : "ok"}` : "anonymous"}</output>;
}
export const authState = (): string => screen.getByTestId("auth-probe").textContent ?? "";

/** Render inside the same provider stack as src/main.tsx (router, toast, auth, i18n). */
export function renderApp(ui: ReactElement, route = "/"): RenderResult {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <ToastProvider>
        <AuthProvider>
          <I18nProvider>{ui}</I18nProvider>
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** Class set of an element, order- and whitespace-insensitive. */
export const classes = (el: Element | null | undefined): string[] => {
  if (!el) throw new Error("classes(): element not found");
  return [...el.classList].sort();
};
/** The same normalisation for an expected class string. */
export const cls = (expected: string): string[] => expected.trim().split(/\s+/).sort();

const CONTROL = "input, select, textarea";
const ownText = (el: Element): string => (el.textContent ?? "").replace(/\s+/g, " ").trim();

/**
 * The form control a visible label belongs to. Works for a sibling label
 * (`<div><label/><input/></div>`), a wrapping label, and a `for=` label, so a
 * refactor may switch between them freely. An exact text match wins over a
 * prefix match (labels often carry a trailing hint).
 */
export function field<T extends HTMLElement = HTMLInputElement>(label: string, within: ParentNode = document.body): T {
  const all = [...within.querySelectorAll("label, .label")];
  const el = all.find((e) => ownText(e) === label) ?? all.find((e) => ownText(e).startsWith(label));
  if (!el) throw new Error(`field(): no label "${label}"`);
  const wrap = el.closest("label");
  const control =
    wrap?.querySelector(CONTROL) ??
    (wrap?.htmlFor ? document.getElementById(wrap.htmlFor) : null) ??
    el.parentElement?.querySelector(CONTROL);
  if (!control) throw new Error(`field(): label "${label}" has no control`);
  return control as T;
}

/** The label element (the one carrying the visible caption) for assertions on its class. */
export function labelEl(label: string, within: ParentNode = document.body): HTMLElement {
  const all = [...within.querySelectorAll(".label")];
  const el = all.find((e) => ownText(e) === label) ?? all.find((e) => ownText(e).startsWith(label));
  if (!el) throw new Error(`labelEl(): no label "${label}"`);
  return el as HTMLElement;
}

/** The open modal with this title (its card), or null when none is open. */
export function modal(title: string): HTMLElement | null {
  const heading = [...document.querySelectorAll("h2")].find((h) => ownText(h) === title);
  return (heading?.closest(".card") as HTMLElement | null) ?? null;
}
export function openModal(title: string): HTMLElement {
  const m = modal(title);
  if (!m) throw new Error(`openModal(): no modal titled "${title}"`);
  return m;
}

/** The button whose icon is `icon` (for icon-only actions such as edit/delete). */
export function iconButton(icon: string, within: ParentNode = document.body): HTMLButtonElement {
  const btn = within.querySelector(`button i.${icon}`)?.closest("button");
  if (!btn) throw new Error(`iconButton(): no button with icon ${icon}`);
  return btn as HTMLButtonElement;
}

/** The button with exactly this visible text. */
export function button(text: string, within: ParentNode = document.body): HTMLButtonElement {
  const btn = [...within.querySelectorAll("button")].find((b) => ownText(b) === text);
  if (!btn) throw new Error(`button(): no button "${text}"`);
  return btn;
}
export const hasButton = (text: string, within: ParentNode = document.body): boolean =>
  [...within.querySelectorAll("button")].some((b) => ownText(b) === text);

/** Text of every toast currently on screen. */
export const toasts = (): string[] =>
  [...document.querySelectorAll(".pointer-events-auto > span")].map((s) => s.textContent ?? "");

/** A promise plus its settle functions, for holding a request open. */
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Render a page with the provider stack plus an AuthProbe, and wait until `/me` has settled. */
export async function renderPage(ui: ReactElement, route = "/"): Promise<RenderResult> {
  const view = renderApp(<>{ui}<AuthProbe /></>, route);
  await waitFor(() => expect(authState()).not.toBe("loading"));
  return view;
}

/** Wait for a toast with exactly this text. */
export const toastShown = (text: string): Promise<void> => waitFor(() => expect(toasts()).toContain(text));

/** Set a text input / textarea / select to a value the way a user edit reports it. */
export const type = (el: Element, value: string): void => { fireEvent.change(el, { target: { value } }); };

/** The switch of a labelled Toggle. */
export function toggle(label: string, within: ParentNode = document.body): HTMLButtonElement {
  const wrap = [...within.querySelectorAll("label")].find((l) => ownText(l) === label && l.querySelector("button"));
  if (!wrap) throw new Error(`toggle(): no toggle "${label}"`);
  return wrap.querySelector("button") as HTMLButtonElement;
}
/** Whether a Toggle switch is drawn in its on state. */
export const isOn = (sw: Element): boolean => sw.classList.contains("bg-brand-600");

/** Texts of the direct cells of a table row. */
export const cells = (row: Element): string[] => [...row.querySelectorAll("td")].map((td) => ownText(td));
