/**
 * Characterization of the shared components: what they render, the classes
 * that carry their appearance, and what they call back with.
 */
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EmptyState, ErrorNote, Spinner, StatusBadge, Toggle, useConfirm } from "../src/components/common";
import { Modal } from "../src/components/Modal";
import { ToastProvider, useToast } from "../src/components/Toast";
import { ModelList } from "../src/components/ModelList";
import { OverridesEditor } from "../src/components/OverridesEditor";
import { HostedToolBinding } from "../src/components/HostedToolBinding";
import { I18nProvider } from "../src/lib/i18n";
import type { HostedTool, HostedToolOptions, Overrides } from "../src/types";
import { button, classes, cls, field, hasButton, iconButton, mockApi, modal, openModal } from "./helpers";

beforeEach(() => {
  mockApi();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** Render under the i18n provider and let its language sync settle. */
async function renderI18n(ui: React.ReactElement) {
  const view = render(<I18nProvider>{ui}</I18nProvider>);
  await act(async () => {});
  return view;
}

describe("Spinner", () => {
  it("renders a centred spinning icon and no label by default", () => {
    const { container } = render(<Spinner />);
    const root = container.firstElementChild!;
    expect(classes(root)).toEqual(cls("flex items-center justify-center gap-2 py-16 text-ink-400"));
    expect(classes(root.querySelector("i"))).toEqual(cls("bi bi-arrow-repeat animate-spin text-xl"));
    expect(root.querySelector("span")).toBeNull();
    expect(root.textContent).toBe("");
  });

  it("renders the label beside the icon when given", () => {
    const { container } = render(<Spinner label="Loading things" />);
    const span = container.querySelector("span")!;
    expect(span.textContent).toBe("Loading things");
    expect(classes(span)).toEqual(cls("text-sm"));
  });
});

describe("EmptyState", () => {
  it("renders icon and title only when hint and action are omitted", () => {
    const { container } = render(<EmptyState icon="bi-box" title="Nothing here" />);
    const root = container.firstElementChild!;
    expect(classes(root)).toEqual(cls("flex flex-col items-center justify-center gap-3 py-16 text-center"));
    expect(classes(root.querySelector("i"))).toEqual(cls("bi bi-box text-4xl text-ink-600"));
    expect(root.children).toHaveLength(2);
    expect(root.children[1].textContent).toBe("Nothing here");
    expect(classes(root.children[1])).toEqual(cls("text-sm font-medium text-ink-300"));
  });

  it("renders the hint and the action after the title", () => {
    const { container } = render(<EmptyState icon="bi-key" title="T" hint="Do this first" action={<button>Go</button>} />);
    const root = container.firstElementChild!;
    expect([...root.children].map((c) => c.tagName)).toEqual(["I", "DIV", "DIV", "BUTTON"]);
    expect(root.children[2].textContent).toBe("Do this first");
    expect(classes(root.children[2])).toEqual(cls("max-w-sm text-xs text-ink-500"));
    expect(root.children[3].textContent).toBe("Go");
  });
});

describe("StatusBadge", () => {
  it.each([
    [200, "badge-green"],
    [204, "badge-green"],
    [299, "badge-green"],
    [199, "badge-red"],
    [300, "badge-red"],
    [404, "badge-red"],
    [498, "badge-red"],
    [499, "badge-gray"],
    [500, "badge-red"],
  ])("status %i is shown as itself with %s", async (status, badge) => {
    const { container } = await renderI18n(<StatusBadge status={status} />);
    const span = container.querySelector("span")!;
    expect(span.textContent).toBe(String(status));
    expect(classes(span)).toEqual([badge]);
  });

  it("status 0 (no response) is red and labelled with the localized error word", async () => {
    const { container } = await renderI18n(<StatusBadge status={0} />);
    const span = container.querySelector("span")!;
    expect(span.textContent).toBe("error");
    expect(classes(span)).toEqual(["badge-red"]);
  });

  it("an explicit label replaces the number but not the colour", async () => {
    const { container } = await renderI18n(<><StatusBadge status={200} label="OK" /><StatusBadge status={0} label="aborted" /></>);
    const spans = container.querySelectorAll("span");
    expect([spans[0].textContent, classes(spans[0])]).toEqual(["OK", ["badge-green"]]);
    expect([spans[1].textContent, classes(spans[1])]).toEqual(["aborted", ["badge-red"]]);
  });
});

describe("ErrorNote", () => {
  it("renders the message in a red bordered box with an octagon icon", () => {
    const { container } = render(<ErrorNote message="It broke" />);
    const root = container.firstElementChild!;
    expect(root.textContent).toBe("It broke");
    expect(classes(root)).toEqual(cls("flex items-center gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300"));
    expect(classes(root.querySelector("i"))).toEqual(cls("bi bi-exclamation-octagon-fill"));
  });
});

describe("Toggle", () => {
  it("off: grey track, knob at the left, pointer cursor, type=button", () => {
    const { container } = render(<Toggle checked={false} onChange={() => {}} />);
    const label = container.querySelector("label")!;
    const btn = label.querySelector("button")!;
    expect(classes(label)).toEqual(cls("inline-flex select-none items-center gap-2 cursor-pointer"));
    expect(classes(btn)).toEqual(cls("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors bg-ink-700"));
    expect(classes(btn.querySelector("span"))).toEqual(cls("inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform translate-x-[2px]"));
    expect(btn.type).toBe("button");
    expect(btn.disabled).toBe(false);
    expect(label.textContent).toBe("");
  });

  it("on: brand track, knob at the right", () => {
    const { container } = render(<Toggle checked onChange={() => {}} />);
    const btn = container.querySelector("button")!;
    expect(classes(btn)).toEqual(cls("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors bg-brand-600"));
    expect(classes(btn.querySelector("span"))).toEqual(cls("inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform translate-x-[18px]"));
  });

  it("renders the label text beside the switch", () => {
    const { container } = render(<Toggle checked onChange={() => {}} label="Enabled" />);
    const text = container.querySelector("label > span")!;
    expect(text.textContent).toBe("Enabled");
    expect(classes(text)).toEqual(cls("text-sm text-ink-300"));
  });

  it.each([[false, true], [true, false]])("clicking when checked=%s calls onChange(%s) once", (checked, next) => {
    const onChange = vi.fn();
    const { container } = render(<Toggle checked={checked} onChange={onChange} label="L" />);
    fireEvent.click(container.querySelector("button")!);
    expect(onChange.mock.calls).toEqual([[next]]);
  });

  it("clicking the label text toggles too (the switch is inside the label)", () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Enabled" />);
    fireEvent.click(screen.getByText("Enabled"));
    expect(onChange.mock.calls).toEqual([[true]]);
  });

  it("disabled: dimmed, not-allowed cursor, button disabled, never calls onChange", () => {
    const onChange = vi.fn();
    const { container } = render(<Toggle checked onChange={onChange} label="Enabled" disabled />);
    const label = container.querySelector("label")!;
    const btn = label.querySelector("button")!;
    expect(classes(label)).toEqual(cls("inline-flex select-none items-center gap-2 cursor-not-allowed opacity-60"));
    expect(classes(btn)).toEqual(cls("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors bg-brand-600 cursor-not-allowed"));
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    fireEvent.click(screen.getByText("Enabled"));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("useConfirm", () => {
  function Harness({ onResult }: { onResult: (v: boolean) => void }) {
    const { confirm, confirmEl } = useConfirm();
    return (
      <div>
        <button onClick={() => void confirm("Delete thing", "Really delete it?").then(onResult)}>ask</button>
        {confirmEl}
      </div>
    );
  }
  const ask = async () => {
    const onResult = vi.fn();
    await renderI18n(<Harness onResult={onResult} />);
    expect(modal("Delete thing")).toBeNull();
    fireEvent.click(button("ask"));
    return onResult;
  };

  it("renders nothing until asked, then a modal with the title, message and two buttons", async () => {
    await ask();
    const m = openModal("Delete thing");
    expect(classes(m.querySelector("h2 i"))).toEqual(cls("bi bi-exclamation-triangle-fill text-brand-400"));
    const message = screen.getByText("Really delete it?");
    expect(message.tagName).toBe("P");
    expect(classes(message)).toEqual(cls("text-sm text-ink-300"));
    expect(classes(button("Cancel", m))).toEqual(["btn-ghost"]);
    const confirmBtn = button("Confirm", m);
    expect(classes(confirmBtn)).toEqual(["btn-danger"]);
    expect(classes(confirmBtn.querySelector("i"))).toEqual(cls("bi bi-trash3"));
    // Cancel comes first, the destructive action last.
    const footer = confirmBtn.parentElement!;
    expect([...footer.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Cancel", "Confirm"]);
  });

  it("resolves true on Confirm and closes", async () => {
    const onResult = await ask();
    await act(async () => { fireEvent.click(button("Confirm")); });
    expect(onResult.mock.calls).toEqual([[true]]);
    expect(modal("Delete thing")).toBeNull();
  });

  it("resolves false on Cancel and closes", async () => {
    const onResult = await ask();
    await act(async () => { fireEvent.click(button("Cancel")); });
    expect(onResult.mock.calls).toEqual([[false]]);
    expect(modal("Delete thing")).toBeNull();
  });

  it("resolves false when dismissed with the title-bar close button", async () => {
    const onResult = await ask();
    await act(async () => { fireEvent.click(iconButton("bi-x-lg", openModal("Delete thing"))); });
    expect(onResult.mock.calls).toEqual([[false]]);
    expect(modal("Delete thing")).toBeNull();
  });

  it("can be asked again after it was answered", async () => {
    const onResult = await ask();
    await act(async () => { fireEvent.click(button("Cancel")); });
    fireEvent.click(button("ask"));
    await act(async () => { fireEvent.click(button("Confirm")); });
    expect(onResult.mock.calls).toEqual([[false], [true]]);
  });
});

describe("Modal", () => {
  it("renders nothing while closed", () => {
    const { container } = render(<Modal open={false} title="T" onClose={() => {}}>body</Modal>);
    expect(container.innerHTML).toBe("");
  });

  it("renders overlay, card, title bar, body and no footer by default", () => {
    const { container } = render(<Modal open title="My title" onClose={() => {}}><p>the body</p></Modal>);
    const overlay = container.firstElementChild!;
    expect(classes(overlay)).toEqual(cls("fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"));
    const card = overlay.firstElementChild!;
    expect(classes(card)).toEqual(cls("card flex max-h-[92vh] w-full flex-col max-w-lg"));
    expect(card.children).toHaveLength(2);
    const [bar, body] = [...card.children];
    expect(classes(bar)).toEqual(cls("flex shrink-0 items-center justify-between border-b border-ink-800 px-5 py-3.5"));
    const h2 = bar.querySelector("h2")!;
    expect(h2.textContent).toBe("My title");
    expect(classes(h2)).toEqual(cls("flex items-center gap-2 text-base font-semibold text-ink-100"));
    expect(h2.querySelector("i")).toBeNull();
    expect(classes(body)).toEqual(cls("card-pad min-h-0 flex-1 overflow-y-auto"));
    expect(body.innerHTML).toBe("<p>the body</p>");
    const close = bar.querySelector("button")!;
    expect(classes(close)).toEqual(cls("text-ink-500 hover:text-ink-200"));
    expect(classes(close.querySelector("i"))).toEqual(cls("bi bi-x-lg"));
  });

  it.each([
    [undefined, "max-w-lg"],
    ["md" as const, "max-w-lg"],
    ["lg" as const, "max-w-2xl"],
    ["xl" as const, "max-w-4xl"],
  ])("size %s uses width class %s", (size, width) => {
    const { container } = render(<Modal open title="T" size={size} onClose={() => {}}>x</Modal>);
    expect(classes(container.querySelector(".card"))).toEqual(cls(`card flex max-h-[92vh] w-full flex-col ${width}`));
  });

  it("renders the title icon in the brand colour", () => {
    render(<Modal open title="T" icon="bi-key" onClose={() => {}}>x</Modal>);
    expect(classes(openModal("T").querySelector("h2 i"))).toEqual(cls("bi bi-key text-brand-400"));
  });

  it("renders the footer right-aligned under a top border", () => {
    render(<Modal open title="T" onClose={() => {}} footer={<button>Save</button>}>x</Modal>);
    const footer = button("Save").parentElement!;
    expect(classes(footer)).toEqual(cls("flex shrink-0 justify-end gap-2 border-t border-ink-800 px-5 py-3.5"));
    expect(openModal("T").lastElementChild).toBe(footer);
  });

  it("renders headerExtra before the close button", () => {
    render(<Modal open title="T" onClose={() => {}} headerExtra={<button>extra</button>}>x</Modal>);
    const group = button("extra").parentElement!;
    expect(classes(group)).toEqual(cls("flex items-center gap-3"));
    expect([...group.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["extra", ""]);
  });

  it("calls onClose from the close button only: not from the backdrop, the card or Escape", () => {
    const onClose = vi.fn();
    const { container } = render(<Modal open title="T" onClose={onClose}>x</Modal>);
    fireEvent.click(container.firstElementChild!);
    fireEvent.click(container.querySelector(".card")!);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(iconButton("bi-x-lg"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Toast", () => {
  function Pusher() {
    const toast = useToast();
    return (
      <div>
        <button onClick={() => toast.success("saved")}>success</button>
        <button onClick={() => toast.error("failed")}>error</button>
        <button onClick={() => toast.info("fyi")}>info</button>
        <button onClick={() => toast.push("info", "pushed")}>push</button>
      </div>
    );
  }
  const stack = () => document.querySelector(".pointer-events-none")!;
  const items = () => [...stack().children];
  const texts = () => items().map((t) => t.querySelector("span")!.textContent);

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("useToast throws outside the provider", () => {
    // React re-throws through a DOM event in development; keep both echoes out of the output.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const swallow = (e: ErrorEvent) => e.preventDefault();
    window.addEventListener("error", swallow);
    expect(() => render(<Pusher />)).toThrow("useToast must be used within ToastProvider");
    window.removeEventListener("error", swallow);
    quiet.mockRestore();
  });

  it("renders the children and an empty stack pinned bottom-right above modals", () => {
    render(<ToastProvider><Pusher /></ToastProvider>);
    expect(hasButton("success")).toBe(true);
    expect(classes(stack())).toEqual(cls("pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2"));
    expect(items()).toHaveLength(0);
  });

  it.each([
    ["success", "saved", "bi bi-check-circle-fill text-emerald-400 mt-0.5"],
    ["error", "failed", "bi bi-exclamation-triangle-fill text-red-400 mt-0.5"],
    ["info", "fyi", "bi bi-info-circle-fill text-brand-400 mt-0.5"],
    ["push", "pushed", "bi bi-info-circle-fill text-brand-400 mt-0.5"],
  ])("%s shows its message with the matching icon", (kind, message, icon) => {
    render(<ToastProvider><Pusher /></ToastProvider>);
    fireEvent.click(button(kind));
    const [item] = items();
    expect(classes(item)).toEqual(cls("pointer-events-auto flex items-start gap-3 rounded-lg border border-ink-700 bg-ink-850 px-4 py-3 text-sm shadow-xl shadow-black/40"));
    expect(classes(item.querySelector("i"))).toEqual(cls(icon));
    const text = item.querySelector("span")!;
    expect(text.textContent).toBe(message);
    expect(classes(text)).toEqual(cls("flex-1 text-ink-100"));
    expect(classes(item.querySelector("button"))).toEqual(cls("text-ink-500 hover:text-ink-200"));
    expect(classes(item.querySelector("button i"))).toEqual(cls("bi bi-x-lg"));
  });

  it("removes a toast after 4500 ms, not before", () => {
    render(<ToastProvider><Pusher /></ToastProvider>);
    fireEvent.click(button("success"));
    act(() => { vi.advanceTimersByTime(4499); });
    expect(texts()).toEqual(["saved"]);
    act(() => { vi.advanceTimersByTime(1); });
    expect(texts()).toEqual([]);
  });

  it("stacks toasts oldest first and expires each on its own clock", () => {
    render(<ToastProvider><Pusher /></ToastProvider>);
    fireEvent.click(button("success"));
    act(() => { vi.advanceTimersByTime(2000); });
    fireEvent.click(button("error"));
    fireEvent.click(button("success"));
    expect(texts()).toEqual(["saved", "failed", "saved"]);
    act(() => { vi.advanceTimersByTime(2500); });
    expect(texts()).toEqual(["failed", "saved"]);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(texts()).toEqual([]);
  });

  it("dismisses one toast early from its close button and leaves the others", () => {
    render(<ToastProvider><Pusher /></ToastProvider>);
    fireEvent.click(button("success"));
    fireEvent.click(button("error"));
    fireEvent.click(items()[0].querySelector("button")!);
    expect(texts()).toEqual(["failed"]);
    // The dismissed toast's timer firing later is harmless.
    act(() => { vi.advanceTimersByTime(4500); });
    expect(texts()).toEqual([]);
  });
});

describe("ModelList", () => {
  const MODELS = ["gpt-4o", "gpt-4o-mini", "Claude-Sonnet", "o3"];
  const rows = (c: ParentNode) => [...c.querySelectorAll("li")].map((li) => li.textContent);

  it("shows only the empty text when there are no models", async () => {
    const { container } = await renderI18n(<ModelList models={[]} emptyText="Nothing reported" />);
    expect(container.children).toHaveLength(1);
    const p = container.firstElementChild!;
    expect(p.tagName).toBe("P");
    expect(p.textContent).toBe("Nothing reported");
    expect(classes(p)).toEqual(cls("rounded-lg border border-dashed border-ink-700 px-3 py-2.5 text-xs text-ink-500"));
    expect(container.querySelector("input")).toBeNull();
  });

  it("uncontrolled + read-only: a search box and plain rows", async () => {
    const { container } = await renderI18n(<ModelList models={MODELS} emptyText="none" />);
    const root = container.firstElementChild!;
    expect(classes(root)).toEqual(cls("overflow-hidden rounded-lg border border-ink-700 bg-ink-950/40"));
    const input = container.querySelector("input")!;
    expect(input.placeholder).toBe("Search models...");
    expect(classes(input)).toEqual(cls("input py-1.5 text-xs"));
    expect(classes(input.parentElement)).toEqual(cls("border-b border-ink-800 p-2"));
    expect(classes(container.querySelector("ul"))).toEqual(cls("max-h-48 overflow-y-auto"));
    expect(rows(container)).toEqual(MODELS);
    expect(container.querySelector("li button")).toBeNull();
    const row = container.querySelector("li > span")!;
    expect(classes(row)).toEqual(cls("flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs text-ink-300"));
    expect(classes(row.querySelector("i"))).toEqual(cls("bi bi-dot shrink-0"));
    expect(classes(row.querySelector("span"))).toEqual(["truncate"]);
  });

  it("filters by its own search box: substring, case-insensitive, trimmed", async () => {
    const { container } = await renderI18n(<ModelList models={MODELS} emptyText="none" />);
    const input = container.querySelector("input")!;
    fireEvent.change(input, { target: { value: "  GPT " } });
    expect(rows(container)).toEqual(["gpt-4o", "gpt-4o-mini"]);
    fireEvent.change(input, { target: { value: "sonnet" } });
    expect(rows(container)).toEqual(["Claude-Sonnet"]);
    fireEvent.change(input, { target: { value: "   " } });
    expect(rows(container)).toEqual(MODELS);
  });

  it("says so when nothing matches, keeping the search box", async () => {
    const { container } = await renderI18n(<ModelList models={MODELS} emptyText="none" />);
    fireEvent.change(container.querySelector("input")!, { target: { value: "zzz" } });
    expect(container.querySelector("ul")).toBeNull();
    const p = screen.getByText('No model matches "zzz".');
    expect(classes(p)).toEqual(cls("px-3 py-2.5 text-xs text-ink-500"));
    expect(container.querySelector("input")).not.toBeNull();
  });

  it("controlled: no search box, the caller's filter narrows the list", async () => {
    const { container, rerender } = await renderI18n(<ModelList models={MODELS} filter="" emptyText="none" />);
    expect(container.querySelector("input")).toBeNull();
    expect(rows(container)).toEqual(MODELS);
    rerender(<I18nProvider><ModelList models={MODELS} filter="MINI" emptyText="none" /></I18nProvider>);
    expect(rows(container)).toEqual(["gpt-4o-mini"]);
  });

  it("picker: rows are buttons that report the clicked model", async () => {
    const onPick = vi.fn();
    const { container } = await renderI18n(<ModelList models={MODELS} filter="" onPick={onPick} emptyText="none" />);
    const btn = button("o3", container);
    expect(btn.type).toBe("button");
    expect(classes(btn)).toEqual(cls("flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs text-ink-300 hover:bg-ink-800"));
    expect(classes(btn.querySelector("i"))).toEqual(cls("bi bi-dot shrink-0"));
    fireEvent.click(btn);
    expect(onPick.mock.calls).toEqual([["o3"]]);
  });

  it("picker: the selected row is highlighted with a check mark", async () => {
    const { container } = await renderI18n(<ModelList models={MODELS} filter="" selected="gpt-4o" onPick={() => {}} emptyText="none" />);
    const selected = button("gpt-4o", container);
    expect(classes(selected)).toEqual(cls("flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs bg-brand-700/25 text-brand-400 hover:bg-ink-800"));
    expect(classes(selected.querySelector("i"))).toEqual(cls("bi bi-check-lg shrink-0"));
    expect(classes(button("gpt-4o-mini", container).querySelector("i"))).toEqual(cls("bi bi-dot shrink-0"));
  });

  it("read-only: the selected row is highlighted but keeps the dot", async () => {
    const { container } = await renderI18n(<ModelList models={MODELS} selected="o3" emptyText="none" />);
    const row = [...container.querySelectorAll("li > span")].find((s) => s.textContent === "o3")!;
    expect(classes(row)).toEqual(cls("flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs bg-brand-700/25 text-brand-400"));
    expect(classes(row.querySelector("i"))).toEqual(cls("bi bi-dot shrink-0"));
  });

  it.each([
    [199, 199, null],
    [200, 200, null],
    [201, 200, "+1 more — refine the search to see them."],
    [450, 200, "+250 more — refine the search to see them."],
  ])("with %i models renders %i rows and the overflow note %j", async (total, shown, note) => {
    const models = Array.from({ length: total }, (_, i) => `model-${i}`);
    const { container } = await renderI18n(<ModelList models={models} emptyText="none" />);
    expect(container.querySelectorAll("li")).toHaveLength(shown);
    const more = container.querySelector("p");
    expect(more?.textContent ?? null).toBe(note);
    if (more) expect(classes(more)).toEqual(cls("border-t border-ink-800 px-3 py-1.5 text-xs text-ink-500"));
  });

  it("counts the overflow against the filtered matches, not the whole list", async () => {
    const models = [...Array.from({ length: 205 }, (_, i) => `aa-${i}`), ...Array.from({ length: 50 }, (_, i) => `bb-${i}`)];
    const { container } = await renderI18n(<ModelList models={models} filter="aa" emptyText="none" />);
    expect(container.querySelectorAll("li")).toHaveLength(200);
    expect(container.querySelector("p")!.textContent).toBe("+5 more — refine the search to see them.");
  });
});

describe("OverridesEditor", () => {
  /** A parent that echoes onChange back as the prop, as every real caller does. */
  function Harness({ initial, spy }: { initial?: Overrides; spy: (ov: Overrides | undefined) => void }) {
    const [ov, setOv] = useState<Overrides | undefined>(initial);
    return (
      <div>
        <OverridesEditor overrides={ov} onChange={(v) => { spy(v); setOv(v); }} />
        <button onClick={() => setOv({ seed: 7 })}>external</button>
      </div>
    );
  }
  const setup = async (initial?: Overrides) => {
    const spy = vi.fn();
    const view = await renderI18n(<Harness initial={initial} spy={spy} />);
    return { spy, ...view };
  };
  const keyInputs = () => [...document.querySelectorAll<HTMLInputElement>('input[placeholder="parameter"]')];
  const valueInputs = () => [...document.querySelectorAll<HTMLInputElement>('input[placeholder="content — JSON or text"]')];
  const rowValues = () => keyInputs().map((k, i) => [k.value, valueInputs()[i].value]);
  const last = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls[spy.mock.calls.length - 1][0] as unknown;
  const type = (el: Element, value: string) => fireEvent.change(el, { target: { value } });
  const ACTIVE = "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors bg-brand-600 text-white";
  const INACTIVE = "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors border border-ink-700 bg-ink-900 text-ink-400 hover:text-ink-200";

  it("empty: panel, title with hint, Fields mode active, the empty hint and an add button", async () => {
    const { container, spy } = await setup();
    const panel = container.firstElementChild!.firstElementChild!;
    expect(classes(panel)).toEqual(cls("rounded-lg border border-ink-800 bg-ink-950/40 p-3"));
    const title = panel.querySelector(".label")!;
    expect(title.textContent).toBe("Parameter overridesparameter/content pairs applied to the outgoing request");
    expect(classes(title)).toEqual(cls("label mb-0"));
    expect(classes(title.querySelector("span"))).toEqual(cls("ml-2 normal-case text-ink-500"));
    expect(classes(button("Fields"))).toEqual(cls(ACTIVE));
    expect(classes(button("JSON"))).toEqual(cls(INACTIVE));
    expect(classes(button("Fields").querySelector("i"))).toEqual(cls("bi bi-sliders mr-1"));
    expect(classes(button("JSON").querySelector("i"))).toEqual(cls("bi bi-code-slash mr-1"));
    expect(screen.getByText(/^No overrides\. Add a parameter/)).toBeTruthy();
    expect(keyInputs()).toHaveLength(0);
    expect(classes(button("Add parameter"))).toEqual(cls("btn-ghost btn-xs"));
    expect(screen.getByText(/^Content that parses as JSON is sent typed/)).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  it("shows stored values so they survive the plain-text round trip", async () => {
    const stored = {
      temperature: 0.5,
      logprobs: true,
      stop: ["a", "b"],
      extra: { a: 1 },
      user: "bob",
      system: " padded ",
      serviceTier: "123",
      verbosity: "true",
      thinking: "line1\nline2",
    } as unknown as Overrides;
    const { spy } = await setup(stored);
    expect(rowValues()).toEqual([
      ["temperature", "0.5"],
      ["logprobs", "true"],
      ["stop", '["a","b"]'],
      ["extra", '{"a":1}'],
      ["user", "bob"],
      ["system", '" padded "'],
      ["serviceTier", '"123"'],
      ["verbosity", '"true"'],
      ["thinking", '"line1\\nline2"'],
    ]);
    expect(spy).not.toHaveBeenCalled();
    // Touching one row re-emits every row with its original type intact.
    type(valueInputs()[0], "0.7");
    expect(last(spy)).toEqual({ ...stored, temperature: 0.7 });
  });

  it("styles a row: mono key and value inputs and a small danger remove button", async () => {
    await setup({ topP: 0.9 });
    expect(classes(keyInputs()[0])).toEqual(cls("input h-8 w-40 py-0 font-mono text-xs"));
    expect(classes(valueInputs()[0])).toEqual(cls("input h-8 flex-1 py-0 font-mono text-xs"));
    expect(keyInputs()[0].type).toBe("text");
    expect(keyInputs()[0].title).toBe("");
    const remove = document.querySelector<HTMLButtonElement>('button[title="Remove override"]')!;
    expect(classes(remove)).toEqual(cls("btn-danger btn-xs shrink-0"));
    expect(classes(remove.querySelector("i"))).toEqual(cls("bi bi-x-lg"));
    expect(classes(keyInputs()[0].parentElement)).toEqual(cls("flex items-start gap-1.5"));
    expect(screen.queryByText(/^No overrides\./)).toBeNull();
  });

  it("adding a row emits nothing; a half-typed row survives the parent echo", async () => {
    const { spy } = await setup();
    fireEvent.click(button("Add parameter"));
    expect(rowValues()).toEqual([["", ""]]);
    expect(spy).not.toHaveBeenCalled();
    type(keyInputs()[0], "topP");
    expect(spy.mock.calls).toEqual([[undefined]]);
    expect(rowValues()).toEqual([["topP", ""]]);
    type(valueInputs()[0], "0.9");
    expect(last(spy)).toEqual({ topP: 0.9 });
    expect(rowValues()).toEqual([["topP", "0.9"]]);
  });

  it.each([
    ["0.9", 0.9],
    ["42", 42],
    [" 7 ", 7],
    ["true", true],
    ["null", null],
    ['["a","b"]', ["a", "b"]],
    ['{"k":1}', { k: 1 }],
    ["hello world", "hello world"],
    ["  padded text  ", "padded text"],
    ['"5"', "5"],
    ['" keep "', " keep "],
    ["{broken", "{broken"],
  ])("coerces the content %j to %j", async (raw, expected) => {
    const { spy } = await setup();
    fireEvent.click(button("Add parameter"));
    type(keyInputs()[0], "p");
    type(valueInputs()[0], raw);
    expect(last(spy)).toEqual({ p: expected });
  });

  it.each([[""], ["   "]])("drops a row whose content is blank (%j)", async (raw) => {
    const { spy } = await setup({ seed: 1 });
    type(valueInputs()[0], raw);
    expect(last(spy)).toBeUndefined();
  });

  it("drops a row whose name is blank and trims the name of the others", async () => {
    const { spy } = await setup();
    fireEvent.click(button("Add parameter"));
    fireEvent.click(button("Add parameter"));
    type(valueInputs()[0], "1");
    expect(last(spy)).toBeUndefined();
    type(keyInputs()[1], "  seed  ");
    type(valueInputs()[1], "2");
    expect(last(spy)).toEqual({ seed: 2 });
  });

  it("removing a row emits what is left, and undefined when nothing is", async () => {
    const { spy } = await setup({ topP: 0.9, seed: 3 });
    const removeButtons = () => [...document.querySelectorAll<HTMLButtonElement>('button[title="Remove override"]')];
    fireEvent.click(removeButtons()[0]);
    expect(last(spy)).toEqual({ seed: 3 });
    expect(rowValues()).toEqual([["seed", "3"]]);
    fireEvent.click(removeButtons()[0]);
    expect(last(spy)).toBeUndefined();
    expect(rowValues()).toEqual([]);
    expect(screen.getByText(/^No overrides\./)).toBeTruthy();
  });

  it("marks every row of a duplicated name, warns, and saves the last one", async () => {
    const { spy } = await setup({ topP: 0.9, seed: 3 });
    expect(screen.queryByText("Duplicate parameter name — only the last one is saved")).toBeNull();
    type(keyInputs()[1], " topP ");
    expect(classes(keyInputs()[0])).toEqual(cls("input h-8 w-40 py-0 font-mono text-xs border-red-500/70"));
    expect(classes(keyInputs()[1])).toEqual(cls("input h-8 w-40 py-0 font-mono text-xs border-red-500/70"));
    expect(keyInputs()[0].title).toBe("Duplicate parameter name — only the last one is saved");
    const warning = screen.getByText("Duplicate parameter name — only the last one is saved");
    expect(classes(warning)).toEqual(cls("text-[11px] text-red-400"));
    expect(classes(warning.querySelector("i"))).toEqual(cls("bi bi-exclamation-triangle mr-1"));
    expect(last(spy)).toEqual({ topP: 3 });
    type(keyInputs()[1], "seed");
    expect(screen.queryByText("Duplicate parameter name — only the last one is saved")).toBeNull();
    expect(classes(keyInputs()[0])).toEqual(cls("input h-8 w-40 py-0 font-mono text-xs"));
  });

  it("JSON mode shows the current overrides pretty-printed", async () => {
    const { spy } = await setup({ topP: 0.9, stop: ["x"] });
    fireEvent.click(button("JSON"));
    expect(classes(button("JSON"))).toEqual(cls(ACTIVE));
    expect(classes(button("Fields"))).toEqual(cls(INACTIVE));
    const area = document.querySelector("textarea")!;
    expect(area.value).toBe(JSON.stringify({ topP: 0.9, stop: ["x"] }, null, 2));
    expect(classes(area)).toEqual(cls("input min-h-[160px] font-mono text-xs"));
    expect(area.placeholder).toBe('{"topP": 0.9, "topK": 40, "maxTokens": 4096, "thinking": "high"}');
    expect(keyInputs()).toHaveLength(0);
    expect(hasButton("Add parameter")).toBe(false);
    const hint = screen.getByText(/^Paste a JSON object\./);
    expect(classes(hint)).toEqual(cls("mt-1 text-[11px] text-ink-600"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("JSON mode of an empty editor is an empty textarea", async () => {
    await setup();
    fireEvent.click(button("JSON"));
    expect(document.querySelector("textarea")!.value).toBe("");
  });

  it("JSON mode emits a valid object, undefined when cleared, and nothing otherwise", async () => {
    const { spy } = await setup({ topP: 0.9 });
    fireEvent.click(button("JSON"));
    const area = document.querySelector("textarea")!;
    type(area, '{"seed": 5}');
    expect(spy.mock.calls).toEqual([[{ seed: 5 }]]);
    for (const text of ['{"seed": ', "[1,2]", "5", '"text"', "null", "true"]) {
      type(area, text);
      expect(area.value).toBe(text);
    }
    expect(spy).toHaveBeenCalledTimes(1);
    type(area, "   ");
    expect(spy.mock.calls).toEqual([[{ seed: 5 }], [undefined]]);
    type(area, "{}");
    expect(last(spy)).toEqual({});
  });

  it("switching back to Fields rebuilds the rows from what JSON mode emitted", async () => {
    await setup({ topP: 0.9 });
    fireEvent.click(button("JSON"));
    type(document.querySelector("textarea")!, '{"seed": 5, "user": "al"}');
    fireEvent.click(button("Fields"));
    expect(rowValues()).toEqual([["seed", "5"], ["user", "al"]]);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("clicking the active mode again keeps unsaved rows", async () => {
    await setup();
    fireEvent.click(button("Add parameter"));
    fireEvent.click(button("Fields"));
    expect(rowValues()).toEqual([["", ""]]);
  });

  it("an external change of the overrides prop replaces the rows", async () => {
    const { spy } = await setup({ topP: 0.9 });
    fireEvent.click(button("Add parameter"));
    await act(async () => { fireEvent.click(button("external")); });
    expect(rowValues()).toEqual([["seed", "7"]]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("focusing a content input selects its text", async () => {
    await setup({ topP: 0.9 });
    const input = valueInputs()[0];
    const select = vi.spyOn(input, "select");
    fireEvent.focus(input);
    expect(select).toHaveBeenCalledTimes(1);
  });
});

describe("HostedToolBinding", () => {
  const tool = (id: number, name: string, enabled = true): HostedTool => ({
    id, name, enabled, description: "", parameters: {}, url: "https://t.example/x", bodyTemplate: {}, resultPath: "/result",
    timeoutMs: 30000, maxResultBytes: 65536, headerNames: [], hasHeaders: false,
  });
  const CONFIG: HostedToolOptions = { streamMode: "progress", maxRounds: 4, maxCalls: 8 };
  const setup = async (tools: HostedTool[], ids: number[] = [], config: HostedToolOptions = CONFIG) => {
    const onIds = vi.fn();
    const onConfig = vi.fn();
    const view = await renderI18n(<HostedToolBinding tools={tools} ids={ids} config={config} onIds={onIds} onConfig={onConfig} />);
    return { onIds, onConfig, ...view };
  };

  it("renders a bordered fieldset with a legend and the two explanations", async () => {
    const { container } = await setup([]);
    const fs = container.querySelector("fieldset")!;
    expect(classes(fs)).toEqual(cls("space-y-3 rounded-lg border border-ink-700 p-4"));
    const legend = fs.querySelector("legend")!;
    expect(legend.textContent).toBe("Hosted server tools");
    expect(classes(legend)).toEqual(cls("px-2 text-sm font-semibold"));
    expect(screen.getByText(/^Bound tools are supplied automatically\./)).toBeTruthy();
    expect(screen.getByText(/^Process events use Hydrogen SSE extensions/)).toBeTruthy();
  });

  it("links to the Tools page when no tool is registered", async () => {
    const { container } = await setup([]);
    const link = screen.getByText("Register a tool on the Tools page") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/tools");
    expect(classes(link)).toEqual(cls("text-sm text-brand-400"));
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it("lists each tool as a checkbox, ticked when bound, flagging disabled tools", async () => {
    const { container } = await setup([tool(1, "search"), tool(2, "fetch", false)], [2]);
    expect(screen.queryByText("Register a tool on the Tools page")).toBeNull();
    const search = field("search", container);
    const fetchBox = field("fetch", container);
    expect([search.type, search.checked]).toEqual(["checkbox", false]);
    expect(fetchBox.checked).toBe(true);
    expect(search.closest("label")!.textContent).toBe("search");
    expect(fetchBox.closest("label")!.textContent).toBe("fetch(disabled)");
    expect(classes(search.closest("label"))).toEqual(cls("flex items-center gap-2 text-sm"));
    expect(classes(fetchBox.closest("label")!.querySelector("span"))).toEqual(["text-ink-500"]);
    expect(classes(search.closest("label")!.parentElement)).toEqual(cls("flex flex-wrap gap-3"));
  });

  it("ticking appends the tool id; unticking removes it", async () => {
    const { container, onIds } = await setup([tool(1, "search"), tool(2, "fetch"), tool(3, "calc")], [2, 3]);
    fireEvent.click(field("search", container));
    expect(onIds.mock.calls[0]).toEqual([[2, 3, 1]]);
    fireEvent.click(field("fetch", container));
    expect(onIds.mock.calls[1]).toEqual([[3]]);
  });

  it("offers the three streaming modes and reports a change with the rest of the config", async () => {
    const { container, onConfig } = await setup([]);
    const select = field<HTMLSelectElement>("Streaming delivery", container);
    expect(classes(select)).toEqual(["select"]);
    expect(select.value).toBe("progress");
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ["all", "Full process: model rounds and tool events"],
      ["progress", "Tool progress and final answer"],
      ["final", "Stream final answer only"],
    ]);
    fireEvent.change(select, { target: { value: "final" } });
    expect(onConfig.mock.calls).toEqual([[{ streamMode: "final", maxRounds: 4, maxCalls: 8 }]]);
  });

  it("edits the two numeric limits as numbers within their declared ranges", async () => {
    const { container, onConfig } = await setup([]);
    const rounds = field("Maximum model rounds", container);
    const calls = field("Maximum tool calls", container);
    expect([rounds.type, rounds.value, rounds.min, rounds.max, classes(rounds)]).toEqual(["number", "4", "1", "32", ["input"]]);
    expect([calls.type, calls.value, calls.min, calls.max, classes(calls)]).toEqual(["number", "8", "1", "128", ["input"]]);
    expect(classes(rounds.closest("label")!.parentElement)).toEqual(cls("grid grid-cols-2 gap-3"));
    fireEvent.change(rounds, { target: { value: "6" } });
    fireEvent.change(calls, { target: { value: "20" } });
    expect(onConfig.mock.calls).toEqual([
      [{ streamMode: "progress", maxRounds: 6, maxCalls: 8 }],
      [{ streamMode: "progress", maxRounds: 4, maxCalls: 20 }],
    ]);
  });

  it("renders in Chinese when the UI language is zh", async () => {
    vi.unstubAllGlobals();
    mockApi({ "GET /settings/ui-language": { language: "zh" } });
    const { container } = await setup([tool(2, "fetch", false)]);
    expect(container.querySelector("legend")!.textContent).toBe("服务器托管工具");
    expect(field("fetch", container).closest("label")!.textContent).toBe("fetch(停用)");
    expect(field<HTMLSelectElement>("流式呈现", container).options[2].textContent).toBe("仅流式返回最终答案");
    expect(field("最大模型轮数", container).value).toBe("4");
  });
});
