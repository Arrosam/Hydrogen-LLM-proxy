/**
 * Unit tests for the shared composites: table, page frame, form modal, entity
 * card, row actions, auth card.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AuthCard } from "../src/components/AuthCard";
import { DataTable, type Column } from "../src/components/DataTable";
import { EntityCard, RowActions } from "../src/components/EntityCard";
import { FormModal } from "../src/components/FormModal";
import { AsyncStatus, PageHeader, ResourcePage } from "../src/components/Page";
import { button, classes, cls, hasButton, mockApi, modal, openModal, renderApp } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

interface Row { id: number; name: string; url: string; bad?: boolean }
const ROWS: Row[] = [{ id: 1, name: "one", url: "https://a.example" }, { id: 2, name: "two", url: "https://b.example", bad: true }];

describe("DataTable", () => {
  const columns: Column<Row>[] = [
    { header: "Name", className: "font-medium text-ink-100", cell: (r) => r.name },
    { header: "URL", className: (r) => (r.bad ? "text-red-400" : "text-ink-400"), title: (r) => r.url, cell: (r) => r.url },
    { header: "Actions", headerClassName: "text-right", cell: (_row, i) => <button>act {i}</button> },
  ];

  it("renders the card + table frame, headers and cells", () => {
    const { container } = render(<DataTable rows={ROWS} rowKey={(r) => r.id} columns={columns} />);
    const card = container.firstElementChild!;
    expect(classes(card)).toEqual(cls("card overflow-hidden"));
    expect(card.firstElementChild!.className).toBe("table");
    const ths = [...card.querySelectorAll("thead th")];
    expect(ths.map((th) => [th.textContent, th.getAttribute("class")])).toEqual([["Name", null], ["URL", null], ["Actions", "text-right"]]);
    const trs = [...card.querySelectorAll("tbody tr")];
    expect(trs.map((tr) => [...tr.children].map((td) => td.textContent))).toEqual([["one", "https://a.example", "act 0"], ["two", "https://b.example", "act 1"]]);
    expect(trs[0].hasAttribute("class")).toBe(false);
  });

  it("applies fixed and per-row cell classes, and cell titles", () => {
    const { container } = render(<DataTable rows={ROWS} rowKey={(r) => r.id} columns={columns} />);
    const cells = [...container.querySelectorAll("tbody tr")].map((tr) => [...tr.children]);
    expect(classes(cells[0][0])).toEqual(cls("font-medium text-ink-100"));
    expect([cells[0][1].className, cells[1][1].className]).toEqual(["text-ink-400", "text-red-400"]);
    expect([cells[0][1].getAttribute("title"), cells[0][0].hasAttribute("title")]).toEqual(["https://a.example", false]);
    expect(cells[0][2].hasAttribute("class")).toBe(false);
  });

  it("a column without a header gets an empty header cell; a hidden column is left out", () => {
    const { container } = render(
      <DataTable
        rows={ROWS}
        rowKey={(r) => r.id}
        columns={[{ header: "Name", cell: (r) => r.name }, { header: "Gone", hidden: true, cell: () => "x" }, { className: "text-right", cell: () => ">" }]}
      />,
    );
    expect([...container.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(["Name", ""]);
    expect([...container.querySelector("tbody tr")!.children].map((td) => td.textContent)).toEqual(["one", ">"]);
  });

  it("row click and row class", () => {
    const onRowClick = vi.fn();
    const { container } = render(
      <DataTable rows={ROWS} rowKey={(r) => r.id} columns={columns.slice(0, 1)} onRowClick={onRowClick} rowClassName={(r) => (r.bad ? "cursor-pointer bad" : "cursor-pointer")} />,
    );
    const trs = [...container.querySelectorAll("tbody tr")];
    expect(trs.map((tr) => tr.className)).toEqual(["cursor-pointer", "cursor-pointer bad"]);
    fireEvent.click(trs[1]);
    expect(onRowClick).toHaveBeenCalledWith(ROWS[1], 1);
  });

  it("expanded renders a full-width detail row under the rows that have one", () => {
    const { container } = render(
      <DataTable rows={ROWS} rowKey={(r) => r.id} columns={columns} expanded={(r) => (r.bad ? <em>why</em> : null)} expandedClassName="bg-ink-950/40 p-3" />,
    );
    const trs = [...container.querySelectorAll("tbody tr")];
    expect(trs.length).toBe(3);
    const detail = trs[2].firstElementChild as HTMLTableCellElement;
    expect([detail.colSpan, classes(detail), detail.textContent, trs[2].childElementCount]).toEqual([3, cls("bg-ink-950/40 p-3"), "why", 1]);
  });

  it("no rows: headers only", () => {
    const { container } = render(<DataTable rows={[]} rowKey={(r: Row) => r.id} columns={columns} />);
    expect(container.querySelectorAll("tbody tr").length).toBe(0);
    expect(container.querySelectorAll("thead th").length).toBe(3);
  });
});

describe("page frame", () => {
  const idle = { data: [1, 2], loading: false, error: null };

  it("PageHeader: title, icon, subtitle, action", () => {
    const { container } = render(<PageHeader title="Things" subtitle="All of them" icon="bi-box" action={<button>New</button>} />);
    const root = container.firstElementChild!;
    expect(classes(root)).toEqual(cls("mb-6 flex items-end justify-between gap-4"));
    const h1 = root.querySelector("h1")!;
    expect([classes(h1), h1.textContent, h1.querySelector("i")!.className]).toEqual([cls("flex items-center gap-2.5 text-2xl font-semibold text-ink-100"), "Things", "bi bi-box text-brand-400"]);
    expect([root.querySelector("p")!.textContent, classes(root.querySelector("p"))]).toEqual(["All of them", cls("mt-1 text-sm text-ink-400")]);
    expect(root.lastElementChild!.textContent).toBe("New");
  });

  it("PageHeader without icon/subtitle/action", () => {
    const { container } = render(<PageHeader title="Bare" />);
    expect([container.querySelector("i"), container.querySelector("p"), container.firstElementChild!.childElementCount]).toEqual([null, null, 1]);
  });

  it("AsyncStatus shows the spinner and the error independently of data", () => {
    const { container, rerender } = render(<AsyncStatus state={{ data: null, loading: true, error: null }} loadingLabel="Loading things" />);
    expect(container.textContent).toBe("Loading things");
    rerender(<AsyncStatus state={{ data: null, loading: false, error: "boom" }} />);
    expect([container.textContent, container.querySelector(".animate-spin")]).toEqual(["boom", null]);
    rerender(<AsyncStatus state={idle} />);
    expect(container.innerHTML).toBe("");
  });

  it("ResourcePage: header, then status, then empty state, then body", () => {
    const { container } = render(
      <ResourcePage title="T" state={{ data: [] as number[], loading: true, error: "stale" }} isEmpty={(d) => d.length === 0} empty={<p>nothing</p>}>
        <section>body</section>
      </ResourcePage>,
    );
    const root = container.firstElementChild!;
    expect(root.tagName).toBe("DIV");
    expect([...root.children].map((c) => c.textContent)).toEqual(["T", "", "stale", "nothing", "body"]);
    expect(root.children[1].querySelector(".animate-spin")).not.toBeNull();
  });

  it("ResourcePage keeps the body on screen during a reload", () => {
    render(<ResourcePage title="T" state={{ data: [1], loading: true, error: null }} isEmpty={(d: number[]) => d.length === 0} empty={<p>nothing</p>}><section>rows</section></ResourcePage>);
    expect([screen.queryByText("rows") !== null, screen.queryByText("nothing")]).toEqual([true, null]);
  });

  it("ResourcePage shows no empty state before data arrives", () => {
    render(<ResourcePage title="T" state={{ data: null as number[] | null, loading: true, error: null }} isEmpty={(d) => d.length === 0} empty={<p>nothing</p>} />);
    expect(screen.queryByText("nothing")).toBeNull();
  });

  it("headerWhileLoading=false: while loading the page is only the spinner", () => {
    const { container } = render(
      <ResourcePage title="T" headerWhileLoading={false} loadingLabel="Loading proxies" state={{ data: null, loading: true, error: null }}><section>body</section></ResourcePage>,
    );
    expect([container.querySelector("h1"), screen.queryByText("body"), container.textContent]).toEqual([null, null, "Loading proxies"]);
    expect(container.childElementCount).toBe(1);
  });

  it("headerWhileLoading=false: after a failed load the page is only the error", () => {
    const { container } = render(<ResourcePage title="T" headerWhileLoading={false} state={{ data: null, loading: false, error: "down" }}><section>body</section></ResourcePage>);
    expect([container.querySelector("h1"), container.textContent]).toEqual([null, "down"]);
  });

  it("headerWhileLoading=false: once loaded it is the ordinary page, without a status block", () => {
    const { container } = render(<ResourcePage title="T" headerWhileLoading={false} state={idle}><section>body</section></ResourcePage>);
    expect([...container.firstElementChild!.children].map((c) => c.textContent)).toEqual(["T", "body"]);
  });
});

describe("FormModal", () => {
  const setup = (props: Partial<Parameters<typeof FormModal>[0]> = {}) => {
    mockApi();
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    renderApp(
      <FormModal open title="Edit thing" icon="bi-box" onClose={onClose} onSubmit={onSubmit} submitLabel="Save" {...props}>
        <p>fields</p>
      </FormModal>,
    );
    return { onClose, onSubmit };
  };

  it("renders nothing while closed", () => {
    setup({ open: false });
    expect(modal("Edit thing")).toBeNull();
  });

  it("standard footer: ghost Cancel then primary submit with the check icon", () => {
    const { onClose, onSubmit } = setup();
    const m = openModal("Edit thing");
    const footer = m.lastElementChild!;
    expect([...footer.children].map((b) => [b.textContent, b.className])).toEqual([["Cancel", "btn-ghost"], ["Save", "btn-primary"]]);
    expect(button("Save", m).querySelector("i")!.className).toBe("bi bi-check-lg");
    fireEvent.click(button("Save", m));
    fireEvent.click(button("Cancel", m));
    expect([onSubmit.mock.calls.length, onClose.mock.calls.length]).toEqual([1, 1]);
  });

  it("custom cancel label and submit icon", () => {
    setup({ cancelLabel: "Never mind", submitIcon: "bi-plus-lg" });
    const m = openModal("Edit thing");
    expect(hasButton("Never mind", m)).toBe(true);
    expect(button("Save", m).querySelector("i")!.className).toBe("bi bi-plus-lg");
  });

  it.each([
    ["busy", { busy: true }, true, "bi bi-check-lg"],
    ["busy + spinWhenBusy", { busy: true, spinWhenBusy: true }, true, "bi bi-arrow-repeat animate-spin"],
    ["disabled", { disabled: true }, true, "bi bi-check-lg"],
    ["idle", {}, false, "bi bi-check-lg"],
  ] as const)("submit state: %s", (_name, props, disabled, icon) => {
    setup(props);
    const save = button("Save", openModal("Edit thing"));
    expect([save.disabled, save.querySelector("i")!.className]).toEqual([disabled, icon]);
  });

  it("footerStart turns the footer into a full-width row with the buttons grouped right", () => {
    setup({ footerStart: <button>Test</button> });
    const m = openModal("Edit thing");
    const row = m.lastElementChild!.firstElementChild!;
    expect(classes(row)).toEqual(cls("flex w-full items-center justify-between gap-2"));
    expect([row.children[0].textContent, classes(row.children[1]), row.children[1].textContent]).toEqual(["Test", cls("flex gap-2"), "CancelSave"]);
  });

  it("passes size through to the modal", () => {
    setup({ size: "lg" });
    expect(openModal("Edit thing").classList.contains("max-w-2xl")).toBe(true);
  });
});

describe("RowActions", () => {
  it("icon-only edit and delete in a right-aligned group", () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const { container } = render(<RowActions className="justify-end" onEdit={onEdit} onDelete={onDelete} />);
    const root = container.firstElementChild!;
    expect(classes(root)).toEqual(cls("flex justify-end gap-1.5"));
    const [edit, del] = [...root.children] as HTMLButtonElement[];
    expect([classes(edit), edit.innerHTML]).toEqual([cls("btn-ghost btn-xs"), '<i class="bi bi-pencil"></i>']);
    expect([classes(del), del.innerHTML]).toEqual([cls("btn-danger btn-xs"), '<i class="bi bi-trash3"></i>']);
    fireEvent.click(edit);
    fireEvent.click(del);
    expect([onEdit.mock.calls.length, onDelete.mock.calls.length]).toEqual([1, 1]);
  });

  it("labels, a different delete glyph, a disabled delete, and no extra layout class", () => {
    const { container } = render(<RowActions onEdit={() => {}} editLabel="Edit" onDelete={() => {}} deleteIcon="bi-x-circle" deleteLabel="Revoke" deleteDisabled />);
    const root = container.firstElementChild!;
    expect(classes(root)).toEqual(cls("flex gap-1.5"));
    const [edit, del] = [...root.children] as HTMLButtonElement[];
    expect([edit.textContent, del.textContent, del.querySelector("i")!.className, del.disabled]).toEqual(["Edit", "Revoke", "bi bi-x-circle", true]);
  });

  it("lead comes first, children last; missing handlers draw no button", () => {
    const { container } = render(<RowActions className="justify-end" lead={<b>lead</b>} onDelete={() => {}}><span>note</span></RowActions>);
    expect([...container.firstElementChild!.children].map((c) => c.tagName)).toEqual(["B", "BUTTON", "SPAN"]);
    cleanup();
    const only = render(<RowActions className="justify-end"><span>read only</span></RowActions>);
    expect(only.container.firstElementChild!.innerHTML).toBe("<span>read only</span>");
  });
});

describe("EntityCard", () => {
  it("plain card: name, badges, description, aside, body", () => {
    const { container } = render(
      <EntityCard title="gpt" badges={<span>on</span>} description="A model" aside={<button>edit</button>}>
        <footer>more</footer>
      </EntityCard>,
    );
    const card = container.firstElementChild!;
    expect(classes(card)).toEqual(cls("card card-pad"));
    const header = card.children[0];
    expect(classes(header)).toEqual(cls("flex items-start justify-between"));
    const text = header.children[0];
    expect(text.hasAttribute("class")).toBe(false);
    expect(classes(text.children[0])).toEqual(cls("flex items-center gap-2"));
    expect([...text.children[0].children].map((c) => [c.tagName, c.textContent])).toEqual([["SPAN", "gpt"], ["SPAN", "on"]]);
    expect(classes(text.children[0].children[0])).toEqual(cls("font-medium text-ink-100"));
    expect([classes(text.children[1]), text.children[1].textContent]).toEqual([cls("mt-0.5 text-sm text-ink-400"), "A model"]);
    expect([header.children[1].textContent, card.children[1].textContent]).toEqual(["edit", "more"]);
  });

  it("icon, mono title, small description, shrinking text column, gap, details", () => {
    const { container } = render(
      <EntityCard icon="bi-robot" title="agent-1" titleStyle="mono" description="d" descriptionSize="xs" shrinkText gap details={<div>line</div>} />,
    );
    const header = container.firstElementChild!.children[0];
    expect(classes(header)).toEqual(cls("flex items-start justify-between gap-3"));
    const text = header.children[0];
    expect(text.className).toBe("min-w-0");
    expect(text.querySelector("i")!.className).toBe("bi bi-robot text-brand-400");
    expect(classes(text.querySelector("span"))).toEqual(cls("truncate font-mono text-sm font-semibold text-ink-100"));
    expect(classes(text.querySelector("p"))).toEqual(cls("mt-1 text-xs text-ink-400"));
    expect(text.lastElementChild!.textContent).toBe("line");
    expect(header.childElementCount).toBe(1);
  });

  it("no description paragraph for null or empty text", () => {
    const { container } = render(<><EntityCard title="a" description={null} /><EntityCard title="b" description="" /></>);
    expect(container.querySelectorAll("p").length).toBe(0);
  });
});

describe("AuthCard", () => {
  it("lays out mark, title, subtitle, fields, error and actions; submits the form", () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    const { container } = render(
      <AuthCard mark={<b>logo</b>} title="Sign in" subtitle="to continue" onSubmit={onSubmit} error="Wrong password" actions={<button>Go</button>}>
        <input placeholder="user" />
      </AuthCard>,
    );
    const root = container.firstElementChild!;
    expect(classes(root)).toEqual(cls("flex min-h-screen items-center justify-center px-4"));
    expect(classes(root.firstElementChild)).toEqual(cls("w-full max-w-sm"));
    expect([root.querySelector("h1")!.textContent, root.querySelector("h1 + p")!.textContent]).toEqual(["Sign in", "to continue"]);
    const form = root.querySelector("form")!;
    expect(classes(form)).toEqual(cls("card card-pad space-y-4"));
    expect([...form.children].map((c) => c.tagName)).toEqual(["INPUT", "DIV", "BUTTON"]);
    expect(classes(form.children[1])).toEqual(cls("flex items-center gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300"));
    expect([form.children[1].textContent, form.children[1].querySelector("i")!.className]).toEqual(["Wrong password", "bi bi-exclamation-circle"]);
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("no error box without an error; wide form", () => {
    const { container } = render(<AuthCard mark={null} title="t" subtitle="s" width="lg" onSubmit={() => {}} error={null} actions={<button>Go</button>}><input /></AuthCard>);
    expect([...container.querySelector("form")!.children].map((c) => c.tagName)).toEqual(["INPUT", "BUTTON"]);
    expect(classes(container.firstElementChild!.firstElementChild)).toEqual(cls("w-full max-w-2xl"));
  });
});
