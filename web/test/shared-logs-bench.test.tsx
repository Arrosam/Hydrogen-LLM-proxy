/**
 * Unit tests for the shared pieces the Logs, Active Requests and Model Bench
 * pages are built from: live query + toggle set, key/value rows, code blocks,
 * disclosure headings, the filter bar family, meta tiles, the HTTP capture
 * block, and the pure helpers (kv, json, labels, files, sse, bench requests).
 */
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { ToastProvider } from "../src/components/Toast";
import { CodeBlock, MutedBox } from "../src/components/CodeBlock";
import { Chevron, DisclosureHeading } from "../src/components/Disclosure";
import { FilterBar, LiveToggle, Pagination, RefreshButton } from "../src/components/FilterBar";
import { HttpInfoBlock } from "../src/components/HttpInfoBlock";
import { KeyValueRows } from "../src/components/KeyValueRows";
import { MetaGrid, MetaTile } from "../src/components/Meta";
import { ResourcePage } from "../src/components/Page";
import { ANTHROPIC_VERSION, buildChatBody, defaultMediaBody, proxyPath } from "../src/lib/benchRequest";
import { base64ToBytes, bytesToBase64, readEncodedFile, toDataUrl } from "../src/lib/files";
import { useCopy } from "../src/lib/hooks";
import { I18nProvider } from "../src/lib/i18n";
import { parseJsonOrText, prettyJson } from "../src/lib/json";
import { coerceJsonish, jsonishText, keyCounts, objectToRows, rowsToObject, type KeyValueRow } from "../src/lib/kv";
import { msLabel, tokenLabel, withDisabledNote } from "../src/lib/labels";
import { drainSse, splitFrames, sseDataOf, textFromFrames, usageFromFrames } from "../src/lib/sse";
import { useLiveQuery } from "../src/lib/useLiveQuery";
import { useToggleSet } from "../src/lib/useToggleSet";
import { button, classes, cls, deferred, iconButton, isOn, mockApi, toasts, toggle } from "./helpers";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const wrapper = ({ children }: { children: ReactNode }) => <ToastProvider>{children}</ToastProvider>;
const t = (key: string): string => ({ "common.ms": "ms", "common.disabled": "disabled" })[key] ?? key;
const flush = (): Promise<void> => act(async () => { await Promise.resolve(); });

describe("useToggleSet", () => {
  it("flips one member at a time and keeps a stable toggle", () => {
    const { result } = renderHook(() => useToggleSet<number>());
    const toggleFn = result.current[1];
    expect([...result.current[0]]).toEqual([]);
    act(() => result.current[1](2));
    act(() => result.current[1](5));
    expect([...result.current[0]]).toEqual([2, 5]);
    act(() => result.current[1](2));
    expect([[...result.current[0]], result.current[1] === toggleFn]).toEqual([[5], true]);
  });
});

describe("useLiveQuery", () => {
  const hook = (query: () => Promise<string>, live = true) =>
    renderHook(({ q, on }: { q: () => Promise<string>; on: boolean }) => useLiveQuery(q, { pollMs: 500, live: on }), { initialProps: { q: query, on: live } });

  it("loads on mount: loading until the answer, then data and no error", async () => {
    const d = deferred<string>();
    const { result } = hook(() => d.promise);
    expect([result.current.data, result.current.loading, result.current.error]).toEqual([null, true, null]);
    await act(async () => { d.resolve("one"); });
    expect([result.current.data, result.current.loading, result.current.error]).toEqual(["one", false, null]);
  });

  it("keeps the last data when a reload fails, and clears the error on the next success", async () => {
    const answers: Array<() => Promise<string>> = [async () => "one", async () => { throw new Error("down"); }, async () => "two"];
    const query = vi.fn(() => answers.shift()!());
    const { result } = hook(query, false);
    await flush();
    await act(async () => { result.current.reload(); });
    expect([result.current.data, result.current.error, result.current.loading]).toEqual(["one", "down", false]);
    await act(async () => { result.current.reload(); });
    expect([result.current.data, result.current.error]).toEqual(["two", null]);
  });

  it("a non-Error rejection is shown as text", async () => {
    const { result } = hook(() => Promise.reject("boom"), false);
    await flush();
    expect(result.current.error).toBe("boom");
  });

  it("a silent reload never raises loading; a plain one does", async () => {
    const pending: Array<ReturnType<typeof deferred<string>>> = [];
    const query = (): Promise<string> => { const d = deferred<string>(); pending.push(d); return d.promise; };
    const { result } = hook(query, false);
    await act(async () => { pending[0].resolve("one"); });
    act(() => result.current.reload(true));
    expect(result.current.loading).toBe(false);
    await act(async () => { pending[1].resolve("two"); });
    expect([result.current.data, result.current.loading]).toEqual(["two", false]);
    act(() => result.current.reload());
    expect(result.current.loading).toBe(true);
    await act(async () => { pending[2].resolve("three"); });
    expect(result.current.loading).toBe(false);
  });

  it("polls silently every pollMs while live, and stops when live goes off", async () => {
    vi.useFakeTimers();
    const query = vi.fn(async () => "x");
    const { result, rerender } = hook(query, true);
    await flush();
    expect(query).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(499); });
    expect(query).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect([query.mock.calls.length, result.current.loading]).toEqual([2, false]);
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(query).toHaveBeenCalledTimes(4);
    rerender({ q: query, on: false });
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("a new query reloads at once and restarts the timer", async () => {
    vi.useFakeTimers();
    const first = vi.fn(async () => "a");
    const second = vi.fn(async () => "b");
    const { result, rerender } = hook(first, true);
    await flush();
    await act(async () => { vi.advanceTimersByTime(400); });
    rerender({ q: second, on: true });
    await flush();
    expect([first.mock.calls.length, second.mock.calls.length, result.current.data]).toEqual([1, 1, "b"]);
    await act(async () => { vi.advanceTimersByTime(499); });
    expect(second).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 2]);
  });

  it("setError shows a message beside the list until the next successful load", async () => {
    const { result } = hook(async () => "x", false);
    await flush();
    act(() => result.current.setError("detail failed"));
    expect(result.current.error).toBe("detail failed");
    await act(async () => { result.current.reload(true); });
    expect(result.current.error).toBeNull();
  });
});

