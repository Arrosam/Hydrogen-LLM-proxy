/** WB9: the "no match" line quotes the search as it was typed, not its lowercased form. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { ModelList } from "../src/components/ModelList";
import { mockApi, renderApp, type } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ModelList: no match", () => {
  it("quotes the built-in search box's text in the case it was typed", () => {
    mockApi();
    const { container } = renderApp(<ModelList models={["gpt-4o", "claude"]} emptyText="none" />);
    type(container.querySelector("input")!, "  GPT-5 Turbo ");
    expect(screen.getByText('No model matches "GPT-5 Turbo".')).toBeTruthy();
  });

  it("quotes the caller's filter in the case it was typed", () => {
    mockApi();
    renderApp(<ModelList models={["gpt-4o"]} filter="Sonnet" emptyText="none" />);
    expect(screen.getByText('No model matches "Sonnet".')).toBeTruthy();
  });

  it("still matches without regard to case", () => {
    mockApi();
    renderApp(<ModelList models={["gpt-4o", "claude"]} filter="  CLAUDE " emptyText="none" />);
    expect(screen.getByText("claude")).toBeTruthy();
    expect(screen.queryByText("gpt-4o")).toBeNull();
  });
});
