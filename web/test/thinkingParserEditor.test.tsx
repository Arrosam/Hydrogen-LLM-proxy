import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ThinkingParserEditor } from "../src/components/ThinkingParserEditor";
import type { ThinkingParser } from "../src/types";

vi.mock("../src/lib/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

function Editor() {
  const [value, setValue] = useState<ThinkingParser>();
  return <><ThinkingParserEditor value={value} onChange={setValue} /><output data-testid="config">{JSON.stringify(value)}</output></>;
}

it("defaults decoding off and explicitly selects per-step exact parsing", () => {
  render(<Editor />);
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("off");
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "think_tags" } });
  expect(JSON.parse(screen.getByTestId("config").textContent!)).toEqual({ mode: "think_tags", unterminated: "error" });
  fireEvent.change(screen.getAllByRole("combobox")[1], { target: { value: "reasoning" } });
  expect(JSON.parse(screen.getByTestId("config").textContent!)).toEqual({ mode: "think_tags", unterminated: "reasoning" });
});

it("preserves exact custom markers and clears them when decoding is disabled", () => {
  render(<Editor />);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "custom" } });
  const [open, close] = screen.getAllByRole("textbox");
  fireEvent.change(open, { target: { value: "[start]" } });
  fireEvent.change(close, { target: { value: "[end]" } });
  expect(JSON.parse(screen.getByTestId("config").textContent!)).toEqual({ mode: "custom", delimiters: { open: "[start]", close: "[end]" }, unterminated: "error" });
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "off" } });
  expect(JSON.parse(screen.getByTestId("config").textContent!)).toEqual({ mode: "off" });
  expect(screen.queryAllByRole("textbox")).toHaveLength(0);
});
