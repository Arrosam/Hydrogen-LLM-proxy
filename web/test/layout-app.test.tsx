/**
 * Characterization of the app shell: the sidebar Layout (navigation per role,
 * the user block, sign-out, the change-password dialog) and App's routing
 * (which page each path renders per role, the redirects, and what stands in
 * for the shell while signed out, loading, or forced to change a password).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import App from "../src/App";
import { Layout, PageHeader } from "../src/components/Layout";
import type { User } from "../src/types";
import {
  ADMIN, AuthProbe, MANAGER, authState, button, classes, cls, deferred, fail, field, hasButton, iconButton, labelEl, mockApi, modal, openModal,
  renderApp, renderPage, toastShown, toasts, type, type Routes as ApiRoutes,
} from "./helpers";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const JSON_HEADERS = { "content-type": "application/json" };
const sentJson = (method: string, path: string, body: unknown) => ({ method, path, body, headers: JSON_HEADERS, credentials: "same-origin" });
const offline = () => { throw new TypeError("offline"); };
const flush = () => act(async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); });

/** Where the router currently is, so a redirect can be told from a mere render. */
function LocationProbe() {
  const { pathname } = useLocation();
  return <output data-testid="location-probe">{pathname}</output>;
}
const path = (): string => screen.getByTestId("location-probe").textContent ?? "";
const navLinks = () => [...document.querySelectorAll<HTMLAnchorElement>("nav a")];

// label, href, icon, admin only
const NAV: [string, string, string, boolean][] = [
  ["Overview", "/", "bi-speedometer2", false],
  ["Model Services", "/services", "bi-diagram-3", false],
  ["Micro Agents", "/micro-agents", "bi-robot", false],
  ["Server Tools", "/tools", "bi-tools", true],
  ["Model Mapping", "/model", "bi-box", false],
  ["Providers", "/providers", "bi-hdd-network", false],
  ["Proxies", "/proxies", "bi-shuffle", false],
  ["API Keys", "/tokens", "bi-key", false],
  ["Model Bench", "/bench", "bi-clipboard-pulse", false],
  ["Logs", "/logs", "bi-journal-text", true],
  ["Active Requests", "/active-requests", "bi-activity", false],
  ["Users", "/users", "bi-people", true],
  ["Key Check", "/check", "bi-search", false],
  ["Settings", "/settings", "bi-gear", true],
];

// ---------------------------------------------------------------------------

