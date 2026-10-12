/**
 * WB2: Tools, HostedToolBinding and the Responses retention card wrote both
 * languages inline (`zh ? "…" : "…"`) instead of going through `t()`, so their
 * strings were missing from the translation tables.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { Tools } from "../src/pages/Tools";
import { ADMIN, button, mockApi, renderPage } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const SRC = path.resolve(__dirname, "../src");
const I18N = path.join(SRC, "lib/i18n.tsx");
const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

describe("one translation mechanism", () => {
  it("no component picks its own wording by comparing the language", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => file !== I18N && /language === "zh"/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it("the moved strings exist in both tables", () => {
    const source = fs.readFileSync(I18N, "utf8");
    const split = source.indexOf("const zh: Dict");
    const keysOf = (text: string) => new Set([...text.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]));
    const en = keysOf(source.slice(0, split));
    const zh = keysOf(source.slice(split));
    const moved = [...en].filter((k) => /^(tools|hostedTools|settings\.responseRetention)(\.|$)/.test(k));
    expect(moved.length).toBeGreaterThan(40);
    expect(moved.filter((k) => !zh.has(k))).toEqual([]);
    expect([...zh].filter((k) => /^(tools|hostedTools|settings\.responseRetention)(\.|$)/.test(k) && !en.has(k))).toEqual([]);
  });

  it("the Tools page still reads the same in Chinese", async () => {
    mockApi({ "GET /settings/ui-language": { language: "zh" }, "GET /tools": { tools: [] } }, ADMIN);
    await renderPage(<Tools />);
    await screen.findByText("把任意 HTTP API 提供给模型");
    expect(screen.getByText("服务器工具")).toBeTruthy();
    expect(button("注册工具")).toBeTruthy();
  });
});
