/**
 * Unit tests for the shared pieces the Settings, Check and Overview pages are
 * built on: the polling helpers, the section / heading / bar atoms, the
 * numeric setting card, and the small additions to api, format and Spinner.
 */
import { useCallback, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { ApiError, readResponse } from "../src/api";
import { Bar } from "../src/components/Bar";
import { Spinner } from "../src/components/common";
import { CardHeading, SectionCard } from "../src/components/Section";
import { NumericSettingCard, type NumericSettingCardProps } from "../src/components/SettingCard";
import { ToastProvider } from "../src/components/Toast";
import { downloadFile } from "../src/lib/download";
import { apiErrorMessage, errorMessage } from "../src/lib/errors";
import { formatQuota } from "../src/lib/format";
import { pollUntil, sleep, usePolling } from "../src/lib/usePolling";
import { button, classes, cls, deferred, toasts, type } from "./helpers";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const flush = () => act(async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); });

describe("usePolling", () => {
  it("calls tick once per interval, the first time one interval after mounting", () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    renderHook(() => usePolling(tick, 5000));
    expect(tick).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(4999);
    expect(tick).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it("does nothing while disabled, starts when enabled and stops when disabled again", () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const { rerender } = renderHook(({ on }) => usePolling(tick, 500, on), { initialProps: { on: false } });
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(0);
    rerender({ on: true });
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    rerender({ on: false });
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("stops on unmount", () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const { unmount } = renderHook(() => usePolling(tick, 500));
    vi.advanceTimersByTime(500);
    unmount();
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("keeps its phase across re-renders with the same tick, and restarts the cycle when tick changes", () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const { rerender } = renderHook(
      ({ id }) => {
        const tick = useCallback(() => { seen.push(id); }, [id]);
        usePolling(tick, 1000);
      },
      { initialProps: { id: "a" } },
    );
    vi.advanceTimersByTime(600);
    rerender({ id: "a" });
    vi.advanceTimersByTime(400);
    expect(seen).toEqual(["a"]);
    vi.advanceTimersByTime(600);
    rerender({ id: "b" });
    // The new cycle starts from the change, not from the old timer's phase.
    vi.advanceTimersByTime(999);
    expect(seen).toEqual(["a"]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(["a", "b"]);
  });

  it("follows a changed interval", () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const { rerender } = renderHook(({ ms }) => usePolling(tick, ms), { initialProps: { ms: 1000 } });
    rerender({ ms: 100 });
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(10);
  });
});

describe("sleep / pollUntil", () => {
  it("sleep resolves after the delay and not before", async () => {
    vi.useFakeTimers();
    let done = false;
    void sleep(300).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(299);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it("waits out the grace period, then resolves with the first answer", async () => {
    vi.useFakeTimers();
    const attempt = vi.fn(async () => "up");
    const result = pollUntil(attempt, { graceMs: 3000, intervalMs: 2500, deadlineMs: 120_000 });
    await vi.advanceTimersByTimeAsync(2999);
    expect(attempt).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(await result).toEqual({ value: "up" });
  });

  it("without a grace period the first attempt is immediate", async () => {
    const attempt = vi.fn(async () => 7);
    expect(await pollUntil(attempt, { intervalMs: 10, deadlineMs: 100 })).toEqual({ value: 7 });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("a falsy answer is still an answer", async () => {
    expect(await pollUntil(async () => null, { intervalMs: 10, deadlineMs: 100 })).toEqual({ value: null });
  });

  it("retries a failed attempt one interval later and swallows the failures", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const attempt = vi.fn(async () => {
      if (++calls < 3) throw new Error("down");
      return "up";
    });
    const result = pollUntil(attempt, { intervalMs: 2500, deadlineMs: 120_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2499);
    expect(attempt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2500);
    expect(await result).toEqual({ value: "up" });
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("gives up at the deadline, counted from the first attempt: 120 s at 2.5 s is 48 attempts, then null", async () => {
    vi.useFakeTimers();
    const attempt = vi.fn(async () => { throw new Error("down"); });
    let settled: unknown = "pending";
    void pollUntil(attempt, { graceMs: 3000, intervalMs: 2500, deadlineMs: 120_000 }).then((r) => { settled = r; });
    await vi.advanceTimersByTimeAsync(3000 + 119_999);
    expect([attempt.mock.calls.length, settled]).toEqual([48, "pending"]);
    await vi.advanceTimersByTimeAsync(1);
    expect([attempt.mock.calls.length, settled]).toEqual([48, null]);
  });
});

describe("api.readResponse", () => {
  const response = (status: number, body: string) => new Response(body || null, { status });

  it("parses a JSON body, keeps a non-JSON body as text, and gives undefined for an empty one", async () => {
    expect(await readResponse(response(200, '{"a":1}'))).toEqual({ a: 1 });
    expect(await readResponse(response(200, "plain"))).toBe("plain");
    expect(await readResponse(response(200, ""))).toBeUndefined();
  });

  it("throws an ApiError carrying the status, the server's error text and the parsed body", async () => {
    const e = await readResponse(response(401, '{"error":"invalid key"}')).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect([(e as ApiError).status, (e as ApiError).message, (e as ApiError).data]).toEqual([401, "invalid key", { error: "invalid key" }]);
  });

  it("falls back to 'Request failed (status)' when the failure names no error", async () => {
    const e = await readResponse(response(502, "<html>bad gateway</html>")).catch((x: unknown) => x);
    expect([(e as ApiError).message, (e as ApiError).data]).toEqual(["Request failed (502)", "<html>bad gateway</html>"]);
    const empty = await readResponse(response(500, "")).catch((x: unknown) => x);
    expect((empty as ApiError).message).toBe("Request failed (500)");
  });
});

describe("format.formatQuota", () => {
  it("writes used / max with a limit", () => {
    expect(formatQuota(1500, 20000)).toBe(`${(1500).toLocaleString()} / ${(20000).toLocaleString()}`);
    expect(formatQuota(0, 0, "unlimited")).toBe("0 / 0");
  });

  it("writes only the usage without one, naming the missing limit when asked to", () => {
    expect(formatQuota(1500, null)).toBe((1500).toLocaleString());
    expect(formatQuota(1500, null, "unlimited")).toBe(`${(1500).toLocaleString()} · unlimited`);
  });
});

describe("download.downloadFile", () => {
  it("saves the text through a temporary object-URL link, as JSON by default, and cleans up", async () => {
    const blobs: Blob[] = [];
    const create = vi.fn((b: Blob) => { blobs.push(b); return "blob:x"; });
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const clicked: { href: string; download: string; attached: boolean }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.getAttribute("href") ?? "", download: this.download, attached: document.body.contains(this) });
    });
    downloadFile("backup.json", '{"a":1}');
    expect(clicked).toEqual([{ href: "blob:x", download: "backup.json", attached: true }]);
    expect([blobs[0]!.type, await blobs[0]!.text()]).toEqual(["application/json", '{"a":1}']);
    expect(revoke).toHaveBeenCalledWith("blob:x");
    expect(document.querySelector("a")).toBeNull();
    downloadFile("notes.txt", "hi", "text/plain");
    expect(blobs[1]!.type).toBe("text/plain");
  });
});

describe("Spinner card variant", () => {
  it("is itself a card, shorter than the page spinner, with the same icon and caption", () => {
    const { container } = render(<Spinner card label="Checking" />);
    const el = container.firstElementChild!;
    expect(classes(el)).toEqual(cls("card card-pad flex items-center justify-center gap-2 py-12 text-ink-400"));
    expect(classes(el.querySelector("i"))).toEqual(cls("bi bi-arrow-repeat animate-spin text-xl"));
    expect([el.querySelector("span")!.textContent, el.querySelector("span")!.className]).toEqual(["Checking", "text-sm"]);
  });

  it("leaves the default spinner as it was", () => {
    const { container } = render(<Spinner />);
    expect(container.firstElementChild!.className).toBe("flex items-center justify-center gap-2 py-16 text-ink-400");
  });
});

describe("Bar", () => {
  it("sm (default): a slim track with a fill as wide as the percentage, not animated", () => {
    const { container } = render(<Bar percent={37.5} tone="bg-brand-600" />);
    const track = container.firstElementChild as HTMLElement;
    const fill = track.firstElementChild as HTMLElement;
    expect(classes(track)).toEqual(cls("h-1.5 overflow-hidden rounded-full bg-ink-800"));
    expect(classes(fill)).toEqual(cls("h-full rounded-full bg-brand-600"));
    expect(fill.style.width).toBe("37.5%");
  });

  it("md animated: the taller meter whose fill glides", () => {
    const { container } = render(<Bar percent={100} tone="bg-red-500" size="md" animated />);
    const track = container.firstElementChild as HTMLElement;
    const fill = track.firstElementChild as HTMLElement;
    expect(classes(track)).toEqual(cls("h-2 overflow-hidden rounded-full bg-ink-800"));
    expect(classes(fill)).toEqual(cls("h-full rounded-full transition-all duration-500 bg-red-500"));
    expect(fill.style.width).toBe("100%");
  });
});

describe("CardHeading", () => {
  it("is an h3 with a brand icon; normal tone, no spacing of its own", () => {
    const { container } = render(<CardHeading icon="bi-graph-up">Traffic</CardHeading>);
    const h = container.firstElementChild!;
    expect([h.tagName, h.textContent]).toEqual(["H3", "Traffic"]);
    expect(classes(h)).toEqual(cls("flex items-center gap-2 text-sm font-semibold text-ink-200"));
    expect(classes(h.querySelector("i"))).toEqual(cls("bi bi-graph-up text-brand-400"));
  });

  it("strong tone and a spacing class", () => {
    const { container } = render(<CardHeading icon="bi-info-circle" tone="strong" className="mb-3">Details</CardHeading>);
    expect(classes(container.firstElementChild)).toEqual(cls("mb-3 flex items-center gap-2 text-sm font-semibold text-ink-100"));
  });
});

describe("SectionCard", () => {
  it("card (default): frame, icon + h3 row, fine-print hint, then the body", () => {
    const { container } = render(<SectionCard icon="bi-archive" title="Backup" hint="Keep a copy."><b>body</b></SectionCard>);
    const el = container.firstElementChild!;
    expect(el.tagName).toBe("DIV");
    expect(classes(el)).toEqual(cls("card card-pad mt-6"));
    expect([...el.children].map((c) => c.tagName)).toEqual(["DIV", "P", "B"]);
    const row = el.children[0]!;
    expect(classes(row)).toEqual(cls("mb-1 flex items-center gap-2"));
    expect(classes(row.querySelector("i"))).toEqual(cls("bi bi-archive text-brand-400"));
    expect([row.querySelector("h3")!.textContent, row.querySelector("h3")!.className]).toEqual(["Backup", "font-medium text-ink-100"]);
    expect([el.children[1]!.textContent, el.children[1]!.className]).toEqual(["Keep a copy.", "mb-3 text-xs text-ink-500"]);
  });

  it("hintGap lg widens the space under the hint", () => {
    const { container } = render(<SectionCard icon="bi-sliders" title="Env" hint="h" hintGap="lg" />);
    expect(container.querySelector("p")!.className).toBe("mb-4 text-xs text-ink-500");
  });

  it("box: a bordered inset with a muted icon and an h4, taking extra frame classes", () => {
    const { container } = render(<SectionCard variant="box" className="mt-4" icon="bi-upload" title="Restore" hint="Put it back." />);
    const el = container.firstElementChild!;
    expect(classes(el)).toEqual(cls("mt-4 rounded-lg border border-ink-800 bg-ink-950/40 p-4"));
    expect(classes(el.querySelector("i"))).toEqual(cls("bi bi-upload text-ink-400"));
    expect([el.querySelector("h4")!.textContent, el.querySelector("h4")!.className]).toEqual(["Restore", "text-sm font-medium text-ink-200"]);
    expect(el.querySelector("h3")).toBeNull();
    expect(el.querySelector("p")!.className).toBe("mb-3 text-xs text-ink-500");
  });

  it("flat: a section with an h2, a body-size hint and no icon", () => {
    const { container } = render(<SectionCard variant="flat" icon="bi-x" title="History" hint="How long."><b>body</b></SectionCard>);
    const el = container.firstElementChild!;
    expect(el.tagName).toBe("SECTION");
    expect(classes(el)).toEqual(cls("card mb-5 space-y-3 p-5"));
    expect([...el.children].map((c) => c.tagName)).toEqual(["H2", "P", "B"]);
    expect([el.querySelector("h2")!.textContent, el.querySelector("h2")!.className]).toEqual(["History", "font-semibold"]);
    expect(el.querySelector("p")!.className).toBe("text-sm text-ink-400");
    expect(el.querySelector("i")).toBeNull();
  });
});

describe("NumericSettingCard", () => {
  type Stored = { days: number };
  type Props = NumericSettingCardProps<Stored>;
  const wrapper = ({ children }: { children: ReactNode }) => <ToastProvider>{children}</ToastProvider>;
  const LOADED = { data: { days: 30 }, loading: false, error: null };
  const LOADING = { data: null, loading: true, error: null };
  const FAILED = { data: null, loading: false, error: "db down" };
  const wholeDays = (raw: string) => (Number.isInteger(Number(raw)) && Number(raw) >= 0 ? Number(raw) : null);
  const base: Props = {
    icon: "bi-clock-history",
    title: "Retention",
    hint: "How long to keep it.",
    state: LOADED,
    loadDisplay: "silent",
    toText: (d) => String(d.days),
    parse: wholeDays,
    invalidMessage: "Not a number of days",
    onSave: async (n) => `Saved ${n}`,
    describeSaveError: (e) => apiErrorMessage(e, "Save failed"),
    input: { mono: true, className: "w-32", inputMode: "numeric", placeholder: "0" },
    unit: "days",
    saveLabel: "Save",
    saveButton: { variant: "ghost", size: "xs", icon: "bi-check-lg", className: "whitespace-nowrap", spinWhenBusy: true },
  };
  const show = (props: Partial<Props> = {}) => render(<NumericSettingCard {...base} {...props} />, { wrapper });
  const box = () => document.querySelector("input")!;
  const save = () => button("Save");

  it("card frame: the stored value in the field, its unit, then Save, on one row", () => {
    const { container } = show();
    const el = container.firstElementChild!;
    expect(classes(el)).toEqual(cls("card card-pad mt-6"));
    expect(el.querySelector("h3")!.textContent).toBe("Retention");
    const row = box().parentElement!;
    expect(row.tagName).toBe("DIV");
    expect(classes(row)).toEqual(cls("flex items-center gap-2"));
    expect([...row.children].map((c) => c.tagName)).toEqual(["INPUT", "SPAN", "BUTTON"]);
    expect([box().value, box().placeholder, box().inputMode, box().type]).toEqual(["30", "0", "numeric", "text"]);
    expect(classes(box())).toEqual(cls("input font-mono text-xs w-32"));
    expect([row.querySelector("span")!.textContent, row.querySelector("span")!.className]).toEqual(["days", "text-xs text-ink-500"]);
    expect(classes(save())).toEqual(cls("btn-ghost btn-xs whitespace-nowrap"));
    expect(classes(save().querySelector("i"))).toEqual(cls("bi bi-check-lg"));
    expect(save().disabled).toBe(false);
  });

  it("wrap lets the row wrap; extra actions follow Save and the footer follows the row", () => {
    show({ wrap: true, extraActions: <button>Clear</button>, footer: <p>1 MiB used</p>, children: <i data-testid="dialog" /> });
    const row = box().parentElement!;
    expect(classes(row)).toEqual(cls("flex flex-wrap items-center gap-2"));
    expect([...row.children].map((c) => c.textContent)).toEqual(["", "days", "Save", "Clear"]);
    expect(row.nextElementSibling!.textContent).toBe("1 MiB used");
    expect(row.parentElement!.lastElementChild!.getAttribute("data-testid")).toBe("dialog");
  });

  it("silent: an empty, usable field while loading and after a failed load -- no spinner, no error", () => {
    const { container, rerender } = show({ state: LOADING });
    expect([box().value, save().disabled]).toEqual(["", false]);
    expect(container.querySelector(".animate-spin")).toBeNull();
    rerender(<NumericSettingCard {...base} state={FAILED} />);
    expect([box().value, container.textContent!.includes("db down")]).toEqual(["", false]);
  });

  it("gated: a spinner alone while loading, the error alone after a failure, the controls once there is a value", () => {
    const footer = <p>usage</p>;
    const { container, rerender } = show({ loadDisplay: "gated", state: LOADING, footer });
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent!.includes("usage")).toBe(false);
    expect(classes(container.querySelector(".animate-spin")!.parentElement)).toEqual(cls("flex items-center justify-center gap-2 py-16 text-ink-400"));
    rerender(<NumericSettingCard {...base} loadDisplay="gated" state={FAILED} footer={footer} />);
    expect(container.querySelector("input")).toBeNull();
    expect(container.firstElementChild!.lastElementChild!.textContent).toBe("db down");
    rerender(<NumericSettingCard {...base} loadDisplay="gated" state={LOADED} footer={footer} />);
    expect([box().value, container.textContent!.includes("usage")]).toEqual(["30", true]);
    // A reload keeps the controls under the spinner.
    rerender(<NumericSettingCard {...base} loadDisplay="gated" state={{ ...LOADED, loading: true }} footer={footer} />);
    expect([container.querySelector(".animate-spin") !== null, box().value]).toEqual([true, "30"]);
  });

  it("flat frame: a section whose row is a label wrapping caption, field and Save", () => {
    const { container } = show({ frame: "flat", caption: "Retention days", unit: undefined, input: { type: "number", min: 0, max: 3650, className: "w-28" }, saveButton: { variant: "primary" } });
    const el = container.firstElementChild!;
    expect([el.tagName, el.querySelector("h2")!.textContent]).toEqual(["SECTION", "Retention"]);
    const label = box().closest("label")!;
    expect(classes(label)).toEqual(cls("flex items-center gap-3"));
    expect([...label.children].map((c) => c.tagName)).toEqual(["SPAN", "INPUT", "BUTTON"]);
    expect([label.querySelector("span")!.textContent, label.querySelector("span")!.className]).toEqual(["Retention days", "text-sm"]);
    expect([box().type, box().min, box().max, box().className]).toEqual(["number", "0", "3650", "input w-28"]);
    expect([save().className, save().querySelector("i")]).toEqual(["btn-primary", null]);
  });

  it("inlineError: shows initialText and holds Save until the value arrives; a failed load is reported last", () => {
    const flat = { frame: "flat" as const, loadDisplay: "inlineError" as const, initialText: "30", caption: "Days" };
    const { container, rerender } = show({ ...flat, state: LOADING });
    expect([box().value, save().disabled]).toEqual(["30", true]);
    expect(container.querySelector(".animate-spin")).toBeNull();
    rerender(<NumericSettingCard {...base} {...flat} state={FAILED} />);
    expect([container.firstElementChild!.lastElementChild!.textContent, save().disabled]).toEqual(["db down", true]);
    rerender(<NumericSettingCard {...base} {...flat} state={{ data: { days: 0 }, loading: false, error: null }} />);
    expect([box().value, save().disabled]).toEqual(["0", false]);
  });

  it("normalize rewrites what is typed before it is kept", () => {
    show({ normalize: (raw) => String(Number(raw)) });
    type(box(), "");
    expect(box().value).toBe("0");
    type(box(), "007");
    expect(box().value).toBe("7");
  });

  it("saves the parsed number, toasts what onSave resolves to, then calls onSaved", async () => {
    const order: string[] = [];
    const onSave = vi.fn(async (n: number) => { order.push(`save ${n}`); return `Kept for ${n} days`; });
    const onSaved = vi.fn(() => { order.push("saved"); });
    show({ onSave, onSaved });
    type(box(), "45");
    fireEvent.click(save());
    await flush();
    expect(onSave.mock.calls).toEqual([[45]]);
    expect(toasts()).toEqual(["Kept for 45 days"]);
    expect(order).toEqual(["save 45", "saved"]);
    expect(box().value).toBe("45");
  });

  it("an unacceptable value toasts invalidMessage and saves nothing; Save is never disabled for it", async () => {
    const onSave = vi.fn(async () => "x");
    show({ onSave });
    type(box(), "1.5");
    fireEvent.click(save());
    expect(save().disabled).toBe(false);
    await flush();
    expect([onSave.mock.calls.length, toasts()]).toEqual([0, ["Not a number of days"]]);
  });

  it("without an invalidMessage a rejected value is dropped silently", async () => {
    const onSave = vi.fn(async () => "x");
    show({ onSave, invalidMessage: undefined, parse: () => null });
    fireEvent.click(save());
    await flush();
    expect([onSave.mock.calls.length, toasts()]).toEqual([0, []]);
  });

  it("is busy while saving: disabled with a spinning icon when the button asks for one, the plain icon otherwise", async () => {
    const gate = deferred<string>();
    const { rerender } = show({ onSave: () => gate.promise });
    fireEvent.click(save());
    await flush();
    expect(save().disabled).toBe(true);
    expect(classes(save().querySelector("i"))).toEqual(cls("bi bi-arrow-repeat animate-spin"));
    rerender(<NumericSettingCard {...base} onSave={() => gate.promise} saveButton={{ variant: "primary" }} />);
    expect([save().disabled, save().querySelector("i")]).toEqual([true, null]);
    await act(async () => { gate.resolve("ok"); });
    await flush();
    expect(save().disabled).toBe(false);
  });

  it("a failed save toasts describeSaveError's text, skips onSaved and frees the button", async () => {
    const onSaved = vi.fn();
    const { rerender } = show({ onSave: async () => { throw new ApiError(400, "days out of range"); }, onSaved });
    fireEvent.click(save());
    await flush();
    rerender(<NumericSettingCard {...base} onSave={async () => { throw new TypeError("offline"); }} onSaved={onSaved} />);
    fireEvent.click(save());
    await flush();
    rerender(<NumericSettingCard {...base} onSave={async () => { throw new TypeError("offline"); }} onSaved={onSaved} describeSaveError={(e) => errorMessage(e)} />);
    fireEvent.click(save());
    await flush();
    expect(toasts()).toEqual(["days out of range", "Save failed", "offline"]);
    expect([onSaved.mock.calls.length, save().disabled]).toEqual([0, false]);
  });

  it("follows a reloaded value, overwriting what was typed", () => {
    function Host() {
      const [days, setDays] = useState(30);
      return (
        <>
          <button onClick={() => setDays(7)}>reload</button>
          <NumericSettingCard {...base} state={{ data: { days }, loading: false, error: null }} />
        </>
      );
    }
    render(<Host />, { wrapper });
    type(box(), "99");
    fireEvent.click(button("reload"));
    expect(box().value).toBe("7");
  });
});
