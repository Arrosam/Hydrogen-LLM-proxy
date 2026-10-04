/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        ink: {
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
        },
        brand: {
          400: "#5eead4",
          500: "#22d3ee",
          600: "#0891b2",
          700: "#0e7490",
        },
        // Preserve existing status colors across the Tailwind 4 default palette change.
        amber: { 300: "#fcd34d", 400: "#fbbf24", 500: "#f59e0b", 700: "#b45309", 900: "#78350f", 950: "#451a03" },
        emerald: { 300: "#6ee7b7", 400: "#34d399", 800: "#065f46", 900: "#064e3b", 950: "#022c22" },
        green: { 400: "#4ade80", 800: "#166534", 950: "#052e16" },
        purple: { 300: "#d8b4fe", 800: "#6b21a8", 950: "#3b0764" },
        red: { 300: "#fca5a5", 400: "#f87171", 500: "#ef4444", 800: "#991b1b", 900: "#7f1d1d", 950: "#450a0a" },
        sky: { 400: "#38bdf8" },
        yellow: { 300: "#fde047", 800: "#854d0e", 950: "#422006" },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      // Retain the previous scale and bare radius/shadow defaults.
      borderRadius: {"none":"0px","sm":"0.125rem","DEFAULT":"0.25rem","md":"0.375rem","lg":"0.5rem","xl":"0.75rem","2xl":"1rem","3xl":"1.5rem","full":"9999px"},
      boxShadow: {
        sm: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        DEFAULT: "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
        md: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
        lg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
        xl: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
        "2xl": "0 25px 50px -12px rgb(0 0 0 / 0.25)",
        inner: "inset 0 2px 4px 0 rgb(0 0 0 / 0.05)",
        none: "none",
      },
    },
  },
  plugins: [],
};
