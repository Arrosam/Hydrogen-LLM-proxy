import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import * as schema from "./schema";
import { ensureDir, resolveMigrationsDir } from "../util/paths";
import { reportStartup, startupStage, type StartupReporter } from "../util/startup";

export type DB = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export interface OpenedDatabase {
  db: DB;
  sqlite: Database.Database;
}

/**
 * Open the SQLite database, apply pending migrations, and return the drizzle
 * client together with the raw connection. No global singleton — the caller
 * (the composition root) owns the instance and injects it into repositories.
 */
export function openDatabase(dataDir: string, report?: StartupReporter): OpenedDatabase {
  ensureDir(dataDir);
  const sqlite = startupStage(report, "db.open", () => new Database(path.join(dataDir, "hydrogen.db")));
  startupStage(report, "db.wal", () => sqlite.pragma("journal_mode = WAL"));
  startupStage(report, "db.foreign_keys", () => sqlite.pragma("foreign_keys = ON"));
  startupStage(report, "db.busy_timeout", () => sqlite.pragma("busy_timeout = 5000"));

  let migrating = false;
  const db = drizzle(sqlite, { schema, logger: report ? { logQuery(query) {
    if (!migrating) return;
    // Drizzle calls the logger just before executing each migration statement.
    // The last marker localizes a blocked native call without logging its SQL.
    const operation = /^\s*SELECT/i.test(query) ? "read_journal"
      : /^\s*CREATE (UNIQUE )?INDEX/i.test(query) ? "create_index"
      : /^\s*ALTER TABLE/i.test(query) ? "alter_table"
      : /^\s*CREATE TABLE/i.test(query) ? "create_table"
      : /^\s*BEGIN/i.test(query) ? "begin"
      : /^\s*COMMIT/i.test(query) ? "commit"
      : /^\s*ROLLBACK/i.test(query) ? "rollback" : "statement";
    reportStartup(report, "db.migrate.sql", "begin", { operation });
  } } : false });

  const migrationsFolder = resolveMigrationsDir();
  if (!migrationsFolder) {
    throw new Error(
      "Could not locate the Drizzle migrations folder. Run `npm run db:generate` in the " +
        "server workspace, or set MIGRATIONS_DIR to the generated folder.",
    );
  }
  try {
    migrating = true;
    startupStage(report, "db.migrate", () => migrate(db, { migrationsFolder }));
  } catch (error) {
    sqlite.close();
    throw error;
  } finally { migrating = false; }

  return { db, sqlite };
}

export { schema };
