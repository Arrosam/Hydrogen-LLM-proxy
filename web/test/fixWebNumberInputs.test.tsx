/**
 * WB7: a cleared number box used to become 0 (`Number("")`), below the box's
 * own minimum, and was sent as such. The value handed on is now always inside
 * the declared range; an emptied box stands for the default.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HostedToolBinding } from "../src/components/HostedToolBinding";
import { BoundedIntInput } from "../src/components/numeric";
import { Tools } from "../src/pages/Tools";
import type { HostedToolOptions } from "../src/types";
import { ADMIN, button, field, mockApi, openModal, renderApp, renderPage, toastShown, type } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("BoundedIntInput", () => {
  const show = (value = 30) => {
    const onChange = vi.fn();
    const view = render(<BoundedIntInput value={value} onChange={onChange} limits={{ min: 10, max: 50 }} fallback={30} />);
    return { onChange, input: view.container.querySelector("input")!, ...view };
  };

  it("is a number box carrying its range", () => {
    const { input } = show();
    expect([input.type, input.min, input.max, input.value, input.className]).toEqual(["number", "10", "50", "30", "input"]);
  });

  it.each([
    ["", 30],
    ["abc", 30],
    ["0", 10],
    ["-4", 10],
    ["9", 10],
    ["10", 10],
    ["42", 42],
    ["42.9", 42],
    ["50", 50],
    ["51", 50],
    ["999999", 50],
  ])("typing %j hands on %i", (raw, expected) => {
    const { onChange, input } = show(20);
    type(input, raw);
    expect(onChange.mock.calls).toEqual([[expected]]);
  });

  it("leaves what is being typed alone, and shows the kept value on leaving the field", () => {
    const { input, rerender } = show(30);
    type(input, "4");
    expect(input.value).toBe("4");
    rerender(<BoundedIntInput value={10} onChange={() => {}} limits={{ min: 10, max: 50 }} fallback={30} />);
    expect(input.value).toBe("4");
    fireEvent.blur(input);
    expect(input.value).toBe("10");
  });

  it("follows a value replaced from outside", () => {
    const { input, rerender } = show(30);
    rerender(<BoundedIntInput value={44} onChange={() => {}} limits={{ min: 10, max: 50 }} fallback={30} />);
    expect(input.value).toBe("44");
  });
});

describe("HostedToolBinding limits", () => {
  const CONFIG: HostedToolOptions = { streamMode: "progress", maxRounds: 4, maxCalls: 8 };
  const setup = () => {
    mockApi();
    const onConfig = vi.fn();
    const view = renderApp(<HostedToolBinding tools={[]} ids={[]} config={CONFIG} onIds={() => {}} onConfig={onConfig} />);
    return { onConfig, ...view };
  };

  it.each([
    ["Maximum model rounds", "maxRounds", "", 8],
    ["Maximum model rounds", "maxRounds", "0", 1],
    ["Maximum model rounds", "maxRounds", "99", 32],
    ["Maximum tool calls", "maxCalls", "", 16],
    ["Maximum tool calls", "maxCalls", "0", 1],
    ["Maximum tool calls", "maxCalls", "500", 128],
  ] as const)("%s: %j is reported as %s = %i", (label, key, raw, expected) => {
    const { onConfig, container } = setup();
    type(field(label, container), raw);
    expect(onConfig.mock.calls).toEqual([[{ ...CONFIG, [key]: expected }]]);
  });
});

describe("Tools editor limits", () => {
  it.each([
    ["an emptied box saves the default", "", "", 30000, 65536],
    ["a value under the minimum saves the minimum", "5", "0", 100, 1],
    ["a value over the maximum saves the maximum", "9999999", "99999999", 600000, 1048576],
  ])("%s", async (_name, timeout, bytes, timeoutMs, maxResultBytes) => {
    const api = mockApi({ "GET /tools": { tools: [] }, "POST /tools": {} }, ADMIN);
    await renderPage(<Tools />);
    await screen.findByText("Make an HTTP API available to your model");
    fireEvent.click(button("Register tool"));
    const m = openModal("Register server tool");
    type(field("Timeout (ms)", m), timeout);
    type(field("Maximum response bytes", m), bytes);
    fireEvent.click(button("Save tool", m));
    await toastShown("Tool saved");
    await waitFor(() => expect(api.mutations()).toHaveLength(1));
    expect(api.mutations()[0].body).toMatchObject({ timeoutMs, maxResultBytes });
  });
});
