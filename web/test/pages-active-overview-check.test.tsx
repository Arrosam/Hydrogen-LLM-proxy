/**
 * Characterization of the Active Requests page (500ms polling, the blocked
 * flag, the progress timeline) and the Overview page (endpoints, stat cards,
 * the traffic chart's inputs, top lists). The API Key Check page is in
 * pages-check.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { ActiveRequests } from "../src/pages/ActiveRequests";
import { Overview } from "../src/pages/Overview";
import { formatNumber } from "../src/lib/format";
import type { GroupCount, StatsSummary, TimePoint } from "../src/types";
import {
  ADMIN, button, cells, classes, cls, deferred, fail, iconButton, isOn, mockApi, modal, openModal,
  renderPage, toastShown, toggle, type, type Routes,
} from "./helpers";

/** What the page handed to the chart library that cannot be read back from the DOM. */
const chart = vi.hoisted(() => ({
  tick: {} as Record<string, (v: number) => string>,
  tooltip: null as null | ((value: number | string, name: string) => [string, string]),
}));
// jsdom has no layout, so recharts draws nothing: stand-ins record the props they are given.
vi.mock("recharts", async () => {
  const { createElement } = await import("react");
  type Props = Record<string, unknown> & { children?: unknown };
  const leaf = (kind: string) => (props: Props) => {
    if (kind === "YAxis") chart.tick[String(props.yAxisId)] = props.tickFormatter as (v: number) => string;
    if (kind === "Tooltip") chart.tooltip = props.formatter as typeof chart.tooltip;
    return createElement("g", { "data-chart": kind, "data-props": JSON.stringify(props) });
  };
  const box = (kind: string, tag: string) => ({ children, ...props }: Props) =>
    createElement(tag, { "data-chart": kind, "data-props": JSON.stringify(props) }, children as never);
  return {
    ResponsiveContainer: box("ResponsiveContainer", "div"), AreaChart: box("AreaChart", "svg"),
    CartesianGrid: leaf("CartesianGrid"), XAxis: leaf("XAxis"), YAxis: leaf("YAxis"), Tooltip: leaf("Tooltip"), Area: leaf("Area"),
  };
});

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
  delete (document as unknown as { execCommand?: unknown }).execCommand;
});

const sentBare = (method: string, path: string) => ({ method, path, body: undefined, headers: {}, credentials: "same-origin" });
const PAGE_TITLE = "flex items-center gap-2.5 text-2xl font-semibold text-ink-100";
const ERROR_NOTE = "flex items-center gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300";
const spinner = () => document.querySelector(".py-16 .animate-spin");
const errorNote = (within: ParentNode = document.body) => within.querySelector(".border-red-900\\/50.px-4");
const text = (el: Element | null | undefined): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const pageCalls = (api: { calls: { method: string; path: string }[] }) =>
  api.calls.filter((c) => c.path !== "/me" && c.path !== "/settings/ui-language").map((c) => `${c.method} ${c.path}`);
