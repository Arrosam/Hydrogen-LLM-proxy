/**
 * Independent verification, spec section WEB-B, item WB13 (Overview): the
 * endpoint hint's two sentences are separated, and the Requests chart series
 * has the colour of the Requests stat card. Colours are resolved from the
 * Tailwind palette (the project's config, then Tailwind's defaults), not from
 * the page's source.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen } from "@testing-library/react";
import defaultColors from "tailwindcss/colors";
// @ts-expect-error -- the Tailwind config is plain JavaScript without a declaration file
import tailwindConfig from "../tailwind.config.js";
import { Overview } from "../src/pages/Overview";
import type { GroupCount, StatsSummary, TimePoint } from "../src/types";
import { ADMIN, mockApi, renderPage, type Routes } from "./helpers";

// jsdom has no layout, so recharts draws nothing: stand-ins record the props they are given.
vi.mock("recharts", async () => {
  const { createElement } = await import("react");
  type Props = Record<string, unknown> & { children?: unknown };
  const leaf = (kind: string) => (props: Props) => createElement("g", { "data-chart": kind, "data-props": JSON.stringify(props) });
  const box = (kind: string, tag: string) => ({ children, ...props }: Props) =>
    createElement(tag, { "data-chart": kind, "data-props": JSON.stringify(props) }, children as never);
  return {
    ResponsiveContainer: box("ResponsiveContainer", "div"), AreaChart: box("AreaChart", "svg"),
    CartesianGrid: leaf("CartesianGrid"), XAxis: leaf("XAxis"), YAxis: leaf("YAxis"), Tooltip: leaf("Tooltip"), Area: leaf("Area"),
  };
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date(2026, 5, 1, 12, 0, 0).getTime());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const SUMMARY: StatsSummary = {
  requests: 12_345, errors: 7, promptTokens: 8000, completionTokens: 2000, totalTokens: 1_234_567, cachedInputTokens: 2000,
  cacheCreationInputTokens: 0, reasoningTokens: 0, avgLatencyMs: 1432,
};
const POINTS: TimePoint[] = [
  { day: "2026-05-30", requests: 10, totalTokens: 120_000, errors: 1, avgLatencyMs: 300 },
  { day: "2026-05-31", requests: 40, totalTokens: 480_000, errors: 0, avgLatencyMs: 250 },
];
const group = (key: string, requests: number): GroupCount => ({ key, requests, totalTokens: requests * 10 });
const overview = async (routes: Routes = {}) => {
  mockApi({
    "GET /stats/summary": SUMMARY,
    "GET /stats/timeseries": { points: POINTS },
    "GET /stats/by-service": { groups: [group("a", 50)] },
    "GET /stats/by-model-provider": { models: [], providers: [group("openai", 0)] },
    ...routes,
  }, ADMIN);
  const view = await renderPage(<Overview />);
  await tick();
  return view;
};
const part = (kind: string): Record<string, unknown>[] =>
  [...document.querySelectorAll(`[data-chart="${kind}"]`)].map((e) => JSON.parse(e.getAttribute("data-props")!) as Record<string, unknown>);

type Palette = Record<string, unknown>;
const projectColors = ((tailwindConfig as { theme?: { extend?: { colors?: Palette } } }).theme?.extend?.colors ?? {}) as Record<string, Record<string, string>>;
/** The hex a Tailwind text colour class stands for. */
const hexOf = (el: Element): string => {
  const name = [...el.classList].find((c) => /^text-[a-z]+-\d+$/.test(c));
  if (!name) throw new Error(`no text colour class on <${el.tagName.toLowerCase()} class="${el.className}">`);
  const [, hue, shade] = /^text-([a-z]+)-(\d+)$/.exec(name)!;
  const hex = projectColors[hue]?.[shade] ?? (defaultColors as unknown as Record<string, Record<string, string>>)[hue]?.[shade];
  if (!hex) throw new Error(`unknown colour ${name}`);
  return hex.toLowerCase();
};
/** The stat card (the smallest `.card`) whose caption is `label`. */
const statCard = (container: HTMLElement, label: string): HTMLElement => {
  const card = [...container.querySelectorAll<HTMLElement>(".card")].find((c) => c.children[0]?.children[0]?.textContent === label && c.querySelector("i"));
  if (!card) throw new Error(`no stat card "${label}"`);
  return card;
};
const normal = (colour: unknown): string => String(colour).toLowerCase();

