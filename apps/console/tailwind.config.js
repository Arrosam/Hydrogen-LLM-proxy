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
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
