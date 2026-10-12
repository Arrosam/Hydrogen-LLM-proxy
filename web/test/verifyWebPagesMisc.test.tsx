/**
 * Independent verification, spec section WEB-B: WB3 (clipboard fallback), WB6
 * (relativeTime), WB9 (model list search), WB11 (sign-out / log detail / clear
 * all), WB12 (Active Requests), WB14 (Proxies and Model Bench page shell) and
 * WB15 (numeric Select, HTTP info block). Expected values come from the spec
 * and the i18n tables only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { copyToClipboard } from "../src/lib/clipboard";
import { relativeTime } from "../src/lib/format";
import { I18nProvider } from "../src/lib/i18n";
import { ModelList } from "../src/components/ModelList";
import { Select } from "../src/components/inputs";
import { HttpInfoBlock } from "../src/components/HttpInfoBlock";
import { Layout } from "../src/components/Layout";
import { ActiveRequests } from "../src/pages/ActiveRequests";
import { Proxies } from "../src/pages/Proxies";
import type { Proxy } from "../src/types";
import { ADMIN, button, deferred, fail, hasButton, mockApi, modal, openModal, renderPage, toastShown, toasts, type, type Handler, type Routes as ApiRoutes } from "./helpers";
import { R1, R2, ROWS, logsPath, setup as logsSetup } from "./logs-harness";
import { TARGETS, setup as benchSetup } from "./modelbench-harness";

const NOW = new Date(2026, 5, 1, 12, 0, 0).getTime();
const rejections: unknown[] = [];
const onRejection = (reason: unknown) => { rejections.push(reason); };

beforeEach(() => {
  // Only the interval clock and Date are faked, and neither advances by itself.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  rejections.length = 0;
  process.on("unhandledRejection", onRejection);
});
afterEach(() => {
  process.off("unhandledRejection", onRejection);
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const errorNote = (within: ParentNode = document.body) => within.querySelector(".border-red-900\\/50.px-4");
const spinner = () => document.querySelector(".animate-spin");
const text = (el: Element | null | undefined): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
/** Advance the interval clock, then let every request that can settle do so. */
const tick = (ms = 0) => act(async () => {
  vi.advanceTimersByTime(ms);
  await new Promise((r) => setTimeout(r, 0));
});
/** Several macrotasks, so that a promise nobody handles is reported before the assertion. */
const drain = async () => { for (let i = 0; i < 4; i++) await tick(); };
const offline = () => { throw new TypeError("Failed to fetch"); };

// ---------------------------------------------------------------------------
// WB3
// ---------------------------------------------------------------------------