describe("WB13: Overview endpoint hints", () => {
  const SECOND = "Use a Model Service or Micro Agent name as the model.";
  const FIRST = {
    "OpenAI base URL": "OpenAI SDK baseURL / OPENAI_BASE_URL — serves both /chat/completions and /responses (Codex CLI, etc.)",
    "Anthropic base URL": "Anthropic SDK base_url / ANTHROPIC_BASE_URL",
  };
  const BLOCK = new Set(["DIV", "P", "LI", "DD", "DT", "SECTION"]);
  /** The innermost element whose own text nodes contain `needle`. */
  const holder = (within: Element, needle: string): Element | null =>
    [...within.querySelectorAll("*")].reverse().find((el) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").includes(needle))) ?? null;

  it.each(Object.entries(FIRST))("%s: its two hint sentences are separated, not run together", async (label, first) => {
    await overview();
    const box = screen.getByText(label).parentElement!;
    const raw = box.textContent ?? "";
    expect(raw).toContain(first);
    expect(raw).toContain(SECOND);
    expect(raw).not.toContain(`${first}${SECOND}`);
    const a = holder(box, first);
    const b = holder(box, SECOND);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const between = raw.slice(raw.indexOf(first) + first.length, raw.indexOf(SECOND));
    const onSeparateLines = a !== b && (BLOCK.has(a!.tagName) || BLOCK.has(b!.tagName) || a!.classList.contains("block") || b!.classList.contains("block"));
    const lineBreak = box.querySelector("br") !== null;
    expect(/\s/.test(between) || onSeparateLines || lineBreak, `between the sentences: ${JSON.stringify(between)}`).toBe(true);
    // Whatever separates them is a separator (blanks, punctuation), not more wording.
    expect(between).not.toMatch(/[A-Za-z0-9\u3400-\u9fff]/);
  });

  it("the Chinese hints are separated as well", async () => {
    await overview({ "GET /settings/ui-language": { language: "zh" } });
    const second = "使用模型服务或微型代理的名称作为 model。";
    const boxes = [...document.querySelectorAll("code")].map((c) => c.closest(".rounded-lg")!).filter((b, i, all) => all.indexOf(b) === i);
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      const raw = box.textContent ?? "";
      expect(raw).toContain(second);
      const before = raw.slice(0, raw.indexOf(second));
      // The first sentence is there, and a blank separates it from the second.
      expect(before.trim().length).toBeGreaterThan(0);
      expect(before).toMatch(/\s$/);
    }
  });

  it("each endpoint still shows its own URL (unchanged)", async () => {
    await overview();
    const origin = window.location.origin;
    expect(screen.getByText("OpenAI base URL").parentElement!.querySelector("code")!.textContent).toBe(`${origin}/v1`);
    expect(screen.getByText("Anthropic base URL").parentElement!.querySelector("code")!.textContent).toBe(origin);
  });
});

describe("WB13: Overview Requests colour", () => {
  it("the palette lookup works (brand-400 comes from the project's Tailwind config)", () => {
    const probe = document.createElement("i");
    probe.className = "bi text-brand-400";
    expect(hexOf(probe)).toBe(projectColors.brand["400"].toLowerCase());
    probe.className = "bi text-red-400";
    expect(hexOf(probe)).toBe("#f87171");
  });

  it("the Requests chart series is drawn in the Requests stat card's colour", async () => {
    const { container } = await overview();
    const card = statCard(container, "Requests");
    const cardColour = hexOf(card.querySelector("i")!);
    const series = part("Area").find((a) => a.name === "Requests" || a.dataKey === "requests");
    expect(series).toBeDefined();
    expect(normal(series!.stroke)).toBe(cardColour);
    // Its axis follows the series.
    const axis = part("YAxis").find((y) => y.yAxisId === series!.yAxisId);
    expect(normal(axis!.stroke)).toBe(cardColour);
  });

  it("the legend's Requests dot has the same colour", async () => {
    const { container } = await overview();
    const cardColour = hexOf(statCard(container, "Requests").querySelector("i")!);
    const entry = [...screen.getByText("Traffic over time").nextElementSibling!.querySelectorAll("button")].find((b) => b.textContent === "Requests")!;
    const dot = entry.querySelector<HTMLElement>("span")!;
    const probe = document.createElement("span");
    probe.style.background = cardColour;
    expect(dot.style.background || dot.style.backgroundColor).toBe(probe.style.background);
  });

  it("the other three series are still there, each with its own colour (unchanged)", async () => {
    await overview();
    const areas = part("Area");
    expect(areas.map((a) => a.name)).toEqual(["Requests", "Tokens", "Errors", "Avg latency"]);
    expect(new Set(areas.map((a) => normal(a.stroke))).size).toBe(4);
  });

  it("the five stat cards keep their captions (unchanged)", async () => {
    const { container } = await overview();
    for (const label of ["Requests", "Total tokens", "Cached input", "Errors", "Avg latency"]) expect(statCard(container, label)).toBeTruthy();
  });
});
