/** WB15: `Select`'s placeholder over a numeric list, and an HTTP block with nothing to show. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HttpInfoBlock } from "../src/components/HttpInfoBlock";
import { Select } from "../src/components/inputs";
import { classes, cls } from "./helpers";

afterEach(() => {
  cleanup();
});

describe("Select placeholder", () => {
  const pick = (value: string) => fireEvent.change(screen.getByRole("combobox"), { target: { value } });

  it("over a numeric list is reported as the empty value, not as the id 0", () => {
    const onChange = vi.fn();
    render(<Select value={2} onChange={onChange} placeholder="All" options={[{ value: 1, label: "One" }, { value: 2, label: "Two" }]} />);
    pick("");
    expect(onChange.mock.calls).toEqual([[""]]);
    pick("1");
    expect(onChange.mock.calls[1]).toEqual([1]);
  });

  it("a real option whose id is 0 is still reported as the number 0", () => {
    const onChange = vi.fn();
    render(<Select value="" onChange={onChange} placeholder="All" options={[{ value: 0, label: "Zero" }, { value: 1, label: "One" }]} />);
    pick("0");
    expect(onChange.mock.calls).toEqual([[0]]);
  });

  it("over a string list is the empty value, as before", () => {
    const onChange = vi.fn();
    render(<Select value="a" onChange={onChange} placeholder="None" options={[{ value: "a", label: "Alpha" }]} />);
    pick("");
    expect(onChange.mock.calls).toEqual([[""]]);
  });
});

describe("HttpInfoBlock", () => {
  it("with only a query string (which is shown as part of the path) says nothing was recorded", () => {
    const { container } = render(<HttpInfoBlock title="Client request" emptyLabel="Not recorded" query="beta=1" method={null} path={null} headers={null} />);
    const root = container.firstElementChild!;
    expect(root.children).toHaveLength(2);
    expect([root.children[1].textContent, classes(root.children[1])]).toEqual(["Not recorded", cls("rounded-lg border border-ink-800 bg-ink-950 px-3 py-2 text-xs text-ink-500")]);
    expect(container.querySelector(".bg-ink-950\\/40")).toBeNull();
  });

  it("still shows the query after its path", () => {
    render(<HttpInfoBlock title="Client request" emptyLabel="Not recorded" method="GET" path="/v1/models" query="beta=1" />);
    expect(screen.getByText("/v1/models?beta=1")).toBeTruthy();
  });
});
