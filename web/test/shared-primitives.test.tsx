/**
 * Unit tests for the shared visual atoms: each variant must render exactly the
 * class set its call sites had before they were unified.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Button, CloseButton, Icon, buttonClass } from "../src/components/Button";
import { Chip, ChipMultiSelect, RemovableChip, SegmentedControl } from "../src/components/Chip";
import { Field, FieldHint } from "../src/components/Field";
import { CheckboxLabel, Select, TextArea, TextInput } from "../src/components/inputs";
import { DashedHint, Notice } from "../src/components/Notice";
import { EnabledBadge, ReadOnlyNote, RoleBadge } from "../src/components/badges";
import { Spinner } from "../src/components/common";
import { classes, cls, mockApi, renderApp } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Button", () => {
  it.each([
    ["primary", "md", undefined, "btn-primary"],
    ["ghost", "xs", undefined, "btn-ghost btn-xs"],
    ["danger", "xs", undefined, "btn-danger btn-xs"],
    ["ghost", "xs", "flex-1", "btn-ghost flex-1 btn-xs"],
    ["ghost", "md", undefined, "btn-ghost"],
  ] as const)("variant %s size %s extra %s -> %s", (variant, size, extra, expected) => {
    render(<Button variant={variant} size={size} className={extra}>Go</Button>);
    expect(classes(screen.getByRole("button"))).toEqual(cls(expected));
    expect(buttonClass(variant, size, extra)).toBe(expected);
  });

  it("sets no type attribute unless one is passed", () => {
    render(<><Button variant="primary">A</Button><Button variant="primary" type="button">B</Button></>);
    const [a, b] = screen.getAllByRole("button");
    expect([a.getAttribute("type"), b.getAttribute("type")]).toEqual([null, "button"]);
  });

  it("draws the icon before the label and a trailing icon after it", () => {
    render(<Button variant="ghost" icon="bi-plus-lg" trailingIcon="bi-chevron-right">Add</Button>);
    const btn = screen.getByRole("button");
    expect([...btn.childNodes].map((n) => (n instanceof Element ? n.className : n.textContent))).toEqual(["bi bi-plus-lg", "Add", "bi bi-chevron-right"]);
  });

  it("an icon-only button holds just the icon", () => {
    render(<Button variant="danger" size="xs" icon="bi-trash3" />);
    expect(screen.getByRole("button").innerHTML).toBe('<i class="bi bi-trash3"></i>');
  });

  it("busy disables but keeps the icon; spinWhenBusy swaps it for the spinner", () => {
    render(
      <>
        <Button variant="primary" icon="bi-check-lg" busy>Keep</Button>
        <Button variant="primary" icon="bi-check-lg" busy spinWhenBusy>Spin</Button>
        <Button variant="primary" icon="bi-check-lg" spinWhenBusy>Idle</Button>
      </>,
    );
    const [keep, spin, idle] = screen.getAllByRole("button") as HTMLButtonElement[];
    expect([keep.disabled, keep.querySelector("i")!.className]).toEqual([true, "bi bi-check-lg"]);
    expect([spin.disabled, spin.querySelector("i")!.className]).toEqual([true, "bi bi-arrow-repeat animate-spin"]);
    expect([idle.disabled, idle.querySelector("i")!.className]).toEqual([false, "bi bi-check-lg"]);
  });

  it("disabled and busy combine; neither leaves no disabled attribute", () => {
    render(<><Button variant="ghost" disabled>X</Button><Button variant="ghost" disabled={false}>Y</Button></>);
    const [x, y] = screen.getAllByRole("button");
    expect([x.hasAttribute("disabled"), y.hasAttribute("disabled")]).toEqual([true, false]);
  });

  it("forwards click and other button attributes", () => {
    const onClick = vi.fn();
    render(<Button variant="ghost" title="tip" onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByTitle("tip"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("Icon joins extra classes; CloseButton is the bare dismiss x", () => {
    const onClick = vi.fn();
    const { container } = render(<><Icon name="bi-key" className="mr-1" /><Icon name="bi-dot" /><CloseButton onClick={onClick} /></>);
    expect([...container.querySelectorAll("i")].map((i) => i.className)).toEqual(["bi bi-key mr-1", "bi bi-dot", "bi bi-x-lg"]);
    const close = screen.getByRole("button");
    expect(classes(close)).toEqual(cls("text-ink-500 hover:text-ink-200"));
    fireEvent.click(close);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("Notice", () => {
  const box = (c: HTMLElement) => c.firstElementChild as HTMLElement;

  it.each([
    ["error", "md", "flex items-center gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300", "bi bi-exclamation-octagon-fill"],
    ["error", "sm", "flex items-center gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300", "bi bi-exclamation-octagon-fill"],
    ["warning", "sm", "flex items-center gap-2 rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-300", "bi bi-exclamation-triangle-fill"],
    ["success", "md", "flex items-center gap-2 rounded-lg border border-emerald-900/50 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-300", "bi bi-check-circle-fill"],
  ] as const)("tone %s size %s", (tone, size, expected, icon) => {
    const { container } = render(<Notice tone={tone} size={size}>msg</Notice>);
    expect(classes(box(container))).toEqual(cls(expected));
    expect(box(container).querySelector("i")!.className).toBe(icon);
    expect(box(container).textContent).toBe("msg");
  });

  it("icon overrides the tone's glyph, and false draws none", () => {
    const { container } = render(<><Notice tone="error" icon="bi-exclamation-circle">a</Notice><Notice tone="error" icon={false}>b</Notice></>);
    expect(container.children[0].querySelector("i")!.className).toBe("bi bi-exclamation-circle");
    expect(container.children[1].querySelector("i")).toBeNull();
  });

  it("inline layout drops the flex row and spaces the icon itself", () => {
    const { container } = render(<Notice tone="success" layout="inline">ok</Notice>);
    expect(classes(box(container))).toEqual(cls("rounded-lg border px-4 py-3 text-sm border-emerald-900/50 bg-emerald-950/30 text-emerald-300"));
    expect(box(container).querySelector("i")!.className).toBe("bi bi-check-circle-fill mr-2");
  });

  it("className is appended", () => {
    const { container } = render(<Notice tone="error" className="mt-2">x</Notice>);
    expect(box(container).classList.contains("mt-2")).toBe(true);
  });

  it("DashedHint sizes", () => {
    const { container } = render(<><DashedHint>a</DashedHint><DashedHint size="lg">b</DashedHint></>);
    expect(container.children[0].tagName).toBe("P");
    expect(classes(container.children[0])).toEqual(cls("rounded-lg border border-dashed border-ink-700 px-3 py-2.5 text-xs text-ink-500"));
    expect(classes(container.children[1])).toEqual(cls("rounded-lg border border-dashed border-ink-700 px-4 py-6 text-center text-xs text-ink-500"));
  });
});

describe("Field", () => {
  it("default: a classless div holding a detached label, the control, then the hint", () => {
    const { container } = render(<Field label="Name" hint="Shown to users"><input className="input" /></Field>);
    const root = container.firstElementChild!;
    expect([root.tagName, root.hasAttribute("class")]).toEqual(["DIV", false]);
    expect([...root.children].map((c) => c.tagName)).toEqual(["LABEL", "INPUT", "P"]);
    expect([root.children[0].className, root.children[0].textContent]).toEqual(["label", "Name"]);
    expect(classes(root.children[2])).toEqual(cls("mt-1 text-xs text-ink-500"));
  });

  it("as=label wraps the control and puts the caption in a span", () => {
    const { container } = render(<Field as="label" className="block" label="URL" hint="h"><input /></Field>);
    const root = container.firstElementChild!;
    expect([root.tagName, root.className]).toEqual(["LABEL", "block"]);
    expect([...root.children].map((c) => c.tagName)).toEqual(["SPAN", "INPUT", "P"]);
    expect(root.children[0].className).toBe("label");
  });

  it("as=label without className renders a classless label", () => {
    const { container } = render(<Field as="label" label="L"><input /></Field>);
    expect(container.firstElementChild!.hasAttribute("class")).toBe(false);
  });

  it.each([
    ["a suffix", "optional", "Port optional", 1],
    ["suffix=false keeps the trailing space", false, "Port ", 0],
    ["no suffix", undefined, "Port", 0],
  ] as const)("caption with %s", (_name, suffix, text, spans) => {
    const { container } = render(<Field label="Port" suffix={suffix}><input /></Field>);
    const label = container.querySelector(".label")!;
    expect(label.textContent).toBe(text);
    expect(label.querySelectorAll("span.normal-case.text-ink-500").length).toBe(spans);
  });

  it.each([
    ["above", "mb-1 text-xs text-ink-500"],
    ["above-loose", "mb-2 text-xs text-ink-500"],
  ] as const)("hintPosition %s puts the hint between caption and control", (position, expected) => {
    const { container } = render(<Field label="L" hint="h" hintPosition={position}><input /></Field>);
    const root = container.firstElementChild!;
    expect([...root.children].map((c) => c.tagName)).toEqual(["LABEL", "P", "INPUT"]);
    expect(classes(root.children[1])).toEqual(cls(expected));
  });

  it("faint hint tone, and FieldHint on its own", () => {
    const { container } = render(<><Field label="L" hint="h" hintTone="faint"><input /></Field><FieldHint>solo</FieldHint></>);
    expect(classes(container.children[0].querySelector("p"))).toEqual(cls("mt-1 text-[11px] text-ink-600"));
    expect(classes(container.children[1])).toEqual(cls("mt-1 text-xs text-ink-500"));
  });

  it("wrapper className on the div form", () => {
    const { container } = render(<Field label="L" className="col-span-2"><input /></Field>);
    expect(container.firstElementChild!.className).toBe("col-span-2");
  });
});

describe("inputs", () => {
  it("TextInput / TextArea class sets", () => {
    const { container } = render(
      <>
        <TextInput />
        <TextInput mono />
        <TextInput className="py-1.5 text-xs" />
        <TextArea mono className="w-full" rows={3} />
      </>,
    );
    expect([...container.children].map((c) => classes(c))).toEqual([
      ["input"], cls("input font-mono text-xs"), cls("input py-1.5 text-xs"), cls("input w-full font-mono text-xs"),
    ]);
    expect([container.children[3].tagName, container.children[3].getAttribute("rows")]).toEqual(["TEXTAREA", "3"]);
  });

  it("TextInput forwards attributes and change events", () => {
    const onChange = vi.fn();
    render(<TextInput type="password" placeholder="pw" autoComplete="new-password" value="" onChange={onChange} />);
    const input = screen.getByPlaceholderText("pw") as HTMLInputElement;
    expect([input.type, input.autocomplete]).toEqual(["password", "new-password"]);
    fireEvent.change(input, { target: { value: "x" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("Select renders its options and reports string values", () => {
    const onChange = vi.fn();
    render(<Select value="b" onChange={onChange} options={[{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }]} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect([select.className, select.value]).toEqual(["select", "b"]);
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([["a", "Alpha"], ["b", "Beta"]]);
    fireEvent.change(select, { target: { value: "a" } });
    expect(onChange).toHaveBeenCalledWith("a");
  });

  it("Select over numeric options reports numbers", () => {
    const onChange = vi.fn();
    render(<Select value={2} onChange={onChange} options={[{ value: 1, label: "One" }, { value: 2, label: "Two" }]} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "1" } });
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it("Select placeholder is a leading empty option; className is appended", () => {
    render(<Select className="w-48" value="" onChange={() => {}} placeholder="Direct" options={[{ value: "7", label: "Seven" }]} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(classes(select)).toEqual(cls("select w-48"));
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([["", "Direct"], ["7", "Seven"]]);
  });

  it.each([
    ["sm", undefined, "flex items-center gap-2 text-sm text-ink-300"],
    ["xs", undefined, "flex items-center gap-1.5 text-xs text-ink-300"],
    ["sm", "mb-2", "mb-2 flex items-center gap-2 text-sm text-ink-300"],
  ] as const)("CheckboxLabel size %s extra %s", (size, extra, expected) => {
    const onChange = vi.fn();
    const { container } = render(<CheckboxLabel size={size} className={extra} checked={false} onChange={onChange}>All</CheckboxLabel>);
    const label = container.firstElementChild!;
    expect([label.tagName, label.textContent]).toEqual(["LABEL", "All"]);
    expect(classes(label)).toEqual(cls(expected));
    fireEvent.click(label.querySelector("input")!);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("badges and spinner", () => {
  it("EnabledBadge: tones and custom labels", () => {
    mockApi();
    const { container } = renderApp(
      <div data-testid="b">
        <EnabledBadge enabled />
        <EnabledBadge enabled={false} />
        <EnabledBadge enabled={false} offTone="gray" />
        <EnabledBadge enabled labels={{ on: "Active", off: "Off" }} />
        <EnabledBadge enabled={false} labels={{ on: "Active", off: "Off" }} />
      </div>,
    );
    const spans = [...container.querySelector("[data-testid=b]")!.children];
    expect(spans.map((s) => [s.className, s.textContent])).toEqual([
      ["badge-green", "enabled"], ["badge-red", "disabled"], ["badge-gray", "disabled"], ["badge-green", "Active"], ["badge-red", "Off"],
    ]);
  });

  it("RoleBadge and ReadOnlyNote", () => {
    mockApi();
    const { container } = renderApp(<div data-testid="b"><RoleBadge role="admin" /><RoleBadge role="manager" /><RoleBadge /><ReadOnlyNote /></div>);
    const [admin, manager, none, note] = [...container.querySelector("[data-testid=b]")!.children];
    expect([admin.className, admin.querySelector("i")!.className, admin.textContent]).toEqual(["badge-blue", "bi bi-shield-lock", "Admin"]);
    expect([manager.className, manager.querySelector("i")!.className, manager.textContent]).toEqual(["badge-gray", "bi bi-person-gear", "Manager"]);
    expect([none.className, none.textContent]).toEqual(["badge-gray", ""]);
    expect([classes(note), note.textContent]).toEqual([cls("text-xs text-ink-500"), "read only"]);
  });

  it("Spinner: in-page and full-screen forms", () => {
    const { container } = render(<><Spinner label="Loading" /><Spinner fullScreen /></>);
    const [page, full] = [...container.children];
    expect(classes(page)).toEqual(cls("flex items-center justify-center gap-2 py-16 text-ink-400"));
    expect([page.querySelector("i")!.className, page.querySelector("span")!.textContent]).toEqual(["bi bi-arrow-repeat animate-spin text-xl", "Loading"]);
    expect(classes(full)).toEqual(cls("flex h-screen items-center justify-center text-brand-400"));
    expect([full.querySelector("i")!.className, full.querySelector("span")]).toEqual(["bi bi-arrow-repeat animate-spin text-3xl", null]);
  });
});

describe("Chip family", () => {
  const ON = "bg-brand-600 text-white";
  const MUTED = "border border-ink-700 bg-ink-900 text-ink-400 hover:text-ink-200";
  const SOFT = "border border-ink-700 bg-ink-900 text-ink-300 hover:text-ink-100";

  it.each([
    ["xs", "muted", true, `rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${ON}`],
    ["xs", "muted", false, `rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${MUTED}`],
    ["fine", "muted", false, `rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${MUTED}`],
    ["md", "soft", false, `rounded-md px-3 py-1 text-xs font-medium transition-colors ${SOFT}`],
    ["md", "soft", true, `rounded-md px-3 py-1 text-xs font-medium transition-colors ${ON}`],
  ] as const)("Chip size %s tone %s active %s", (size, tone, active, expected) => {
    render(<Chip size={size} tone={tone} active={active}>c</Chip>);
    const chip = screen.getByRole("button");
    expect(classes(chip)).toEqual(cls(expected));
    expect(chip.getAttribute("type")).toBe("button");
  });

  it("SegmentedControl chips: one active, icons spaced, click reports the value", () => {
    const onChange = vi.fn();
    const { container } = render(
      <SegmentedControl value="a" onChange={onChange} size="fine" options={[{ value: "a", label: "A", icon: "bi-sliders" }, { value: "b", label: "B" }]} />,
    );
    expect(classes(container.firstElementChild)).toEqual(cls("flex items-center gap-1"));
    const [a, b] = screen.getAllByRole("button");
    expect([a.classList.contains("bg-brand-600"), b.classList.contains("bg-brand-600")]).toEqual([true, false]);
    expect([a.querySelector("i")!.className, b.querySelector("i")]).toEqual(["bi bi-sliders mr-1", null]);
    fireEvent.click(b);
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("SegmentedControl chips: loose gap and disabled", () => {
    const { container } = render(<SegmentedControl value="a" onChange={() => {}} gap="loose" size="md" tone="soft" disabled options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} />);
    expect(classes(container.firstElementChild)).toEqual(cls("flex items-center gap-2"));
    expect((screen.getAllByRole("button") as HTMLButtonElement[]).map((b) => b.disabled)).toEqual([true, true]);
  });

  it("SegmentedControl joined: one bordered pill, borderless segments, no type attribute", () => {
    const onChange = vi.fn();
    const { container } = render(<SegmentedControl variant="joined" value="json" onChange={onChange} options={[{ value: "formatted", label: "Formatted" }, { value: "json", label: "JSON" }]} />);
    expect(classes(container.firstElementChild)).toEqual(cls("inline-flex rounded-lg border border-ink-700 p-0.5 text-xs"));
    const [f, j] = screen.getAllByRole("button");
    expect(classes(f)).toEqual(cls("rounded-md px-2.5 py-1 font-medium capitalize transition-colors text-ink-400 hover:text-ink-200"));
    expect(classes(j)).toEqual(cls("rounded-md px-2.5 py-1 font-medium capitalize transition-colors bg-brand-600 text-white"));
    expect([f.hasAttribute("type"), f.hasAttribute("disabled")]).toEqual([false, false]);
    fireEvent.click(f);
    expect(onChange).toHaveBeenCalledWith("formatted");
  });

  it("SegmentedControl buttons: equal-width primary/ghost with per-option disable", () => {
    const { container } = render(
      <SegmentedControl variant="buttons" value="internal" onChange={() => {}} options={[{ value: "proxy", label: "Proxy", icon: "bi-globe2", disabled: true }, { value: "internal", label: "Internal", icon: "bi-cpu" }]} />,
    );
    expect(classes(container.firstElementChild)).toEqual(cls("flex gap-2"));
    const [p, i] = screen.getAllByRole("button") as HTMLButtonElement[];
    expect([classes(p), p.disabled, p.type, p.querySelector("i")!.className]).toEqual([cls("btn-ghost flex-1 btn-xs"), true, "button", "bi bi-globe2"]);
    expect([classes(i), i.disabled]).toEqual([cls("btn-primary flex-1 btn-xs"), false]);
  });

  describe("ChipMultiSelect", () => {
    const options = [{ value: 429, label: "429" }, { value: "timeout", label: "Timed out" }] as const;
    const custom = {
      parse: (raw: string) => (/^\d{3}$/.test(raw) ? Number(raw) : raw === "network" ? "network" : null),
      placeholder: "code",
      addLabel: "Add",
      hint: "any status",
      inputMode: "numeric" as const,
    };
    const setup = (selected: (string | number)[], withCustom = true) => {
      const onToggle = vi.fn();
      const view = render(<ChipMultiSelect<string | number> options={options} selected={selected} onToggle={onToggle} custom={withCustom ? custom : undefined} removeTitle="Click to remove" />);
      return { onToggle, ...view };
    };

    it("preset chips toggle by value, not by label", () => {
      const { onToggle } = setup([429]);
      expect(screen.getByText("429").classList.contains("bg-brand-600")).toBe(true);
      fireEvent.click(screen.getByText("Timed out"));
      expect(onToggle).toHaveBeenCalledWith("timeout");
    });

    it("without custom there is no entry box", () => {
      setup([], false);
      expect(screen.queryByPlaceholderText("code")).toBeNull();
    });

    it("the entry box adds a parsed value on Enter and on the button, then clears", () => {
      const { onToggle } = setup([]);
      const input = screen.getByPlaceholderText("code") as HTMLInputElement;
      expect([classes(input), input.getAttribute("inputmode"), input.type]).toEqual([cls("input w-32 text-xs"), "numeric", "text"]);
      const add = screen.getByText("Add").closest("button") as HTMLButtonElement;
      expect([add.disabled, classes(add)]).toEqual([true, cls("btn-ghost btn-xs")]);
      fireEvent.change(input, { target: { value: " 503 " } });
      expect(add.disabled).toBe(false);
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onToggle).toHaveBeenLastCalledWith(503);
      expect(input.value).toBe("");
      fireEvent.change(input, { target: { value: "network" } });
      fireEvent.click(add);
      expect(onToggle).toHaveBeenLastCalledWith("network");
      expect(screen.getByText("any status").className).toBe("text-[11px] text-ink-500");
    });

    it("an unparseable entry is left in the box and nothing is added", () => {
      const { onToggle } = setup([]);
      const input = screen.getByPlaceholderText("code") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "nope" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect([onToggle.mock.calls.length, input.value]).toEqual([0, "nope"]);
    });

    it("an entry already selected is not toggled off, only cleared", () => {
      const { onToggle } = setup([503]);
      const input = screen.getByPlaceholderText("code") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "503" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect([onToggle.mock.calls.length, input.value]).toEqual([0, ""]);
    });

    it("selected values outside the presets show as removable chips", () => {
      const { onToggle } = setup([429, 503, "bogus"]);
      const extras = screen.getAllByTitle("Click to remove");
      expect(extras.map((e) => e.textContent)).toEqual(["503", "bogus"]);
      expect(classes(extras[0])).toEqual(cls("inline-flex items-center gap-1 rounded-md bg-brand-600 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-brand-500"));
      expect(extras[0].querySelector("i")!.className).toBe("bi bi-x-lg text-[10px]");
      fireEvent.click(extras[1]);
      expect(onToggle).toHaveBeenCalledWith("bogus");
    });
  });

  it("RemovableChip: plain and mono forms, remove tones", () => {
    const onRemove = vi.fn();
    const { container } = render(
      <>
        <RemovableChip onRemove={onRemove}>plain</RemovableChip>
        <RemovableChip onRemove={() => {}} mono removeTone="muted" removeTitle="Remove" disabled>host</RemovableChip>
      </>,
    );
    const [plain, mono] = [...container.children];
    expect(classes(plain)).toEqual(cls("inline-flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1 text-xs"));
    expect(classes(mono)).toEqual(cls("inline-flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1 font-mono text-xs text-ink-200"));
    const [x1, x2] = [plain.querySelector("button")!, mono.querySelector("button")!];
    expect([classes(x1), x1.hasAttribute("title"), x1.disabled]).toEqual([cls("text-ink-600 hover:text-red-400"), false, false]);
    expect([classes(x2), x2.title, x2.disabled]).toEqual([cls("text-ink-500 hover:text-red-400"), "Remove", true]);
    fireEvent.click(x1);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
