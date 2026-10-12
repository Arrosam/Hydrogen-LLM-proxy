/**
 * Colours needed as raw values (chart SVG attributes cannot take a Tailwind
 * class). `INK` and `BRAND` mirror `theme.extend.colors` in
 * web/tailwind.config.js -- change both together.
 */

export const INK = {
  950: "#0a0c10",
  900: "#0f131a",
  850: "#151b24",
  800: "#1b222d",
  700: "#273140",
  600: "#3a4657",
  500: "#5b6b80",
  400: "#8595a8",
  300: "#aab6c6",
  200: "#c7d0dc",
  100: "#e6ebf1",
} as const;

export const BRAND = {
  400: "#5eead4",
  500: "#22d3ee",
  600: "#0891b2",
  700: "#0e7490",
} as const;

/** Tailwind's stock amber-400 / sky-400 / red-400 / emerald-400. */
export const ACCENT = {
  amber: "#fbbf24",
  sky: "#38bdf8",
  red: "#f87171",
  emerald: "#34d399",
} as const;

/**
 * The colour of a metric both ways it is drawn: `text`, the class of its stat
 * card's icon, and `color`, the raw value of its chart curve. One entry holds
 * both so that the two cannot drift apart.
 */
export const METRIC_TONE = {
  brand: { text: "text-brand-400", color: BRAND[400] },
  amber: { text: "text-amber-400", color: ACCENT.amber },
  sky: { text: "text-sky-400", color: ACCENT.sky },
  red: { text: "text-red-400", color: ACCENT.red },
  emerald: { text: "text-emerald-400", color: ACCENT.emerald },
} as const;
