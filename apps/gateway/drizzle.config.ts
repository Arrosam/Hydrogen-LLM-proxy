import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit generates SQL migration files from this package's schema into
 * ./drizzle (no live DB needed for `generate`). The files are then embedded
 * into src/migrations.ts by scripts/embed-migrations.mjs, which is what runs
 * at startup -- the folder exists so drizzle-kit can diff against its snapshot.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  strict: true,
});
