/**
 * Unit tests for the shared pieces of the service editors: panels, list
 * header, editor card, the reorderable-list hook, the disclosure and advanced
 * overrides, the two integer inputs, the service select, the warning hint
 * tones and FormModal's lead-actions footer.
 */
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { AdvancedOverrides, DisclosureToggle, useDisclosure } from "../src/components/AdvancedOverrides";
import { AddButton, EditorCard, EditorPanel, InsetPanel, ListHeader, RowPanel } from "../src/components/EditorCard";
import { FieldHint } from "../src/components/Field";
import { FormModal } from "../src/components/FormModal";
import { nameOptions } from "../src/components/inputs";
import { IntInput, OptionalIntInput } from "../src/components/numeric";
import { OcrEditor, ServiceSelect } from "../src/components/PrePassEditors";
import { StageEditor } from "../src/components/StageEditor";
import { useReorderableList } from "../src/lib/useReorderableList";
import type { AgentOcr, AgentStage, ModelService, Overrides } from "../src/types";
import { button, classes, cls, field, hasButton, iconButton, mockApi, openModal, renderApp, toggle, type } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const EDITOR = "rounded-xl border border-ink-700 bg-ink-850/70 p-3";
const INSET = "rounded-lg border border-ink-800 bg-ink-950/40 p-3";
const ROW = "rounded-lg border border-ink-800 bg-ink-900/60 p-2 text-xs";
const TOGGLE = "text-xs text-ink-500 hover:text-ink-300";

describe("panels", () => {
  it("each has its frame, takes extra classes and passes div props through", () => {
    const onDrop = vi.fn();
    const { container } = render(
      <>
        <EditorPanel onDrop={onDrop}>a</EditorPanel>
        <InsetPanel className="mt-2 space-y-3">b</InsetPanel>
        <RowPanel className="space-y-2">c</RowPanel>
        <RowPanel>d</RowPanel>
      </>,
    );
    const [a, b, c, d] = [...container.children];
    expect([a, b, c, d].map((el) => el.tagName)).toEqual(["DIV", "DIV", "DIV", "DIV"]);
    expect(classes(a)).toEqual(cls(EDITOR));
    expect(classes(b)).toEqual(cls(`mt-2 space-y-3 ${INSET}`));
    expect(classes(c)).toEqual(cls(`space-y-2 ${ROW}`));
    expect(d.className).toBe(ROW);
    fireEvent.drop(a);
    expect(onDrop).toHaveBeenCalledTimes(1);
  });
});

