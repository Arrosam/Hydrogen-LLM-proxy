/**
 * WB13: the Overview's endpoint hint ran two sentences together, and the
 * traffic chart drew "requests" in a different colour from its stat card
 * although a metric is meant to have one colour in both places.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { Overview } from "../src/pages/Overview";
import { ADMIN, mockApi, renderPage } from "./helpers";

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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const SUMMARY = { requests: 10, errors: 1, promptTokens: 900, completionTokens: 100, totalTokens: 1000, cachedInputTokens: 300, avgLatencyMs: 12 };
const setup = async () => {
  mockApi({
    "GET /stats/summary": SUMMARY,
    "GET /stats/timeseries": { points: [{ day: "2026-06-01", requests: 10, totalTokens: 1000, errors: 1, avgLatencyMs: 12 }] },
    "GET /stats/by-service": { groups: [] },
    "GET /stats/by-model-provider": { models: [], providers: [] },
  }, ADMIN);
  const view = await renderPage(<Overview />);
  await screen.findByText("Traffic over time");
  return view;
};
/** The Tailwind tone classes the stat cards use, as the colours they resolve to (tailwind.config.js brand, stock 400s). */
const TONE_COLOR: Record<string, string> = {
  "text-brand-400": "#5eead4", "text-amber-400": "#fbbf24", "text-sky-400": "#38bdf8", "text-red-400": "#f87171", "text-emerald-400": "#34d399",
};

describe("Overview", () => {
  it("separates the endpoint's own hint from the shared model-name hint", async () => {
    await setup();
    const hints = [...document.querySelectorAll(".mt-1\\.5.text-\\[11px\\]")].map((e) => e.textContent);
    expect(hints).toEqual([
      "OpenAI SDK baseURL / OPENAI_BASE_URL — serves both /chat/completions and /responses (Codex CLI, etc.) · Use a Model Service or Micro Agent name as the model.",
      "Anthropic SDK base_url / ANTHROPIC_BASE_URL · Use a Model Service or Micro Agent name as the model.",
    ]);
  });

  it("draws every charted metric in the colour of its stat card's icon", async () => {
    const { container } = await setup();
    const cards = [...container.querySelector(".space-y-6")!.firstElementChild!.children];
    const cardColor = Object.fromEntries(cards.map((card) => {
      const tone = [...card.querySelector("i")!.classList].find((c) => c.startsWith("text-"))!;
      return [card.querySelector("span")!.textContent, TONE_COLOR[tone]];
    }));
    expect(Object.values(cardColor).every(Boolean)).toBe(true);
    const curves = [...document.querySelectorAll('[data-chart="Area"]')].map((e) => JSON.parse(e.getAttribute("data-props")!) as { name: string; stroke: string });
    expect(curves.map((c) => c.name)).toEqual(["Requests", "Tokens", "Errors", "Avg latency"]);
    const label: Record<string, string> = { Requests: "Requests", Tokens: "Total tokens", Errors: "Errors", "Avg latency": "Avg latency" };
    expect(curves.map((c) => [c.name, c.stroke])).toEqual(curves.map((c) => [c.name, cardColor[label[c.name]]]));
  });
});