describe("WB3: clipboard fallback", () => {
  const doc = document as unknown as { execCommand?: unknown };
  const noClipboard = () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  };
  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
    Reflect.deleteProperty(window, "isSecureContext");
    delete doc.execCommand;
    document.body.innerHTML = "";
  });

  it.each([
    ["an Error", () => { throw new Error("copy blocked"); }],
    ["a DOMException", () => { throw new DOMException("not allowed", "NotAllowedError"); }],
    ["a non-Error value", () => { throw "nope"; }],
  ])("execCommand throwing %s: the copy reports failure and no textarea is left in the document", async (_name, thrower) => {
    noClipboard();
    let seen = 0;
    doc.execCommand = vi.fn(() => {
      seen = document.querySelectorAll("textarea").length;
      return thrower();
    });
    await expect(copyToClipboard("secret")).resolves.toBe(false);
    expect(doc.execCommand).toHaveBeenCalledTimes(1);
    // The fallback did go through a temporary textarea...
    expect(seen).toBe(1);
    // ...and removed it although the command threw.
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });

  it("the same when the async clipboard exists but rejects and execCommand then throws", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => { throw new Error("denied"); }) }, configurable: true });
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    doc.execCommand = vi.fn(() => { throw new Error("copy blocked"); });
    await expect(copyToClipboard("secret")).resolves.toBe(false);
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });

  it("a textarea of the page itself is left alone when the fallback throws", async () => {
    noClipboard();
    const own = document.createElement("textarea");
    own.value = "mine";
    document.body.appendChild(own);
    doc.execCommand = vi.fn(() => { throw new Error("copy blocked"); });
    await expect(copyToClipboard("secret")).resolves.toBe(false);
    expect([...document.querySelectorAll("textarea")]).toEqual([own]);
    expect(own.value).toBe("mine");
  });

  it.each([[true], [false]])("execCommand returning %s is reported as such and leaves no textarea either (unchanged)", async (ok) => {
    noClipboard();
    let copied = "";
    doc.execCommand = vi.fn(() => {
      copied = document.querySelector("textarea")?.value ?? "";
      return ok;
    });
    await expect(copyToClipboard("secret")).resolves.toBe(ok);
    expect(copied).toBe("secret");
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// WB6
// ---------------------------------------------------------------------------

describe("WB6: relativeTime of a future timestamp", () => {
  const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;

  it.each([
    ["1 ms", 1], ["499 ms", 499], ["500 ms", 500], ["1 s", S], ["59 s", 59 * S], ["1 min", M], ["90 s", 90 * S],
    ["1 h", H], ["1 day", D], ["400 days", 400 * D],
  ])("%s ahead reads '0s ago'", (_name, ahead) => {
    const out = relativeTime(NOW + ahead);
    expect(out).not.toContain("-");
    expect(out).toBe("0s ago");
  });

  it.each([
    [0, "0s ago"], [S, "1s ago"], [59 * S, "59s ago"], [5 * M, "5m ago"], [2 * H, "2h ago"], [3 * D, "3d ago"],
  ])("%i ms in the past still reads %s (unchanged)", (age, expected) => {
    expect(relativeTime(NOW - age)).toBe(expected);
  });

  it.each([[null], [undefined], [0]])("the empty value %s is still a dash (unchanged)", (v) => {
    expect(relativeTime(v)).toBe("-");
  });
});

// ---------------------------------------------------------------------------
// WB9
// ---------------------------------------------------------------------------

describe("WB9: model list search with no match", () => {
  const MODELS = ["gpt-4o", "gpt-4o-mini", "Claude-Sonnet", "o3"];
  const list = async (ui: React.ReactElement, routes: ApiRoutes = {}) => {
    mockApi(routes);
    const view = render(<I18nProvider>{ui}</I18nProvider>);
    await act(async () => {});
    return view;
  };
  const rows = (c: ParentNode) => [...c.querySelectorAll("li")].map((li) => li.textContent);

  it.each([["GPT-9 Turbo"], ["ZzZ"], ["ÀÉÎ"], ["MiXeD-cAsE-123"], ["Inner  Space X"]])("typing %j into the search box quotes it exactly as typed", async (query) => {
    const { container } = await list(<ModelList models={MODELS} emptyText="none" />);
    type(container.querySelector("input")!, query);
    expect(rows(container)).toEqual([]);
    expect(container.textContent).toContain(`No model matches "${query}".`);
    if (query.toLowerCase() !== query) expect(container.textContent).not.toContain(`"${query.toLowerCase()}"`);
  });

  // The spec fixes the case of the quoted query; whether surrounding blanks are
  // quoted too is not stated, so only the case is asserted for a padded query.
  it("a query typed with surrounding blanks keeps its case in the quote", async () => {
    const { container } = await list(<ModelList models={MODELS} emptyText="none" />);
    type(container.querySelector("input")!, "  Padded Query ");
    expect(rows(container)).toEqual([]);
    expect(container.textContent).toMatch(/No model matches "\s*Padded Query\s*"\./);
  });

  it("a controlled filter is quoted exactly as given", async () => {
    const { container } = await list(<ModelList models={MODELS} filter="NoSuchModel-XL" emptyText="none" />);
    expect(container.textContent).toContain('No model matches "NoSuchModel-XL".');
    expect(container.textContent).not.toContain("nosuchmodel-xl");
  });

  it("the Chinese message keeps the query's case as well", async () => {
    const { container } = await list(<ModelList models={MODELS} filter="NoSuchModel-XL" emptyText="none" />, { "GET /settings/ui-language": { language: "zh" } });
    await waitFor(() => expect(container.textContent).toContain("没有匹配「NoSuchModel-XL」的模型。"));
  });

  it("matching itself is still case-insensitive (unchanged)", async () => {
    const { container } = await list(<ModelList models={MODELS} emptyText="none" />);
    type(container.querySelector("input")!, "MINI");
    expect(rows(container)).toEqual(["gpt-4o-mini"]);
    type(container.querySelector("input")!, "claude");
    expect(rows(container)).toEqual(["Claude-Sonnet"]);
    expect(container.textContent).not.toContain("No model matches");
  });
});

// ---------------------------------------------------------------------------
// WB11
// ---------------------------------------------------------------------------

describe("WB11(a): a failed sign-out", () => {
  const shell = async (logout: Handler, routes: ApiRoutes = {}) => {
    const api = mockApi({ "POST /logout": logout, ...routes }, ADMIN);
    await renderPage(
      <Routes>
        <Route element={<Layout />}>
          <Route path="*" element={<p>page body</p>} />
        </Route>
      </Routes>,
      "/providers",
    );
    await tick();
    return api;
  };

  it.each<[string, Handler]>([
    ["the server answers 500", fail(500, { error: "session store down" })],
    ["the network fails", offline],
    ["the request rejects with a non-Error", () => Promise.reject("boom")],
  ])("when %s: an error toast, and no unhandled rejection", async (_name, handler) => {
    const api = await shell(handler);
    fireEvent.click(button("Sign out"));
    await waitFor(() => expect(toasts().length).toBeGreaterThan(0));
    await drain();
    expect(api.sent("POST", "/logout")).toHaveLength(1);
    expect(toasts().every((t) => t.trim().length > 0)).toBe(true);
    // It is an error toast (the red warning glyph), not a success or info one.
    expect(document.querySelector(".pointer-events-auto i")!.className).toContain("text-red-400");
    expect(rejections).toEqual([]);
  });

  it("the fallback text is the translated 'Sign out failed'", async () => {
    await shell(() => Promise.reject("boom"));
    fireEvent.click(button("Sign out"));
    await toastShown("Sign out failed");
    await drain();
    expect(rejections).toEqual([]);
    cleanup();
    vi.unstubAllGlobals();

    await shell(() => Promise.reject("boom"), { "GET /settings/ui-language": { language: "zh" } });
    await waitFor(() => expect(hasButton("退出登录")).toBe(true));
    fireEvent.click(button("退出登录"));
    await toastShown("退出登录失败");
  });

  it("a successful sign-out shows no toast (unchanged)", async () => {
    const api = await shell({ ok: true });
    fireEvent.click(button("Sign out"));
    await waitFor(() => expect(screen.getByTestId("auth-probe").textContent).toBe("anonymous"));
    await drain();
    expect(api.sent("POST", "/logout")).toHaveLength(1);
    expect(toasts()).toEqual([]);
    expect(rejections).toEqual([]);
  });
});

describe("WB11(b): a failed log-detail load", () => {
  it.each<[string, Handler, string | null]>([
    ["the server's message", fail(500, { error: "detail gone" }), "detail gone"],
    ["a 404", fail(404, { error: "log not found" }), "log not found"],
    ["a network failure", offline, null],
    ["'Failed to load detail' for a failure that is not an Error", () => Promise.reject("boom"), "Failed to load detail"],
  ])("shows %s as an error on the page, opens no detail and leaves no unhandled rejection", async (_name, handler, message) => {
    const s = await logsSetup({ rows: [R1, R2], total: 2 }, { "GET /logs/1": handler });
    fireEvent.click(s.pageRow(0));
    await waitFor(() => expect(errorNote()).not.toBeNull());
    await drain();
    expect(text(errorNote()).length).toBeGreaterThan(0);
    if (message) expect(text(errorNote())).toBe(message);
    expect(s.api.sent("GET", "/logs/1")).toHaveLength(1);
    expect(modal("Request #1")).toBeNull();
    // The list is still there.
    expect(s.table()).not.toBeNull();
    expect(rejections).toEqual([]);
  });

  it("a detail that loads opens the modal and shows no error (unchanged)", async () => {
    const detail = {
      ...R1, attemptPath: [], requestPayload: null, upstreamRequestPayload: null, responsePayload: null, requestMethod: null, requestPath: null,
      requestQuery: null, requestHeaders: null, responseHeaders: null, traceId: null, servedModel: null, servedProvider: null,
    };
    const s = await logsSetup({ rows: [R1, R2], total: 2 }, { "GET /logs/1": { log: detail } });
    fireEvent.click(s.pageRow(0));
    await waitFor(() => expect(modal("Request #1")).not.toBeNull());
    expect(errorNote()).toBeNull();
  });
});

describe("WB11(c): 'Clear all' from a later page", () => {
  const TITLE = "Delete all logs";
  const clear = () => {
    fireEvent.click(button("Clear all"));
    fireEvent.click(button("Confirm", openModal(TITLE)));
  };

  it.each([
    ["page 2", 1, 120],
    ["page 3", 2, 120],
  ])("pressed on %s: exactly one list request afterwards, for offset 0", async (_name, nexts, total) => {
    let page: unknown = { rows: ROWS, total };
    const s = await logsSetup(() => page, { "DELETE /logs": () => { page = { rows: [], total: 0 }; return { deleted: total }; } });
    for (let i = 0; i < nexts; i++) {
      fireEvent.click(button("Next"));
      await tick();
    }
    const before = s.listed().length;
    expect(s.listed().at(-1)).toBe(logsPath({ offset: 50 * nexts }));
    clear();
    await toastShown(`Deleted ${total} log entries`);
    await drain();
    expect(s.api.sent("DELETE", "/logs")).toHaveLength(1);
    expect(s.listed().slice(before)).toEqual([logsPath({ offset: 0 })]);
  });

  it("the same when the list is still non-empty after the delete", async () => {
    const s = await logsSetup({ rows: ROWS, total: 120 }, { "DELETE /logs": { deleted: 120 } });
    fireEvent.click(button("Next"));
    await tick();
    const before = s.listed().length;
    clear();
    await toastShown("Deleted 120 log entries");
    await drain();
    expect(s.listed().slice(before)).toEqual([logsPath({ offset: 0 })]);
    expect(button("Prev").disabled).toBe(true);
  });

  it("the filters in force are kept on that one request", async () => {
    const s = await logsSetup({ rows: ROWS, total: 120 }, { "DELETE /logs": { deleted: 120 } });
    fireEvent.click(s.errorsOnly());
    await tick();
    fireEvent.click(button("Next"));
    await tick();
    const before = s.listed().length;
    expect(s.listed().at(-1)).toBe(logsPath({ offset: 50, errorsOnly: true }));
    clear();
    await toastShown("Deleted 120 log entries");
    await drain();
    expect(s.listed().slice(before)).toEqual([logsPath({ offset: 0, errorsOnly: true })]);
  });

  it("pressed on the first page: one list request for offset 0 (unchanged)", async () => {
    const s = await logsSetup({ rows: ROWS, total: 120 }, { "DELETE /logs": { deleted: 120 } });
    const before = s.listed().length;
    clear();
    await toastShown("Deleted 120 log entries");
    await drain();
    expect(s.listed().slice(before)).toEqual([logsPath({ offset: 0 })]);
  });
});

// ---------------------------------------------------------------------------
// WB12
// ---------------------------------------------------------------------------

describe("WB12: Active Requests", () => {
  const STARTED = Date.UTC(2026, 5, 1, 10, 20, 30, 0);
  const LIST = "/active-requests";
  const request = (traceId: string, extra: Record<string, unknown> = {}) => ({
    traceId, tokenId: 1, serviceId: 10, serviceName: "svc-a", ingress: "openai", streaming: false, startedAt: STARTED, updatedAt: STARTED + 1500,
    elapsedMs: 1500, blocked: false, done: false, httpStatus: null, error: null, eventCount: 3, lastPhase: "llm", lastNode: "call:openai",
    lastMessage: "waiting for upstream", lastEventTs: STARTED + 1500, events: [], ...extra,
  });
  const listOf = (active: unknown[], completed: unknown[] = []) => ({ active, completed, blockThresholdMs: 30_000, now: NOW });
  const page = async (list: unknown, routes: ApiRoutes = {}) => {
    const api = mockApi({ [`GET ${LIST}`]: list, ...routes }, ADMIN);
    const view = await renderPage(<ActiveRequests />);
    await tick();
    const tables = () => [...view.container.querySelectorAll("table.table")] as HTMLTableElement[];
    const rows = (table = 0) => [...tables()[table].querySelectorAll("tbody tr")] as HTMLElement[];
    const showCompleted = () => view.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    return { api, tables, rows, showCompleted, ...view };
  };
  const tiles = (within: ParentNode) => Object.fromEntries([...within.querySelectorAll(".grid.grid-cols-3 > div")].map((d) => [d.children[0].textContent, d.children[1].textContent]));
  const hasNullText = (within: Element) => [...within.querySelectorAll("*")].some((el) => el.childElementCount === 0 && /^\s*(null|undefined)\s*$/.test(el.textContent ?? "x"));

  describe("(a) a request with no status", () => {
    const DONE = request("tr-done", { done: true, httpStatus: null, lastPhase: "done" });

    it("its detail shows '-' for the status, never 'null'", async () => {
      const { rows, showCompleted, container } = await page(listOf([], [DONE]), { [`GET ${LIST}/tr-done`]: { request: DONE, blockThresholdMs: 30_000 } });
      fireEvent.click(showCompleted());
      expect(hasNullText(container)).toBe(false);
      fireEvent.click(rows()[0]);
      const m = await waitFor(() => openModal("Trace tr-done"));
      expect(tiles(m).Status).toBe("-");
      expect(hasNullText(m)).toBe(false);
      expect(m.textContent).not.toMatch(/\bnull\b/);
    });

    it("the list never prints 'null' for it either", async () => {
      const { rows, showCompleted } = await page(listOf([], [DONE, request("tr-undef", { done: true, httpStatus: undefined })]));
      fireEvent.click(showCompleted());
      for (const tr of rows()) {
        expect(tr.textContent).not.toMatch(/\bnull\b|\bundefined\b/);
        expect(text(tr.querySelector("td:nth-child(7)")).length).toBeGreaterThan(0);
      }
    });

    it("a request with a status still shows it, and an in-flight one still reads 'in-flight' (unchanged)", async () => {
      const ok = request("tr-ok", { done: true, httpStatus: 200 });
      const live = request("tr-live");
      const { rows, showCompleted } = await page(listOf([live], [ok]), {
        [`GET ${LIST}/tr-ok`]: { request: ok, blockThresholdMs: 30_000 }, [`GET ${LIST}/tr-live`]: { request: live, blockThresholdMs: 30_000 },
      });
      fireEvent.click(showCompleted());
      fireEvent.click(rows(1)[0]);
      const done = await waitFor(() => openModal("Trace tr-ok"));
      expect(tiles(done).Status).toBe("200");
      fireEvent.click(done.querySelector("button i.bi-x-lg")!.closest("button")!);
      fireEvent.click(rows(0)[0]);
      const m = await waitFor(() => openModal("Trace tr-live"));
      expect(tiles(m).Status).toBe("in-flight");
    });
  });

  describe("(b) the detail URL", () => {
    it.each([
      ["a slash", "a/b"],
      ["a question mark", "a?b=1"],
      ["a hash", "a#b"],
      ["all three", "x/y?z=1#frag"],
      ["a percent sign and a space", "50% done"],
    ])("a trace id containing %s is percent-encoded", async (_name, traceId) => {
      const detail = request(traceId, { events: [] });
      const encoded = `${LIST}/${encodeURIComponent(traceId)}`;
      const { api, rows } = await page(listOf([detail]), { [`GET ${encoded}`]: { request: detail, blockThresholdMs: 30_000 } });
      fireEvent.click(rows()[0]);
      await tick();
      const asked = api.calls.filter((c) => c.path.startsWith(`${LIST}/`)).map((c) => c.path);
      expect(asked).toEqual([encoded]);
      await waitFor(() => expect(document.querySelector("h2")).not.toBeNull());
      expect(errorNote()).toBeNull();
    });

    it("a plain trace id is requested as it is (unchanged)", async () => {
      const detail = request("tr-1_abc.DEF~9");
      const { api, rows } = await page(listOf([detail]), { [`GET ${LIST}/tr-1_abc.DEF~9`]: { request: detail, blockThresholdMs: 30_000 } });
      fireEvent.click(rows()[0]);
      await tick();
      expect(api.calls.filter((c) => c.path.startsWith(`${LIST}/`)).map((c) => c.path)).toEqual([`${LIST}/tr-1_abc.DEF~9`]);
    });
  });

  describe("(c) the status text after a failed first load", () => {
    it.each<[string, Handler]>([
      ["the server answers 500", fail(500, { error: "db down" })],
      ["the network fails", offline],
    ])("when %s it no longer says 'loading...'", async (_name, handler) => {
      const { container } = await page(handler);
      await waitFor(() => expect(errorNote()).not.toBeNull());
      expect(container.textContent).not.toContain("loading...");
      expect(screen.queryByText("loading...")).toBeNull();
      expect(document.querySelector(".py-16 .animate-spin")).toBeNull();
    });

    it("it still says 'loading...' while the first load is pending, and the counts once it answers (unchanged)", async () => {
      const gate = deferred<unknown>();
      const { container } = await page(() => gate.promise);
      expect(container.textContent).toContain("loading...");
      await act(async () => { gate.resolve(listOf([request("tr-1")], [])); });
      await tick();
      expect(container.textContent).not.toContain("loading...");
      expect(container.textContent).toContain("1 active, 0 completed");
    });
  });
});

// ---------------------------------------------------------------------------
// WB14
// ---------------------------------------------------------------------------

describe("WB14: Proxies and Model Bench page shell", () => {
  const LOCAL: Proxy = { id: 3, name: "local", scheme: "http", host: "127.0.0.1", port: 7890, username: "u1", hasPassword: true, enabled: true, createdAt: 1 };
  const SPARE: Proxy = { id: 4, name: "spare", scheme: "https", host: "px.example", port: 443, username: null, hasPassword: false, enabled: false, createdAt: 2 };
  const proxies = async (list: Handler) => {
    const api = mockApi({ "GET /proxies": list }, ADMIN);
    const view = await renderPage(<Proxies />);
    return { api, ...view };
  };
  const ICON = "bi-shuffle";
  /** The icon class the sidebar gives the Proxies entry. */
  const navIcon = async (): Promise<string[]> => {
    mockApi({}, ADMIN);
    await renderPage(
      <Routes>
        <Route element={<Layout />}>
          <Route path="*" element={<p>page body</p>} />
        </Route>
      </Routes>,
    );
    await tick();
    const link = [...document.querySelectorAll<HTMLAnchorElement>("nav a")].find((a) => a.getAttribute("href") === "/proxies")!;
    const glyphs = [...link.querySelector("i")!.classList].filter((c) => c.startsWith("bi-"));
    cleanup();
    vi.unstubAllGlobals();
    return glyphs;
  };

  it("the Proxies nav item uses bi-shuffle", async () => {
    expect(await navIcon()).toEqual([ICON]);
  });

  it("the page header uses the nav item's icon", async () => {
    const [glyph] = await navIcon();
    const { container } = await proxies({ proxies: [LOCAL, SPARE] });
    await screen.findByText("local");
    const h1 = container.querySelector("h1")!;
    expect(h1.textContent).toBe("Proxies");
    expect([...h1.querySelector("i")!.classList]).toContain(glyph);
    expect(glyph).toBe(ICON);
  });

  it("each proxy card uses the nav item's icon, and no other 'network' glyph stands in for it", async () => {
    await proxies({ proxies: [LOCAL, SPARE] });
    await screen.findByText("local");
    for (const name of ["local", "spare"]) {
      const card = screen.getByText(name).closest(".card") as HTMLElement;
      expect(card.querySelector(`i.${ICON}`), name).not.toBeNull();
      // The card's leading icon (the first one in the card) is that glyph.
      expect([...card.querySelector("i")!.classList], name).toContain(ICON);
    }
  });

  it("the empty state uses the nav item's icon", async () => {
    await proxies({ proxies: [] });
    const title = await screen.findByText("No proxies yet");
    expect([...title.parentElement!.querySelector("i")!.classList]).toContain(ICON);
  });

  it("Proxies shows its h1 while loading", async () => {
    const gate = deferred<unknown>();
    const { container } = await proxies(() => gate.promise);
    expect(spinner()).not.toBeNull();
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelector("h1")!.textContent).toBe("Proxies");
    expect([...container.querySelector("h1 i")!.classList]).toContain(ICON);
    await act(async () => { gate.resolve({ proxies: [LOCAL] }); });
    await screen.findByText("local");
    expect(container.querySelector("h1")!.textContent).toBe("Proxies");
  });

  it.each<[string, Handler]>([
    ["the server answers 500", fail(500, { error: "db down" })],
    ["the network fails", offline],
  ])("Proxies shows its h1 after a failed load (%s)", async (_name, handler) => {
    const { container } = await proxies(handler);
    await waitFor(() => expect(errorNote()).not.toBeNull());
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelector("h1")!.textContent).toBe("Proxies");
    expect(spinner()).toBeNull();
  });

  it("Model Bench shows its h1 while loading", async () => {
    vi.useRealTimers();
    const gate = deferred<unknown>();
    const { container } = await benchSetup({ "GET /bench/targets": () => gate.promise });
    expect(spinner()).not.toBeNull();
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelector("h1")!.textContent).toBe("Model Bench");
    await act(async () => { gate.resolve(TARGETS); });
    await waitFor(() => expect(container.querySelector(".card")).not.toBeNull());
    expect(container.querySelector("h1")!.textContent).toBe("Model Bench");
  });

  it.each<[string, Handler]>([
    ["the server answers 500", fail(500, { error: "db down" })],
    ["the network fails", offline],
  ])("Model Bench shows its h1 after a failed load (%s)", async (_name, handler) => {
    vi.useRealTimers();
    const { container } = await benchSetup({ "GET /bench/targets": handler });
    await waitFor(() => expect(errorNote()).not.toBeNull());
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelector("h1")!.textContent).toBe("Model Bench");
    expect(spinner()).toBeNull();
  });

  it("the headers are translated while loading too", async () => {
    const gate = deferred<unknown>();
    const api = mockApi({ "GET /proxies": () => gate.promise, "GET /settings/ui-language": { language: "zh" } }, ADMIN);
    const { container } = await renderPage(<Proxies />);
    await waitFor(() => expect(container.querySelector("h1")!.textContent).toBe("代理"));
    expect(api.sent("GET", "/proxies")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// WB15
// ---------------------------------------------------------------------------

describe("WB15: numeric Select with a placeholder", () => {
  const OPTIONS = [{ value: 0, label: "Zero" }, { value: 7, label: "Seven" }];
  const pick = (el: HTMLSelectElement, label: string) => {
    const option = [...el.options].find((o) => o.textContent === label)!;
    fireEvent.change(el, { target: { value: option.value } });
  };

  it("choosing the placeholder reports the empty value, not 0", () => {
    const onChange = vi.fn();
    const { container } = render(<Select<number> value={7} onChange={onChange} options={OPTIONS} placeholder="Direct connection" />);
    pick(container.querySelector("select")!, "Direct connection");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).not.toBe(0);
    expect(onChange.mock.calls[0][0]).toBe("");
  });

  it("choosing the real option whose id is 0 reports the number 0", () => {
    const onChange = vi.fn();
    const { container } = render(<Select<number> value="" onChange={onChange} options={OPTIONS} placeholder="Direct connection" />);
    pick(container.querySelector("select")!, "Zero");
    expect(onChange.mock.calls).toEqual([[0]]);
    expect(onChange.mock.calls[0][0]).toBe(0);
  });

  it("the placeholder and the 0 option are told apart on display too", () => {
    const selectedLabel = (el: HTMLSelectElement) => el.options[el.selectedIndex].textContent;
    const empty = render(<Select<number> value="" onChange={() => {}} options={OPTIONS} placeholder="Direct connection" />);
    expect(selectedLabel(empty.container.querySelector("select")!)).toBe("Direct connection");
    empty.unmount();
    const zero = render(<Select<number> value={0} onChange={() => {}} options={OPTIONS} placeholder="Direct connection" />);
    expect(selectedLabel(zero.container.querySelector("select")!)).toBe("Zero");
  });

  it("other numeric options are still reported as numbers, and a string list as strings (unchanged)", () => {
    const onNumber = vi.fn();
    const numeric = render(<Select<number> value="" onChange={onNumber} options={OPTIONS} placeholder="Direct connection" />);
    pick(numeric.container.querySelector("select")!, "Seven");
    expect(onNumber.mock.calls).toEqual([[7]]);
    numeric.unmount();
    const onString = vi.fn();
    const strings = render(<Select<string> value="a" onChange={onString} options={[{ value: "a", label: "Alpha" }, { value: "0", label: "Nought" }]} />);
    pick(strings.container.querySelector("select")!, "Nought");
    expect(onString.mock.calls).toEqual([["0"]]);
  });

  it("a numeric list without a placeholder reports 0 for its 0 option", () => {
    const onChange = vi.fn();
    const { container } = render(<Select<number> value={7} onChange={onChange} options={OPTIONS} />);
    pick(container.querySelector("select")!, "Zero");
    expect(onChange.mock.calls).toEqual([[0]]);
  });
});

describe("WB15: HTTP info block", () => {
  const view = (props: Partial<Parameters<typeof HttpInfoBlock>[0]>) => {
    mockApi();
    return render(<I18nProvider><HttpInfoBlock title="Client request" emptyLabel="Not recorded" {...props} /></I18nProvider>);
  };
  const body = (container: HTMLElement) => container.firstElementChild!.children[1];

  it.each([
    ["only a query string", { query: "beta=1" }],
    ["a query string with every other part empty", { query: "beta=1", method: null, path: null, headers: {}, status: 0 }],
    ["a query string and an empty path", { query: "beta=1", path: "" }],
  ])("given %s it shows the 'Not recorded' text, not an empty box", (_name, props) => {
    const { container } = view(props);
    expect(container.textContent).toContain("Not recorded");
    expect(text(body(container))).toBe("Not recorded");
  });

  it("given nothing at all it shows the 'Not recorded' text (unchanged)", () => {
    const { container } = view({});
    expect(text(body(container))).toBe("Not recorded");
  });

  it.each([
    ["a path and a query", { path: "/v1/messages", query: "beta=1" }, "/v1/messages?beta=1"],
    ["a method and a path", { method: "POST", path: "/v1/messages" }, "POST/v1/messages"],
    ["a status", { status: 200 }, "200"],
  ])("given %s it draws the line and no 'Not recorded' (unchanged)", (_name, props, shown) => {
    const { container } = view(props);
    expect(container.textContent).not.toContain("Not recorded");
    expect(text(body(container)).replace(/\s+/g, "")).toBe(shown);
  });

  it("given headers only it lists them and no 'Not recorded' (unchanged)", () => {
    const { container } = view({ headers: { accept: "*/*" } });
    expect(container.textContent).not.toContain("Not recorded");
    expect([...container.querySelectorAll("tr")].map((tr) => text(tr))).toEqual(["accept*/*"]);
  });
});
