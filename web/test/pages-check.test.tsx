/**
 * Characterization of the public API Key Check page: the key form, the status,
 * usage and details cards, the 5s re-check and what each kind of failure does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { Check } from "../src/pages/Check";
import { formatDate, formatNumber } from "../src/lib/format";
import { button, classes, cls, deferred, fail, hasButton, labelEl, mockApi, renderPage, type } from "./helpers";

const NOW = new Date(2026, 5, 1, 12, 0, 0).getTime();

beforeEach(() => {
  // Only the interval clock and Date are faked, and neither advances by itself:
  // a poll fires exactly when a test advances to it.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const JSON_HEADERS = { "content-type": "application/json" };
const ERROR_NOTE = "flex items-center gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300";
const errorNote = (within: ParentNode = document.body) => within.querySelector(".border-red-900\\/50.px-4");
const text = (el: Element | null | undefined): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
/** A CSS value as jsdom reports it back (it rewrites numbers). */
const css = (prop: "width", value: string): string => {
  const probe = document.createElement("span");
  probe.style[prop] = value;
  return probe.style[prop];
};
/** Advance the interval clock, then let every request that can settle do so. */
const tick = (ms = 0) => act(async () => {
  vi.advanceTimersByTime(ms);
  await new Promise((r) => setTimeout(r, 0));
});

// ---------------------------------------------------------------------------

