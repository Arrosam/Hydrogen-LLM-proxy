import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit uses this only to generate SQL migration files from the schema
 * (no live DB connection needed for `generate`). Migrations are applied at
 * runtime by the server via drizzle's migrator.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  strict: true,
});