describe("useCopy: successOnFailure", () => {
  it("toasts the ok text even when the copy failed, and still reports the truth", async () => {
    document.execCommand = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { result } = renderHook(() => useCopy({ ok: "Copied" }, { successOnFailure: true }), { wrapper });
    let ok = true;
    await act(async () => { ok = await result.current("body"); });
    expect([ok, toasts()]).toEqual([false, ["Copied"]]);
    await act(async () => { ok = await result.current("body"); });
    expect([ok, toasts()]).toEqual([true, ["Copied", "Copied"]]);
  });
});

describe("kv", () => {
  it("coerceJsonish: JSON when it parses, the text otherwise; trim is opt-in", () => {
    expect(["true", "0.7", '["a"]', '"x"', "pong", " 1 "].map((v) => coerceJsonish(v))).toEqual([true, 0.7, ["a"], "x", "pong", 1]);
    expect([coerceJsonish(" pong "), coerceJsonish(" pong ", { trim: true })]).toEqual([" pong ", "pong"]);
    expect([coerceJsonish(""), coerceJsonish("  ", { trim: true })]).toEqual(["", ""]);
  });

  it("rowsToObject: trims keys, skips keyless rows, last duplicate wins", () => {
    const rows: KeyValueRow[] = [{ key: " a ", value: "1" }, { key: "", value: "lost" }, { key: "  ", value: "lost" }, { key: "a", value: "2" }, { key: "b", value: "x" }];
    expect(rowsToObject(rows)).toEqual({ a: 2, b: "x" });
  });

  it("rowsToObject: an empty value is sent as \"\" unless dropEmpty; trim decides what counts as empty", () => {
    const rows: KeyValueRow[] = [{ key: "a", value: "" }, { key: "b", value: "  " }, { key: "c", value: " v " }];
    expect(rowsToObject(rows)).toEqual({ a: "", b: "  ", c: " v " });
    expect(rowsToObject(rows, { dropEmpty: true })).toEqual({ b: "  ", c: " v " });
    expect(rowsToObject(rows, { trim: true })).toEqual({ a: "", b: "", c: "v" });
    expect(rowsToObject(rows, { trim: true, dropEmpty: true })).toEqual({ c: "v" });
  });

  it("jsonishText quotes exactly the strings that would not survive the trip back", () => {
    expect([jsonishText(undefined), jsonishText("plain"), jsonishText(0.7), jsonishText(true), jsonishText({ a: 1 })]).toEqual(["", "plain", "0.7", "true", '{"a":1}']);
    expect([jsonishText("12"), jsonishText("true"), jsonishText(" pad "), jsonishText("a\nb")]).toEqual(['"12"', '"true"', '" pad "', '"a\\nb"']);
    for (const v of ["plain", "12", "true", " pad ", "a\nb", 3, null, ["x"], { a: 1 }]) {
      expect(coerceJsonish(jsonishText(v), { trim: true })).toEqual(v);
    }
  });

  it("objectToRows and keyCounts", () => {
    expect(objectToRows(undefined)).toEqual([]);
    expect(objectToRows({ topP: 0.9, stop: "12" })).toEqual([{ key: "topP", value: "0.9" }, { key: "stop", value: '"12"' }]);
    const counts = keyCounts([{ key: "a", value: "" }, { key: " a ", value: "" }, { key: "", value: "" }, { key: "b", value: "" }]);
    expect([...counts]).toEqual([["a", 2], ["b", 1]]);
  });
});

