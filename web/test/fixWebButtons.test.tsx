/**
 * WB1: every button class a page puts on an element must be one index.css
 * defines. `btn-secondary` (Tools) and `btn-sm` (Check) were not, so those
 * controls rendered as bare unstyled buttons.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { Check } from "../src/pages/Check";
import { Tools } from "../src/pages/Tools";
import type { HostedTool } from "../src/types";
import { ADMIN, button, classes, cls, mockApi, openModal, renderPage } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const SRC = path.resolve(__dirname, "../src");
const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

describe("button classes", () => {
  it("every btn-* class named in the source is defined in index.css", () => {
    const css = fs.readFileSync(path.join(SRC, "index.css"), "utf8");
    const defined = new Set([...css.matchAll(/^\s*\.(btn(?:-[a-z0-9]+)*)\s*\{/gm)].map((m) => m[1]));
    const used = new Set(sourceFiles(SRC).flatMap((file) => [...fs.readFileSync(file, "utf8").matchAll(/(?<![A-Za-z0-9-])btn-[a-z0-9]+(?![A-Za-z0-9-])/g)].map((m) => m[0])));
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
  });

  const TOOL: HostedTool = {
    id: 5, name: "search", description: "Search the docs", parameters: { type: "object" }, url: "https://adapter.example/call",
    bodyTemplate: {}, resultPath: "/data", timeoutMs: 5000, maxResultBytes: 1024, enabled: true, headerNames: [], hasHeaders: false,
  };

  it("Tools: Edit, Delete, Preview and Cancel are ghost buttons", async () => {
    mockApi({ "GET /tools": { tools: [TOOL] } }, ADMIN);
    await renderPage(<Tools />);
    await screen.findByText("search");
    expect(classes(button("Edit"))).toEqual(["btn-ghost"]);
    expect(classes(button("Delete"))).toEqual(["btn-ghost"]);
    fireEvent.click(button("Edit"));
    const m = openModal("Edit search");
    expect(classes(button("Preview", m))).toEqual(["btn-ghost"]);
    expect(classes(button("Cancel", m))).toEqual(["btn-ghost"]);
    expect(classes(button("Save tool", m))).toEqual(["btn-primary"]);
  });

  it("Check: the dashboard link is a small ghost button", async () => {
    mockApi();
    await renderPage(<Check />);
    const home = screen.getByText("Dashboard").closest("a")!;
    expect(classes(home)).toEqual(cls("btn-ghost btn-xs"));
  });
});
