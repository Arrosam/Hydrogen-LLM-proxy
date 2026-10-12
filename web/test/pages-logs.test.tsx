/**
 * Characterization of the Logs page list: the filter bar and the query string
 * each filter produces, pagination, the 5s silent refresh and clearing all
 * logs. The detail modal is in pages-logs-detail.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { formatNumber } from "../src/lib/format";
import {
  MANAGER, button, cells, classes, cls, deferred, fail, hasButton, isOn, modal, openModal, toastShown, toasts, toggle, type, type Handler,
} from "./helpers";
import {
  ERROR_NOTE, FIRST, NOW, PAGE_TITLE, R1, ROWS, errorNote, logsPath, row, sentBare, setup, spinner, text, tick,
} from "./logs-harness";

beforeEach(() => {
  // Only the interval clock and Date are faked, and neither advances by itself:
  // a refresh fires exactly when a test advances to it, and "5m ago" stays put.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});


// ---------------------------------------------------------------------------

describe("Logs page: list", () => {
  it("loads the first page of 50 with no filter, plus the services and keys for the filters", async () => {
    const { api } = await setup();
    expect(api.calls.filter((c) => c.path !== "/me" && c.path !== "/settings/ui-language").map((c) => `${c.method} ${c.path}`).sort())
      .toEqual([`GET ${FIRST}`, "GET /services", "GET /tokens"]);
    expect(api.calls.find((c) => c.path === FIRST)).toEqual(sentBare("GET", FIRST));
    expect(FIRST).toBe("/logs?limit=50&offset=0");
  });

  it("shows the header and the filter bar", async () => {
    const { container, selects, errorsOnly } = await setup();
    const h1 = container.querySelector("h1")!;
    expect(h1.textContent).toBe("Logs");
    expect(classes(h1)).toEqual(cls(PAGE_TITLE));
    expect(classes(h1.querySelector("i"))).toEqual(cls("bi bi-journal-text text-brand-400"));
    expect(screen.getByText("Every request, its resolved attempt path, and payloads.")).toBeTruthy();

    const bar = selects()[0].parentElement!;
    expect(classes(bar)).toEqual(cls("mb-4 flex flex-wrap items-center gap-3"));
    expect(selects().map((s) => [classes(s), s.value])).toEqual([[cls("select w-auto"), ""], [cls("select w-auto"), ""]]);
    expect([...selects()[0].options].map((o) => [o.value, o.textContent])).toEqual([["", "All Model Services"], ["10", "svc-a"], ["11", "svc-b"]]);
    expect([...selects()[1].options].map((o) => [o.value, o.textContent])).toEqual([["", "All API keys"], ["1", "laptop · hk_abc"], ["2", "ci · hk_xyz"]]);
    expect([errorsOnly().checked, text(errorsOnly().parentElement)]).toEqual([false, "Errors only"]);
    expect(classes(errorsOnly().parentElement)).toEqual(cls("flex items-center gap-2 text-sm text-ink-300"));

    const refresh = button("Refresh");
    expect(classes(refresh)).toEqual(cls("btn-ghost btn-xs"));
    expect(classes(refresh.querySelector("i"))).toEqual(cls("bi bi-arrow-clockwise"));
    expect(isOn(toggle("Auto-refresh (5s)"))).toBe(true);
    const live = screen.getByText("live");
    expect(classes(live)).toEqual(["badge-green"]);
    expect(classes(live.querySelector("i"))).toEqual(cls("bi bi-broadcast"));
    const total = screen.getByText("4 total");
    expect(classes(total)).toEqual(cls("text-xs text-ink-500"));
    expect(classes(total.previousElementSibling)).toEqual(["flex-1"]);
    const clear = button("Clear all");
    expect(classes(clear)).toEqual(cls("btn-danger btn-xs"));
    expect(classes(clear.querySelector("i"))).toEqual(cls("bi bi-trash3"));
    expect([clear.disabled, clear.title]).toEqual([false, "Delete all log entries"]);
    expect([...bar.children].map((c) => c.tagName)).toEqual(["SELECT", "SELECT", "LABEL", "BUTTON", "LABEL", "SPAN", "DIV", "SPAN", "BUTTON"]);
  });

  it("a manager gets the same page without Clear all", async () => {
    const { table } = await setup(undefined, {}, MANAGER);
    expect(table()).not.toBeNull();
    expect(hasButton("Clear all")).toBe(false);
    expect(hasButton("Refresh")).toBe(true);
  });

  it("offers only the 'all' options when the services and keys cannot be listed, and still lists logs", async () => {
    const { selects, pageRow } = await setup(undefined, { "GET /services": fail(403, { error: "forbidden" }), "GET /tokens": fail(403, { error: "forbidden" }) });
    expect(selects().map((s) => [...s.options].map((o) => o.textContent))).toEqual([["All Model Services"], ["All API keys"]]);
    expect(errorNote()).toBeNull();
    // Without the service list an unnamed row falls back to its id.
    expect(cells(pageRow(1))[1]).toBe("#11");
  });

  it("shows a spinner while the first page loads, with a zero total and no empty state", async () => {
    const gate = deferred<unknown>();
    const { table } = await setup(() => gate.promise);
    expect(classes(spinner()!.parentElement)).toEqual(cls("flex items-center justify-center gap-2 py-16 text-ink-400"));
    expect(screen.getByText("0 total")).toBeTruthy();
    expect(screen.queryByText("No log entries")).toBeNull();
    expect(table()).toBeNull();
    expect(button("Clear all").disabled).toBe(true);
    await act(async () => { gate.resolve({ rows: ROWS, total: 4 }); });
    await tick();
    expect(spinner()).toBeNull();
    expect(table()).not.toBeNull();
  });

  it("shows the empty state, and disables Clear all, when there is nothing", async () => {
    const { table, container } = await setup({ rows: [], total: 0 });
    const title = screen.getByText("No log entries");
    expect(classes(title)).toEqual(cls("text-sm font-medium text-ink-300"));
    expect(classes(title.parentElement)).toEqual(cls("flex flex-col items-center justify-center gap-3 py-16 text-center"));
    expect(classes(title.parentElement!.querySelector("i"))).toEqual(cls("bi bi-journal-text text-4xl text-ink-600"));
    expect(classes(screen.getByText("Requests through your Model Service endpoints appear here."))).toEqual(cls("max-w-sm text-xs text-ink-500"));
    expect(table()).toBeNull();
    expect(button("Clear all").disabled).toBe(true);
    expect(container.querySelector(".mt-4.justify-between")).toBeNull();
  });

  it("shows a load error above the empty state when the first page fails", async () => {
    const { table } = await setup(fail(500, { error: "db down" }));
    expect(errorNote()!.textContent).toBe("db down");
    expect(classes(errorNote())).toEqual(cls(ERROR_NOTE));
    expect(classes(errorNote()!.querySelector("i"))).toEqual(cls("bi bi-exclamation-octagon-fill"));
    expect(screen.getByText("No log entries")).toBeTruthy();
    expect(table()).toBeNull();
  });

  it("keeps the rows it has when a reload fails, and drops the error on the next success", async () => {
    const { api, table } = await setup();
    api.on(`GET ${FIRST}`, fail(502, { error: "bad gateway" }));
    fireEvent.click(button("Refresh"));
    await tick();
    expect(errorNote()!.textContent).toBe("bad gateway");
    expect(table()!.querySelectorAll("tbody tr")).toHaveLength(4);
    expect(screen.getByText("4 total")).toBeTruthy();
    api.on(`GET ${FIRST}`, { rows: [R1], total: 1 });
    fireEvent.click(button("Refresh"));
    await tick();
    expect(errorNote()).toBeNull();
    expect(table()!.querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("lists requests in a table: age, service, route, status, tokens, latency and tries", async () => {
    const { table, pageRow } = await setup();
    expect(classes(table())).toEqual(["table"]);
    expect(classes(table()!.parentElement)).toEqual(cls("card overflow-hidden"));
    expect([...table()!.querySelectorAll("th")].map((th) => [th.textContent, th.className])).toEqual([
      ["Time", ""], ["Model Service", ""], ["Route", ""], ["Status", ""], ["Tokens", ""], ["Latency", ""], ["Tries", ""], ["", ""],
    ]);
    const n = formatNumber;
    expect(cells(pageRow(0))).toEqual(["5m ago", "svc-a", "openaianthropic", "200", `${n(1200)} (300)450 (50)`, "812 ms", "2", ""]);
    // An unnamed row is named from the service list; a missing egress is a dash.
    expect(cells(pageRow(1))).toEqual(["2h ago", "svc-b", "openai-", "500", "70", "15 ms", "1", ""]);
    expect(cells(pageRow(2))).toEqual(["3d ago", "#99", "openaianthropic", "499", `${n(1200)}450`, "812 ms", "1", ""]);
    expect(cells(pageRow(3)).slice(0, 4)).toEqual(["-", "-", "openaianthropic", "error"]);

    expect(classes(pageRow(0))).toEqual(["cursor-pointer"]);
    const [time, name, route, status, tokens, latency, tries, open] = [...pageRow(0).querySelectorAll("td")];
    expect(classes(time)).toEqual(cls("whitespace-nowrap text-xs text-ink-400"));
    expect(classes(name)).toEqual(cls("font-mono text-xs text-ink-200"));
    expect(classes(route)).toEqual(["text-xs"]);
    expect([...route.children].map((c) => [c.tagName, classes(c)])).toEqual([
      ["SPAN", ["text-ink-300"]], ["I", cls("bi bi-arrow-right mx-1 text-ink-600")], ["SPAN", ["text-ink-400"]], ["I", cls("bi bi-broadcast ml-2 text-brand-400")],
    ]);
    expect((route.lastElementChild as HTMLElement).title).toBe("streaming");
    expect([status.className, tokens.className]).toEqual(["", ""]);
    expect(classes(latency)).toEqual(cls("text-xs text-ink-400"));
    expect(classes(tries)).toEqual(cls("text-xs text-ink-400"));
    expect(classes(open)).toEqual(["text-right"]);
    expect(classes(open.querySelector("i"))).toEqual(cls("bi bi-chevron-right text-ink-600"));
    // Not streaming: no broadcast icon.
    expect(pageRow(1).querySelectorAll("td:nth-child(3) i")).toHaveLength(1);
  });

  it.each([
    [200, "200", "badge-green"],
    [299, "299", "badge-green"],
    [199, "199", "badge-red"],
    [300, "300", "badge-red"],
    [429, "429", "badge-red"],
    [499, "499", "badge-gray"],
    [500, "500", "badge-red"],
    [0, "error", "badge-red"],
  ])("draws status %i as '%s' in %s", async (httpStatus, label, badge) => {
    const { pageRow } = await setup({ rows: [row(1, { httpStatus })], total: 1 });
    const el = pageRow(0).querySelector("td:nth-child(4) span")!;
    expect([el.textContent, classes(el)]).toEqual([label, [badge]]);
  });

  it("writes the cache hit and the thinking share inside the counts they belong to, with the full split as a tooltip", async () => {
    const { pageRow } = await setup();
    const split = pageRow(0).querySelector("td:nth-child(5) > span") as HTMLElement;
    const n = formatNumber;
    expect(classes(split)).toEqual(cls("whitespace-nowrap text-xs text-ink-300"));
    expect(split.title).toBe(`input ${n(1200)} — 300 from cache, 100 written · output 450 — 50 thinking. The bracketed figures are parts of the count beside them, not additions to it.`);
    expect([...split.children].map((c) => [c.tagName, c.textContent, classes(c)])).toEqual([
      ["SPAN", " (300)", ["text-ink-500"]], ["I", "", cls("bi bi-arrow-right mx-1 text-ink-600")], ["SPAN", " (50)", ["text-ink-500"]],
    ]);
    // Zero shares are left out of the cell but still spelled out in the tooltip.
    const plain = pageRow(1).querySelector("td:nth-child(5) > span") as HTMLElement;
    expect(plain.querySelectorAll("span")).toHaveLength(0);
    expect(plain.title).toMatch(/^input 7 — 0 from cache, 0 written · output 0 — 0 thinking\./);
  });
});

// ---------------------------------------------------------------------------

describe("Logs page: filters, pagination and refresh", () => {
  it.each([
    ["a service", (s: Awaited<ReturnType<typeof setup>>) => type(s.selects()[0], "11"), logsPath({ serviceId: 11 })],
    ["the other service", (s: Awaited<ReturnType<typeof setup>>) => type(s.selects()[0], "10"), logsPath({ serviceId: 10 })],
    ["a key", (s: Awaited<ReturnType<typeof setup>>) => type(s.selects()[1], "2"), logsPath({ tokenId: 2 })],
    ["errors only", (s: Awaited<ReturnType<typeof setup>>) => { fireEvent.click(s.errorsOnly()); }, logsPath({ errorsOnly: true })],
  ])("filtering by %s reloads with just that parameter", async (_name, apply, path) => {
    const s = await setup();
    apply(s);
    await tick();
    expect(s.listed()).toEqual([FIRST, path]);
    expect(s.api.calls.at(-1)).toEqual(sentBare("GET", path));
  });

  it("combines the filters in a fixed parameter order and drops each one again when it is cleared", async () => {
    const { listed, selects, errorsOnly } = await setup();
    type(selects()[1], "1");
    await tick();
    fireEvent.click(errorsOnly());
    await tick();
    type(selects()[0], "10");
    await tick();
    expect([selects()[0].value, selects()[1].value, errorsOnly().checked]).toEqual(["10", "1", true]);
    type(selects()[1], "");
    await tick();
    type(selects()[0], "");
    await tick();
    fireEvent.click(errorsOnly());
    await tick();
    expect(listed()).toEqual([
      "/logs?limit=50&offset=0",
      "/logs?limit=50&offset=0&tokenId=1",
      "/logs?limit=50&offset=0&errorsOnly=true&tokenId=1",
      "/logs?limit=50&offset=0&errorsOnly=true&serviceId=10&tokenId=1",
      "/logs?limit=50&offset=0&errorsOnly=true&serviceId=10",
      "/logs?limit=50&offset=0&errorsOnly=true",
      "/logs?limit=50&offset=0",
    ]);
  });

  it("a filter change shows the spinner over the rows it already has", async () => {
    const gate = deferred<unknown>();
    const { api, selects, table } = await setup();
    api.on(`GET ${logsPath({ serviceId: 10 })}`, () => gate.promise);
    type(selects()[0], "10");
    await tick();
    expect(spinner()).not.toBeNull();
    expect(table()!.querySelectorAll("tbody tr")).toHaveLength(4);
    await act(async () => { gate.resolve({ rows: [R1], total: 1 }); });
    await tick();
    expect(spinner()).toBeNull();
    expect(table()!.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(screen.getByText("1 total")).toBeTruthy();
  });

  const paged = (total: number): Handler => (_body: unknown, call: { path: string }) => {
    const offset = Number(new URLSearchParams(call.path.split("?")[1]).get("offset"));
    return { rows: [row(offset + 1)], total };
  };
  const pager = (container: HTMLElement) => container.querySelector(".mt-4.justify-between") as HTMLElement | null;

  it("pages by 50: Prev and Next move the offset and are disabled at the ends", async () => {
    const { container, listed } = await setup(paged(120));
    const bar = pager(container)!;
    expect(classes(bar)).toEqual(cls("mt-4 flex items-center justify-between text-sm text-ink-400"));
    const prev = () => button("Prev", bar);
    const next = () => button("Next", bar);
    expect([classes(prev()), classes(next())]).toEqual([cls("btn-ghost btn-xs"), cls("btn-ghost btn-xs")]);
    // The chevron leads Prev and trails Next.
    expect([classes(prev().firstElementChild), prev().firstChild]).toEqual([cls("bi bi-chevron-left"), prev().firstElementChild]);
    expect([classes(next().lastElementChild), next().lastChild]).toEqual([cls("bi bi-chevron-right"), next().lastElementChild]);
    expect([...bar.children].map((c) => c.tagName)).toEqual(["BUTTON", "SPAN", "BUTTON"]);
    const state = () => [text(bar.querySelector("span")), prev().disabled, next().disabled];
    expect(state()).toEqual(["1-50 of 120", true, false]);

    fireEvent.click(next());
    await tick();
    expect(state()).toEqual(["51-100 of 120", false, false]);
    fireEvent.click(next());
    await tick();
    expect(state()).toEqual(["101-120 of 120", false, true]);
    fireEvent.click(prev());
    await tick();
    fireEvent.click(prev());
    await tick();
    expect(state()).toEqual(["1-50 of 120", true, false]);
    expect(listed()).toEqual([0, 50, 100, 50, 0].map((offset) => logsPath({ offset })));
  });

  it.each([
    [50, null],
    [51, "1-50 of 51"],
    [1234, `1-50 of ${formatNumber(1234)}`],
  ])("with %i entries the pager is %s", async (total, summary) => {
    const { container } = await setup(paged(total));
    expect(pager(container) ? text(pager(container)!.querySelector("span")) : null).toBe(summary);
  });

  it("a last page of one entry reads 51-51", async () => {
    const { container } = await setup(paged(51));
    fireEvent.click(button("Next"));
    await tick();
    expect(text(pager(container)!.querySelector("span"))).toBe("51-51 of 51");
    expect(button("Next").disabled).toBe(true);
  });

  it.each([
    ["the service", (s: Awaited<ReturnType<typeof setup>>) => type(s.selects()[0], "10"), logsPath({ serviceId: 10 })],
    ["the key", (s: Awaited<ReturnType<typeof setup>>) => type(s.selects()[1], "1"), logsPath({ tokenId: 1 })],
    ["errors only", (s: Awaited<ReturnType<typeof setup>>) => { fireEvent.click(s.errorsOnly()); }, logsPath({ errorsOnly: true })],
  ])("changing %s goes back to the first page in one request", async (_name, apply, path) => {
    const s = await setup(paged(120));
    fireEvent.click(button("Next"));
    await tick();
    apply(s);
    await tick();
    expect(s.listed()).toEqual([FIRST, logsPath({ offset: 50 }), path]);
    expect(button("Prev").disabled).toBe(true);
  });

  it("refreshes silently every 5s with the current filter and page", async () => {
    const { api, listed, table, selects } = await setup(paged(120));
    await tick(4999);
    expect(listed()).toHaveLength(1);
    const gate = deferred<unknown>();
    api.on(`GET ${FIRST}`, () => gate.promise);
    await tick(1);
    expect(listed()).toEqual([FIRST, FIRST]);
    // Silent: no spinner while the refresh is in flight.
    expect(spinner()).toBeNull();
    await act(async () => { gate.resolve({ rows: [row(7), row(8)], total: 120 }); });
    await tick();
    expect(table()!.querySelectorAll("tbody tr")).toHaveLength(2);

    fireEvent.click(button("Next"));
    await tick();
    type(selects()[0], "11");
    await tick();
    fireEvent.click(button("Next"));
    await tick();
    const before = listed().length;
    await tick(5000);
    expect(listed().slice(before)).toEqual([logsPath({ offset: 50, serviceId: 11 })]);
  });

  it("switching auto-refresh off stops the timer and hides the live badge; on restarts a full 5s period", async () => {
    const { listed } = await setup();
    fireEvent.click(toggle("Auto-refresh (5s)"));
    expect(isOn(toggle("Auto-refresh (5s)"))).toBe(false);
    expect(screen.queryByText("live")).toBeNull();
    await tick(60_000);
    expect(listed()).toHaveLength(1);
    fireEvent.click(toggle("Auto-refresh (5s)"));
    expect(screen.getByText("live")).toBeTruthy();
    // Switching it on does not itself reload.
    await tick(4999);
    expect(listed()).toHaveLength(1);
    await tick(1);
    expect(listed()).toHaveLength(2);
  });

  it("Refresh reloads the same query with a spinner", async () => {
    const gate = deferred<unknown>();
    const { api, listed, selects } = await setup();
    type(selects()[1], "2");
    await tick();
    api.on(`GET ${logsPath({ tokenId: 2 })}`, () => gate.promise);
    fireEvent.click(button("Refresh"));
    await tick();
    expect(listed()).toEqual([FIRST, logsPath({ tokenId: 2 }), logsPath({ tokenId: 2 })]);
    expect(spinner()).not.toBeNull();
    await act(async () => { gate.resolve({ rows: [], total: 0 }); });
    await tick();
    expect(spinner()).toBeNull();
  });

  it("stops refreshing once unmounted", async () => {
    const { listed, unmount } = await setup();
    unmount();
    await tick(60_000);
    expect(listed()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("Logs page: clear all", () => {
  const TITLE = "Delete all logs";
  const BODY = `This permanently deletes all ${formatNumber(1234)} request log entries and reclaims the disk space. This cannot be undone.`;

  it("asks first, quoting the total; Cancel sends nothing", async () => {
    const { api } = await setup({ rows: ROWS, total: 1234 });
    fireEvent.click(button("Clear all"));
    const m = openModal(TITLE);
    expect(classes(m)).toEqual(cls("card flex max-h-[92vh] w-full flex-col max-w-lg"));
    expect(classes(m.querySelector("h2 i"))).toEqual(cls("bi bi-exclamation-triangle-fill text-brand-400"));
    expect(classes(screen.getByText(BODY))).toEqual(cls("text-sm text-ink-300"));
    expect([classes(button("Cancel", m)), classes(button("Confirm", m))]).toEqual([["btn-ghost"], ["btn-danger"]]);
    await act(async () => { fireEvent.click(button("Cancel", m)); });
    expect(modal(TITLE)).toBeNull();
    expect(api.mutations()).toEqual([]);
  });

  it("deletes with a bare DELETE /logs, toasts the server's count and reloads the first page", async () => {
    let page: unknown = { rows: ROWS, total: 1234 };
    const { api, listed, table } = await setup(() => page, { "DELETE /logs": () => { page = { rows: [], total: 0 }; return { deleted: 1230 }; } });
    fireEvent.click(button("Clear all"));
    fireEvent.click(button("Confirm", openModal(TITLE)));
    await toastShown(`Deleted ${formatNumber(1230)} log entries`);
    await tick();
    expect(api.mutations()).toEqual([sentBare("DELETE", "/logs")]);
    expect(listed()).toEqual([FIRST, FIRST]);
    expect(table()).toBeNull();
    expect(screen.getByText("No log entries")).toBeTruthy();
    expect(button("Clear all").disabled).toBe(true);
  });

  it("disables the button and spins its icon while the delete is in flight", async () => {
    const gate = deferred<unknown>();
    await setup({ rows: ROWS, total: 1234 }, { "DELETE /logs": () => gate.promise });
    fireEvent.click(button("Clear all"));
    fireEvent.click(button("Confirm", openModal(TITLE)));
    await tick();
    expect(button("Clear all").disabled).toBe(true);
    expect(classes(button("Clear all").querySelector("i"))).toEqual(cls("bi bi-arrow-repeat animate-spin"));
    await act(async () => { gate.resolve({ deleted: 0 }); });
    await tick();
    expect(button("Clear all").disabled).toBe(false);
    expect(classes(button("Clear all").querySelector("i"))).toEqual(cls("bi bi-trash3"));
  });

  it("from a later page it ends up back on the first", async () => {
    const { listed } = await setup({ rows: ROWS, total: 120 }, { "DELETE /logs": { deleted: 120 } });
    fireEvent.click(button("Next"));
    await tick();
    fireEvent.click(button("Clear all"));
    fireEvent.click(button("Confirm", openModal(TITLE)));
    await toastShown("Deleted 120 log entries");
    await tick();
    expect(listed().at(-1)).toBe(FIRST);
    expect(button("Prev").disabled).toBe(true);
  });

  it.each([
    ["the server's message", fail(403, { error: "forbidden" }), "forbidden"],
    // Unlike the other pages, any Error's own message is shown, not just an API error's.
    ["a network error's own message", () => { throw new TypeError("offline"); }, "offline"],
    ["'Failed to clear logs' for a failure that is not an Error", () => Promise.reject("boom"), "Failed to clear logs"],
  ])("toasts %s when the delete is refused, and does not reload", async (_name, handler, message) => {
    const { listed } = await setup({ rows: ROWS, total: 1234 }, { "DELETE /logs": handler });
    fireEvent.click(button("Clear all"));
    fireEvent.click(button("Confirm", openModal(TITLE)));
    await toastShown(message);
    await tick();
    expect(toasts()).toEqual([message]);
    expect(listed()).toHaveLength(1);
    expect(button("Clear all").disabled).toBe(false);
  });
});