describe("KeyValueRows", () => {
  const ROWS: KeyValueRow[] = [{ key: "temperature", value: "0.2" }, { key: "top_p", value: "1" }];
  const base = { keyPlaceholder: "name", valuePlaceholder: "value", addLabel: "Add parameter" };

  it("default (bench) form: wrapped rows, equal-width inputs, trash button, add after the rows", () => {
    const { container } = render(<KeyValueRows rows={ROWS} onChange={() => {}} {...base} rowsClassName="space-y-1.5" addClassName="mt-1.5" />);
    const [stack, add] = [...container.children];
    expect([container.children.length, stack.className]).toEqual([2, "space-y-1.5"]);
    const row = stack.children[0];
    expect(classes(row)).toEqual(cls("flex gap-1.5"));
    const [key, value] = [...row.querySelectorAll("input")];
    expect([classes(key), classes(value)]).toEqual([cls("input flex-1 font-mono text-xs"), cls("input flex-1 font-mono text-xs")]);
    expect([key.placeholder, value.placeholder, key.value, value.value, key.hasAttribute("type"), key.hasAttribute("title")]).toEqual(["name", "value", "temperature", "0.2", false, false]);
    const remove = iconButton("bi-trash", row);
    expect([classes(remove), remove.type, remove.hasAttribute("title")]).toEqual([cls("btn-ghost btn-xs"), "button", false]);
    expect([classes(add), (add as HTMLButtonElement).type, add.textContent, add.querySelector("i")!.className]).toEqual([cls("btn-ghost btn-xs mt-1.5"), "button", "Add parameter", "bi bi-plus-lg"]);
  });

  it("reports edits, removals and additions with what changed", () => {
    const onChange = vi.fn();
    const { container } = render(<KeyValueRows rows={ROWS} onChange={onChange} {...base} rowsClassName="space-y-1.5" />);
    const inputs = [...container.querySelectorAll("input")];
    fireEvent.change(inputs[0], { target: { value: "temp" } });
    fireEvent.change(inputs[3], { target: { value: "0.5" } });
    fireEvent.click(container.querySelectorAll("button")[0]);
    fireEvent.click(button("Add parameter"));
    expect(onChange.mock.calls).toEqual([
      [[{ key: "temp", value: "0.2" }, ROWS[1]], "edit"],
      [[ROWS[0], { key: "top_p", value: "0.5" }], "edit"],
      [[ROWS[1]], "remove"],
      [[...ROWS, { key: "", value: "" }], "add"],
    ]);
  });

  it("dense (editor) form: unwrapped siblings, 32px typed inputs, danger x with a title, add icon with a margin", () => {
    const { container } = render(
      <div id="stack">
        <KeyValueRows rows={ROWS} onChange={() => {}} {...base} dense selectValueOnFocus removeStyle="danger" removeTitle="Remove override" />
      </div>,
    );
    const stack = container.querySelector("#stack")!;
    expect([...stack.children].map((c) => c.tagName)).toEqual(["DIV", "DIV", "BUTTON"]);
    const row = stack.children[0];
    expect(classes(row)).toEqual(cls("flex items-start gap-1.5"));
    const [key, value] = [...row.querySelectorAll("input")];
    expect([classes(key), classes(value)]).toEqual([cls("input h-8 w-40 py-0 font-mono text-xs"), cls("input h-8 flex-1 py-0 font-mono text-xs")]);
    expect([key.getAttribute("type"), value.getAttribute("type")]).toEqual(["text", "text"]);
    const remove = iconButton("bi-x-lg", row);
    expect([classes(remove), remove.title, remove.type]).toEqual([cls("btn-danger btn-xs shrink-0"), "Remove override", "button"]);
    const add = button("Add parameter");
    expect([classes(add), add.querySelector("i")!.className]).toEqual([cls("btn-ghost btn-xs"), "bi bi-plus-lg mr-1"]);
    const select = vi.spyOn(value, "select");
    fireEvent.focus(value);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("does not select on focus unless asked", () => {
    const { container } = render(<KeyValueRows rows={ROWS} onChange={() => {}} {...base} />);
    const value = container.querySelectorAll("input")[1];
    const select = vi.spyOn(value, "select");
    fireEvent.focus(value);
    expect(select).not.toHaveBeenCalled();
  });

  it("duplicateKeyWarning marks every row of a repeated key and shows the warning between rows and add", () => {
    const rows: KeyValueRow[] = [{ key: "a", value: "1" }, { key: "b", value: "2" }, { key: " a ", value: "3" }];
    const { container, rerender } = render(<div id="stack"><KeyValueRows rows={rows} onChange={() => {}} {...base} dense duplicateKeyWarning="Duplicate name" /></div>);
    const keys = [...container.querySelectorAll("input")].filter((_, i) => i % 2 === 0);
    expect(keys.map((k) => [k.classList.contains("border-red-500/70"), k.getAttribute("title")])).toEqual([[true, "Duplicate name"], [false, null], [true, "Duplicate name"]]);
    const children = [...container.querySelector("#stack")!.children];
    const warning = children[3];
    expect([children.map((c) => c.tagName), classes(warning), warning.textContent, warning.querySelector("i")!.className]).toEqual([
      ["DIV", "DIV", "DIV", "P", "BUTTON"], cls("text-[11px] text-red-400"), "Duplicate name", "bi bi-exclamation-triangle mr-1",
    ]);
    rerender(<div id="stack"><KeyValueRows rows={rows} onChange={() => {}} {...base} dense /></div>);
    expect([container.querySelector("p"), container.querySelector(".border-red-500\\/70")]).toEqual([null, null]);
    rerender(<div id="stack"><KeyValueRows rows={rows.slice(0, 2)} onChange={() => {}} {...base} dense duplicateKeyWarning="Duplicate name" /></div>);
    expect(container.querySelector("p")).toBeNull();
  });

  it("createRow and rowKey let rows carry an id that survives a removal", () => {
    interface IdRow extends KeyValueRow { id: number }
    const rows: IdRow[] = [{ id: 7, key: "a", value: "1" }, { id: 8, key: "b", value: "2" }];
    const onChange = vi.fn();
    const view = (list: IdRow[]) => <KeyValueRows<IdRow> rows={list} onChange={onChange} createRow={() => ({ id: 9, key: "", value: "" })} rowKey={(r) => r.id} {...base} />;
    const { container, rerender } = render(view(rows));
    const second = container.querySelectorAll("input")[2];
    fireEvent.click(button("Add parameter"));
    expect(onChange.mock.calls[0]).toEqual([[...rows, { id: 9, key: "", value: "" }], "add"]);
    fireEvent.change(second, { target: { value: "bb" } });
    expect(onChange.mock.calls[1]).toEqual([[rows[0], { id: 8, key: "bb", value: "2" }], "edit"]);
    rerender(view([rows[1]]));
    expect(container.querySelectorAll("input")[0]).toBe(second);
  });
});

describe("CodeBlock / MutedBox", () => {
  const BOX = "whitespace-pre-wrap break-words rounded-lg border border-ink-800 bg-ink-950 font-mono text-xs";

  it("default: a framed, unbounded pre in the normal tone", () => {
    const { container } = render(<CodeBlock>{"{}"}</CodeBlock>);
    const el = container.firstElementChild!;
    expect([el.tagName, classes(el), el.textContent]).toEqual(["PRE", cls(`${BOX} p-3 text-ink-300`), "{}"]);
  });

  it.each([
    ["live text", { maxHeight: "sm" }, `max-h-64 overflow-auto ${BOX} p-3 text-ink-300`],
    ["stream text", { maxHeight: "sm", tone: "strong" }, `max-h-64 overflow-auto ${BOX} p-3 text-ink-200`],
    ["request body", { maxHeight: "md", relaxed: true, className: "mt-2" }, `mt-2 max-h-72 overflow-auto ${BOX} p-3 leading-relaxed text-ink-300`],
    ["json block", { maxHeight: "xl", relaxed: true, className: "mt-1" }, `mt-1 max-h-96 overflow-auto ${BOX} p-3 leading-relaxed text-ink-300`],
    ["log payload", { maxHeight: "screen", relaxed: true, className: "mt-2" }, `mt-2 max-h-[60vh] overflow-auto ${BOX} p-3 leading-relaxed text-ink-300`],
    ["error body", { maxHeight: "sm", padding: "sm", tone: "muted", relaxed: true, className: "mt-1" }, `mt-1 max-h-64 overflow-auto ${BOX} p-2 leading-relaxed text-ink-400`],
  ] as const)("%s", (_, props, expected) => {
    const { container } = render(<CodeBlock {...props}>x</CodeBlock>);
    expect(classes(container.firstElementChild)).toEqual(cls(expected));
  });

  it("frame none + row padding is the unframed transcript turn", () => {
    const { container } = render(<CodeBlock maxHeight="lg" frame="none" padding="row" tone="strong" relaxed>x</CodeBlock>);
    expect(classes(container.firstElementChild)).toEqual(cls("max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-relaxed text-ink-200"));
  });

  it("as=p with the error frame is the upstream error paragraph", () => {
    const { container } = render(<CodeBlock as="p" className="mt-1" frame="error" padding="sm" tone="error">no tool use</CodeBlock>);
    const el = container.firstElementChild!;
    expect([el.tagName, classes(el)]).toEqual(["P", cls("mt-1 whitespace-pre-wrap break-words rounded-lg border border-red-900/50 bg-red-950/30 p-2 font-mono text-xs text-red-300")]);
  });

  it("MutedBox", () => {
    const { container } = render(<><MutedBox>Not recorded</MutedBox><MutedBox className="mt-2">x</MutedBox></>);
    const quiet = "rounded-lg border border-ink-800 bg-ink-950 px-3 py-2 text-xs text-ink-500";
    expect([container.children[0].tagName, container.children[0].textContent]).toEqual(["DIV", "Not recorded"]);
    expect([classes(container.children[0]), classes(container.children[1])]).toEqual([cls(quiet), cls(`mt-2 ${quiet}`)]);
  });
});

describe("Disclosure", () => {
  it("Chevron points down when open, right when closed", () => {
    const { container } = render(<><Chevron open /><Chevron open={false} /><Chevron open className="mr-1 text-ink-500" /></>);
    expect([...container.children].map((c) => c.className)).toEqual(["bi bi-chevron-down text-ink-500", "bi bi-chevron-right text-ink-500", "bi bi-chevron-down mr-1 text-ink-500"]);
  });

  it("bare heading: a button with chevron and an h4 label; no aria-expanded unless announced", () => {
    const onToggle = vi.fn();
    const { container } = render(<DisclosureHeading open={false} onToggle={onToggle} title="Response" />);
    const btn = container.firstElementChild as HTMLButtonElement;
    expect([btn.tagName, btn.type, classes(btn), btn.hasAttribute("aria-expanded")]).toEqual(["BUTTON", "button", cls("flex items-center gap-1.5 text-left"), false]);
    expect(btn.firstElementChild!.className).toBe("bi bi-chevron-right text-ink-500");
    const heading = btn.lastElementChild!;
    expect([heading.tagName, classes(heading), heading.textContent]).toEqual(["H4", cls("label m-0 cursor-pointer select-none"), "Response"]);
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("fullWidth + announce: the log payload heading", () => {
    const { container, rerender } = render(<DisclosureHeading open onToggle={() => {}} title="Request" fullWidth announce />);
    const btn = (): Element => container.firstElementChild!;
    expect([classes(btn()), btn().getAttribute("aria-expanded")]).toEqual([cls("flex w-full items-center gap-1.5 text-left"), "true"]);
    rerender(<DisclosureHeading open={false} onToggle={() => {}} title="Request" fullWidth announce />);
    expect(btn().getAttribute("aria-expanded")).toBe("false");
  });

  it("actions put the heading in a spread row; as picks the heading level", () => {
    const { container } = render(<DisclosureHeading open onToggle={() => {}} title="Body" as="h3" actions={<button>copy</button>} />);
    const row = container.firstElementChild!;
    expect([row.tagName, classes(row), row.children.length, row.children[1].textContent]).toEqual(["DIV", cls("flex items-center justify-between"), 2, "copy"]);
    expect(row.children[0].lastElementChild!.tagName).toBe("H3");
  });
});

describe("filter bar family", () => {
  it("FilterBar: controls, a spacer, the count, then the end slot", () => {
    const { container } = render(<FilterBar count="12 total" end={<button>Clear</button>}><input /><span>x</span></FilterBar>);
    const bar = container.firstElementChild!;
    expect(classes(bar)).toEqual(cls("mb-4 flex flex-wrap items-center gap-3"));
    expect([...bar.children].map((c) => [c.tagName, c.className, c.textContent])).toEqual([
      ["INPUT", "", ""], ["SPAN", "", "x"], ["DIV", "flex-1", ""], ["SPAN", "text-xs text-ink-500", "12 total"], ["BUTTON", "", "Clear"],
    ]);
  });

  it("FilterBar without an end slot stops at the count", () => {
    const { container } = render(<FilterBar count="0"><i /></FilterBar>);
    expect(container.firstElementChild!.lastElementChild!.textContent).toBe("0");
  });

  it("RefreshButton", () => {
    const onClick = vi.fn();
    render(<RefreshButton onClick={onClick}>Refresh</RefreshButton>);
    const btn = button("Refresh");
    expect([classes(btn), btn.querySelector("i")!.className, btn.hasAttribute("type")]).toEqual([cls("btn-ghost btn-xs"), "bi bi-arrow-clockwise", false]);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("LiveToggle shows the badge only while live and reports the flip", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<LiveToggle live onChange={onChange} label="Auto-refresh" badge="live" />);
    const badge = container.querySelector(".badge-green")!;
    expect([isOn(toggle("Auto-refresh")), badge.textContent, badge.firstElementChild!.className]).toEqual([true, "live", "bi bi-broadcast"]);
    fireEvent.click(toggle("Auto-refresh"));
    expect(onChange.mock.calls).toEqual([[false]]);
    rerender(<LiveToggle live={false} onChange={onChange} label="Auto-refresh" badge="live" />);
    expect([isOn(toggle("Auto-refresh")), container.querySelector(".badge-green")]).toEqual([false, null]);
  });

  describe("Pagination", () => {
    const labels = { prev: "Prev", next: "Next", summary: ({ start, end }: { start: number; end: number }) => `${start}-${end} of many` };
    const view = (offset: number, total: number, onChange = vi.fn()) => <Pagination offset={offset} pageSize={50} total={total} onChange={onChange} labels={labels} />;

    it("renders nothing while everything fits on one page", () => {
      const { container } = render(view(0, 50));
      expect(container.innerHTML).toBe("");
    });

    it("first page: prev disabled, icons on the outside, summary in between", () => {
      const { container } = render(view(0, 51));
      const bar = container.firstElementChild!;
      expect(classes(bar)).toEqual(cls("mt-4 flex items-center justify-between text-sm text-ink-400"));
      const [prev, next] = [button("Prev"), button("Next")];
      expect([prev.disabled, next.disabled, classes(prev), classes(next)]).toEqual([true, false, cls("btn-ghost btn-xs"), cls("btn-ghost btn-xs")]);
      expect([prev.firstElementChild!.className, next.lastElementChild!.className, prev.firstChild === prev.firstElementChild, next.lastChild === next.lastElementChild]).toEqual(["bi bi-chevron-left", "bi bi-chevron-right", true, true]);
      expect(bar.querySelector("span")!.textContent).toBe("1-50 of many");
    });

    it("moves by one page, never below zero, and disables next on the last page", () => {
      const onChange = vi.fn();
      const { rerender } = render(view(50, 120, onChange));
      fireEvent.click(button("Prev"));
      fireEvent.click(button("Next"));
      expect(onChange.mock.calls).toEqual([[0], [100]]);
      rerender(view(100, 120, onChange));
      expect([button("Next").disabled, document.querySelector("span")!.textContent]).toEqual([true, "101-120 of many"]);
      rerender(view(20, 120, onChange));
      fireEvent.click(button("Prev"));
      expect(onChange.mock.calls[2]).toEqual([0]);
    });
  });
});

describe("Meta", () => {
  it("MetaGrid of MetaTiles", () => {
    const { container } = render(<MetaGrid><MetaTile label="Status" value="200" /></MetaGrid>);
    const grid = container.firstElementChild!;
    const tile = grid.firstElementChild!;
    expect([classes(grid), classes(tile)]).toEqual([cls("grid grid-cols-3 gap-3 text-sm"), cls("rounded-lg bg-ink-950/50 px-3 py-2")]);
    expect([...tile.children].map((c) => [c.textContent, classes(c)])).toEqual([
      ["Status", cls("text-[11px] uppercase tracking-wide text-ink-500")], ["200", cls("mt-0.5 text-ink-200")],
    ]);
  });
});

describe("HttpInfoBlock", () => {
  const view = (props: Partial<Parameters<typeof HttpInfoBlock>[0]>) =>
    render(<I18nProvider><HttpInfoBlock title="Client request" emptyLabel="Not recorded" {...props} /></I18nProvider>);

  it("nothing captured: the title and the quiet box", () => {
    mockApi();
    const { container } = view({ headers: {}, method: null, status: 0 });
    const root = container.firstElementChild!;
    expect([root.children.length, root.children[0].tagName, root.children[0].className, root.children[0].textContent]).toEqual([2, "H4", "label", "Client request"]);
    expect([root.children[1].textContent, classes(root.children[1])]).toEqual(["Not recorded", cls("rounded-lg border border-ink-800 bg-ink-950 px-3 py-2 text-xs text-ink-500")]);
  });

  it("a request line and headers", () => {
    mockApi();
    const { container } = view({ method: "POST", path: "/v1/messages", query: "beta=1", headers: { accept: "*/*", "x-id": "7" } });
    const box = container.firstElementChild!.children[1];
    expect(classes(box)).toEqual(cls("overflow-hidden rounded-lg border border-ink-800 bg-ink-950/40"));
    const line = box.children[0];
    expect([classes(line), [...line.children].map((c) => [c.className, c.textContent])]).toEqual([
      cls("flex items-center gap-2 border-b border-ink-800/70 px-3 py-1.5 font-mono text-xs"),
      [["text-brand-400", "POST"], ["text-ink-200", "/v1/messages?beta=1"]],
    ]);
    const rows = [...box.querySelectorAll("tr")];
    expect(rows.map((r) => [...r.children].map((td) => td.textContent))).toEqual([["accept", "*/*"], ["x-id", "7"]]);
    expect([box.querySelector("table")!.className, classes(rows[0]), classes(rows[0].children[0]), classes(rows[0].children[1])]).toEqual([
      "w-full text-xs", cls("border-b border-ink-800/40 last:border-0"),
      cls("whitespace-nowrap px-3 py-1 align-top font-mono text-ink-400"), cls("break-all px-3 py-1 font-mono text-ink-300"),
    ]);
  });

  it("a status line alone, and headers alone, and a query alone", () => {
    mockApi();
    const status = view({ status: 502 });
    expect([status.container.querySelector(".badge-red")!.textContent, status.container.querySelector("table")]).toEqual(["502", null]);
    status.unmount();
    const headers = view({ headers: { a: "b" } });
    expect([headers.container.querySelector(".font-mono.border-b"), headers.container.querySelectorAll("tr").length]).toEqual([null, 1]);
    headers.unmount();
    // A query with no path has no line to sit on: the block says nothing was recorded.
    const query = view({ query: "a=1" });
    const box = query.container.firstElementChild!.children[1];
    expect([box.children.length, box.textContent]).toEqual([0, "Not recorded"]);
  });
});

describe("ResourcePage className", () => {
  it("lands on the page root, and is absent by default", () => {
    const state = { data: 1, loading: false, error: null };
    const { container, rerender } = render(<ResourcePage title="Bench" state={state} className="space-y-4" />);
    expect(container.firstElementChild!.className).toBe("space-y-4");
    rerender(<ResourcePage title="Bench" state={state} />);
    expect(container.firstElementChild!.hasAttribute("class")).toBe(false);
  });
});

describe("json", () => {
  it("parseJsonOrText", () => {
    expect([parseJsonOrText('{"a":1}'), parseJsonOrText("upstream said no"), parseJsonOrText(""), parseJsonOrText("null")]).toEqual([{ a: 1 }, "upstream said no", "", null]);
  });

  it("prettyJson: re-indents JSON text, keeps other text, serializes values, empties undefined", () => {
    expect([prettyJson(undefined), prettyJson('{"a":1}'), prettyJson("not json"), prettyJson({ a: [1] }), prettyJson(null), prettyJson("")]).toEqual([
      "", '{\n  "a": 1\n}', "not json", '{\n  "a": [\n    1\n  ]\n}', "null", "",
    ]);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(prettyJson(loop)).toBe("[object Object]");
  });
});

describe("labels", () => {
  it("tokenLabel, withDisabledNote, msLabel", () => {
    expect(tokenLabel({ name: "ci", keyPrefix: "hk-abc" })).toBe("ci · hk-abc");
    expect([withDisabledNote("svc · chat", true, t), withDisabledNote("svc · chat", false, t)]).toEqual(["svc · chat", "svc · chat (disabled)"]);
    expect([msLabel(120, t), msLabel("1,200", t)]).toEqual(["120 ms", "1,200 ms"]);
  });
});

describe("files", () => {
  it("base64 round trip, across the chunk boundary", () => {
    const bytes = Uint8Array.from({ length: 0x8000 * 2 + 5 }, (_, i) => i % 251);
    const encoded = bytesToBase64(bytes);
    expect([encoded, bytesToBase64(new Uint8Array()), bytesToBase64(Uint8Array.from([104, 105]))]).toEqual([btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join("")), "", "aGk="]);
    expect(Array.from(base64ToBytes(encoded))).toEqual(Array.from(bytes));
  });

  it("toDataUrl and readEncodedFile (unknown type falls back to octet-stream)", async () => {
    expect(toDataUrl("image/png", "AAAA")).toBe("data:image/png;base64,AAAA");
    const file = (name: string, type: string) => ({ name, type, arrayBuffer: async () => Uint8Array.from([104, 105]).buffer }) as unknown as File;
    expect(await readEncodedFile(file("a.txt", "text/plain"))).toEqual({ name: "a.txt", mediaType: "text/plain", data: "aGk=", dataUrl: "data:text/plain;base64,aGk=" });
    expect((await readEncodedFile(file("blob", ""))).mediaType).toBe("application/octet-stream");
  });
});

describe("sse", () => {
  const data = (o: unknown): string => `data: ${JSON.stringify(o)}`;

  it("sseDataOf", () => {
    expect([sseDataOf("data: {\"a\":1} "), sseDataOf("data:x"), sseDataOf("event: bench"), sseDataOf("data:")]).toEqual(['{"a":1}', "x", null, ""]);
  });

  it("splitFrames keeps whole frames, drops blank ones, returns the unfinished tail", () => {
    expect(splitFrames("a\n\nb\r\n\r\n\n\n  \n\nc")).toEqual({ frames: ["a", "b"], rest: "c" });
    expect(splitFrames("partial")).toEqual({ frames: [], rest: "partial" });
  });

  it("textFromFrames reads all three dialects and skips what is not a delta", () => {
    const frames = [
      `event: content_block_delta\n${data({ type: "content_block_delta", delta: { text: "An" } })}`,
      data({ type: "response.output_text.delta", delta: "Re" }),
      data({ choices: [{ delta: { content: "Ch" } }, { delta: {} }] }),
      "data: [DONE]", "data: not json", "data:", ": comment", data({ type: "message_stop" }),
    ];
    expect(textFromFrames(frames)).toBe("AnReCh");
  });

  it("usageFromFrames merges Anthropic's two halves, and prefers a whole usage object", () => {
    const anthropic = [data({ type: "message_start", message: { usage: { input_tokens: 5, cache_read_input_tokens: 2 } } }), data({ type: "message_delta", usage: { output_tokens: 9 } })];
    expect(usageFromFrames(anthropic)).toEqual({ input_tokens: 5, cache_read_input_tokens: 2, output_tokens: 9 });
    expect(usageFromFrames([data({ type: "response.completed", response: { usage: { total_tokens: 3 } } })])).toEqual({ total_tokens: 3 });
    expect(usageFromFrames([...anthropic, data({ choices: [], usage: { total_tokens: 7 } })])).toEqual({ total_tokens: 7 });
    expect(usageFromFrames([data({ choices: [] }), "data: [DONE]"])).toBeUndefined();
  });

  it("drainSse reports frames as they complete and flushes an unterminated last one", async () => {
    const enc = new TextEncoder();
    const chunks = ["data: 1\n\ndata", ": 2\n\n", "data: 3"].map((c) => enc.encode(c));
    const body = { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true, value: undefined }) }) } as unknown as ReadableStream<Uint8Array>;
    const seen: string[][] = [];
    const all = await drainSse(body, (f) => seen.push(f));
    expect([all, seen]).toEqual([["data: 1", "data: 2", "data: 3"], [["data: 1"], ["data: 2"], ["data: 3"]]]);
  });
});

