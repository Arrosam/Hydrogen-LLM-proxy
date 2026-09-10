import { defineConfig } from "vitest/config";
import { areelaiAliases } from "../../vitest.shared.mjs";

export default defineConfig({
  resolve: { alias: areelaiAliases },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