describe("Check page", () => {
  const CREATED = new Date(2026, 0, 2, 3, 4).getTime();
  const EXPIRY = new Date(2027, 0, 2, 3, 4).getTime();
  const KEY = "sk-secret-key-1234567890";
  const result = (key: Record<string, unknown> = {}, status: Record<string, unknown> = {}) => ({
    key: { name: "laptop", scopeServiceCount: 0, maxRequests: 100, maxTokens: null, usedRequests: 5, usedTokens: 1234, expiresAt: null, enabled: true, createdAt: CREATED, ...key },
    status: { valid: true, expired: false, requestsExceeded: false, tokensExceeded: false, checkedAt: NOW, ...status },
  });
  /** The page posts by hand rather than through the API client, so no credentials mode is set. */
  const sentCheck = (apiKey: string) => ({ method: "POST", path: "/check", body: { apiKey }, headers: JSON_HEADERS, credentials: undefined });
  const SMALL_NOTE = "flex items-center gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300";
  const CARD_HEADING = "flex items-center gap-2 text-sm font-semibold text-ink-100";
  const setup = async (check: unknown = result()) => {
    const api = mockApi({ "POST /check": check });
    const view = await renderPage(<Check />);
    const input = () => view.container.querySelector("input") as HTMLInputElement | null;
    const form = () => view.container.querySelector("form");
    const checks = () => api.sent("POST", "/check");
    const submit = async (value = KEY) => {
      type(input()!, value);
      fireEvent.submit(form()!);
      await tick();
    };
    const results = () => view.container.querySelector(".mx-auto > div.space-y-4") as HTMLElement | null;
    return { api, input, form, checks, submit, results, ...view };
  };
  const bars = (within: ParentNode) => [...screen.getByText("Usage", { selector: "h3" }).parentElement!.children].slice(1).filter((el) => within.contains(el));
  const rowsOf = (within: ParentNode) => [...within.querySelectorAll("dl > div")].map((d) => [text(d.children[0]), text(d.children[1])]);

  it("starts as a bare key form under its own header, and sends nothing", async () => {
    const { api, container, input, form } = await setup();
    expect(api.mutations()).toEqual([]);
    const root = container.firstElementChild!;
    expect(classes(root)).toEqual(cls("min-h-screen bg-ink-950 px-4 py-8"));
    expect(classes(root.firstElementChild)).toEqual(cls("mx-auto max-w-2xl"));
    const header = root.firstElementChild!.firstElementChild!;
    expect(classes(header)).toEqual(cls("mb-8 flex items-center justify-between"));
    expect(classes(header.firstElementChild)).toEqual(cls("flex items-center gap-3"));
    expect(classes(header.querySelector("svg"))).toEqual(cls("h-12 w-12"));
    const h1 = container.querySelector("h1")!;
    expect([h1.textContent, classes(h1)]).toEqual(["API Key Check", cls("text-lg font-semibold text-ink-100")]);
    expect(classes(screen.getByText("Check the status and usage of an API key without logging in."))).toEqual(cls("text-sm text-ink-500"));
    const home = header.querySelector("a")!;
    expect([text(home), home.getAttribute("href"), home.classList.contains("btn-ghost"), classes(home.querySelector("i"))]).toEqual(["Dashboard", "/", true, cls("bi bi-house")]);

    expect(classes(form())).toEqual(cls("card card-pad space-y-4"));
    expect(classes(labelEl("API Key"))).toEqual(["label"]);
    const field = input()!;
    expect([field.type, field.value, field.placeholder, field.getAttribute("autocomplete"), classes(field)]).toEqual(["password", "", "sk-...", "off", cls("input font-mono")]);
    expect(document.activeElement).toBe(field);
    const go = button("Check");
    expect([classes(go), go.disabled, classes(go.querySelector("i"))]).toEqual([cls("btn-primary w-full"), true, cls("bi bi-search")]);
    expect(form()!.querySelector(".border-red-900\\/50")).toBeNull();
  });

  it("Check is disabled for a blank key, and submitting one anyway sends nothing", async () => {
    const { api, input, form } = await setup();
    type(input()!, "   ");
    expect(button("Check").disabled).toBe(true);
    fireEvent.submit(form()!);
    await tick();
    expect(api.mutations()).toEqual([]);
    expect(form()).not.toBeNull();
    type(input()!, " x ");
    expect(button("Check").disabled).toBe(false);
  });

  it("posts the trimmed key to /check and swaps the form for a key bar and a loading card", async () => {
    const gate = deferred<unknown>();
    const { api, form, submit, results } = await setup(() => gate.promise);
    await submit(`  ${KEY}  `);
    expect(api.mutations()).toEqual([sentCheck(KEY)]);
    expect(form()).toBeNull();
    expect(classes(results())).toEqual(["space-y-4"]);
    const [bar, loading] = [...results()!.children];
    expect(results()!.childElementCount).toBe(2);
    expect(classes(bar)).toEqual(cls("card card-pad flex items-center justify-between"));
    expect(classes(bar.firstElementChild)).toEqual(cls("flex items-center gap-2"));
    // Only the first 14 characters of the key are echoed.
    expect([text(bar.querySelector("code")), classes(bar.querySelector("code"))]).toEqual(["sk-secret-key-...", cls("rounded bg-ink-950 px-2 py-1 font-mono text-xs text-brand-400")]);
    expect(bar.firstElementChild!.childElementCount).toBe(1);
    const again = button("Check another");
    expect([classes(again), classes(again.querySelector("i"))]).toEqual([cls("btn-ghost btn-xs"), cls("bi bi-arrow-left")]);
    expect(classes(loading)).toEqual(cls("card card-pad flex items-center justify-center gap-2 py-12 text-ink-400"));
    expect(classes(loading.querySelector("i"))).toEqual(cls("bi bi-arrow-repeat animate-spin text-xl"));
    expect([loading.querySelector("span")!.textContent, classes(loading.querySelector("span"))]).toEqual(["Checking...", ["text-sm"]]);

    await act(async () => { gate.resolve(result()); });
    await tick();
    expect(results()!.querySelector(".animate-spin")).toBeNull();
    expect([text(bar.querySelector("span")), classes(bar.querySelector("span"))]).toEqual(["laptop", cls("text-sm text-ink-300")]);
  });

  it("an active key: a green status card, usage, details and the live note", async () => {
    const { results, submit } = await setup();
    await submit();
    const [, status, usage, details, live] = [...results()!.children];
    expect(results()!.childElementCount).toBe(5);
    expect(classes(status)).toEqual(cls("card card-pad flex items-center gap-3 border-green-800/50"));
    expect(classes(status.children[0])).toEqual(cls("flex h-10 w-10 items-center justify-center rounded-full bg-green-950/50 text-green-400"));
    expect(classes(status.querySelector("i"))).toEqual(cls("bi bi-check-circle-fill text-xl"));
    expect([text(status.children[1]), classes(status.children[1].firstElementChild), status.children[1].childElementCount]).toEqual(["Active", cls("text-sm font-medium text-ink-100"), 1]);
    expect(status.childElementCount).toBe(2);

    expect(classes(usage)).toEqual(cls("card card-pad space-y-4"));
    expect([text(usage.querySelector("h3")), classes(usage.querySelector("h3")), classes(usage.querySelector("h3 i"))]).toEqual(["Usage", cls(CARD_HEADING), cls("bi bi-graph-up text-brand-400")]);
    expect(bars(usage).map((b) => [...b.children].map((c) => text(c)))).toEqual([
      ["Requests5 / 100", "", "95 remaining"], [`Tokens${formatNumber(1234)} · unlimited`, ""],
    ]);
    const bar = bars(usage)[0];
    expect(bar.className).toBe("");
    expect(classes(bar.children[0])).toEqual(cls("mb-1 flex items-center justify-between text-sm"));
    expect(classes(bar.children[0].children[0])).toEqual(["text-ink-300"]);
    expect(classes(bar.children[0].children[1])).toEqual(cls("font-mono text-xs text-ink-400"));
    expect(classes(bar.children[1])).toEqual(cls("h-2 overflow-hidden rounded-full bg-ink-800"));
    expect(classes(bar.children[1].firstElementChild)).toEqual(cls("h-full rounded-full transition-all duration-500 bg-brand-500"));
    expect(classes(bar.children[2])).toEqual(cls("mt-0.5 text-right text-xs text-ink-500"));

    expect(classes(details)).toEqual(cls("card card-pad space-y-3"));
    expect([text(details.querySelector("h3")), classes(details.querySelector("h3")), classes(details.querySelector("h3 i"))]).toEqual(["Details", cls(CARD_HEADING), cls("bi bi-info-circle text-brand-400")]);
    expect(classes(details.querySelector("dl"))).toEqual(cls("space-y-2 text-sm"));
    expect(rowsOf(details)).toEqual([["Name", "laptop"], ["Enabled", "yes"], ["Scope", "All Model Services"], ["Expires", "never"], ["Created", formatDate(CREATED)]]);
    expect([...details.querySelectorAll("dl > div")].map((d) => [classes(d), d.children[0].tagName, classes(d.children[0]), d.children[1].tagName, classes(d.children[1])])).toEqual(
      ["text-ink-100", "text-green-400", "text-ink-100", "text-ink-100", "text-ink-100"].map((dd) => [cls("flex justify-between"), "DT", ["text-ink-400"], "DD", [dd]]),
    );

    expect([text(live), classes(live)]).toEqual(["Live - refreshing every 5s", cls("flex items-center justify-center gap-1.5 text-xs text-ink-500")]);
    expect(classes(live.firstElementChild)).toEqual(cls("relative flex h-2 w-2"));
    expect([...live.firstElementChild!.children].map((c) => classes(c))).toEqual([
      cls("absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75"), cls("relative inline-flex h-2 w-2 rounded-full bg-brand-500"),
    ]);
  });

  it.each([
    ["no limit", 5, null, "5 · unlimited", 0, "bg-brand-500", null],
    ["unused", 0, 100, "0 / 100", 0, "bg-brand-500", "100 remaining"],
    ["just under 70%", 139, 200, "139 / 200", 69.5, "bg-brand-500", "61 remaining"],
    ["exactly 70%", 7, 10, "7 / 10", 70, "bg-amber-500", "3 remaining"],
    ["just under 90%", 179, 200, "179 / 200", 89.5, "bg-amber-500", "21 remaining"],
    ["exactly 90%", 9, 10, "9 / 10", 90, "bg-red-500", "1 remaining"],
    ["exactly spent", 100, 100, "100 / 100", 100, "bg-red-500", "0 remaining"],
    ["overspent", 150, 100, "150 / 100", 100, "bg-red-500", "0 remaining"],
    ["a zero limit", 0, 0, "0 / 0", 100, "bg-red-500", "0 remaining"],
    ["thousands", 2500, 10_000, `${formatNumber(2500)} / ${formatNumber(10_000)}`, 25, "bg-brand-500", `${formatNumber(7500)} remaining`],
  ])("usage bar, %s: %i of %s", async (_name, usedTokens, maxTokens, figures, percent, colour, remaining) => {
    const { results, submit } = await setup(result({ usedTokens, maxTokens }));
    await submit();
    const bar = bars(results()!)[1];
    const fill = bar.children[1].firstElementChild as HTMLElement;
    expect([text(bar.children[0].children[1]), fill.style.width, classes(fill), bar.children[2]?.textContent ?? null]).toEqual([
      figures, css("width", `${percent}%`), cls(`h-full rounded-full transition-all duration-500 ${colour}`), remaining,
    ]);
  });

  it.each([
    ["expired", { expired: true }, "This key has expired."],
    ["out of requests", { requestsExceeded: true }, "Request quota exceeded."],
    ["out of tokens", { tokensExceeded: true }, "Token quota exceeded."],
    ["all three", { expired: true, requestsExceeded: true, tokensExceeded: true }, "This key has expired. Request quota exceeded. Token quota exceeded."],
    ["none given", {}, ""],
  ])("an inactive key (%s) gets a red status card with the reasons", async (_name, flags, reasons) => {
    const { results, submit } = await setup(result({}, { valid: false, ...flags }));
    await submit();
    const status = results()!.children[1];
    expect(classes(status)).toEqual(cls("card card-pad flex items-center gap-3 border-red-800/50"));
    expect(classes(status.children[0])).toEqual(cls("flex h-10 w-10 items-center justify-center rounded-full bg-red-950/50 text-red-400"));
    expect(classes(status.querySelector("i"))).toEqual(cls("bi bi-x-circle-fill text-xl"));
    expect([...status.children[1].children].map((c) => [text(c), classes(c)])).toEqual([["Inactive", cls("text-sm font-medium text-ink-100")], [reasons, cls("text-xs text-ink-400")]]);
    // Enabled, so no "Disabled" badge.
    expect(status.childElementCount).toBe(2);
  });

  it.each([
    ["inactive and disabled", { valid: false }, true],
    ["reported active although disabled", { valid: true }, false],
  ])("a disabled key, %s: badge shown %s", async (_name, status, shown) => {
    const { results, submit } = await setup(result({ enabled: false, scopeServiceCount: 3, expiresAt: EXPIRY }, status));
    await submit();
    const badge = results()!.children[1].querySelector(".badge-red");
    expect(badge !== null).toBe(shown);
    if (badge) expect([text(badge), classes(badge), classes(badge.querySelector("i"))]).toEqual(["Disabled", cls("badge-red ml-auto"), cls("bi bi-pause-circle")]);
    expect(rowsOf(results()!).slice(1, 4)).toEqual([["Enabled", "no"], ["Scope", "3 Model Services"], ["Expires", formatDate(EXPIRY)]]);
    expect(classes(results()!.querySelectorAll("dd")[1])).toEqual(["text-red-400"]);
  });

  it("re-checks the same key every 5s and redraws in place, without the loading card", async () => {
    const { api, checks, results, submit } = await setup();
    await submit();
    await tick(4999);
    expect(checks()).toHaveLength(1);
    const gate = deferred<unknown>();
    api.on("POST /check", () => gate.promise);
    await tick(1);
    expect(checks()).toEqual([sentCheck(KEY), sentCheck(KEY)]);
    expect(results()!.childElementCount).toBe(5);
    expect(results()!.querySelector(".animate-spin")).toBeNull();
    await act(async () => { gate.resolve(result({ usedRequests: 6, name: "renamed" })); });
    await tick();
    expect(text(bars(results()!)[0].children[0])).toBe("Requests6 / 100");
    expect(screen.getAllByText("renamed")).toHaveLength(2);
    await tick(10_000);
    expect(checks()).toHaveLength(4);
  });

  it.each([
    ["the server's message", fail(500, { error: "db down" }), "db down"],
    ["the status when the body carries none", fail(503), "Request failed (503)"],
    ["'Failed to fetch key status' for a network failure", () => { throw new TypeError("offline"); }, "Failed to fetch key status"],
  ])("a failed re-check replaces the result with %s, keeps the key bar and keeps polling", async (_name, handler, message) => {
    const { api, checks, results, submit } = await setup();
    await submit();
    api.on("POST /check", handler);
    await tick(5000);
    expect(results()!.childElementCount).toBe(2);
    expect(text(results()!.children[0])).toBe("sk-secret-key-...Check another");
    const card = results()!.children[1];
    expect(classes(card)).toEqual(cls("card card-pad"));
    expect([card.firstElementChild!.textContent, classes(card.firstElementChild), classes(card.querySelector("i"))]).toEqual([message, cls(ERROR_NOTE), cls("bi bi-exclamation-octagon-fill")]);
    api.on("POST /check", result());
    await tick(5000);
    expect(checks()).toHaveLength(3);
    expect(results()!.childElementCount).toBe(5);
    expect(errorNote()).toBeNull();
  });

  it("a first check that fails for another reason than 401 stays on the result view and keeps polling", async () => {
    const { checks, form, results, submit } = await setup(fail(429, { error: "slow down" }));
    await submit();
    expect(form()).toBeNull();
    expect(text(results()!.children[1])).toBe("slow down");
    await tick(5000);
    expect(checks()).toHaveLength(2);
  });

  it("a 401 goes back to the form with the error and the typed key, and stops polling", async () => {
    const { checks, form, input, results, submit } = await setup(fail(401, { error: "invalid api key" }));
    await submit();
    expect(results()).toBeNull();
    const note = form()!.querySelector(".border-red-900\\/50")!;
    expect([note.textContent, classes(note), classes(note.querySelector("i"))]).toEqual(["invalid api key", cls(SMALL_NOTE), cls("bi bi-exclamation-circle")]);
    expect([...form()!.children].map((c) => c.tagName)).toEqual(["DIV", "DIV", "BUTTON"]);
    expect(input()!.value).toBe(KEY);
    expect(button("Check").disabled).toBe(false);
    await tick(60_000);
    expect(checks()).toHaveLength(1);
  });

  it("a 401 on a later re-check also goes back to the form and stops polling", async () => {
    const { api, checks, form, submit } = await setup();
    await submit();
    api.on("POST /check", fail(401, { error: "key revoked" }));
    await tick(5000);
    expect(text(form()!.querySelector(".border-red-900\\/50"))).toBe("key revoked");
    await tick(60_000);
    expect(checks()).toHaveLength(2);
  });

  it("'Check another' returns to an empty form and stops polling; a new key starts a new cycle", async () => {
    const { checks, form, input, submit } = await setup();
    await submit();
    fireEvent.click(button("Check another"));
    expect(form()).not.toBeNull();
    expect(input()!.value).toBe("");
    expect(hasButton("Check another")).toBe(false);
    await tick(60_000);
    expect(checks()).toHaveLength(1);
    await submit("sk-other");
    await tick(5000);
    expect(checks().map((c) => c.body)).toEqual([{ apiKey: KEY }, { apiKey: "sk-other" }, { apiKey: "sk-other" }]);
    // A key shorter than 14 characters is echoed whole.
    expect(screen.getByText("sk-other...")).toBeTruthy();
  });

  it("stops polling once unmounted", async () => {
    const { checks, submit, unmount } = await setup();
    await submit();
    unmount();
    await tick(60_000);
    expect(checks()).toHaveLength(1);
  });
});
