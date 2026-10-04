import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostedToolBinding } from "../src/components/HostedToolBinding";
import { I18nProvider } from "../src/lib/i18n";
import type { HostedTool, HostedToolOptions } from "../src/types";
import { comboboxLayout } from "./comboboxLayout";

comboboxLayout();

const config: HostedToolOptions = { streamMode: "progress", maxRounds: 8, maxCalls: 16 };
const tool = (id: number, name = `tool_${id}`, description = "Synthetic lookup"): HostedTool => ({
  id, name, description, parameters: {}, url: "http://127.0.0.1:1/never-called", bodyTemplate: {}, resultPath: "", timeoutMs: 5000, maxResultBytes: 1024, enabled: true, headerNames: [], hasHeaders: false,
});
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ language: "en" }))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function setup(tools = [tool(1, "Alpha", "Customer records"), tool(2, "Beta", "Inventory")], ids: number[] = [], disabled = false) {
  const onIds = vi.fn(), onConfig = vi.fn();
  function Harness({ catalog }: { catalog: HostedTool[] }) {
    const [selected, setSelected] = useState(ids);
    return <HostedToolBinding tools={catalog} ids={selected} config={config} onIds={next => { onIds(next); setSelected(next); }} onConfig={onConfig} disabled={disabled} />;
  }
  const view = render(<I18nProvider><Harness catalog={tools} /></I18nProvider>);
  return { input: screen.getByRole("combobox", { name: "Bound tools" }) as HTMLInputElement, onIds, onConfig,
    refresh: (catalog: HostedTool[]) => view.rerender(<I18nProvider><Harness catalog={catalog} /></I18nProvider>) };
}
async function open(input: HTMLInputElement) {
  fireEvent.focus(input);
  await waitFor(() => expect(input.getAttribute("aria-expanded")).toBe("true"));
}
async function select(name: RegExp) {
  fireEvent.mouseDown(await screen.findByRole("option", { name }), { button: 0 });
}
describe("hosted tool Combobox", () => {
  it("searches descriptions/case, adds existing IDs, clears query, and retains focus for consecutive selections", async () => {
    const { input, onIds } = setup();
    await open(input);
    fireEvent.change(input, { target: { value: "CUSTOMER" } });
    await select(/Alpha/);
    expect(onIds).toHaveBeenLastCalledWith([1]);
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain(`${input.id}-help`);
    await select(/Beta/);
    expect(onIds).toHaveBeenLastCalledWith([1, 2]);
    expect(screen.getByRole("button", { name: "Remove Alpha" })).toBeTruthy();
  });
  it("unions filtered results, deduplicates catalog/selection IDs, and clears everything", () => {
    const { input, onIds } = setup([tool(1, "Alpha"), tool(2, "Beta"), tool(2, "Beta")], [1, 1, 999]);
    fireEvent.change(input, { target: { value: "Beta" } });
    fireEvent.click(screen.getByRole("button", { name: "Select all search results" }));
    expect(onIds).toHaveBeenLastCalledWith([1, 999, 2]);
    expect(screen.getAllByRole("button", { name: "Remove Alpha" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear", exact: true }));
    expect(onIds).toHaveBeenLastCalledWith([]);
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Select all search results" }));
    expect(onIds).toHaveBeenLastCalledWith([1, 2]);
  });
  it.each(["pointer", "keyboard"])("keeps the filter across blur for a %s bulk activation", async mode => {
    const { input, onIds } = setup();
    await open(input);
    fireEvent.change(input, { target: { value: "Beta" } });
    const bulk = screen.getByRole("button", { name: "Select all search results" });
    if (mode === "pointer") fireEvent.mouseDown(bulk, { button: 0 });
    fireEvent.blur(input, { relatedTarget: bulk });
    fireEvent.focus(bulk);
    await waitFor(() => expect(input.getAttribute("aria-expanded")).toBe("false"));
    expect(input.value).toBe("Beta");
    if (mode === "pointer") fireEvent.mouseUp(bulk, { button: 0 });
    else fireEvent.keyDown(bulk, { key: "Enter" });
    // jsdom doesn't synthesize a native button click from keyboard input.
    fireEvent.click(bulk);
    expect(onIds).toHaveBeenLastCalledWith([2]);
  });
  it("rejects a two-tool batch at 63 atomically rather than partially filling the cap", () => {
    const catalog = Array.from({ length: 65 }, (_, i) => tool(i + 1, i >= 63 ? `batch_${i + 1}` : `tool_${i + 1}`));
    const { input, onIds } = setup(catalog, Array.from({ length: 63 }, (_, i) => i + 1));
    fireEvent.change(input, { target: { value: "batch" } });
    fireEvent.click(screen.getByRole("button", { name: "Select all search results" }));
    expect(onIds).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(63);
  });
  it("reports no results for a nonempty catalog and Escape closes without inventing an ID", async () => {
    const { input, onIds } = setup();
    await open(input);
    fireEvent.change(input, { target: { value: "unknown_tool" } });
    expect(await screen.findByText("No matching tools")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(input.getAttribute("aria-expanded")).toBe("false"));
    expect(onIds).not.toHaveBeenCalled();
  });
  it("does not select a stale active option after filtering a previously selected result to zero", async () => {
    const { input, onIds } = setup();
    await open(input);
    fireEvent.change(input, { target: { value: "Beta" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onIds).toHaveBeenLastCalledWith([2]);
    onIds.mockClear();
    fireEvent.change(input, { target: { value: "unknown_tool" } });
    expect(await screen.findByText("No matching tools")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onIds).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove Beta" })).toBeTruthy();
  });
  it.each([63, 64, 65])("bulk additions at %s selected reject atomically or reach 64, with removals allowed", count => {
    const catalog = Array.from({ length: 66 }, (_, i) => tool(i + 1));
    const ids = Array.from({ length: count }, (_, i) => i + 1);
    const { input, onIds } = setup(catalog, ids);
    fireEvent.change(input, { target: { value: count === 63 ? "tool_64" : "tool_66" } });
    fireEvent.click(screen.getByRole("button", { name: "Select all search results" }));
    if (count === 63) expect(onIds).toHaveBeenLastCalledWith([...ids, 64]);
    else {
      expect(onIds).not.toHaveBeenCalled();
      expect(screen.getByRole("alert").textContent).toContain("No tools were added");
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(input.getAttribute("aria-describedby")).toContain(`${input.id}-error`);
    }
    fireEvent.click(screen.getByRole("button", { name: "Remove tool_1" }));
    expect(onIds.mock.lastCall?.[0].length).toBe(count === 63 ? 63 : count - 1);
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("rejects an individual 65th binding and allows toggling an existing option off at the cap", async () => {
    const { input, onIds } = setup(Array.from({ length: 65 }, (_, i) => tool(i + 1)), Array.from({ length: 64 }, (_, i) => i + 1));
    await open(input);
    fireEvent.change(input, { target: { value: "tool_65" } });
    await select(/tool_65/);
    expect(onIds).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.change(input, { target: { value: "tool_64" } });
    await select(/tool_64/);
    expect(onIds.mock.lastCall?.[0]).toHaveLength(63);
  });
  it("preserves disabled and missing bindings, and allows explicitly binding disabled registered tools", async () => {
    const disabledTool = { ...tool(1, "Paused"), enabled: false };
    const { input, onIds } = setup([disabledTool, tool(2, "Active")], [999]);
    expect(screen.getByRole("button", { name: "Remove Missing tool #999" })).toBeTruthy();
    await open(input);
    await select(/Paused.*disabled/);
    expect(onIds).toHaveBeenLastCalledWith([999, 1]);
    fireEvent.change(input, { target: { value: "Active" } });
    await select(/Active/);
    expect(onIds).toHaveBeenLastCalledWith([999, 1, 2]);
  });
  it("survives an open catalog refresh, preserves removed bindings, and selects only remaining tools", async () => {
    const { input, onIds, refresh } = setup(undefined, [1]);
    await open(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    refresh([tool(2, "Beta")]);
    expect(screen.getByRole("button", { name: "Remove Missing tool #1" })).toBeTruthy();
    expect(onIds).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("option", { name: /Alpha/ })).toBeNull());
    await select(/Beta/);
    expect(onIds).toHaveBeenLastCalledWith([1, 2]);
    onIds.mockClear();
    refresh([]);
    expect(await screen.findByText("No matching tools")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Missing tool #2" })).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onIds).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove Missing tool #1" }));
    expect(onIds).toHaveBeenLastCalledWith([2]);
    expect(document.activeElement).toBe(input);
  });
  it("shows empty/no-result states, has no arbitrary tool option, and keeps config callbacks intact", async () => {
    const { input, onIds, onConfig } = setup([], [999]);
    await open(input);
    fireEvent.change(input, { target: { value: "invented_tool" } });
    expect(await screen.findByText("No matching tools")).toBeTruthy();
    expect(within(screen.getByRole("listbox")).queryByRole("option")).toBeNull();
    expect(screen.getByRole("link", { name: "Register a tool on the Tools page" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Select all search results" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onIds).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Streaming delivery"), { target: { value: "final" } });
    expect(onConfig).toHaveBeenCalledWith({ ...config, streamMode: "final" });
  });
  it("disables input, chip removal, bulk actions and configuration in the disabled state", () => {
    const { input, onIds } = setup(undefined, [1], true);
    expect(input.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Remove Alpha" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Clear", exact: true }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove Alpha" }));
    expect(onIds).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Streaming delivery") as HTMLSelectElement).closest("fieldset")?.disabled).toBe(true);
  });
});
