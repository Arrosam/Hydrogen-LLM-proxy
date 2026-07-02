import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import * as schema from "./schema";
import { ensureDir, resolveMigrationsDir } from "../util/paths";

export type DB = BetterSQLite3Database<typeof schema>;

let _db: DB | null = null;
let _sqlite: Database.Database | null = null;

/** Open (or reuse) the SQLite database, apply migrations, return the drizzle client. */
export function openDatabase(dataDir: string): DB {
  if (_db) return _db;
  ensureDir(dataDir);
  const file = path.join(dataDir, "hydrogen.db");
  const sqlite = new Database(file);
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

  _db = db;
  _sqlite = sqlite;
  return db;
}

export function getDb(): DB {
  if (!_db) throw new Error("Database not initialised. Call openDatabase() first.");
  return _db;
}

export function getSqlite(): Database.Database {
  if (!_sqlite) throw new Error("Database not initialised.");
  return _sqlite;
}

export function closeDatabase(): void {
  _sqlite?.close();
  _sqlite = null;
  _db = null;
}

export { schema };