describe("Layout", () => {
  const TITLE = "Change password";
  const setup = async (me: User = ADMIN, route = "/", routes: ApiRoutes = {}) => {
    const api = mockApi(routes, me);
    const view = await renderPage(
      <>
        <Routes>
          <Route element={<Layout />}>
            <Route path="*" element={<p data-testid="outlet">page body</p>} />
          </Route>
        </Routes>
        <LocationProbe />
      </>,
      route,
    );
    await flush();
    return { api, ...view };
  };
  const openDialog = () => {
    fireEvent.click(button("Password"));
    return openModal(TITLE);
  };
  const fill = (m: HTMLElement, current: string, next: string, confirmation: string) => {
    type(field("Current password", m), current);
    type(field("New password", m), next);
    type(field("Confirm new password", m), confirmation);
  };

  it("is a fixed sidebar beside a scrolling, centred content column that hosts the routed page", async () => {
    const { container } = await setup();
    const shell = container.firstElementChild!;
    expect(classes(shell)).toEqual(cls("flex h-screen overflow-hidden"));
    expect([...shell.children].map((e) => e.tagName)).toEqual(["ASIDE", "MAIN"]);
    const aside = shell.querySelector("aside")!;
    expect(classes(aside)).toEqual(cls("flex w-64 shrink-0 flex-col border-r border-ink-800 bg-ink-900/60"));
    expect([...aside.children].map((e) => [e.tagName, e.className])).toEqual([
      ["DIV", "flex items-center gap-2.5 px-5 py-5"], ["NAV", "flex-1 space-y-1 px-3 py-2"], ["DIV", "border-t border-ink-800 px-4 py-3"],
    ]);
    const main = shell.querySelector("main")!;
    expect(classes(main)).toEqual(cls("flex-1 overflow-y-auto"));
    expect(classes(main.firstElementChild)).toEqual(cls("mx-auto max-w-6xl px-6 py-8"));
    expect(screen.getByTestId("outlet").parentElement).toBe(main.firstElementChild);
    expect(main.firstElementChild!.children).toHaveLength(1);
  });

  it("shows the brand at the top of the sidebar", async () => {
    const { container } = await setup();
    const brand = container.querySelector("aside")!.firstElementChild!;
    const logo = brand.querySelector("svg")!;
    expect([logo.getAttribute("class"), logo.getAttribute("aria-label"), logo.getAttribute("role")]).toEqual(["h-9 w-9", "Hydrogen", "img"]);
    expect([...brand.querySelectorAll(":scope > div > div")].map((d) => [d.textContent, d.className])).toEqual([
      ["Hydrogen", "text-sm font-semibold text-ink-100"], ["LLM Proxy", "text-[11px] text-ink-500"],
    ]);
  });

  it.each([
    ["an admin", ADMIN, NAV],
    ["a manager", MANAGER, NAV.filter(([, , , adminOnly]) => !adminOnly)],
  ])("lists the navigation for %s in a fixed order, each with its icon", async (_name, me, expected) => {
    await setup(me);
    expect(navLinks().map((a) => [a.textContent, a.getAttribute("href"), a.querySelector("i")!.className])).toEqual(
      expected.map(([label, href, glyph]) => [label, href, `bi ${glyph} text-base`]),
    );
    for (const a of navLinks()) {
      expect(a.classList.contains("nav-link")).toBe(true);
      expect(classes(a.querySelector("span"))).toEqual(["truncate"]);
    }
    expect(document.querySelector("nav")!.children).toHaveLength(expected.length);
  });

  it("Key Check alone opens in a new tab, and says so with a trailing icon", async () => {
    await setup();
    expect(navLinks().filter((a) => a.target !== "").map((a) => [a.textContent, a.target, a.rel])).toEqual([["Key Check", "_blank", "noreferrer"]]);
    const check = navLinks().find((a) => a.textContent === "Key Check")!;
    expect([...check.children].map((e) => [e.tagName, e.className])).toEqual([
      ["I", "bi bi-search text-base"], ["SPAN", "truncate"], ["I", "bi bi-box-arrow-up-right ml-auto text-xs text-ink-500"],
    ]);
    for (const a of navLinks().filter((l) => l !== check)) expect([...a.children].map((e) => e.tagName)).toEqual(["I", "SPAN"]);
  });

  // Overview matches its own path only; every other entry also matches paths beneath it.
  it.each([
    ["/", "Overview"],
    ["/services", "Model Services"],
    ["/micro-agents", "Micro Agents"],
    ["/tools", "Server Tools"],
    ["/model", "Model Mapping"],
    ["/providers", "Providers"],
    ["/proxies", "Proxies"],
    ["/tokens", "API Keys"],
    ["/bench", "Model Bench"],
    ["/logs", "Logs"],
    ["/active-requests", "Active Requests"],
    ["/users", "Users"],
    ["/settings", "Settings"],
    ["/settings/anything", "Settings"],
    ["/models", null],
    ["/check", null],
    ["/elsewhere", null],
  ])("at %s the active entry is %s", async (route, label) => {
    await setup(ADMIN, route);
    const active = navLinks().filter((a) => a.classList.contains("active"));
    expect(active.map((a) => a.textContent)).toEqual(label ? [label] : []);
    expect(navLinks().filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.textContent)).toEqual(label ? [label] : []);
    if (label) expect(classes(active[0])).toEqual(cls("nav-link active"));
    for (const a of navLinks().filter((l) => !active.includes(l))) expect(classes(a)).toEqual(["nav-link"]);
  });

  it("clicking an entry navigates inside the app and moves the highlight", async () => {
    const { api } = await setup();
    const before = api.calls.length;
    fireEvent.click(navLinks().find((a) => a.textContent === "Providers")!);
    expect(path()).toBe("/providers");
    expect(navLinks().filter((a) => a.classList.contains("active")).map((a) => a.textContent)).toEqual(["Providers"]);
    expect(api.calls).toHaveLength(before);
  });

  it.each([
    ["an admin", ADMIN, "root", "Admin", "badge-blue", "bi bi-shield-lock"],
    ["a manager", MANAGER, "mia", "Manager", "badge-gray", "bi bi-person-gear"],
  ])("shows who is signed in at the bottom, with a role badge for %s", async (_name, me, username, role, badge, glyph) => {
    const { container } = await setup(me);
    const block = container.querySelector("aside")!.lastElementChild!;
    expect([...block.children].map((e) => e.className)).toEqual(["mb-2 flex items-center gap-2.5", "flex gap-1.5"]);
    const avatar = block.querySelector("span")!;
    expect(classes(avatar)).toEqual(cls("flex h-8 w-8 items-center justify-center rounded-full bg-ink-800 text-ink-300"));
    expect(classes(avatar.querySelector("i"))).toEqual(cls("bi bi-person-fill"));
    const name = screen.getByText(username, { selector: "aside div" });
    expect(classes(name)).toEqual(cls("truncate text-sm text-ink-100"));
    expect(classes(name.parentElement)).toEqual(cls("min-w-0 flex-1"));
    const chip = name.nextElementSibling!;
    expect([chip.tagName, chip.textContent, chip.className]).toEqual(["SPAN", role, badge]);
    expect(classes(chip.querySelector("i"))).toEqual(cls(glyph));
  });

  it("offers Password and Sign out as two equal small ghost buttons, and no language control", async () => {
    const { container } = await setup();
    const aside = container.querySelector("aside")!;
    expect([...aside.querySelectorAll("button")].map((b) => [b.textContent, classes(b), b.querySelector("i")!.className])).toEqual([
      ["Password", cls("btn-ghost flex-1 btn-xs"), "bi bi-key"], ["Sign out", cls("btn-ghost flex-1 btn-xs"), "bi bi-box-arrow-right"],
    ]);
    expect(aside.querySelector("select")).toBeNull();
  });

  it("follows the UI language", async () => {
    await setup(ADMIN, "/", { "GET /settings/ui-language": { language: "zh" } });
    expect(navLinks().slice(0, 3).map((a) => a.textContent)).toEqual(["概览", "模型服务", "微型代理"]);
    expect(hasButton("密码")).toBe(true);
    expect(hasButton("退出登录")).toBe(true);
    expect(document.querySelector("aside .badge-blue")!.textContent).toBe("管理员");
  });

  it("Sign out posts /logout and drops the session", async () => {
    const { api } = await setup(ADMIN, "/providers", { "POST /logout": { ok: true } });
    fireEvent.click(button("Sign out"));
    await waitFor(() => expect(authState()).toBe("anonymous"));
    expect(api.mutations()).toEqual([sentJson("POST", "/logout", {})]);
    expect(toasts()).toEqual([]);
    // Layout itself does not navigate; what replaces it is App's decision.
    expect(path()).toBe("/providers");
    expect(document.querySelector("aside .truncate.text-sm")!.textContent).toBe("");
  });

  it("the dialog is closed until Password is pressed, then shows three password fields with Cancel and Update", async () => {
    await setup();
    expect(modal(TITLE)).toBeNull();
    const m = openDialog();
    expect(classes(m)).toEqual(cls("card flex max-h-[92vh] w-full flex-col max-w-lg"));
    expect(classes(m.querySelector("h2 i"))).toEqual(cls("bi bi-key text-brand-400"));
    expect(classes(m.querySelector(".card-pad")!.firstElementChild)).toEqual(["space-y-4"]);
    expect([...m.querySelectorAll(".label")].map((l) => [l.tagName, l.textContent, l.className])).toEqual([
      ["LABEL", "Current password", "label"], ["LABEL", "New password", "label"], ["LABEL", "Confirm new password", "label"],
    ]);
    expect(classes(labelEl("New password", m))).toEqual(["label"]);
    expect([field("Current password", m), field("New password", m), field("Confirm new password", m)].map((f) => [f.type, f.value, f.placeholder, f.autocomplete, f.className])).toEqual([
      ["password", "", "", "current-password", "input"],
      ["password", "", "at least 8 characters", "new-password", "input"],
      ["password", "", "", "new-password", "input"],
    ]);
    const update = button("Update", m);
    expect([...update.parentElement!.querySelectorAll("button")].map((b) => [b.textContent, b.className, b.disabled])).toEqual([["Cancel", "btn-ghost", false], ["Update", "btn-primary", false]]);
    expect(classes(update.querySelector("i"))).toEqual(cls("bi bi-check-lg"));
  });

  it.each([
    ["empty", "", "", "New password must be at least 8 characters"],
    ["seven characters", "1234567", "1234567", "New password must be at least 8 characters"],
    ["too short and mismatched (length is checked first)", "1234567", "7654321", "New password must be at least 8 characters"],
    ["long enough but mismatched", "12345678", "12345679", "Passwords do not match"],
    ["confirmation left empty", "12345678", "", "Passwords do not match"],
  ])("refuses a new password that is %s with a toast, without calling the server", async (_name, next, confirmation, text) => {
    const { api } = await setup();
    const m = openDialog();
    fill(m, "old-pass", next, confirmation);
    fireEvent.click(button("Update", m));
    await toastShown(text);
    expect(api.mutations()).toEqual([]);
    expect(modal(TITLE)).not.toBeNull();
    expect(field("New password", m).value).toBe(next);
  });

  it("accepts exactly eight characters: posts both passwords untrimmed, adopts the returned user, toasts, closes and clears", async () => {
    const renamed: User = { ...ADMIN, username: "root2" };
    const { api } = await setup(ADMIN, "/", { "POST /change-password": { user: renamed } });
    const m = openDialog();
    fill(m, " old ", " 2345678", " 2345678");
    fireEvent.click(button("Update", m));
    await toastShown("Password changed");
    expect(api.mutations()).toEqual([sentJson("POST", "/change-password", { currentPassword: " old ", newPassword: " 2345678" })]);
    expect(modal(TITLE)).toBeNull();
    expect(authState()).toBe("root2:admin:ok");
    expect(document.querySelector("aside .truncate.text-sm")!.textContent).toBe("root2");
    const again = openDialog();
    expect([field("Current password", again).value, field("New password", again).value, field("Confirm new password", again).value]).toEqual(["", "", ""]);
  });

  it("does not require the current password on the client", async () => {
    const { api } = await setup(ADMIN, "/", { "POST /change-password": { user: ADMIN } });
    const m = openDialog();
    fill(m, "", "new-password", "new-password");
    fireEvent.click(button("Update", m));
    await toastShown("Password changed");
    expect(api.mutations()[0].body).toEqual({ currentPassword: "", newPassword: "new-password" });
  });

  it("disables Update while the request is in flight; its icon does not change", async () => {
    const gate = deferred<unknown>();
    await setup(ADMIN, "/", { "POST /change-password": () => gate.promise });
    const m = openDialog();
    fill(m, "old-pass", "new-password", "new-password");
    const update = button("Update", m);
    fireEvent.click(update);
    await flush();
    expect([update.disabled, update.querySelector("i")!.className, button("Cancel", m).disabled]).toEqual([true, "bi bi-check-lg", false]);
    await act(async () => { gate.resolve({ user: ADMIN }); });
    await toastShown("Password changed");
    expect(modal(TITLE)).toBeNull();
  });

  it.each([
    ["the server's message", fail(400, { error: "current password is incorrect" }), "current password is incorrect"],
    ["'Failed' for a non-API failure", offline, "Failed"],
  ])("toasts %s when the change is refused, and keeps the dialog and what was typed", async (_name, handler, text) => {
    await setup(ADMIN, "/", { "POST /change-password": handler });
    const m = openDialog();
    fill(m, "wrong", "new-password", "new-password");
    fireEvent.click(button("Update", m));
    await toastShown(text);
    expect(modal(TITLE)).not.toBeNull();
    expect([field("Current password", m).value, field("New password", m).value, button("Update", m).disabled]).toEqual(["wrong", "new-password", false]);
    expect(authState()).toBe("root:admin:ok");
  });

  it.each([
    ["Cancel", (m: HTMLElement) => button("Cancel", m)],
    ["the x in the title bar", (m: HTMLElement) => iconButton("bi-x-lg", m.querySelector("h2")!.parentElement!)],
  ])("%s closes the dialog without sending, and what was typed is still there when it reopens", async (_name, closer) => {
    const { api } = await setup();
    const m = openDialog();
    fill(m, "old-pass", "new-password", "new-pass");
    fireEvent.click(closer(m));
    expect(modal(TITLE)).toBeNull();
    expect(api.mutations()).toEqual([]);
    const again = openDialog();
    expect([field("Current password", again).value, field("New password", again).value, field("Confirm new password", again).value]).toEqual(["old-pass", "new-password", "new-pass"]);
  });
});