describe("ListHeader / AddButton", () => {
  it("default: a span caption with the md gap and the action on the right", () => {
    const { container } = render(<ListHeader label="Stages" action={<button>add</button>} />);
    const row = container.firstElementChild!;
    expect(classes(row)).toEqual(cls("mb-2 flex items-center justify-between"));
    expect([...row.children].map((c) => [c.tagName, c.className, c.textContent])).toEqual([["SPAN", "label mb-0", "Stages"], ["BUTTON", "", "add"]]);
  });

  it.each([["md", "mb-2"], ["sm", "mb-1.5"], ["xs", "mb-1"]] as const)("gap %s is %s", (gap, margin) => {
    const { container } = render(<ListHeader label="x" gap={gap} />);
    expect(classes(container.firstElementChild)).toEqual(cls(`${margin} flex items-center justify-between`));
  });

  it("as a label with a hint: caption, a space, then the lower-case note", () => {
    const { container } = render(<ListHeader as="label" label="Input" hint="(in order)" />);
    const caption = container.firstElementChild!.firstElementChild!;
    expect([caption.tagName, caption.className, caption.textContent]).toEqual(["LABEL", "label mb-0", "Input (in order)"]);
    expect(caption.firstElementChild!.className).toBe("normal-case text-ink-500");
    expect(container.firstElementChild!.children).toHaveLength(1);
  });

  it("AddButton is a small ghost button with the plus icon", () => {
    const onClick = vi.fn();
    render(<AddButton onClick={onClick}>Add step</AddButton>);
    const b = button("Add step");
    expect([b.className, b.querySelector("i")!.className, b.hasAttribute("type")]).toEqual(["btn-ghost btn-xs", "bi bi-plus-lg", false]);
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("EditorCard", () => {
  const setup = (headerExtra?: React.ReactNode) => {
    const h = { onDuplicate: vi.fn(), onRemove: vi.fn(), onDragStart: vi.fn(), onDragEnd: vi.fn(), onDrop: vi.fn() };
    const { container } = render(
      <EditorCard
        badge="Step 2"
        headerExtra={headerExtra}
        dragTitle="Drag to reorder"
        duplicateTitle="Duplicate"
        onDuplicate={h.onDuplicate}
        onRemove={h.onRemove}
        dragHandleProps={{ draggable: true, onDragStart: h.onDragStart, onDragEnd: h.onDragEnd }}
        dropTargetProps={{ onDrop: h.onDrop }}
      >
        <p>body</p>
      </EditorCard>,
    );
    return { ...h, card: container.firstElementChild as HTMLElement };
  };

  it("draws the frame, then a header of grip, badge, spacer, duplicate and delete, then the body", () => {
    const { card } = setup();
    expect(classes(card)).toEqual(cls(EDITOR));
    const [header, body] = [...card.children];
    expect(classes(header)).toEqual(cls("mb-2.5 flex items-center gap-2"));
    expect([...header.children].map((c) => [c.tagName, c.className, c.textContent])).toEqual([
      ["SPAN", "cursor-grab text-ink-600 hover:text-ink-300", ""],
      ["SPAN", "badge-blue", "Step 2"],
      ["DIV", "flex-1", ""],
      ["BUTTON", "btn-ghost btn-xs", ""],
      ["BUTTON", "btn-danger btn-xs", ""],
    ]);
    const grip = header.firstElementChild!;
    expect([grip.getAttribute("draggable"), grip.getAttribute("title"), grip.firstElementChild!.className]).toEqual(["true", "Drag to reorder", "bi bi-grip-vertical"]);
    expect([iconButton("bi-files", card).title, iconButton("bi-trash3", card).title]).toEqual(["Duplicate", ""]);
    expect(body.textContent).toBe("body");
  });

  it("puts headerExtra between the badge and the spacer", () => {
    const { card } = setup(<input aria-label="name" />);
    expect([...card.firstElementChild!.children].map((c) => c.tagName)).toEqual(["SPAN", "SPAN", "INPUT", "DIV", "BUTTON", "BUTTON"]);
  });

  it("wires the buttons, the grip and the drop target", () => {
    const h = setup();
    fireEvent.click(iconButton("bi-files", h.card));
    fireEvent.click(iconButton("bi-trash3", h.card));
    const grip = h.card.querySelector("[draggable]")!;
    fireEvent.dragStart(grip);
    fireEvent.dragEnd(grip);
    fireEvent.drop(h.card);
    expect([h.onDuplicate, h.onRemove, h.onDragStart, h.onDragEnd, h.onDrop].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1, 1]);
  });
});

describe("useReorderableList", () => {
  /** A list of letters; each row remembers its React key and holds an uncontrolled note. */
  function Harness({ initial, onCommit, special }: { initial: string[]; onCommit?: (next: string[]) => void; special?: (next: string[]) => void }) {
    const [items, setItems] = useState(initial);
    const list = useReorderableList(items, (next) => {
      onCommit?.(next);
      setItems(next);
    });
    return (
      <div>
        <button onClick={() => list.append("new")}>append</button>
        {items.map((item, i) => (
          <div key={list.keys[i]} data-row={item} data-key={list.keys[i]} {...list.dropTargetProps(i)}>
            <span data-grip {...list.dragHandleProps(i)} />
            <input defaultValue="" aria-label={`note ${item}`} />
            <button onClick={() => list.insertAfter(i, `${item}'`)}>dup {item}</button>
            <button onClick={() => list.remove(i)}>del {item}</button>
            {special && (
              <button
                onClick={() =>
                  list.remove(i, (next) => {
                    special(next);
                    setItems(next);
                  })
                }
              >
                special {item}
              </button>
            )}
          </div>
        ))}
      </div>
    );
  }
  const rows = () => [...document.querySelectorAll<HTMLElement>("[data-row]")];
  const order = () => rows().map((r) => r.dataset.row);
  const keyOf = (item: string) => rows().find((r) => r.dataset.row === item)!.dataset.key;
  const note = (item: string) => rows().find((r) => r.dataset.row === item)!.querySelector("input")!;
  const grip = (item: string) => rows().find((r) => r.dataset.row === item)!.querySelector("[data-grip]")!;
  const row = (item: string) => rows().find((r) => r.dataset.row === item)!;

  it("gives every item a distinct key and marks the grip draggable", () => {
    render(<Harness initial={["a", "b", "c"]} />);
    expect(new Set(rows().map((r) => r.dataset.key)).size).toBe(3);
    expect(grip("a").getAttribute("draggable")).toBe("true");
  });

  it("append adds at the end, insertAfter right after its item; existing keys do not change", () => {
    render(<Harness initial={["a", "b"]} />);
    const before = [keyOf("a"), keyOf("b")];
    fireEvent.click(button("append"));
    fireEvent.click(button("dup a"));
    expect(order()).toEqual(["a", "a'", "b", "new"]);
    expect([keyOf("a"), keyOf("b")]).toEqual(before);
    expect(new Set(rows().map((r) => r.dataset.key)).size).toBe(4);
  });

  it("remove drops the item; the others keep their keys and their local state", () => {
    render(<Harness initial={["a", "b", "c"]} />);
    type(note("c"), "kept");
    const key = keyOf("c");
    fireEvent.click(button("del b"));
    expect(order()).toEqual(["a", "c"]);
    expect([keyOf("c"), note("c").value]).toEqual([key, "kept"]);
  });

  it("remove can commit through another function instead of the list's own", () => {
    const onCommit = vi.fn();
    const special = vi.fn();
    render(<Harness initial={["a", "b"]} onCommit={onCommit} special={special} />);
    fireEvent.click(button("special a"));
    expect([onCommit.mock.calls.length, special.mock.calls]).toEqual([0, [[["b"]]]]);
    expect(order()).toEqual(["b"]);
  });

  it.each([
    ["a", "c", ["b", "c", "a"]],
    ["c", "a", ["c", "a", "b"]],
    ["a", "b", ["b", "a", "c"]],
  ])("dragging %s onto %s moves it there, state travelling with it", (from, to, expected) => {
    render(<Harness initial={["a", "b", "c"]} />);
    type(note(from), "mine");
    const key = keyOf(from);
    fireEvent.dragStart(grip(from));
    fireEvent.drop(row(to));
    expect(order()).toEqual(expected);
    expect([keyOf(from), note(from).value]).toEqual([key, "mine"]);
  });

  it("a drop on itself, after the drag ended, or with no drag at all commits nothing", () => {
    const onCommit = vi.fn();
    render(<Harness initial={["a", "b", "c"]} onCommit={onCommit} />);
    fireEvent.drop(row("b"));
    fireEvent.dragStart(grip("a"));
    fireEvent.drop(row("a"));
    fireEvent.dragEnd(grip("a"));
    fireEvent.drop(row("c"));
    expect(onCommit).not.toHaveBeenCalled();
    expect(order()).toEqual(["a", "b", "c"]);
  });

  it("a completed drop ends the drag: a second drop moves nothing", () => {
    const onCommit = vi.fn();
    render(<Harness initial={["a", "b", "c"]} onCommit={onCommit} />);
    fireEvent.dragStart(grip("a"));
    fireEvent.drop(row("b"));
    fireEvent.drop(row("c"));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("dragging over a target is allowed (default prevented)", () => {
    render(<Harness initial={["a", "b"]} />);
    expect(fireEvent.dragOver(row("a"))).toBe(false);
  });
});

describe("DisclosureToggle", () => {
  it("shows a right chevron closed and a down chevron open, with the default classes and no type", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<DisclosureToggle open={false} onToggle={onToggle}>More</DisclosureToggle>);
    const b = button("More");
    expect([b.className, b.hasAttribute("type"), b.querySelector("i")!.className]).toEqual([TOGGLE, false, "bi bi-chevron-right mr-1"]);
    fireEvent.click(b);
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(<DisclosureToggle open onToggle={onToggle} className="mt-1.5 text-[11px]" type="button">More</DisclosureToggle>);
    expect([button("More").className, button("More").getAttribute("type"), button("More").querySelector("i")!.className]).toEqual(["mt-1.5 text-[11px]", "button", "bi bi-chevron-down mr-1"]);
  });
});

describe("AdvancedOverrides", () => {
  function Harness({ variant, initial, withTimeout = true }: { variant: "step" | "stage" | "ocr"; initial?: Overrides; withTimeout?: boolean }) {
    const [overrides, setOverrides] = useState<Overrides | undefined>(initial);
    const [timeoutMs, setTimeoutMs] = useState<number | undefined>(undefined);
    const advanced = useDisclosure();
    return (
      <div data-testid="host">
        <AdvancedOverrides
          {...advanced}
          variant={variant}
          label="Advanced"
          overrides={overrides}
          onOverrides={setOverrides}
          timeout={withTimeout ? { label: "Timeout (ms)", value: timeoutMs, onChange: setTimeoutMs } : undefined}
        >
          <p>extra</p>
        </AdvancedOverrides>
        <output>{JSON.stringify({ overrides, timeoutMs })}</output>
      </div>
    );
  }
  const setup = (props: Parameters<typeof Harness>[0]) => {
    mockApi();
    const view = renderApp(<Harness {...props} />);
    const host = view.getByTestId("host");
    return { host, state: () => JSON.parse(host.querySelector("output")!.textContent!) as { overrides?: Overrides; timeoutMs?: number } };
  };

  it.each([
    ["step", TOGGLE, "button"],
    ["stage", `mt-2 ${TOGGLE}`, null],
    ["ocr", TOGGLE, null],
  ] as const)("%s: is closed at first, with its own toggle classes and type", (variant, toggleClass, typeAttr) => {
    const { host } = setup({ variant });
    const b = button("Advanced", host);
    expect([classes(b), b.getAttribute("type"), b.querySelector("i")!.className]).toEqual([cls(toggleClass), typeAttr, "bi bi-chevron-right mr-1"]);
    expect(host.children).toHaveLength(2);
  });

  it("step: opens to the overrides editor alone, in a plain mt-2 wrapper, ignoring children and timeout", () => {
    const { host } = setup({ variant: "step" });
    fireEvent.click(button("Advanced", host));
    const body = host.children[1];
    expect([body.tagName, body.className, body.children.length]).toEqual(["DIV", "mt-2", 1]);
    expect(classes(body.firstElementChild)).toEqual(cls(INSET));
    expect(host.textContent).not.toContain("extra");
    expect(host.textContent).not.toContain("Timeout (ms)");
  });

  it.each([["stage", `mt-2 space-y-3 ${INSET}`], ["ocr", `space-y-3 ${INSET}`]] as const)(
    "%s: opens to a panel of the caller's fields, a third-width timeout and the overrides editor",
    (variant, panelClass) => {
      const { host, state } = setup({ variant });
      fireEvent.click(button("Advanced", host));
      const panel = host.children[1];
      expect(classes(panel)).toEqual(cls(panelClass));
      expect([...panel.children].map((c) => c.tagName)).toEqual(["P", "DIV", "DIV"]);
      expect(classes(panel.children[1])).toEqual(cls("grid grid-cols-3 gap-3"));
      const timeout = panel.children[1].querySelector("input")!;
      expect([timeout.placeholder, timeout.className, panel.children[1].querySelector("label")!.className]).toEqual(["inherit", "input", "label"]);
      type(timeout, "12x34");
      expect(state().timeoutMs).toBe(1234);
      expect(classes(panel.children[2])).toEqual(cls(INSET));
    },
  );

  it("a panel variant without a timeout has no timeout row", () => {
    const { host } = setup({ variant: "stage", withTimeout: false });
    fireEvent.click(button("Advanced", host));
    expect([...host.children[1].children].map((c) => c.tagName)).toEqual(["P", "DIV"]);
  });

  it("only the step variant flags existing overrides with a dot", () => {
    const dot = (host: HTMLElement) => host.querySelector("button")!.querySelector("span");
    const step = setup({ variant: "step", initial: { topP: 1 } });
    expect([dot(step.host)!.className, dot(step.host)!.textContent]).toEqual(["ml-1 text-brand-400", "●"]);
    cleanup();
    expect(dot(setup({ variant: "step" }).host)).toBeNull();
    cleanup();
    expect(dot(setup({ variant: "step", initial: {} }).host)).toBeNull();
    cleanup();
    expect(dot(setup({ variant: "stage", initial: { topP: 1 } }).host)).toBeNull();
  });

  it("edits the overrides and closes again", () => {
    const { host, state } = setup({ variant: "step" });
    fireEvent.click(button("Advanced", host));
    fireEvent.click(button("Add parameter", host));
    const [key, value] = [...host.querySelectorAll<HTMLInputElement>("input")];
    type(key, "topP");
    type(value, "0.5");
    expect(state().overrides).toEqual({ topP: 0.5 });
    fireEvent.click(host.querySelector("button")!);
    expect(host.children).toHaveLength(2);
    expect(hasButton("Add parameter", host)).toBe(false);
  });
});

describe("IntInput", () => {
  function Harness({ fallback, min, initial = 5 }: { fallback: number; min?: number; initial?: number }) {
    const [v, setV] = useState(initial);
    return <IntInput value={v} onChange={setV} fallback={fallback} min={min} />;
  }
  const input = () => document.querySelector<HTMLInputElement>("input")!;

  it("is a plain text input with a numeric keyboard that selects itself on focus and on click", () => {
    render(<Harness fallback={0} />);
    const el = input();
    expect([el.className, el.type, el.inputMode, el.value]).toEqual(["input", "text", "numeric", "5"]);
    const select = vi.spyOn(el, "select");
    fireEvent.focus(el);
    fireEvent.click(el);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["12", 0, undefined, "12"], ["", 0, undefined, "0"], ["abc", 0, undefined, "0"], ["  ", 7, undefined, "7"], ["3.9", 0, undefined, "3"],
    ["-4", 0, undefined, "0"], ["0", 1, 1, "1"], ["", 1, 1, "1"], ["x", 60000, 1000, "60000"], ["7", 60000, 1000, "1000"],
  ])("typing %j with fallback %d and min %s shows %s", (text, fallback, min, shown) => {
    render(<Harness fallback={fallback} min={min} />);
    type(input(), text);
    expect(input().value).toBe(shown);
  });
});

describe("OptionalIntInput", () => {
  function Harness({ initial }: { initial?: number }) {
    const [v, setV] = useState<number | undefined>(initial);
    return (
      <>
        <OptionalIntInput value={v} onChange={setV} placeholder="inherit" />
        <output>{v === undefined ? "unset" : String(v)}</output>
        <button onClick={() => setV(42)}>external</button>
        <button onClick={() => setV(undefined)}>clear</button>
      </>
    );
  }
  const input = () => document.querySelector<HTMLInputElement>("input")!;
  const value = () => document.querySelector("output")!.textContent;

  it("is a plain text input showing the placeholder while unset; it selects itself on focus only", () => {
    render(<Harness />);
    const el = input();
    expect([el.className, el.type, el.inputMode, el.value, el.placeholder]).toEqual(["input", "text", "numeric", "", "inherit"]);
    const select = vi.spyOn(el, "select");
    fireEvent.focus(el);
    fireEvent.click(el);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["1500", "1500", "1500"], ["", "", "unset"], ["abc", "", "unset"], ["1a2b", "12", "12"], ["-5", "5", "5"], ["3.5", "35", "35"], ["0", "0", "0"], ["007", "007", "7"], ["  ", "", "unset"],
  ])("typing %j shows %j and reports %s", (text, shown, reported) => {
    render(<Harness initial={9} />);
    type(input(), text);
    expect([input().value, value()]).toEqual([shown, reported]);
  });

  it("follows a value changed from outside, in both directions", () => {
    render(<Harness initial={9} />);
    expect(input().value).toBe("9");
    fireEvent.click(button("external"));
    expect(input().value).toBe("42");
    fireEvent.click(button("clear"));
    expect(input().value).toBe("");
  });
});

describe("ServiceSelect", () => {
  const svc = (id: number, name: string): ModelService => ({ id, name, description: null, steps: { timeoutMs: 1, steps: [] }, enabled: true, summary: "", createdAt: id });

  it("lists the placeholder, the services by name, then the extra options, and reports the placeholder as undefined", () => {
    const onChange = vi.fn();
    const { container } = render(
      <ServiceSelect value="b" onChange={onChange} placeholder="pick…" services={[svc(1, "a"), svc(2, "b")]}>
        <option value="__x__">extra</option>
      </ServiceSelect>,
    );
    const select = container.querySelector("select")!;
    expect([select.className, select.value]).toEqual(["select", "b"]);
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([["", "pick…"], ["a", "a"], ["b", "b"], ["__x__", "extra"]]);
    type(select, "a");
    type(select, "");
    type(select, "__x__");
    expect(onChange.mock.calls).toEqual([["a"], [undefined], ["__x__"]]);
  });

  it("with no services is just the placeholder", () => {
    const { container } = render(<ServiceSelect value="" onChange={() => {}} placeholder="pick…" />);
    expect(container.querySelectorAll("option")).toHaveLength(1);
  });
});

describe("FieldHint warning tones / nameOptions", () => {
  it.each([
    ["warning", "below", "mt-1 text-xs text-amber-300"],
    ["warning-dim", "below", "mt-1 text-xs text-amber-400/90"],
    ["warning", "above", "mb-1 text-xs text-amber-300"],
  ] as const)("tone %s %s is %s", (tone, position, expected) => {
    const { container } = render(<FieldHint tone={tone} position={position}>careful</FieldHint>);
    expect([container.firstElementChild!.tagName, container.firstElementChild!.className]).toEqual(["P", expected]);
  });

  it("nameOptions labels each name with itself", () => {
    expect(nameOptions(["a", "b"])).toEqual([{ value: "a", label: "a" }, { value: "b", label: "b" }]);
  });
});

describe("FormModal footerLead", () => {
  it("keeps the lead actions as direct footer children, then a spacer, then Cancel and submit", () => {
    mockApi();
    const onSubmit = vi.fn();
    renderApp(
      <FormModal open title="Edit" onClose={() => {}} onSubmit={onSubmit} submitLabel="Save" busy footerLead={<><button>one</button><button>two</button></>}>
        <p>fields</p>
      </FormModal>,
    );
    const footer = openModal("Edit").lastElementChild!;
    expect([...footer.children].map((c) => [c.tagName, c.textContent, c.className])).toEqual([
      ["BUTTON", "one", ""], ["BUTTON", "two", ""], ["DIV", "", "flex-1"], ["BUTTON", "Cancel", "btn-ghost"], ["BUTTON", "Save", "btn-primary"],
    ]);
    expect([button("Save").disabled, button("Cancel").disabled]).toEqual([true, false]);
  });
});

describe("where the Advanced state lives", () => {
  const chat: ModelService = { id: 1, name: "chat-a", description: null, steps: { timeoutMs: 1, steps: [] }, enabled: true, summary: "", createdAt: 1 };
  const OCR_ADVANCED = "Advanced (prompt, parameter overrides, timeout)";
  const STAGE_ADVANCED = "Advanced (tools, parameter overrides, timeout)";

  it("OCR: the section is still open after the pre-pass is switched off and on again", () => {
    function Harness() {
      const [ocr, setOcr] = useState<AgentOcr | undefined>({ service: "chat-a" });
      return <OcrEditor ocr={ocr} onChange={setOcr} services={[chat]} />;
    }
    mockApi();
    renderApp(<Harness />);
    fireEvent.click(button(OCR_ADVANCED));
    expect(document.body.textContent).toContain("OCR prompt (optional)");
    fireEvent.click(toggle("Translate images to text (OCR pre-pass)"));
    expect(hasButton(OCR_ADVANCED)).toBe(false);
    fireEvent.click(toggle("Translate images to text (OCR pre-pass)"));
    expect(document.body.textContent).toContain("OCR prompt (optional)");
  });

  it("stage: the section is still open after the stage was a router for a while", () => {
    function Harness() {
      const [stages, setStages] = useState<AgentStage[]>([{ name: "one", input: [], service: "chat-a" }]);
      return <StageEditor stages={stages} output="" onChange={setStages} services={[chat]} />;
    }
    mockApi();
    renderApp(<Harness />);
    fireEvent.click(button(STAGE_ADVANCED));
    expect(document.body.textContent).toContain("Tools");
    type(field<HTMLSelectElement>("Runs"), "__router__");
    expect(hasButton(STAGE_ADVANCED)).toBe(false);
    type(field<HTMLSelectElement>("Runs"), "chat-a");
    expect(button(STAGE_ADVANCED).querySelector("i")!.className).toBe("bi bi-chevron-down mr-1");
  });
});
