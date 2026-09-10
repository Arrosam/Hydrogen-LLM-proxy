import type Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

/** This package's typed drizzle handle over a shared or private SQLite connection. */
export type DB = BetterSQLite3Database<typeof schema>;

export function modelServiceDb(sqlite: Database.Database): DB {
  return drizzle(sqlite, { schema });
}

export { schema };