/** A CSS value as jsdom reports it back (it rewrites colours and numbers). */
const css = (prop: "background" | "width", value: string): string => {
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

describe("ActiveRequests page", () => {
  const STARTED = Date.UTC(2026, 5, 1, 10, 20, 30, 0);
  const LONG = "trace-0123456789-abcdefghij";
  const request = (traceId: string, extra: Record<string, unknown> = {}) => ({
    traceId, tokenId: 1, serviceId: 10, serviceName: "svc-a", ingress: "openai", streaming: false, startedAt: STARTED, updatedAt: STARTED + 1500,
    elapsedMs: 1500, blocked: false, done: false, httpStatus: null, error: null, eventCount: 3, lastPhase: "llm", lastNode: "call:openai",
    lastMessage: "waiting for upstream", lastEventTs: STARTED + 1500, events: [], ...extra,
  });
  const A1 = request("tr-1");
  const A2 = request(LONG, { serviceName: null, lastPhase: null, lastNode: null, elapsedMs: 45_000, blocked: true, eventCount: 9 });
  const C1 = request("tr-done", { done: true, httpStatus: 200, lastPhase: "done", elapsedMs: 125_000 });
  const listOf = (active: unknown[] = [A1, A2], completed: unknown[] = [C1], blockThresholdMs = 30_000) => ({ active, completed, blockThresholdMs, now: NOW });
  const LIST = "/active-requests";
  const STATUS = "text-xs text-ink-500";
  const setup = async (list: unknown = listOf(), routes: Routes = {}) => {
    const api = mockApi({ [`GET ${LIST}`]: list, ...routes }, ADMIN);
    const view = await renderPage(<ActiveRequests />);
    await tick();
    const listed = () => api.calls.filter((c) => c.path.startsWith(LIST) && !c.path.startsWith(`${LIST}/`)).map((c) => c.path);
    const tables = () => [...view.container.querySelectorAll("table.table")] as HTMLTableElement[];
    const rows = (table = 0) => [...tables()[table].querySelectorAll("tbody tr")] as HTMLElement[];
    const filter = () => view.container.querySelector("input.input") as HTMLInputElement;
    const showCompleted = () => view.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    return { api, listed, tables, rows, filter, showCompleted, ...view };
  };
  const AUTO = "Auto-refresh (500ms)";
  const BLOCKED_ROW = "cursor-pointer border-l-4 border-l-red-500 bg-red-950/20 hover:bg-ink-850/50";
  const PLAIN_ROW = "cursor-pointer hover:bg-ink-850/50";

  it("loads GET /active-requests once on mount", async () => {
    const { api } = await setup();
    expect(pageCalls(api)).toEqual([`GET ${LIST}`]);
    expect(api.calls.find((c) => c.path === LIST)).toEqual(sentBare("GET", LIST));
  });

  it("shows the header with the live controls, and the filter bar with the counts", async () => {
    const { container, filter, showCompleted } = await setup(listOf([A1], [C1]));
    const h1 = container.querySelector("h1")!;
    expect(h1.textContent).toBe("Active Requests");
    expect(classes(h1)).toEqual(cls(PAGE_TITLE));
    expect(classes(h1.querySelector("i"))).toEqual(cls("bi bi-activity text-brand-400"));
    expect(screen.getByText("Real-time monitoring of in-flight requests. Blocked requests (>30s) are highlighted.")).toBeTruthy();
    const action = toggle(AUTO).closest("label")!.parentElement!;
    expect(classes(action)).toEqual(cls("flex items-center gap-3"));
    expect([...action.children].map((c) => c.tagName)).toEqual(["LABEL", "SPAN"]);
    expect(isOn(toggle(AUTO))).toBe(true);
    const live = screen.getByText("live");
    expect(classes(live)).toEqual(["badge-green"]);
    expect(classes(live.querySelector("i"))).toEqual(cls("bi bi-broadcast"));

    const bar = filter().parentElement!;
    expect(classes(bar)).toEqual(cls("mb-4 flex flex-wrap items-center gap-3"));
    expect([...bar.children].map((c) => c.tagName)).toEqual(["INPUT", "BUTTON", "LABEL", "DIV", "SPAN"]);
    expect([classes(filter()), filter().placeholder, filter().value]).toEqual([cls("input w-auto font-mono text-xs"), "Filter by trace ID...", ""]);
    expect(classes(button("Refresh"))).toEqual(cls("btn-ghost btn-xs"));
    expect(classes(button("Refresh").querySelector("i"))).toEqual(cls("bi bi-arrow-clockwise"));
    expect([showCompleted().checked, text(showCompleted().parentElement)]).toEqual([false, "Show recently completed"]);
    expect(classes(showCompleted().parentElement)).toEqual(cls("flex items-center gap-2 text-sm text-ink-300"));
    expect(classes(bar.children[3])).toEqual(["flex-1"]);
    expect([text(bar.lastElementChild), classes(bar.lastElementChild)]).toEqual(["1 active, 1 completed", cls(STATUS)]);
  });

  it("says 'loading...' with a spinner until the first answer, then shows the empty state", async () => {
    const gate = deferred<unknown>();
    const { container } = await setup(() => gate.promise);
    expect(text(container.querySelector(".mb-4 > span"))).toBe("loading...");
    expect(spinner()).not.toBeNull();
    expect(screen.queryByText("No active requests")).toBeNull();
    await act(async () => { gate.resolve(listOf([], [])); });
    await tick();
    expect(spinner()).toBeNull();
    expect(text(container.querySelector(".mb-4 > span"))).toBe("0 active, 0 completed");
    const title = screen.getByText("No active requests");
    expect(classes(title.parentElement!.querySelector("i"))).toEqual(cls("bi bi-activity text-4xl text-ink-600"));
    expect(screen.getByText("In-flight requests will appear here in real-time.")).toBeTruthy();
    expect(container.querySelector("table")).toBeNull();
  });

  it("lists in-flight requests in a table", async () => {
    const { tables, rows } = await setup();
    expect(tables()).toHaveLength(1);
    expect(classes(tables()[0])).toEqual(["table"]);
    expect(classes(tables()[0].parentElement)).toEqual(cls("card overflow-hidden"));
    expect([...tables()[0].querySelectorAll("th")].map((th) => [th.textContent, th.className])).toEqual([
      ["Trace ID", ""], ["Service", ""], ["Phase", ""], ["Last Node", ""], ["Elapsed", ""], ["Events", ""], ["Status", ""], ["", ""],
    ]);
    expect(rows().map((tr) => cells(tr))).toEqual([
      ["tr-1", "svc-a", "llm", "call:openai", "1.5s", "3", "serving", ""],
      ["trace-0123...efghij", "-", "", "-", "45.0s", "9", "blocked", ""],
    ]);
    const [trace, svc, phase, node, elapsed, events, status, open] = [...rows()[0].querySelectorAll("td")];
    expect([classes(trace), trace.title]).toEqual([cls("font-mono text-xs text-ink-200"), "tr-1"]);
    expect(classes(svc)).toEqual(cls("font-mono text-xs text-ink-300"));
    expect([phase.className, status.className]).toEqual(["", ""]);
    expect(classes(node)).toEqual(cls("font-mono text-xs text-ink-400"));
    expect(classes(elapsed)).toEqual(cls("text-xs font-medium text-ink-300"));
    expect(classes(events)).toEqual(cls("text-xs text-ink-400"));
    expect(classes(open)).toEqual(["text-right"]);
    expect(classes(open.querySelector("i"))).toEqual(cls("bi bi-chevron-right text-ink-600"));
    expect(classes(rows()[0])).toEqual(cls(PLAIN_ROW));
    // A long trace id is shortened in the cell and kept whole in its tooltip.
    expect(rows()[1].querySelector("td")!.title).toBe(LONG);
    expect(rows()[1].querySelector("td:nth-child(3)")!.childElementCount).toBe(0);
  });

  it.each([
    ["20 characters", "a".repeat(20), "a".repeat(20)],
    ["21 characters", `${"a".repeat(10)}bbbbb${"c".repeat(6)}`, `${"a".repeat(10)}...${"c".repeat(6)}`],
  ])("a trace id of %s is shown as %s", async (_name, traceId, shown) => {
    const { rows } = await setup(listOf([request(traceId)], []));
    expect(cells(rows()[0])[0]).toBe(shown);
  });

  it.each([
    [0, "0ms"], [999, "999ms"], [1000, "1.0s"], [1549, "1.5s"], [59_999, "60.0s"], [60_000, "1m0s"], [125_999, "2m5s"], [3_600_000, "60m0s"],
  ])("formats %i ms elapsed as %s", async (elapsedMs, shown) => {
    const { rows } = await setup(listOf([request("tr-1", { elapsedMs })], []));
    expect(cells(rows()[0])[4]).toBe(shown);
  });

  it.each([
    ["init", "badge-blue"], ["agent", "badge-purple"], ["llm", "badge-green"], ["retry", "badge-yellow"], ["done", "badge-gray"],
    ["error", "badge-red"], ["tool", "badge-gray"],
  ])("draws phase %s in %s", async (lastPhase, badge) => {
    const { rows } = await setup(listOf([request("tr-1", { lastPhase })], []));
    const el = rows()[0].querySelector("td:nth-child(3) span")!;
    expect([el.textContent, classes(el)]).toEqual([lastPhase, [badge]]);
  });

  it.each([
    ["serving", { done: false, blocked: false }, "serving", "badge-green"],
    ["blocked", { done: false, blocked: true }, "blocked", "badge-red"],
    ["done 200", { done: true, httpStatus: 200 }, "200", "badge-green"],
    ["done 499", { done: true, httpStatus: 499 }, "499", "badge-gray"],
    ["done 502, even if it was blocked", { done: true, blocked: true, httpStatus: 502 }, "502", "badge-red"],
    ["done without a status", { done: true, httpStatus: null }, "error", "badge-red"],
  ])("status cell: %s", async (_name, extra, label, badge) => {
    const { rows } = await setup(listOf([request("tr-1", extra)], []));
    const el = rows()[0].querySelector("td:nth-child(7) span")!;
    expect([el.textContent, classes(el)]).toEqual([label, [badge]]);
  });

  it("highlights a blocked request and counts the blocked in-flight ones in the header", async () => {
    const { rows } = await setup(listOf([A1, A2, request("tr-3", { blocked: true })], [request("tr-old", { blocked: true, done: true, httpStatus: 504 })]));
    expect(classes(rows()[1])).toEqual(cls(BLOCKED_ROW));
    const elapsed = rows()[1].querySelector("td:nth-child(5)")!;
    expect(classes(elapsed)).toEqual(cls("text-xs font-medium text-red-400"));
    const warn = elapsed.querySelector("i") as HTMLElement;
    expect([classes(warn), warn.title]).toEqual([cls("bi bi-exclamation-triangle ml-1 text-red-400"), "Blocked > 30s"]);
    expect(rows()[0].querySelector("td:nth-child(5) i")).toBeNull();
    // Completed requests are not counted.
    const count = screen.getByText("2 blocked");
    expect(classes(count)).toEqual(cls("badge-red animate-pulse"));
    expect(classes(count.querySelector("i"))).toEqual(cls("bi bi-exclamation-triangle"));
    expect([...count.parentElement!.children].map((c) => c.tagName)).toEqual(["SPAN", "LABEL", "SPAN"]);
  });

  it("takes the blocked flag from the server as-is: the threshold and the elapsed time play no part", async () => {
    const { rows } = await setup(listOf([request("slow", { elapsedMs: 999_000, blocked: false }), request("quick", { elapsedMs: 5, blocked: true })], [], 30_000));
    expect(rows().map((tr) => [classes(tr), cells(tr)[6]])).toEqual([[cls(PLAIN_ROW), "serving"], [cls(BLOCKED_ROW), "blocked"]]);
    expect(screen.getByText("1 blocked")).toBeTruthy();
  });

  it("polls every 500ms without a spinner and redraws from each answer", async () => {
    const { api, listed, rows } = await setup();
    await tick(499);
    expect(listed()).toHaveLength(1);
    const gate = deferred<unknown>();
    api.on(`GET ${LIST}`, () => gate.promise);
    await tick(1);
    expect(listed()).toEqual([LIST, LIST]);
    expect(spinner()).toBeNull();
    await act(async () => { gate.resolve(listOf([request("tr-9", { elapsedMs: 2000 })], [])); });
    await tick();
    expect(rows().map((tr) => cells(tr).slice(0, 5))).toEqual([["tr-9", "svc-a", "llm", "call:openai", "2.0s"]]);
    expect(screen.getByText("1 active, 0 completed")).toBeTruthy();
    await tick(1500);
    expect(listed()).toHaveLength(5);
    expect(api.calls.at(-1)).toEqual(sentBare("GET", LIST));
  });

  it("switching auto-refresh off stops polling and hides the live badge; on restarts a full period", async () => {
    const { listed } = await setup();
    fireEvent.click(toggle(AUTO));
    expect(isOn(toggle(AUTO))).toBe(false);
    expect(screen.queryByText("live")).toBeNull();
    await tick(10_000);
    expect(listed()).toHaveLength(1);
    fireEvent.click(toggle(AUTO));
    expect(screen.getByText("live")).toBeTruthy();
    await tick(499);
    expect(listed()).toHaveLength(1);
    await tick(1);
    expect(listed()).toHaveLength(2);
  });

  it("Refresh reloads at once, with a spinner over the current table", async () => {
    const gate = deferred<unknown>();
    const { api, listed, tables } = await setup();
    api.on(`GET ${LIST}`, () => gate.promise);
    fireEvent.click(button("Refresh"));
    await tick();
    expect(listed()).toHaveLength(2);
    expect(spinner()).not.toBeNull();
    expect(tables()).toHaveLength(1);
    await act(async () => { gate.resolve(listOf()); });
    await tick();
    expect(spinner()).toBeNull();
  });

  it("filters by trace id through the query string, for the reload and for every poll after it", async () => {
    const { api, listed, filter, rows } = await setup(listOf(), {
      "GET /active-requests?traceId=tr-1": listOf([A1], []),
      "GET /active-requests?traceId=tr%2F1+x": listOf([], []),
    });
    type(filter(), "tr-1");
    await tick();
    expect(api.calls.at(-1)).toEqual(sentBare("GET", "/active-requests?traceId=tr-1"));
    expect(rows()).toHaveLength(1);
    await tick(500);
    type(filter(), "tr/1 x");
    await tick();
    type(filter(), "");
    await tick();
    await tick(500);
    expect(listed()).toEqual([LIST, `${LIST}?traceId=tr-1`, `${LIST}?traceId=tr-1`, `${LIST}?traceId=tr%2F1+x`, LIST, LIST]);
  });

  it("a filter change restarts the polling period", async () => {
    const { listed, filter } = await setup(listOf(), { "GET /active-requests?traceId=tr-1": listOf([A1], []) });
    await tick(400);
    type(filter(), "tr-1");
    await tick();
    await tick(499);
    expect(listed()).toHaveLength(2);
    await tick(1);
    expect(listed()).toHaveLength(3);
  });

  it("shows a failed poll as an error over the table it already has, keeps polling, and clears it on the next answer", async () => {
    const { api, listed, tables } = await setup();
    api.on(`GET ${LIST}`, fail(502, { error: "bad gateway" }));
    await tick(500);
    expect([errorNote()!.textContent, classes(errorNote())]).toEqual(["bad gateway", cls(ERROR_NOTE)]);
    expect(tables()).toHaveLength(1);
    expect(screen.getByText("2 active, 1 completed")).toBeTruthy();
    api.on(`GET ${LIST}`, listOf([A1], []));
    await tick(500);
    expect(listed()).toHaveLength(3);
    expect(errorNote()).toBeNull();
    expect(screen.getByText("1 active, 0 completed")).toBeTruthy();
  });

  it("shows a load error when the first request fails, and keeps polling", async () => {
    const { api, listed, tables } = await setup(fail(500, { error: "db down" }));
    expect(errorNote()!.textContent).toBe("db down");
    expect(tables()).toHaveLength(0);
    api.on(`GET ${LIST}`, listOf());
    await tick(500);
    expect(listed()).toHaveLength(2);
    expect(errorNote()).toBeNull();
    expect(tables()).toHaveLength(1);
  });

  it("stops polling once unmounted", async () => {
    const { listed, unmount } = await setup();
    unmount();
    await tick(10_000);
    expect(listed()).toHaveLength(1);
  });

  it("'Show recently completed' adds a second table from data it already has", async () => {
    const { listed, tables, rows, showCompleted, container } = await setup();
    expect(container.querySelector("h3")).toBeNull();
    fireEvent.click(showCompleted());
    expect(listed()).toHaveLength(1);
    const h3 = container.querySelector("h3")!;
    expect([text(h3), classes(h3)]).toEqual(["Recently completed1", cls("mb-2 mt-6 text-sm font-medium text-ink-400")]);
    expect([h3.querySelector("span")!.textContent, classes(h3.querySelector("span"))]).toEqual(["1", cls("ml-2 text-xs text-ink-600")]);
    expect(tables()).toHaveLength(2);
    expect(classes(tables()[1].parentElement)).toEqual(cls("card overflow-hidden"));
    expect([...tables()[1].querySelectorAll("th")].map((th) => th.textContent)).toEqual([...tables()[0].querySelectorAll("th")].map((th) => th.textContent));
    expect(rows(1).map((tr) => cells(tr))).toEqual([["tr-done", "svc-a", "done", "call:openai", "2m5s", "3", "200", ""]]);
    expect(classes(rows(1)[0])).toEqual(cls(PLAIN_ROW));
    fireEvent.click(showCompleted());
    expect(tables()).toHaveLength(1);
  });

  it("with completed shown, an empty active list has no empty state and an empty completed list has its own", async () => {
    const { showCompleted, tables } = await setup(listOf([], []));
    fireEvent.click(showCompleted());
    expect(screen.queryByText("No active requests")).toBeNull();
    const title = screen.getByText("No recently completed requests");
    expect(classes(title.parentElement!.querySelector("i"))).toEqual(cls("bi bi-check2-circle text-4xl text-ink-600"));
    expect(screen.getByText("Completed requests appear here briefly before expiring.")).toBeTruthy();
    expect(tables()).toHaveLength(0);
  });

  const EVENTS = [
    { ts: STARTED + 456, phase: "init", node: "ingress", message: "request received" },
    { ts: STARTED + 1234, phase: "llm", node: "call:openai", message: "waiting for upstream", detail: { attempt: 2, model: "gpt-4o" } },
    { ts: STARTED + 2000, phase: "tool", node: "tool:search", message: "running", detail: {} },
  ];
  const openDetail = async (detail: Record<string, unknown>, title: string) => {
    const s = await setup(listOf([A1, A2], [C1]), { [`GET ${LIST}/${detail.traceId as string}`]: { request: detail, blockThresholdMs: 30_000 } });
    fireEvent.click(s.rows()[detail.traceId === LONG ? 1 : 0]);
    const m = await waitFor(() => openModal(title));
    return { m, ...s };
  };
  const tiles = (within: ParentNode) => [...within.querySelectorAll(".grid.grid-cols-3 > div")].map((d) => [d.children[0].textContent, d.children[1].textContent]);

  it("a row click fetches GET /active-requests/:traceId and opens a wide modal with six tiles and the timeline", async () => {
    const { api, m } = await openDetail(request("tr-1", { events: EVENTS, eventCount: 5, streaming: true }), "Trace tr-1");
    expect(api.sent("GET", `${LIST}/tr-1`)).toEqual([sentBare("GET", `${LIST}/tr-1`)]);
    expect(classes(m)).toEqual(cls("card flex max-h-[92vh] w-full flex-col max-w-4xl"));
    expect(classes(m.querySelector("h2 i"))).toEqual(cls("bi bi-activity text-brand-400"));
    expect(classes(m.querySelector(".card-pad > div"))).toEqual(["space-y-4"]);
    expect(m.querySelector(".border-red-800")).toBeNull();
    expect(errorNote(m)).toBeNull();

    expect(tiles(m)).toEqual([["Service", "svc-a"], ["Ingress", "openai"], ["Streaming", "yes"], ["Elapsed", "1.5s"], ["Events", "5"], ["Status", "in-flight"]]);
    const grid = m.querySelector(".grid")!;
    expect(classes(grid)).toEqual(cls("grid grid-cols-3 gap-3 text-sm"));
    const tile = grid.firstElementChild!;
    expect(classes(tile)).toEqual(cls("rounded-lg bg-ink-950/50 px-3 py-2"));
    expect(classes(tile.children[0])).toEqual(cls("text-[11px] uppercase tracking-wide text-ink-500"));
    expect(classes(tile.children[1])).toEqual(cls("mt-0.5 text-ink-200"));

    // The heading counts the events it lists; the tile shows the server's running count.
    const h4 = m.querySelector("h4")!;
    expect([h4.textContent, classes(h4)]).toEqual(["Progress timeline (3 events)", ["label"]]);
    const list = h4.nextElementSibling!;
    expect(classes(list)).toEqual(cls("max-h-[50vh] space-y-1 overflow-y-auto"));
    expect([...list.children].map((ev) => [...ev.children].map((c) => text(c)))).toEqual([
      ["10:20:30.456", "init", "ingressrequest received", "+456ms"],
      ["10:20:31.234", "llm", `call:openaiwaiting for upstream${JSON.stringify(EVENTS[1].detail)}`, `+${formatNumber(1234)}ms`],
      ["10:20:32.000", "tool", "tool:searchrunning", `+${formatNumber(2000)}ms`],
    ]);
    const [time, phase, body, offset] = [...list.children[1].children];
    expect(classes(list.children[1])).toEqual(cls("flex items-start gap-3 rounded-lg border border-ink-800 bg-ink-950/40 px-3 py-2"));
    expect(classes(time)).toEqual(cls("mt-0.5 text-[11px] font-mono text-ink-500"));
    expect(classes(phase)).toEqual(cls("mt-0.5 shrink-0 badge-green"));
    expect(classes(body)).toEqual(cls("min-w-0 flex-1"));
    expect([...body.children].map((c) => [c.tagName, classes(c)])).toEqual([
      ["DIV", cls("font-mono text-xs text-brand-400")], ["DIV", cls("text-xs text-ink-200")], ["PRE", cls("mt-1 overflow-auto rounded bg-ink-950 px-2 py-1 text-[10px] text-ink-400")],
    ]);
    expect(body.querySelector("pre")!.textContent).toBe('{"attempt":2,"model":"gpt-4o"}');
    expect(classes(offset)).toEqual(cls("text-[10px] text-ink-600"));
    expect(classes(list.children[0].children[1])).toEqual(cls("mt-0.5 shrink-0 badge-blue"));
    // No detail, or an empty one: no block.
    expect([list.children[0].querySelector("pre"), list.children[2].querySelector("pre")]).toEqual([null, null]);

    fireEvent.click(iconButton("bi-x-lg", m));
    expect(modal("Trace tr-1")).toBeNull();
  });

  it("warns on top for a blocked in-flight request, shortens the trace in the title and says so when there are no events", async () => {
    const { m } = await openDetail(request(LONG, { blocked: true, elapsedMs: 45_000, serviceName: null }), "Trace trace-0123...efghij");
    const warning = m.querySelector(".card-pad > div")!.firstElementChild!;
    expect(classes(warning)).toEqual(cls("rounded-lg border border-red-800 bg-red-950/30 px-4 py-3"));
    expect(classes(warning.children[0])).toEqual(cls("flex items-center gap-2 text-red-400"));
    expect(classes(warning.querySelector("i"))).toEqual(cls("bi bi-exclamation-triangle-fill"));
    expect([text(warning.querySelector("span")), classes(warning.querySelector("span"))]).toEqual([
      "BLOCKED — this request has been in-flight for 45.0s (exceeds 30s threshold)", ["font-semibold"],
    ]);
    expect([text(warning.children[1]), classes(warning.children[1])]).toEqual(["Last progress: llm/call:openai — waiting for upstream", cls("mt-1 text-xs text-red-300")]);
    expect(tiles(m)[0]).toEqual(["Service", "-"]);
    expect(m.querySelector("h4")!.textContent).toBe("Progress timeline (0 events)");
    const none = m.querySelector("h4")!.nextElementSibling!.firstElementChild!;
    expect([none.textContent, classes(none)]).toEqual(["No events recorded", cls("rounded-lg border border-ink-800 bg-ink-950 px-3 py-2 text-xs text-ink-500")]);
  });

  it("a finished request shows its status and its error, and no blocked warning even if it had been blocked", async () => {
    const { m } = await openDetail(request("tr-1", { done: true, blocked: true, httpStatus: 502, error: "upstream gave up", lastPhase: null, lastNode: null, lastMessage: null }), "Trace tr-1");
    expect(m.querySelector(".border-red-800")).toBeNull();
    const note = m.querySelector(".card-pad > div")!.firstElementChild!;
    expect([note.textContent, classes(note)]).toEqual(["upstream gave up", cls(ERROR_NOTE)]);
    expect(tiles(m).slice(2)).toEqual([["Streaming", "no"], ["Elapsed", "1.5s"], ["Events", "3"], ["Status", "502"]]);
  });

  it("the open detail is a snapshot: polling goes on behind it and does not refetch or change it", async () => {
    const { api, listed, m } = await openDetail(request("tr-1", { events: EVENTS }), "Trace tr-1");
    api.on(`GET ${LIST}`, listOf([], []));
    await tick(1000);
    expect(listed()).toHaveLength(3);
    expect(api.sent("GET", `${LIST}/tr-1`)).toHaveLength(1);
    expect(modal("Trace tr-1")).toBe(m);
    expect(m.querySelector("h4")!.textContent).toBe("Progress timeline (3 events)");
  });

  it("a completed row opens its detail the same way", async () => {
    const { api, rows, showCompleted } = await setup(listOf(), { [`GET ${LIST}/tr-done`]: { request: C1, blockThresholdMs: 30_000 } });
    fireEvent.click(showCompleted());
    fireEvent.click(rows(1)[0]);
    const m = await waitFor(() => openModal("Trace tr-done"));
    expect(api.sent("GET", `${LIST}/tr-done`)).toHaveLength(1);
    expect(tiles(m).at(-1)).toEqual(["Status", "200"]);
  });

  it.each([
    ["the server's message", fail(404, { error: "request expired" }), "request expired"],
    ["a network error's own message", () => { throw new TypeError("offline"); }, "offline"],
    ["'Failed to load detail' for a failure that is not an Error", () => Promise.reject("boom"), "Failed to load detail"],
  ])("shows %s in the page's error note when the detail cannot be loaded, until the next poll answers", async (_name, handler, message) => {
    const { rows } = await setup(listOf(), { [`GET ${LIST}/tr-1`]: handler });
    fireEvent.click(rows()[0]);
    await tick();
    expect(errorNote()!.textContent).toBe(message);
    expect(document.querySelector("h2")).toBeNull();
    await tick(500);
    expect(errorNote()).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("Overview page", () => {
  const SUMMARY: StatsSummary = {
    requests: 12_345, errors: 7, promptTokens: 8000, completionTokens: 2000, totalTokens: 1_234_567, cachedInputTokens: 2000,
    cacheCreationInputTokens: 0, reasoningTokens: 0, avgLatencyMs: 1432,
  };
  const POINTS: TimePoint[] = [
    { day: "2026-05-30", requests: 10, totalTokens: 120_000, errors: 1, avgLatencyMs: 300 },
    { day: "2026-05-31", requests: 40, totalTokens: 480_000, errors: 0, avgLatencyMs: 250 },
  ];
  const group = (key: string, requests: number): GroupCount => ({ key, requests, totalTokens: requests * 10 });
  const SERVICES = [group("a", 50), group("b", 100), group("c", 25), group("d", 10), group("e", 5), group("f", 1), group("g", 200)];
  const ROUTES = ["GET /stats/summary", "GET /stats/timeseries", "GET /stats/by-service", "GET /stats/by-model-provider"];
  const setup = async (routes: Routes = {}) => {
    const api = mockApi({
      "GET /stats/summary": SUMMARY,
      "GET /stats/timeseries": { points: POINTS },
      "GET /stats/by-service": { groups: SERVICES },
      "GET /stats/by-model-provider": { models: [], providers: [group("openai", 0)] },
      ...routes,
    }, ADMIN);
    const view = await renderPage(<Overview />);
    await tick();
    return { api, ...view };
  };
  const CARD_HEADING = "flex items-center gap-2 text-sm font-semibold text-ink-200";
  const part = (kind: string): Record<string, unknown>[] =>
    [...document.querySelectorAll(`[data-chart="${kind}"]`)].map((e) => JSON.parse(e.getAttribute("data-props")!) as Record<string, unknown>);
  const SERIES = [
    // brand-400: the colour of the Requests stat card's icon.
    { key: "requests", label: "Requests", color: "#5eead4" },
    { key: "totalTokens", label: "Tokens", color: "#fbbf24" },
    { key: "errors", label: "Errors", color: "#f87171" },
    { key: "avgLatencyMs", label: "Avg latency", color: "#34d399" },
  ];
  const legend = () => [...screen.getByText("Traffic over time").nextElementSibling!.querySelectorAll("button")];
  const LEGEND = "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition";
  const LEGEND_OFF = `${LEGEND} text-ink-400 hover:bg-ink-800/60 hover:text-ink-200`;
  const LEGEND_ON = `${LEGEND} bg-ink-800 font-medium text-ink-100`;

  it("loads the four stats endpoints once, with no parameters, and offers no period selector", async () => {
    const { api, container } = await setup();
    expect(pageCalls(api).sort()).toEqual([...ROUTES].sort());
    expect(api.calls.filter((c) => c.path.startsWith("/stats/"))).toEqual(ROUTES.map((r) => sentBare("GET", r.slice(4))));
    expect(container.querySelector("select, input")).toBeNull();
    await tick(600_000);
    expect(pageCalls(api)).toHaveLength(4);
  });

  it("shows the header and the endpoints card at once, with a spinner while the stats load", async () => {
    const gate = deferred<unknown>();
    const { container } = await setup({ "GET /stats/summary": () => gate.promise });
    const h1 = container.querySelector("h1")!;
    expect(h1.textContent).toBe("Overview");
    expect(classes(h1)).toEqual(cls(PAGE_TITLE));
    expect(classes(h1.querySelector("i"))).toEqual(cls("bi bi-speedometer2 text-brand-400"));
    expect(screen.getByText("Traffic and usage across all Model Services and Micro Agents")).toBeTruthy();
    expect(spinner()).not.toBeNull();
    expect(container.querySelector(".space-y-6")).toBeNull();

    const title = screen.getByText("Endpoints");
    expect(classes(title)).toEqual(cls(`mb-3 ${CARD_HEADING}`));
    expect(classes(title.querySelector("i"))).toEqual(cls("bi bi-link-45deg text-brand-400"));
    const card = title.parentElement!;
    expect(classes(card)).toEqual(cls("card card-pad"));
    expect(classes(card.parentElement)).toEqual(["mb-6"]);
    expect(classes(card.children[1])).toEqual(cls("grid gap-3 sm:grid-cols-2"));
    const origin = window.location.origin;
    const boxes = [...card.children[1].children];
    expect(boxes.map((b) => [b.children[0].textContent, b.querySelector("code")!.textContent])).toEqual([
      ["OpenAI base URL", `${origin}/v1`], ["Anthropic base URL", origin],
    ]);
    expect(boxes.map((b) => [text(b.children[2]).startsWith("OpenAI SDK baseURL / OPENAI_BASE_URL"), text(b.children[2]).startsWith("Anthropic SDK base_url / ANTHROPIC_BASE_URL")])).toEqual([[true, false], [false, true]]);
    for (const b of boxes) expect(text(b.children[2]).endsWith("Use a Model Service or Micro Agent name as the model.")).toBe(true);
    const box = boxes[0];
    expect(classes(box)).toEqual(cls("rounded-lg border border-ink-800 bg-ink-950/40 p-3"));
    expect(classes(box.children[0])).toEqual(cls("mb-1.5 text-[11px] uppercase tracking-wide text-ink-500"));
    expect(classes(box.children[1])).toEqual(cls("flex items-center gap-2"));
    expect(classes(box.querySelector("code"))).toEqual(cls("flex-1 overflow-x-auto whitespace-nowrap rounded bg-ink-950 px-2 py-1 font-mono text-xs text-brand-400"));
    const copy = box.querySelector("button")!;
    expect([classes(copy), copy.title, classes(copy.querySelector("i"))]).toEqual([cls("btn-ghost btn-xs shrink-0"), "Copy", cls("bi bi-clipboard")]);
    expect(classes(box.children[2])).toEqual(cls("mt-1.5 text-[11px] text-ink-500"));

    await act(async () => { gate.resolve(SUMMARY); });
    await tick();
    expect(spinner()).toBeNull();
    expect(container.querySelector(".space-y-6")).not.toBeNull();
  });

  it.each([
    [true, "Copied to clipboard"],
    [false, "Copy failed - select the URL and copy it manually"],
  ])("copies an endpoint URL (copy succeeded: %s) and says so", async (ok, message) => {
    await setup();
    let copied = "";
    (document as unknown as { execCommand: unknown }).execCommand = vi.fn(() => {
      copied = document.querySelector("textarea")!.value;
      return ok;
    });
    fireEvent.click(iconButton("bi-clipboard", screen.getByText("Anthropic base URL").parentElement!));
    await toastShown(message);
    expect(copied).toBe(window.location.origin);
    fireEvent.click(iconButton("bi-clipboard", screen.getByText("OpenAI base URL").parentElement!));
    await waitFor(() => expect(copied).toBe(`${window.location.origin}/v1`));
  });

  it.each(ROUTES)("shows a load error and no stats when %s fails", async (route) => {
    const { container } = await setup({ [route]: fail(500, { error: "db down" }) });
    expect([errorNote()!.textContent, classes(errorNote())]).toEqual(["db down", cls(ERROR_NOTE)]);
    expect(spinner()).toBeNull();
    expect(container.querySelector(".space-y-6")).toBeNull();
    expect(screen.getByText("Endpoints")).toBeTruthy();
  });

  it("shows five stat cards, each with its own icon colour", async () => {
    const { container } = await setup();
    expect(classes(container.querySelector(".space-y-6"))).toEqual(["space-y-6"]);
    const grid = container.querySelector(".space-y-6")!.firstElementChild!;
    expect(classes(grid)).toEqual(cls("grid grid-cols-2 gap-4 lg:grid-cols-5"));
    expect([...grid.children].map((c) => [...c.children].map((x) => text(x)).concat(c.querySelector("i")!.className.split(" ").sort().join(" ")))).toEqual([
      ["Requests", formatNumber(12_345), "bi bi-arrow-left-right text-brand-400"],
      ["Total tokens", "1.2M", "bi bi-coin text-amber-400"],
      ["Cached input", "2K", "25% of input", "bi bi-database-check text-sky-400"],
      ["Errors", "7", "bi bi-exclamation-triangle text-red-400"],
      ["Avg latency", `${formatNumber(1432)} ms`, "bi bi-stopwatch text-emerald-400"],
    ]);
    const card = grid.children[2];
    expect(classes(card)).toEqual(cls("card card-pad"));
    expect(classes(card.children[0])).toEqual(cls("flex items-center justify-between"));
    expect(classes(card.children[0].children[0])).toEqual(cls("text-xs font-medium uppercase tracking-wide text-ink-400"));
    expect(card.children[0].children[1].tagName).toBe("I");
    expect(classes(card.children[1])).toEqual(cls("mt-2 text-2xl font-semibold text-ink-100"));
    expect(classes(card.children[2])).toEqual(cls("mt-1 text-xs text-ink-500"));
  });

  it.each([
    ["no prompt tokens", { promptTokens: 0, cachedInputTokens: 0 }, null],
    ["nothing cached", { promptTokens: 900, cachedInputTokens: 0 }, "0% of input"],
    ["a third cached", { promptTokens: 900, cachedInputTokens: 300 }, "33% of input"],
    ["two thirds cached", { promptTokens: 900, cachedInputTokens: 600 }, "67% of input"],
  ])("the cached-input card with %s has the hint %s, and small numbers are not compacted", async (_name, extra, hint) => {
    const { container } = await setup({ "GET /stats/summary": { ...SUMMARY, totalTokens: 999, ...extra } });
    const cards = container.querySelector(".space-y-6")!.firstElementChild!.children;
    expect(cards[2].children[2]?.textContent ?? null).toBe(hint);
    expect([cards[1].children[1].textContent, cards[2].children[1].textContent]).toEqual(["999", String(extra.cachedInputTokens)]);
  });

  it("hands the chart the day points and four line series, one hidden axis each", async () => {
    await setup();
    const title = screen.getByText("Traffic over time");
    expect(classes(title)).toEqual(cls(CARD_HEADING));
    expect(classes(title.querySelector("i"))).toEqual(cls("bi bi-graph-up text-brand-400"));
    expect(classes(title.parentElement)).toEqual(cls("mb-4 flex flex-wrap items-center justify-between gap-3"));
    expect(classes(title.parentElement!.parentElement)).toEqual(cls("card card-pad"));

    expect(part("ResponsiveContainer")).toEqual([{ width: "100%", height: 260 }]);
    expect(part("AreaChart")).toEqual([{ data: POINTS, margin: { top: 4, right: 8, bottom: 0, left: -12 } }]);
    expect(part("CartesianGrid")).toEqual([{ strokeDasharray: "3 3", stroke: "#1b222d" }]);
    expect(part("XAxis")).toEqual([{ dataKey: "day", stroke: "#5b6b80", fontSize: 11, tickLine: false }]);
    expect(part("YAxis")).toEqual(SERIES.map((s) => ({ yAxisId: s.key, hide: true, stroke: s.color, fontSize: 11, tickLine: false, axisLine: false, allowDecimals: false })));
    expect(part("Tooltip")).toEqual([{ contentStyle: { background: "#151b24", border: "1px solid #273140", borderRadius: 8, fontSize: 12 }, labelStyle: { color: "#aab6c6" } }]);
    expect(part("Area")).toEqual(SERIES.map((s) => ({ yAxisId: s.key, name: s.label, type: "monotone", dataKey: s.key, stroke: s.color, strokeWidth: 2, fill: "none", fillOpacity: 0 })));
    const gradients = [...document.querySelectorAll('[id^="grad-"]')];
    expect(gradients.map((g) => [g.id, ...[...g.children].map((s) => `${s.getAttribute("offset")} ${s.getAttribute("stop-color")} ${s.getAttribute("stop-opacity")}`)])).toEqual(
      SERIES.map((s) => [`grad-${s.key}`, `0% ${s.color} 0.5`, `100% ${s.color} 0`]),
    );
    expect(gradients.map((g) => ["x1", "y1", "x2", "y2"].map((a) => g.getAttribute(a)).join(" "))).toEqual(SERIES.map(() => "0 0 0 1"));
  });

  it("formats axis ticks and tooltip values per series", async () => {
    await setup();
    const n = formatNumber;
    expect([chart.tick.requests(12_345), chart.tick.totalTokens(120_000), chart.tick.totalTokens(999), chart.tick.errors(1200), chart.tick.avgLatencyMs(1432)])
      .toEqual([n(12_345), "120K", "999", n(1200), `${n(1432)} ms`]);
    const tip = chart.tooltip!;
    expect(tip(12_345, "Requests")).toEqual([n(12_345), "Requests"]);
    expect(tip("480000", "Tokens")).toEqual(["480K", "Tokens"]);
    expect(tip(3, "Errors")).toEqual(["3", "Errors"]);
    expect(tip(1432, "Avg latency")).toEqual([`${n(1432)} ms`, "Avg latency"]);
    // A name the chart does not know passes through untouched.
    expect(tip(1234, "other")).toEqual(["1234", "other"]);
  });

  it("the legend is a row of toggle buttons with a colour dot each", async () => {
    await setup();
    const buttons = legend();
    expect(classes(buttons[0].parentElement)).toEqual(cls("flex flex-wrap items-center gap-1"));
    expect(buttons.map((b) => [text(b), b.type, b.title, b.getAttribute("aria-pressed"), classes(b)])).toEqual(
      SERIES.map((s) => [s.label, "button", "Click to show this metric alone, with its own scale", "false", cls(LEGEND_OFF)]),
    );
    const dots = buttons.map((b) => b.querySelector("span") as HTMLElement);
    expect(classes(dots[0])).toEqual(cls("h-2 w-2 rounded-full transition-opacity"));
    expect(dots.map((d) => [d.style.background, d.style.opacity])).toEqual(SERIES.map((s) => [css("background", s.color), "1"]));
  });

  it("clicking a legend entry locks the chart to that series; again releases it; another switches", async () => {
    await setup();
    fireEvent.click(legend()[1]);
    expect(legend().map((b) => [b.getAttribute("aria-pressed"), classes(b), b.querySelector("span")!.style.opacity])).toEqual([
      ["false", cls(LEGEND_OFF), "0.3"], ["true", cls(LEGEND_ON), "1"], ["false", cls(LEGEND_OFF), "0.3"], ["false", cls(LEGEND_OFF), "0.3"],
    ]);
    // The lone curve is filled with its gradient, its axis is revealed, and the plot makes room for the ticks.
    expect(part("Area")).toEqual([{ yAxisId: "totalTokens", name: "Tokens", type: "monotone", dataKey: "totalTokens", stroke: "#fbbf24", strokeWidth: 2, fill: "url(#grad-totalTokens)", fillOpacity: 1 }]);
    expect(part("YAxis").map((a) => [a.yAxisId, a.hide])).toEqual([["requests", true], ["totalTokens", false], ["errors", true], ["avgLatencyMs", true]]);
    expect(part("AreaChart")[0].margin).toEqual({ top: 4, right: 8, bottom: 0, left: 4 });
    expect(document.querySelectorAll('[id^="grad-"]')).toHaveLength(4);

    fireEvent.click(legend()[3]);
    expect(legend().map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "false", "true"]);
    expect(part("Area").map((a) => [a.dataKey, a.fill])).toEqual([["avgLatencyMs", "url(#grad-avgLatencyMs)"]]);

    fireEvent.click(legend()[3]);
    expect(legend().map((b) => [b.getAttribute("aria-pressed"), b.querySelector("span")!.style.opacity])).toEqual(SERIES.map(() => ["false", "1"]));
    expect(part("Area").map((a) => [a.dataKey, a.fill, a.fillOpacity])).toEqual(SERIES.map((s) => [s.key, "none", 0]));
    expect(part("AreaChart")[0].margin).toEqual({ top: 4, right: 8, bottom: 0, left: -12 });
  });

  it("with no points it keeps the legend and shows an empty state instead of the chart", async () => {
    await setup({ "GET /stats/timeseries": { points: [] } });
    expect(legend()).toHaveLength(4);
    expect(part("AreaChart")).toEqual([]);
    const title = screen.getByText("No requests logged yet");
    expect(classes(title.parentElement!.querySelector("i"))).toEqual(cls("bi bi-bar-chart-line text-4xl text-ink-600"));
    expect(screen.getByText("Send a request through one of your Model Service endpoints to see traffic here.")).toBeTruthy();
  });

  it("lists the first six of each group with a bar scaled to the largest of all of them", async () => {
    const { container } = await setup();
    const grid = container.querySelector(".space-y-6")!.lastElementChild!;
    expect(classes(grid)).toEqual(cls("grid gap-4 md:grid-cols-3"));
    expect([...grid.children].map((c) => [text(c.querySelector("h3")), c.querySelector("h3 i")!.className.split(" ").sort().join(" ")])).toEqual([
      ["Top Model Services", "bi bi-diagram-3 text-brand-400"], ["Top models", "bi bi-box text-brand-400"], ["Top providers", "bi bi-hdd-network text-brand-400"],
    ]);
    const [services, models, providers] = [...grid.children];
    expect(classes(services)).toEqual(cls("card card-pad"));
    expect(classes(services.querySelector("h3"))).toEqual(cls(`mb-3 ${CARD_HEADING}`));
    const list = services.querySelector("ul")!;
    expect(classes(list)).toEqual(["space-y-2.5"]);
    // "g" is the largest but seventh, so it is not listed and no listed bar is full.
    expect([...list.children].map((li) => [text(li.children[0].children[0]), text(li.children[0].children[1]), (li.children[1].firstElementChild as HTMLElement).style.width])).toEqual([
      ["a", "50 req", "25%"], ["b", "100 req", "50%"], ["c", "25 req", "12.5%"], ["d", "10 req", "5%"], ["e", "5 req", "2.5%"], ["f", "1 req", "0.5%"],
    ]);
    const li = list.firstElementChild!;
    expect(li.className).toBe("");
    expect(classes(li.children[0])).toEqual(cls("mb-1 flex justify-between text-xs"));
    expect(classes(li.children[0].children[0])).toEqual(cls("truncate text-ink-200"));
    expect(classes(li.children[0].children[1])).toEqual(["text-ink-500"]);
    expect(classes(li.children[1])).toEqual(cls("h-1.5 overflow-hidden rounded-full bg-ink-800"));
    expect(classes(li.children[1].firstElementChild)).toEqual(cls("h-full rounded-full bg-brand-600"));

    const none = models.querySelector("p")!;
    expect([none.textContent, classes(none), models.querySelector("ul")]).toEqual(["No usage yet", cls("py-4 text-center text-xs text-ink-500"), null]);
    const idle = providers.querySelector("li")!;
    expect([text(idle.children[0]), (idle.children[1].firstElementChild as HTMLElement).style.width]).toEqual(["openai0 req", "0%"]);
  });

  it("formats large request counts in a top list", async () => {
    await setup({ "GET /stats/by-service": { groups: [group("big", 1_234_567)] } });
    expect(screen.getByText(`${formatNumber(1_234_567)} req`)).toBeTruthy();
    expect((screen.getByText("big").parentElement!.nextElementSibling!.firstElementChild as HTMLElement).style.width).toBe("100%");
  });
});