// ---------------------------------------------------------------------------

describe("PageHeader", () => {
  const setup = async (ui: React.ReactElement) => {
    mockApi({}, ADMIN);
    return renderPage(ui);
  };

  it("renders an icon and title, a subtitle below, and the action at the far end", async () => {
    const { container } = await setup(<PageHeader title="Things" subtitle="All the things" icon="bi-box" action={<button className="btn-primary">New</button>} />);
    const head = container.firstElementChild!;
    expect(classes(head)).toEqual(cls("mb-6 flex items-end justify-between gap-4"));
    expect([...head.children].map((e) => e.tagName)).toEqual(["DIV", "BUTTON"]);
    const h1 = head.querySelector("h1")!;
    expect([h1.textContent, classes(h1)]).toEqual(["Things", cls("flex items-center gap-2.5 text-2xl font-semibold text-ink-100")]);
    expect(classes(h1.querySelector("i"))).toEqual(cls("bi bi-box text-brand-400"));
    const p = h1.nextElementSibling!;
    expect([p.tagName, p.textContent, classes(p)]).toEqual(["P", "All the things", cls("mt-1 text-sm text-ink-400")]);
  });

  it("omits the icon, the subtitle and the action when not given", async () => {
    const { container } = await setup(<PageHeader title="Bare" />);
    const head = container.firstElementChild!;
    expect(head.children).toHaveLength(1);
    expect(head.firstElementChild!.children).toHaveLength(1);
    expect(head.querySelector("i")).toBeNull();
    expect(head.querySelector("p")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("App routing", () => {
  const PAGE_TITLE = "flex items-center gap-2.5 text-2xl font-semibold text-ink-100";
  /** Empty but well-formed answers, so each page settles into its normal (empty) state. */
  const DATA: ApiRoutes = {
    "GET /providers": { providers: [] },
    "GET /provider-models": { providerModels: [] },
    "GET /proxies": { proxies: [] },
    "GET /models": { models: [] },
    "GET /mappings": { mappings: [] },
    "GET /services": { services: [] },
    "GET /tokens": { tokens: [] },
    "GET /users": { users: [] },
    "GET /tools": { tools: [] },
    "GET /bench/targets": { services: [], mappings: [] },
  };
  const mount = (route: string, me: User | null, routes: ApiRoutes = {}) => {
    const api = mockApi({ ...DATA, ...routes }, me);
    const view = renderApp(<><App /><AuthProbe /><LocationProbe /></>, route);
    return { api, ...view };
  };
  const setup = async (route: string, me: User | null, routes: ApiRoutes = {}) => {
    const r = mount(route, me, routes);
    await waitFor(() => expect(authState()).not.toBe("loading"));
    await flush();
    return r;
  };
  const h1 = () => document.querySelector("h1");
  const shell = () => document.querySelector("aside");
  const FRESH: User = { ...ADMIN, mustChangePassword: true };

  // path, page title, title icon, where the router ends up
  const COMMON: [string, string, string, string][] = [
    ["/", "Overview", "bi-speedometer2", "/"],
    ["/providers", "Providers", "bi-hdd-network", "/providers"],
    ["/proxies", "Proxies", "bi-shuffle", "/proxies"],
    ["/model", "Model Mapping", "bi-box", "/model"],
    ["/models", "Model Mapping", "bi-box", "/model"],
    ["/services", "Model Services", "bi-diagram-3", "/services"],
    ["/micro-agents", "Micro Agents", "bi-robot", "/micro-agents"],
    ["/tokens", "API Keys", "bi-key", "/tokens"],
    ["/bench", "Model Bench", "bi-clipboard-pulse", "/bench"],
    ["/active-requests", "Active Requests", "bi-activity", "/active-requests"],
    ["/no-such-page", "Overview", "bi-speedometer2", "/"],
    ["/providers/7", "Overview", "bi-speedometer2", "/"],
    ["/settings/env", "Overview", "bi-speedometer2", "/"],
  ];
  const ADMIN_ONLY: [string, string, string, string][] = [
    ["/logs", "Logs", "bi-journal-text", "/logs"],
    ["/users", "Users", "bi-people", "/users"],
    ["/settings", "Settings", "bi-gear", "/settings"],
    ["/tools", "Server tools", "bi-tools", "/tools"],
  ];
  const expectPage = (title: string, glyph: string, at: string) => {
    expect(h1()!.textContent).toBe(title);
    expect(classes(h1())).toEqual(cls(PAGE_TITLE));
    expect(classes(h1()!.querySelector("i"))).toEqual(cls(`bi ${glyph} text-brand-400`));
    expect(path()).toBe(at);
    // Inside the shell's content column.
    expect(h1()!.closest("main")).not.toBeNull();
    expect(shell()).not.toBeNull();
    expect(document.querySelectorAll("h1")).toHaveLength(1);
  };

  it.each([...COMMON, ...ADMIN_ONLY])("admin at %s sees %s", async (route, title, glyph, at) => {
    await setup(route, ADMIN);
    expectPage(title, glyph, at);
  });

  it.each([...COMMON, ...ADMIN_ONLY.map(([route]): [string, string, string, string] => [route, "Overview", "bi-speedometer2", "/"])])(
    "manager at %s sees %s",
    async (route, title, glyph, at) => {
      await setup(route, MANAGER);
      expectPage(title, glyph, at);
    },
  );

  it.each([
    ["admin", ADMIN, 14],
    ["manager", MANAGER, 10],
  ])("the shell's navigation matches the %s's routes", async (_name, me, count) => {
    await setup("/", me);
    expect(navLinks()).toHaveLength(count);
    expect(navLinks().filter((a) => a.classList.contains("active")).map((a) => a.textContent)).toEqual(["Overview"]);
  });

  it("/services and /micro-agents are the same page in its two kinds", async () => {
    await setup("/services", ADMIN);
    expect(hasButton("New Model Service")).toBe(true);
    expect(hasButton("New Micro Agent")).toBe(false);
    cleanup();
    vi.unstubAllGlobals();
    await setup("/micro-agents", ADMIN);
    expect(hasButton("New Micro Agent")).toBe(true);
    expect(hasButton("New Model Service")).toBe(false);
  });

  it("navigating from the sidebar swaps the page inside the same shell", async () => {
    await setup("/", ADMIN);
    const aside = shell();
    fireEvent.click(navLinks().find((a) => a.textContent === "Users")!);
    await flush();
    expectPage("Users", "bi-people", "/users");
    expect(shell()).toBe(aside);
  });

  it("shows a full-screen spinner, and nothing else, while the session is being checked", async () => {
    const gate = deferred<unknown>();
    const { api, container } = mount("/settings", ADMIN, { "GET /me": () => gate.promise });
    await flush();
    expect(authState()).toBe("loading");
    const spin = container.firstElementChild!;
    expect(classes(spin)).toEqual(cls("flex h-screen items-center justify-center text-brand-400"));
    expect([...spin.children].map((e) => [e.tagName, e.className])).toEqual([["I", "bi bi-arrow-repeat animate-spin text-3xl"]]);
    expect(spin.textContent).toBe("");
    expect([shell(), h1()]).toEqual([null, null]);
    // No page has mounted, so nothing but the two provider calls went out, and the deep link is not bounced.
    expect(api.calls.map((c) => c.path).sort()).toEqual(["/me", "/settings/ui-language"]);
    expect(path()).toBe("/settings");

    await act(async () => { gate.resolve({ user: ADMIN }); });
    await flush();
    expect(container.querySelector(".h-screen.justify-center")).toBeNull();
    expectPage("Settings", "bi-gear", "/settings");
  });

  it.each(["/", "/users", "/no-such-page"])("signed out at %s: the login screen in place of the shell, without redirecting", async (route) => {
    const { api } = await setup(route, null);
    expect(authState()).toBe("anonymous");
    expect(h1()!.textContent).toBe("Hydrogen");
    expect(screen.getByText("Sign in to the LLM proxy console")).toBeTruthy();
    expect(hasButton("Sign in")).toBe(true);
    expect(shell()).toBeNull();
    expect(path()).toBe(route);
    expect(api.calls.map((c) => c.path).sort()).toEqual(["/me", "/settings/ui-language"]);
  });

  it.each([
    ["an admin", ADMIN, "Users", "bi-people", "/users"],
    ["a manager", MANAGER, "Overview", "bi-speedometer2", "/"],
  ])("signing in as %s at /users lands on %s", async (_name, me, title, glyph, at) => {
    await setup("/users", null, { "POST /login": { user: me } });
    type(field("Username"), me.username);
    type(field("Password"), "hunter22");
    fireEvent.click(button("Sign in"));
    await waitFor(() => expect(authState()).toBe(`${me.username}:${me.role}:ok`));
    await flush();
    expectPage(title, glyph, at);
  });

  it("signing out from the shell returns to the login screen at the same path", async () => {
    await setup("/providers", ADMIN, { "POST /logout": { ok: true } });
    fireEvent.click(button("Sign out"));
    await waitFor(() => expect(authState()).toBe("anonymous"));
    expect(hasButton("Sign in")).toBe(true);
    expect(shell()).toBeNull();
    expect(path()).toBe("/providers");
  });

  it.each(["/", "/providers", "/settings", "/no-such-page"])("a user who must change their password gets only that form at %s", async (route) => {
    const { api } = await setup(route, FRESH);
    expect(authState()).toBe("root:admin:must-change");
    expect(h1()!.textContent).toBe("Create your password");
    expect(hasButton("Set password and continue")).toBe(true);
    expect(shell()).toBeNull();
    expect(path()).toBe(route);
    expect(api.calls.map((c) => c.path).sort()).toEqual(["/me", "/settings/ui-language"]);
  });

  it("once the password is set, the page that was asked for appears", async () => {
    await setup("/providers", FRESH, { "POST /change-password": { user: ADMIN } });
    type(field("Current password"), "old-pass");
    type(field("New password"), "new-password");
    type(field("Confirm password"), "new-password");
    fireEvent.click(button("Set password and continue"));
    await waitFor(() => expect(authState()).toBe("root:admin:ok"));
    await flush();
    expectPage("Providers", "bi-hdd-network", "/providers");
  });

  it.each([
    ["signed out", null],
    ["an admin", ADMIN],
    ["a manager", MANAGER],
    ["a user who must change their password", FRESH],
  ])("/check is public: %s gets the key check page outside the shell", async (_name, me) => {
    await setup("/check", me);
    expect(h1()!.textContent).toBe("API Key Check");
    expect(classes(h1())).toEqual(cls("text-lg font-semibold text-ink-100"));
    expect(shell()).toBeNull();
    expect(hasButton("Sign in")).toBe(false);
    expect(path()).toBe("/check");
  });

  it("/check does not wait for the session check", async () => {
    const gate = deferred<unknown>();
    mount("/check", ADMIN, { "GET /me": () => gate.promise });
    await flush();
    expect(authState()).toBe("loading");
    expect(h1()!.textContent).toBe("API Key Check");
    expect(document.querySelector(".animate-spin")).toBeNull();
    await act(async () => { gate.resolve({ user: ADMIN }); });
  });
});
