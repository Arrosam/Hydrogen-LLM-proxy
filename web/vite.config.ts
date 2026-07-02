import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_TARGET = process.env.HYDROGEN_API ?? "http://127.0.0.1:8080";

// The server serves the built SPA in production; in dev we proxy API + proxy
// endpoints to the running server so the dashboard behaves identically.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/admin/api": API_TARGET,
      "/v1": API_TARGET,
      "/healthz": API_TARGET,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