describe("benchRequest", () => {
  const image = { name: "a.png", mediaType: "image/png", data: "AAAA", dataUrl: "data:image/png;base64,AAAA" };
  const doc = { name: "a.pdf", mediaType: "application/pdf", data: "BBBB", dataUrl: "data:application/pdf;base64,BBBB" };
  const input = { model: "svc", system: "be brief", text: "hi", attachments: [image, doc], stream: true, params: { temperature: 0 } };

  it("proxyPath: chat by ingress family, media by category", () => {
    expect([proxyPath("chat", "anthropic"), proxyPath("ocr", "openai_responses"), proxyPath("tts", "anthropic"), proxyPath("embedding", "openai_completion")]).toEqual([
      "/v1/messages", "/v1/responses", "/v1/audio/speech", "/v1/embeddings",
    ]);
    expect(ANTHROPIC_VERSION).toBe("2023-06-01");
  });

  it("buildChatBody: chat completions", () => {
    expect(buildChatBody({ ...input, family: "openai_completion" })).toEqual({
      model: "svc",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: image.dataUrl } }, { type: "file", file: { filename: "a.pdf", file_data: doc.dataUrl } }] },
      ],
      stream: true,
      temperature: 0,
    });
  });

  it("buildChatBody: anthropic states max_tokens and a top-level system", () => {
    expect(buildChatBody({ ...input, family: "anthropic", stream: false, system: "" })).toEqual({
      model: "svc",
      max_tokens: 4096,
      messages: [{ role: "user", content: [
        { type: "text", text: "hi" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        { type: "document", title: "a.pdf", source: { type: "base64", media_type: "application/pdf", data: "BBBB" } },
      ] }],
      temperature: 0,
    });
  });

  it("buildChatBody: responses uses instructions/input and omits an empty text part", () => {
    expect(buildChatBody({ ...input, family: "openai_responses", text: "" })).toEqual({
      model: "svc",
      instructions: "be brief",
      input: [{ role: "user", content: [{ type: "input_image", image_url: image.dataUrl }, { type: "input_file", filename: "a.pdf", file_data: doc.dataUrl }] }],
      stream: true,
      temperature: 0,
    });
  });

  it("params can override what the form built", () => {
    expect(buildChatBody({ ...input, family: "openai_completion", attachments: [], params: { model: "other", stream: false } })).toMatchObject({ model: "other", stream: false });
  });

  it("defaultMediaBody: a starting body per category, using the typed text when there is one", () => {
    expect([defaultMediaBody("embedding", "m", ""), defaultMediaBody("embedding", "m", "hey"), defaultMediaBody("stt", "m", "x"), defaultMediaBody("chat", "m", "x")]).toEqual([
      { model: "m", input: "hello" }, { model: "m", input: "hey" }, { model: "m" }, { model: "m" },
    ]);
    expect(defaultMediaBody("rerank", "m", "q")).toEqual({ model: "m", query: "q", documents: ["first document", "second document"] });
    expect(defaultMediaBody("image", "m", "")).toEqual({ model: "m", prompt: "a red circle on a white background", n: 1, size: "1024x1024" });
    expect(defaultMediaBody("tts", "m", "")).toEqual({ model: "m", input: "Hydrogen model bench.", voice: "alloy" });
    expect(defaultMediaBody("video", "m", "")).toEqual({ model: "m", prompt: "a red circle rolling across a white background" });
  });
});
