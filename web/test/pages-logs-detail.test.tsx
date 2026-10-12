/**
 * Characterization of the Logs detail modal: meta tiles, the HTTP blocks, both
 * attempt tables (the flat path table and the one inside a Micro Agent call),
 * the call list and the payload viewers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { formatNumber } from "../src/lib/format";
import type { LogSummary } from "../src/types";
import { button, cells, classes, cls, iconButton, modal, openModal, type Routes } from "./helpers";
import { ERROR_NOTE, MUTED_BOX, NOT_RECORDED, NOW, R1, R2, ROW_CHEVRON, errorNote, row, sentBare, setup, text, tick } from "./logs-harness";

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

describe("Logs page: detail", () => {
  type Detail = LogSummary & Record<string, unknown>;
  const detail = (extra: Record<string, unknown> = {}, id = 1): Detail => ({
    ...row(id), attemptPath: [], requestPayload: null, upstreamRequestPayload: null, responsePayload: null, requestMethod: null, requestPath: null,
    requestQuery: null, requestHeaders: null, responseHeaders: null, traceId: null, servedModel: null, servedProvider: null, ...extra,
  });
  const TITLE = "Request #1";
  /** Load the list, click the first row and return the open detail modal. */
  const open = async (d: Detail, routes: Routes = {}) => {
    const s = await setup({ rows: [R1, R2], total: 2 }, { "GET /logs/1": { log: d }, ...routes });
    fireEvent.click(s.pageRow(0));
    const m = await waitFor(() => openModal(TITLE));
    return { m, ...s };
  };
  const heading = (title: string, within: ParentNode): HTMLElement => {
    const all = [...within.querySelectorAll("h4")];
    const h = all.find((e) => text(e) === title) ?? all.find((e) => text(e).startsWith(title));
    if (!h) throw new Error(`heading(): no h4 "${title}"`);
    return h;
  };
  /** The block a heading introduces (for a payload block, the heading sits inside its toggle). */
  const section = (title: string, within: ParentNode): HTMLElement => {
    const h = heading(title, within);
    return (h.closest("button")?.parentElement ?? h.parentElement) as HTMLElement;
  };
  const tiles = (within: ParentNode) => [...within.querySelectorAll(".grid.grid-cols-3 > div")].map((d) => [d.children[0].textContent, d.children[1].textContent]);
  const closeModal = (m: HTMLElement) => fireEvent.click(iconButton("bi-x-lg", m));
  const att = (extra: Record<string, unknown> = {}) => ({ step: 1, attempt: 1, model: "sonnet", provider: "openai", status: 200, kind: "ok", latencyMs: 120, ...extra });
  const pathTable = (m: HTMLElement) => section("Attempt path", m).querySelector("table") as HTMLTableElement;
  const headers = (table: Element) => [...table.querySelectorAll("th")].map((th) => th.textContent);
  const bodyRows = (table: Element) => [...table.querySelectorAll(":scope > tbody > tr")] as HTMLElement[];
  const FAILED_ROW = "cursor-pointer hover:bg-ink-850/50";
  const BASE_COLUMNS = ["Step", "Try", "Model", "Provider", "Result", "Latency"];

  it("a row click fetches GET /logs/:id and opens a wide modal with the view switch in its title bar", async () => {
    const { api, m } = await open(detail());
    expect(api.sent("GET", "/logs/1")).toEqual([sentBare("GET", "/logs/1")]);
    expect(classes(m)).toEqual(cls("card flex max-h-[92vh] w-full flex-col max-w-4xl"));
    expect(classes(m.querySelector("h2 i"))).toEqual(cls("bi bi-journal-text text-brand-400"));
    const extra = m.querySelector("h2")!.nextElementSibling!;
    expect(classes(extra)).toEqual(cls("flex items-center gap-3"));
    expect([...extra.children].map((c) => c.tagName)).toEqual(["DIV", "BUTTON"]);
    expect(classes(m.querySelector(".card-pad > div"))).toEqual(["space-y-4"]);
    expect([...m.querySelectorAll("h4")].map((h) => text(h))).toEqual([
      "Client request (received)", "Upstream response (received)", "Attempt path",
      "Client request payload", "Upstream request payload (sent, with effective params)", "Response payload",
    ]);
    expect(errorNote(m)).toBeNull();
    closeModal(m);
    expect(modal(TITLE)).toBeNull();
  });

  it("the list keeps refreshing behind the open detail, which stays as fetched", async () => {
    const { api, listed, m } = await open(detail());
    await tick(5000);
    expect(listed()).toHaveLength(2);
    expect(api.sent("GET", "/logs/1")).toHaveLength(1);
    expect(modal(TITLE)).toBe(m);
  });

  it("summarises the request in eleven tiles", async () => {
    const { m } = await open(detail({
      cachedInputTokens: 300, cacheCreationInputTokens: 100, reasoningTokens: 50, streaming: true, traceId: "tr-1", servedModel: "gpt-4o", servedProvider: "openai",
    }));
    const n = formatNumber;
    expect(tiles(m)).toEqual([
      ["Model Service", "svc-a"], ["Status", "200"], ["Latency", "812 ms"], ["Route", "openai -> anthropic"], ["Streaming", "yes"],
      ["Input", `${n(1200)} (300 from cache · 100 written to cache)`], ["Output", "450 (50 thinking)"], ["Total tokens", n(1650)],
      ["Served model", "gpt-4o"], ["Served provider", "openai"], ["Trace", "tr-1"],
    ]);
    const grid = m.querySelector(".grid")!;
    expect(classes(grid)).toEqual(cls("grid grid-cols-3 gap-3 text-sm"));
    const tile = grid.firstElementChild!;
    expect(classes(tile)).toEqual(cls("rounded-lg bg-ink-950/50 px-3 py-2"));
    expect(classes(tile.children[0])).toEqual(cls("text-[11px] uppercase tracking-wide text-ink-500"));
    expect(classes(tile.children[1])).toEqual(cls("mt-0.5 text-ink-200"));
  });

  it.each([
    ["only a cache hit", { cachedInputTokens: 300 }, `${formatNumber(1200)} (300 from cache)`, "450"],
    ["only a cache write", { cacheCreationInputTokens: 100 }, `${formatNumber(1200)} (100 written to cache)`, "450"],
    ["neither", {}, formatNumber(1200), "450"],
  ])("with %s the input tile reads '%s'", async (_name, extra, input, output) => {
    const { m } = await open(detail(extra));
    expect(tiles(m).filter(([label]) => label === "Input" || label === "Output")).toEqual([["Input", input], ["Output", output]]);
  });

  it("falls back to dashes in the tiles, without looking the service name up", async () => {
    const { m } = await open(detail({ serviceName: null, egressFormat: null, httpStatus: 0 }));
    expect(tiles(m)).toEqual([
      ["Model Service", "-"], ["Status", "0"], ["Latency", "812 ms"], ["Route", "openai -> -"], ["Streaming", "no"], ["Input", formatNumber(1200)],
      ["Output", "450"], ["Total tokens", formatNumber(1650)], ["Served model", "-"], ["Served provider", "-"], ["Trace", "-"],
    ]);
  });

  it("shows the request's error on top", async () => {
    const { m } = await open(detail({ error: "all attempts failed", httpStatus: 502 }));
    const note = m.querySelector(".card-pad > div")!.firstElementChild!;
    expect([note.textContent, classes(note)]).toEqual(["all attempts failed", cls(ERROR_NOTE)]);
  });

  it("shows the captured HTTP request line and headers, and the response status and headers", async () => {
    const { m } = await open(detail({
      requestMethod: "POST", requestPath: "/v1/chat/completions", requestQuery: "beta=true",
      requestHeaders: { "content-type": "application/json", authorization: "[redacted]" }, responseHeaders: { "x-request-id": "abc" },
    }));
    const request = section("Client request (received)", m);
    expect(classes(heading("Client request (received)", m))).toEqual(["label"]);
    const box = request.children[1];
    expect(classes(box)).toEqual(cls("overflow-hidden rounded-lg border border-ink-800 bg-ink-950/40"));
    const line = box.children[0];
    expect(classes(line)).toEqual(cls("flex items-center gap-2 border-b border-ink-800/70 px-3 py-1.5 font-mono text-xs"));
    expect([...line.children].map((c) => [c.textContent, classes(c)])).toEqual([["POST", ["text-brand-400"]], ["/v1/chat/completions?beta=true", ["text-ink-200"]]]);
    const table = box.querySelector("table")!;
    expect(classes(table)).toEqual(cls("w-full text-xs"));
    expect([...table.querySelectorAll("tr")].map((tr) => cells(tr))).toEqual([["content-type", "application/json"], ["authorization", "[redacted]"]]);
    expect(classes(table.querySelector("tr"))).toEqual(cls("border-b border-ink-800/40 last:border-0"));
    const [k, v] = [...table.querySelectorAll("td")];
    expect(classes(k)).toEqual(cls("whitespace-nowrap px-3 py-1 align-top font-mono text-ink-400"));
    expect(classes(v)).toEqual(cls("break-all px-3 py-1 font-mono text-ink-300"));

    const response = section("Upstream response (received)", m).children[1];
    expect([...response.children[0].children].map((c) => [c.textContent, classes(c)])).toEqual([["200", ["badge-green"]]]);
    expect([...response.querySelectorAll("tr")].map((tr) => cells(tr))).toEqual([["x-request-id", "abc"]]);
  });

  it("says 'not recorded' for an HTTP block with nothing in it", async () => {
    const { m } = await open(detail({ httpStatus: 0, requestHeaders: {}, responseHeaders: {} }));
    for (const title of ["Client request (received)", "Upstream response (received)"]) {
      const body = section(title, m).children[1];
      expect([body.textContent, classes(body)]).toEqual([NOT_RECORDED, cls(MUTED_BOX)]);
    }
  });

  it("a path without a query has no question mark, and a status alone still draws the line", async () => {
    const { m } = await open(detail({ requestPath: "/v1/messages" }));
    expect(text(section("Client request (received)", m).children[1])).toBe("/v1/messages");
    const response = section("Upstream response (received)", m).children[1];
    expect(text(response)).toBe("200");
    expect(response.querySelector("table")).toBeNull();
  });

  // -- AttemptPathTable (a Model Service log: a flat attempt list) ----------

  it("flat path: six columns, plain rows that do not expand", async () => {
    const { m } = await open(detail({ attemptPath: [att(), att({ step: 2, attempt: 3, model: "haiku", provider: "anthropic", latencyMs: 45 })] }));
    const h4 = heading("Attempt path", m);
    expect([text(h4), classes(h4), h4.querySelector("span")]).toEqual(["Attempt path", ["label"], null]);
    const table = pathTable(m);
    expect(classes(table)).toEqual(["table"]);
    expect(classes(table.parentElement)).toEqual(cls("card overflow-hidden"));
    expect([...table.querySelectorAll("th")].map((th) => [th.textContent, th.className])).toEqual(BASE_COLUMNS.map((c) => [c, ""]));
    expect(bodyRows(table).map((tr) => cells(tr))).toEqual([["1", "1", "sonnet", "openai", "ok", "120 ms"], ["2", "3", "haiku", "anthropic", "ok", "45 ms"]]);
    expect([...bodyRows(table)[0].querySelectorAll("td")].map((td) => td.className.split(" ").sort().join(" "))).toEqual([
      "", "", "font-mono text-xs", "font-mono text-xs", "", "text-ink-400 text-xs",
    ]);
    expect(bodyRows(table).map((tr) => [tr.className, tr.querySelector("i")])).toEqual([["", null], ["", null]]);
    fireEvent.click(bodyRows(table)[0]);
    expect(bodyRows(table)).toHaveLength(2);
  });

  it.each([
    ["null", null],
    ["an object", { step: 1 }],
    ["an empty list", []],
  ])("flat path: %s draws the bare table header", async (_name, attemptPath) => {
    const { m } = await open(detail({ attemptPath }));
    expect(headers(pathTable(m))).toEqual(BASE_COLUMNS);
    expect(bodyRows(pathTable(m))).toHaveLength(0);
  });

  it.each([
    ["ok whatever the status", { kind: "ok", status: 500 }, "ok", "badge-green"],
    ["a failure by its status", { kind: "http", status: 429 }, "429", "badge-red"],
    ["a 2xx that is not ok by its status, in green", { kind: "http", status: 204 }, "204", "badge-green"],
    ["a client abort in gray", { kind: "aborted", status: 499 }, "499", "badge-gray"],
    ["a failure without a status by its kind", { kind: "timeout", status: 0 }, "timeout", "badge-red"],
  ])("flat path: the result badge shows %s", async (_name, extra, label, badge) => {
    const { m } = await open(detail({ attemptPath: [att(extra)] }));
    const el = bodyRows(pathTable(m))[0].querySelector("td:nth-child(5) span")!;
    expect([el.textContent, classes(el)]).toEqual([label, [badge]]);
  });

  it("flat path with a failure: an Error column, the chevron in the first cell, and the failure on expand", async () => {
    const body = { error: { message: "slow down" } };
    const { m } = await open(detail({
      attemptPath: [
        att({ status: 429, kind: "rate_limit", latencyMs: 30, error: "upstream returned 429", upstreamError: "slow down", errorBody: JSON.stringify(body) }),
        att({ attempt: 2 }),
      ],
    }));
    const table = pathTable(m);
    expect(headers(table)).toEqual([...BASE_COLUMNS, "Error"]);
    const [failed, fine] = bodyRows(table);
    // The provider's words win over the proxy's in the one-line summary.
    expect(cells(failed)).toEqual(["1", "1", "sonnet", "openai", "429", "30 ms", "slow down"]);
    expect(cells(fine)).toEqual(["1", "2", "sonnet", "openai", "ok", "120 ms", ""]);
    expect(classes(failed)).toEqual(cls(FAILED_ROW));
    expect([fine.className, fine.querySelector("i")]).toEqual(["", null]);
    const first = failed.querySelector("td")!;
    expect(classes(first.querySelector("i"))).toEqual(cls(`${ROW_CHEVRON} bi-chevron-right`));
    const errorCell = failed.querySelector("td:last-child")!;
    expect(classes(errorCell)).toEqual(["max-w-md"]);
    expect(errorCell.querySelector("i")).toBeNull();
    const line = errorCell.firstElementChild as HTMLElement;
    expect([classes(line), line.title]).toEqual([cls("text-xs text-red-300"), "slow down"]);
    expect(classes(line.firstElementChild)).toEqual(cls("line-clamp-2 break-words"));
    expect(fine.querySelector("td:last-child")!.childElementCount).toBe(0);

    fireEvent.click(fine);
    expect(bodyRows(table)).toHaveLength(2);
    fireEvent.click(failed);
    expect(bodyRows(table)).toHaveLength(3);
    expect(classes(first.querySelector("i"))).toEqual(cls(`${ROW_CHEVRON} bi-chevron-down`));
    const cell = bodyRows(table)[1].querySelector("td")!;
    expect(bodyRows(table)[1].className).toBe("");
    expect([cell.colSpan, classes(cell)]).toEqual([7, cls("bg-ink-950/40 p-3")]);
    expect(classes(cell.firstElementChild)).toEqual(["space-y-3"]);
    const failure = cell.firstElementChild!.firstElementChild!;
    expect(classes(failure)).toEqual(["space-y-2"]);
    expect([...failure.querySelectorAll(".label")].map((l) => [l.textContent, classes(l), l.tagName])).toEqual([
      ["Provider said", cls("label m-0"), "DIV"], ["Proxy said", cls("label m-0"), "DIV"], ["Upstream error body", cls("label m-0"), "DIV"],
    ]);
    const [upstream, proxy] = [...failure.querySelectorAll("p")];
    expect([upstream.textContent, classes(upstream)]).toEqual(["slow down", cls("mt-1 whitespace-pre-wrap break-words rounded-lg border border-red-900/50 bg-red-950/30 p-2 font-mono text-xs text-red-300")]);
    expect([proxy.textContent, classes(proxy)]).toEqual(["upstream returned 429", cls("mt-1 whitespace-pre-wrap break-words rounded-lg border border-ink-800 bg-ink-950 p-2 font-mono text-xs text-ink-300")]);
    const pre = failure.querySelector("pre")!;
    expect([pre.textContent, classes(pre)]).toEqual([
      JSON.stringify(body, null, 2),
      cls("mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-ink-800 bg-ink-950 p-2 font-mono text-xs leading-relaxed text-ink-400"),
    ]);
    // No stage payloads to show, so no payload blocks.
    expect(cell.querySelector("button")).toBeNull();

    fireEvent.click(failed);
    expect(bodyRows(table)).toHaveLength(2);
    expect(classes(first.querySelector("i"))).toEqual(cls(`${ROW_CHEVRON} bi-chevron-right`));
  });

  it.each([
    ["the same message from both sides once, as the proxy's", { error: "bad request", upstreamError: "bad request" }, ["Proxy said"], "bad request"],
    ["a provider message alone", { upstreamError: "model overloaded" }, ["Provider said"], "model overloaded"],
    ["a proxy message alone", { error: "connect ECONNREFUSED" }, ["Proxy said"], "connect ECONNREFUSED"],
    ["a body alone, with an empty summary line", { errorBody: "<html>bad gateway</html>" }, ["Upstream error body"], ""],
  ])("flat path: the expanded failure shows %s", async (_name, extra, labels, line) => {
    const { m } = await open(detail({ attemptPath: [att({ status: 502, kind: "http", ...extra })] }));
    const table = pathTable(m);
    expect(cells(bodyRows(table)[0])[6]).toBe(line);
    fireEvent.click(bodyRows(table)[0]);
    const failure = bodyRows(table)[1].querySelector(".space-y-2")!;
    expect([...failure.querySelectorAll(".label")].map((l) => l.textContent)).toEqual(labels);
    // A body that is not JSON is shown as it came.
    if ("errorBody" in extra) expect(failure.querySelector("pre")!.textContent).toBe(extra.errorBody);
  });

  it("legacy agent path: Stage and Model Service columns lead, the chevron moves to the stage cell, and a stage expands into its payloads", async () => {
    const request = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const { m } = await open(detail({
      attemptPath: [att({ stage: "plan", service: "svc-a", request, response: JSON.stringify({ role: "assistant", content: "yo" }) }), att({ step: 2 })],
    }));
    const hint = heading("Attempt path", m).querySelector("span")!;
    expect([hint.textContent, classes(hint)]).toEqual(["(click a stage to see its request & response)", cls("ml-2 normal-case text-ink-500")]);
    const table = pathTable(m);
    expect(headers(table)).toEqual(["Stage", "Model Service", ...BASE_COLUMNS]);
    const [staged, bare] = bodyRows(table);
    expect(cells(staged)).toEqual(["plan", "svc-a", "1", "1", "sonnet", "openai", "ok", "120 ms"]);
    expect(cells(bare)).toEqual(["-", "-", "2", "1", "sonnet", "openai", "ok", "120 ms"]);
    const [stage, svc, step] = [...staged.querySelectorAll("td")];
    expect(classes(stage)).toEqual(cls("font-mono text-xs text-brand-400"));
    expect(classes(svc)).toEqual(cls("font-mono text-xs text-ink-300"));
    expect(classes(stage.querySelector("i"))).toEqual(cls(`${ROW_CHEVRON} bi-chevron-right`));
    expect(step.querySelector("i")).toBeNull();
    expect([classes(staged), bare.className, bare.querySelector("i")]).toEqual([cls(FAILED_ROW), "", null]);

    fireEvent.click(staged);
    const cell = bodyRows(table)[1].querySelector("td")!;
    expect(cell.colSpan).toBe(8);
    expect(cell.querySelector(".space-y-2 .label")).toBeNull();
    expect([...cell.querySelectorAll("h4")].map((h) => h.textContent)).toEqual(['Stage "plan" request', 'Stage "plan" response']);
    expect(section('Stage "plan" request', cell).querySelector("pre")!.textContent).toBe("hi");
    expect(section('Stage "plan" response', cell).querySelector("pre")!.textContent).toBe("yo");
  });

  it("flat path with only a request: no Stage column, the chevron in the step cell, an unnamed stage and an unrecorded response", async () => {
    const { m } = await open(detail({ attemptPath: [att({ request: JSON.stringify({ a: 1 }) })] }));
    expect(heading("Attempt path", m).querySelector("span")).not.toBeNull();
    const table = pathTable(m);
    expect(headers(table)).toEqual(BASE_COLUMNS);
    const first = bodyRows(table)[0];
    expect(classes(first.querySelector("td")!.querySelector("i"))).toEqual(cls(`${ROW_CHEVRON} bi-chevron-right`));
    fireEvent.click(first);
    const cell = bodyRows(table)[1].querySelector("td")!;
    expect(cell.colSpan).toBe(6);
    expect([...cell.querySelectorAll("h4")].map((h) => h.textContent)).toEqual(['Stage "" request', 'Stage "" response']);
    expect(section('Stage "" response', cell).children[1].textContent).toBe(NOT_RECORDED);
  });

  it.each([
    ["a stage only", { stage: "plan" }, ["Stage", ...BASE_COLUMNS], null],
    ["a service only", { service: "svc-a" }, ["Model Service", ...BASE_COLUMNS], null],
    ["a stage and an error", { stage: "plan", error: "x", status: 500, kind: "http" }, ["Stage", ...BASE_COLUMNS, "Error"], 8],
    ["a stage, a service and an error", { stage: "plan", service: "svc-a", error: "x", status: 500, kind: "http" }, ["Stage", "Model Service", ...BASE_COLUMNS, "Error"], 9],
  ])("flat path with %s: columns %j", async (_name, extra, columns, span) => {
    const { m } = await open(detail({ attemptPath: [att(extra)] }));
    const table = pathTable(m);
    expect(headers(table)).toEqual(columns);
    fireEvent.click(bodyRows(table)[0]);
    expect(bodyRows(table)[1]?.querySelector("td")!.colSpan ?? null).toBe(span);
  });

  it("flat path: a failed stage with payloads expands into the failure and then the payloads; several rows can be open", async () => {
    const failing = att({ stage: "plan", error: "x", status: 500, kind: "http", request: "{}" });
    const { m } = await open(detail({ attemptPath: [failing, { ...failing, stage: "act", attempt: 2 }] }));
    const table = pathTable(m);
    fireEvent.click(bodyRows(table)[0]);
    fireEvent.click(bodyRows(table)[2]);
    expect(bodyRows(table)).toHaveLength(4);
    const box = bodyRows(table)[1].querySelector("td > div")!;
    expect([...box.children].map((c) => text(c.querySelector(".label, h4")))).toEqual(["Proxy said", 'Stage "plan" request', 'Stage "plan" response']);
    expect(text(bodyRows(table)[3].querySelector("h4"))).toBe('Stage "act" request');
  });

  it("opening a request collapses whatever was expanded in the attempt path before", async () => {
    const failing = [att({ status: 500, kind: "http", error: "x" })];
    const { m, pageRow, api } = await open(detail({ attemptPath: failing }), { "GET /logs/2": { log: detail({ attemptPath: failing }, 2) } });
    fireEvent.click(bodyRows(pathTable(m))[0]);
    expect(bodyRows(pathTable(m))).toHaveLength(2);
    closeModal(m);
    fireEvent.click(pageRow(1));
    const second = await waitFor(() => openModal("Request #2"));
    expect(bodyRows(pathTable(second))).toHaveLength(1);
    fireEvent.click(bodyRows(pathTable(second))[0]);
    closeModal(second);
    // The same request again is fetched again and also starts collapsed.
    fireEvent.click(pageRow(1));
    await waitFor(() => expect(api.sent("GET", "/logs/2")).toHaveLength(2));
    await tick();
    expect(bodyRows(pathTable(openModal("Request #2")))).toHaveLength(1);
  });

  // -- CallList / AttemptsTable (a Micro Agent log: one entry per service call) --

  const call = (extra: Record<string, unknown> = {}) => ({ stage: "plan", service: "svc-a", kind: "service", status: 200, latencyMs: 300, attempts: [], ...extra });
  const CALLS = [
    call({
      attempts: [att({ status: 500, kind: "http", error: "upstream returned 500", upstreamError: "overloaded" }), att({ attempt: 2, request: "{}", response: "{}" })],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedInputTokens: 4 }, streamed: true, request: JSON.stringify({ x: 1 }),
    }),
    call({ stage: "route", service: "ignored", kind: "router", status: 0, latencyMs: 5 }),
    call({ stage: "delegate", service: "sub-agent", kind: "agent", status: 502, error: "agent blew up", calls: [call({ stage: "inner", status: 204 })] }),
    call({ stage: "answer", attempts: [att()] }),
  ];
  const callItems = (within: ParentNode) => [...heading("Model Service calls", within).nextElementSibling!.children] as HTMLElement[];
  const ITEM_HEAD = "flex items-center gap-2 px-3 py-2";

  it("agent log: lists each service call instead of an attempt table", async () => {
    const { m } = await open(detail({ attemptPath: CALLS }));
    const h4 = heading("Model Service calls", m);
    expect(classes(h4)).toEqual(["label"]);
    expect([h4.querySelector("span")!.textContent, classes(h4.querySelector("span"))]).toEqual(["(every service this Micro Agent called, in order)", cls("ml-2 normal-case text-ink-500")]);
    expect([...m.querySelectorAll("h4")].map((h) => text(h))).not.toContain("Attempt path");
    expect(m.querySelector("table")).toBeNull();
    expect(classes(h4.nextElementSibling)).toEqual(["space-y-2"]);
    const items = callItems(m);
    expect(items).toHaveLength(4);
    expect(classes(items[0])).toEqual(cls("overflow-hidden rounded-lg border border-ink-800 bg-ink-950/40"));

    const [svc, router, agent, last] = items.map((i) => i.firstElementChild as HTMLElement);
    expect([svc, agent, last].map((h) => classes(h))).toEqual([1, 2, 3].map(() => cls(`${ITEM_HEAD} cursor-pointer hover:bg-ink-850/50`)));
    expect(classes(router)).toEqual(cls(ITEM_HEAD));
    expect([svc, router, agent, last].map((h) => classes(h.firstElementChild))).toEqual([
      cls("bi bi-chevron-right text-ink-500"), cls("bi bi-dot text-ink-500"), cls("bi bi-chevron-right text-ink-500"), cls("bi bi-chevron-right text-ink-500"),
    ]);
    expect([...svc.children].map((c) => [c.tagName, text(c)])).toEqual([
      ["I", ""], ["SPAN", "plan"], ["SPAN", "svc-a"], ["I", ""], ["DIV", ""], ["SPAN", "10 (4)5"], ["SPAN", "300 ms"], ["SPAN", "ok"],
    ]);
    expect(classes(svc.children[1])).toEqual(cls("font-mono text-xs text-brand-400"));
    expect(classes(svc.children[2])).toEqual(cls("flex items-center gap-1.5 font-mono text-xs text-ink-300"));
    expect(classes(svc.children[2].querySelector("i"))).toEqual(cls("bi bi-diagram-3 text-ink-500"));
    expect([classes(svc.children[3]), (svc.children[3] as HTMLElement).title]).toEqual([cls("bi bi-broadcast text-brand-400"), "streamed to the client"]);
    expect(classes(svc.children[4])).toEqual(["flex-1"]);
    expect(classes(svc.children[5])).toEqual(cls("whitespace-nowrap text-xs text-ink-300"));
    expect(classes(svc.children[6])).toEqual(cls("text-xs text-ink-400"));
    expect(classes(svc.children[7])).toEqual(["badge-green"]);

    // A router makes no model call: no service name, no latency, a neutral badge.
    expect([...router.children].map((c) => [c.tagName, text(c)])).toEqual([["I", ""], ["SPAN", "route"], ["SPAN", "(no model call)"], ["DIV", ""], ["SPAN", "route"]]);
    expect(classes(router.children[2].querySelector("i"))).toEqual(cls("bi bi-signpost-split text-ink-500"));
    expect(classes(router.lastElementChild)).toEqual(["badge-gray"]);
    expect([...agent.children].map((c) => text(c))).toEqual(["", "delegate", "sub-agent", "", "300 ms", "502"]);
    expect(classes(agent.children[2].querySelector("i"))).toEqual(cls("bi bi-robot text-ink-500"));
    expect(classes(agent.lastElementChild)).toEqual(["badge-red"]);

    fireEvent.click(router);
    expect(items[1].childElementCount).toBe(1);
  });

  it("agent log: a call expands into its own attempt table, where the chevron sits in the error cell and only a failure expands", async () => {
    const { m } = await open(detail({ attemptPath: CALLS }));
    const item = callItems(m)[0];
    fireEvent.click(item.firstElementChild!);
    expect(classes(item.firstElementChild!.firstElementChild)).toEqual(cls("bi bi-chevron-down text-ink-500"));
    const body = item.children[1];
    expect(classes(body)).toEqual(cls("space-y-3 border-t border-ink-800/70 bg-ink-950/40 p-3"));
    expect([...body.querySelectorAll("h4")].map((h) => [h.textContent, h.classList.contains("label")])).toEqual([["Attempt path", true], ["Request", true], ["Response", true]]);
    expect(errorNote(body)).toBeNull();

    const table = section("Attempt path", body).querySelector("table")!;
    expect(classes(table)).toEqual(["table"]);
    expect(classes(table.parentElement)).toEqual(cls("card overflow-hidden"));
    expect([...table.querySelectorAll("th")].map((th) => [th.textContent, th.className])).toEqual([...BASE_COLUMNS, "Error"].map((c) => [c, ""]));
    const [failed, fine] = bodyRows(table);
    expect(cells(failed)).toEqual(["1", "1", "sonnet", "openai", "500", "120 ms", "overloaded"]);
    expect(cells(fine)).toEqual(["1", "2", "sonnet", "openai", "ok", "120 ms", ""]);
    expect([...failed.querySelectorAll("td")].map((td) => td.className.split(" ").sort().join(" "))).toEqual([
      "", "", "font-mono text-xs", "font-mono text-xs", "", "text-ink-400 text-xs", "max-w-md",
    ]);
    expect(classes(failed)).toEqual(cls(FAILED_ROW));
    expect(failed.querySelector("td")!.querySelector("i")).toBeNull();
    const line = failed.querySelector("td:last-child")!.firstElementChild as HTMLElement;
    expect([classes(line), line.title]).toEqual([cls("flex items-start gap-1 text-xs text-red-300"), "overloaded"]);
    expect([...line.children].map((c) => [c.tagName, classes(c)])).toEqual([
      ["I", cls("bi bi-chevron-right mt-0.5 text-ink-500")], ["SPAN", cls("line-clamp-2 break-words")],
    ]);
    // Per-attempt payloads do not make a row expandable here, unlike the flat path table.
    expect([fine.className, fine.querySelector("i")]).toEqual(["", null]);
    fireEvent.click(fine);
    expect(bodyRows(table)).toHaveLength(2);

    fireEvent.click(failed);
    expect(classes(line.querySelector("i"))).toEqual(cls("bi bi-chevron-down mt-0.5 text-ink-500"));
    const cell = bodyRows(table)[1].querySelector("td")!;
    expect([cell.colSpan, classes(cell)]).toEqual([7, cls("bg-ink-950/40 p-3")]);
    expect(classes(cell.firstElementChild)).toEqual(["space-y-2"]);
    expect([...cell.querySelectorAll(".label")].map((l) => l.textContent)).toEqual(["Provider said", "Proxy said"]);
    expect(cell.querySelector("h4")).toBeNull();
    fireEvent.click(failed);
    expect(bodyRows(table)).toHaveLength(2);

    expect(section("Request", body).querySelector("pre")!.textContent).toBe(JSON.stringify({ x: 1 }, null, 2));
    expect(section("Response", body).children[1].textContent).toBe(NOT_RECORDED);

    fireEvent.click(item.firstElementChild!);
    expect(item.childElementCount).toBe(1);
    expect(classes(item.firstElementChild!.firstElementChild)).toEqual(cls("bi bi-chevron-right text-ink-500"));
  });

  it("agent log: an attempt table without failures has six columns and no expandable row", async () => {
    const { m } = await open(detail({ attemptPath: CALLS }));
    const item = callItems(m)[3];
    fireEvent.click(item.firstElementChild!);
    const table = item.querySelector("table")!;
    expect(headers(table)).toEqual(BASE_COLUMNS);
    expect(bodyRows(table).map((tr) => [tr.className, cells(tr)])).toEqual([["", ["1", "1", "sonnet", "openai", "ok", "120 ms"]]]);
    fireEvent.click(bodyRows(table)[0]);
    expect(bodyRows(table)).toHaveLength(1);
  });

  it("agent log: a failed nested agent shows its error, no attempt table, and the calls it made in turn", async () => {
    const { m } = await open(detail({ attemptPath: CALLS }));
    const item = callItems(m)[2];
    fireEvent.click(item.firstElementChild!);
    const body = item.children[1];
    expect([body.firstElementChild!.textContent, classes(body.firstElementChild)]).toEqual(["agent blew up", cls(ERROR_NOTE)]);
    expect([...body.querySelectorAll("h4")].map((h) => h.textContent)).toEqual(["Request", "Response", "Model Service calls (nested)"]);
    expect(body.querySelector("table")).toBeNull();
    const nested = heading("Model Service calls (nested)", body);
    expect(classes(nested)).toEqual(["label"]);
    expect(classes(nested.nextElementSibling)).toEqual(["space-y-2"]);
    const inner = nested.nextElementSibling!.children;
    expect(inner).toHaveLength(1);
    expect([...inner[0].firstElementChild!.children].map((c) => text(c))).toEqual(["", "inner", "svc-a", "", "300 ms", "ok"]);
    expect(classes(inner[0].firstElementChild!.firstElementChild)).toEqual(cls("bi bi-dot text-ink-500"));
  });

  // -- Payload viewers -------------------------------------------------------

  const REQUEST = {
    model: "gpt-x", max_tokens: 100, stream: true, tools: [{ function: { name: "search" } }, { name: "calc" }], system: "be brief",
    messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "", reasoning: "hmm" }, { role: "tool", content: "42" }],
  };
  const viewSwitch = (m: HTMLElement) => m.querySelector(".inline-flex.rounded-lg") as HTMLElement;
  const SEGMENT = "rounded-md px-2.5 py-1 font-medium capitalize transition-colors";
  const SEGMENT_ON = `${SEGMENT} bg-brand-600 text-white`;
  const SEGMENT_OFF = `${SEGMENT} text-ink-400 hover:text-ink-200`;
  const RAW_PRE = "mt-2 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-ink-800 bg-ink-950 p-3 font-mono text-xs leading-relaxed text-ink-300";

  it("the view switch is a joined two-segment control that starts on 'formatted'", async () => {
    const { m } = await open(detail({ requestPayload: JSON.stringify(REQUEST) }));
    const control = viewSwitch(m);
    expect(classes(control)).toEqual(cls("inline-flex rounded-lg border border-ink-700 p-0.5 text-xs"));
    expect([...control.querySelectorAll("button")].map((b) => [b.textContent, classes(b)])).toEqual([["formatted", cls(SEGMENT_ON)], ["json", cls(SEGMENT_OFF)]]);
    fireEvent.click(button("json", control));
    expect([...control.querySelectorAll("button")].map((b) => classes(b))).toEqual([cls(SEGMENT_OFF), cls(SEGMENT_ON)]);
    fireEvent.click(button("formatted", control));
    expect([...control.querySelectorAll("button")].map((b) => classes(b))).toEqual([cls(SEGMENT_ON), cls(SEGMENT_OFF)]);
  });

  it("a payload block opens expanded and its heading collapses it; the state survives a view switch", async () => {
    const { m } = await open(detail({ requestPayload: JSON.stringify(REQUEST) }));
    const block = section("Client request payload", m);
    const head = block.querySelector("button")!;
    expect([classes(head), head.type, head.getAttribute("aria-expanded")]).toEqual([cls("flex w-full items-center gap-1.5 text-left"), "button", "true"]);
    expect(classes(head.querySelector("i"))).toEqual(cls("bi bi-chevron-down text-ink-500"));
    expect(classes(head.querySelector("h4"))).toEqual(cls("label m-0 cursor-pointer select-none"));
    expect(block.childElementCount).toBe(2);
    fireEvent.click(head);
    expect([head.getAttribute("aria-expanded"), block.childElementCount]).toEqual(["false", 1]);
    expect(classes(head.querySelector("i"))).toEqual(cls("bi bi-chevron-right text-ink-500"));
    // The other blocks collapse independently.
    expect(section("Response payload", m).childElementCount).toBe(2);
    fireEvent.click(button("json", viewSwitch(m)));
    expect(block.childElementCount).toBe(1);
    fireEvent.click(head);
    expect(block.querySelector("pre")!.textContent).toBe(JSON.stringify(REQUEST, null, 2));
  });

  it("formatted: parameters as chips, the tool names behind a disclosure, and one card per turn", async () => {
    const { m } = await open(detail({ requestPayload: JSON.stringify(REQUEST) }));
    const body = section("Client request payload", m).children[1];
    expect(classes(body)).toEqual(["mt-2"]);
    const transcript = body.firstElementChild!;
    expect(classes(transcript)).toEqual(["space-y-3"]);
    const [chips, tools, turns] = [...transcript.children];
    expect(classes(chips)).toEqual(cls("flex flex-wrap gap-1.5"));
    expect([...chips.children].map((c) => [c.textContent, classes(c)])).toEqual([
      ["model: gpt-x", ["badge-gray"]], ["max_tokens: 100", ["badge-gray"]], ["stream: true", ["badge-gray"]],
    ]);
    expect([chips.firstElementChild!.firstElementChild!.textContent, classes(chips.firstElementChild!.firstElementChild)]).toEqual(["model:", ["text-ink-500"]]);

    expect([tools.tagName, classes(tools), (tools as HTMLDetailsElement).open]).toEqual(["DETAILS", cls("rounded-lg border border-ink-800 bg-ink-950/40 px-3 py-2"), false]);
    const summary = tools.querySelector("summary")!;
    expect([text(summary), classes(summary)]).toEqual(["2 tools", cls("cursor-pointer text-xs font-medium text-ink-300")]);
    expect(classes(summary.querySelector("i"))).toEqual(cls("bi bi-tools mr-1 text-ink-500"));
    expect(classes(tools.children[1])).toEqual(cls("mt-2 flex flex-wrap gap-1.5"));
    expect([...tools.children[1].children].map((c) => [c.textContent, classes(c)])).toEqual([["search", cls("badge-gray font-mono")], ["calc", cls("badge-gray font-mono")]]);

    expect(classes(turns)).toEqual(["space-y-2"]);
    expect([...turns.children].map((card) => {
      const [role, size] = [...card.firstElementChild!.children];
      return [role.textContent, classes(role), size.textContent, card.querySelector("pre")!.textContent];
    })).toEqual([
      ["system", ["badge-gray"], "8 chars", "be brief"],
      ["user", ["badge-blue"], "2 chars", "hi"],
      ["thinking", ["badge-purple"], "3 chars", "hmm"],
      ["assistant", ["badge-green"], "0 chars", "(empty)"],
      ["tool", ["badge-gray"], "2 chars", "42"],
    ]);
    const card = turns.firstElementChild!;
    expect(classes(card)).toEqual(cls("overflow-hidden rounded-lg border border-ink-800 bg-ink-950/40"));
    expect(classes(card.firstElementChild)).toEqual(cls("flex items-center gap-2 border-b border-ink-800/70 px-3 py-1.5"));
    expect(classes(card.firstElementChild!.children[1])).toEqual(cls("text-[11px] text-ink-600"));
    expect(classes(card.querySelector("pre"))).toEqual(cls("max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-relaxed text-ink-200"));
  });

  it("formatted: one tool is singular, a truncated stream is flagged, and a payload with neither chips nor tools shows only turns", async () => {
    const { m } = await open(detail({
      requestPayload: JSON.stringify({ tools: [{ name: "calc" }] }),
      responsePayload: JSON.stringify({ content: "partial", incomplete: true, usage: { a: 1 } }),
      upstreamRequestPayload: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    }));
    const request = section("Client request payload", m).children[1].firstElementChild!;
    expect([...request.children].map((c) => c.tagName)).toEqual(["DETAILS", "DIV"]);
    expect(text(request.querySelector("summary"))).toBe("1 tool");
    const response = section("Response payload", m).children[1].firstElementChild!;
    expect([...response.firstElementChild!.children].map((c) => c.textContent)).toEqual(['usage: {"a":1}', "incomplete: stream truncated upstream"]);
    expect([response.querySelector(".badge-green")!.textContent, response.querySelector("pre")!.textContent]).toEqual(["assistant", "partial"]);
    const upstream = section("Upstream request payload", m).children[1].firstElementChild!;
    expect([...upstream.children].map((c) => classes(c))).toEqual([["space-y-2"]]);
  });

  it("json: every recorded payload is one pretty-printed block, in every nesting level", async () => {
    const { m } = await open(detail({ requestPayload: JSON.stringify(REQUEST), responsePayload: "not json at all" }));
    fireEvent.click(button("json", viewSwitch(m)));
    const request = section("Client request payload", m);
    expect(request.children[1].tagName).toBe("PRE");
    expect([request.children[1].textContent, classes(request.children[1])]).toEqual([JSON.stringify(REQUEST, null, 2), cls(RAW_PRE)]);
    expect(section("Response payload", m).children[1].textContent).toBe("not json at all");
    const missing = section("Upstream request payload", m).children[1];
    expect([missing.tagName, missing.textContent, classes(missing)]).toEqual(["DIV", NOT_RECORDED, cls(`mt-2 ${MUTED_BOX}`)]);
  });

  it.each([
    ["text that is not JSON", "plain text", "plain text"],
    ["JSON with nothing to format", JSON.stringify({ foo: 1 }), JSON.stringify({ foo: 1 }, null, 2)],
    ["a JSON array", "[1,2]", JSON.stringify([1, 2], null, 2)],
    ["an empty string", "", "-"],
  ])("formatted falls back to the raw block for %s", async (_name, raw, shown) => {
    const { m } = await open(detail({ requestPayload: raw }));
    const body = section("Client request payload", m).children[1];
    expect([body.tagName, body.textContent, classes(body)]).toEqual(["PRE", shown, cls(RAW_PRE)]);
  });

  it("the chosen view applies to stage payloads and call payloads, and is kept for the next request opened", async () => {
    const payload = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
    const { m, pageRow } = await open(detail({ attemptPath: [att({ stage: "plan", request: payload })] }), {
      "GET /logs/2": { log: detail({ attemptPath: [call({ request: payload })], requestPayload: payload }, 2) },
    });
    fireEvent.click(bodyRows(pathTable(m))[0]);
    const stage = () => section('Stage "plan" request', m).children[1];
    expect([stage().tagName, stage().querySelector("pre")!.textContent]).toEqual(["DIV", "hi"]);
    fireEvent.click(button("json", viewSwitch(m)));
    expect([stage().tagName, stage().textContent]).toEqual(["PRE", JSON.stringify(JSON.parse(payload), null, 2)]);

    closeModal(m);
    fireEvent.click(pageRow(1));
    const second = await waitFor(() => openModal("Request #2"));
    expect([...viewSwitch(second).querySelectorAll("button")].map((b) => classes(b))).toEqual([cls(SEGMENT_OFF), cls(SEGMENT_ON)]);
    expect(section("Client request payload", second).children[1].tagName).toBe("PRE");
    const item = callItems(second)[0];
    fireEvent.click(item.firstElementChild!);
    expect(section("Request", item).children[1].tagName).toBe("PRE");
    fireEvent.click(button("formatted", viewSwitch(second)));
    expect(section("Request", item).children[1].querySelector(".badge-blue")!.textContent).toBe("user");
  });
});
