import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import * as schema from "./schema";
import { ensureDir, resolveMigrationsDir } from "../util/paths";

export type DB = BetterSQLite3Database<typeof schema>;

export interface OpenedDatabase {
  db: DB;
  sqlite: Database.Database;
}

/**
 * Open the SQLite database, apply pending migrations, and return the drizzle
 * client together with the raw connection. No global singleton — the caller
 * (the composition root) owns the instance and injects it into repositories.
 */
export function openDatabase(dataDir: string): OpenedDatabase {
  ensureDir(dataDir);
  const sqlite = new Database(path.join(dataDir, "hydrogen.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  const db = drizzle(sqlite, { schema });

  const migrationsFolder = resolveMigrationsDir();
  if (!migrationsFolder) {
    throw new Error(
      "Could not locate the Drizzle migrations folder. Run `npm run db:generate` in the " +
        "server workspace, or set MIGRATIONS_DIR to the generated folder.",
    );
  }
  migrate(db, { migrationsFolder });

  return { db, sqlite };
}

export { schema };
