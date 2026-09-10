import type Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { applyMigrations, openSqlite, type MigrationSet } from "@areelai/common";
import { supplierMigrations } from "@areelai/supplier-management";
import { userMigrations } from "@areelai/user-management";
import { modelServiceMigrations } from "@areelai/model-services";
import { microAgentMigrations } from "@areelai/micro-agent";
import * as schema from "./schema.js";
import { gatewayMigrations } from "./migrations.js";
import { importLegacyDatabase, type LegacyImportReport } from "./legacyImport.js";
import { ensureDir } from "../util/paths.js";

/** The gateway's typed drizzle handle (its own tables only). */
export type DB = BetterSQLite3Database<typeof schema>;

/** The database file every package shares, in DATA_DIR. */
export const DB_FILE = "hydro.db";
/** The pre-split database file. Read once, on the first boot beside it, never written. */
export const LEGACY_DB_FILE = "hydrogen.db";

/** Every migration set, in dependency order: the packages', then the gateway's. */
export const ALL_MIGRATIONS: MigrationSet[] = [supplierMigrations, userMigrations, modelServiceMigrations, microAgentMigrations, gatewayMigrations];

export interface OpenedDatabase {
  db: DB;
  sqlite: Database.Database;
  /** Set when this boot imported a legacy hydrogen.db. */
  legacyImport: LegacyImportReport | null;
}

/** Apply every package's migrations plus the gateway's to a connection. */
export function applyAllMigrations(sqlite: Database.Database): void {
  for (const set of ALL_MIGRATIONS) applyMigrations(sqlite, set);
}

/**
 * Open the shared SQLite database, apply every package's migrations, and
 * return the gateway's drizzle client together with the raw connection. No
 * global singleton -- the caller (the composition root) owns the instance and
 * hands the connection to each package's store factory.
 *
 * Upgrade path: when DATA_DIR holds a legacy hydrogen.db and no hydro.db yet,
 * the legacy file's rows are copied into the new database on this first boot.
 * The legacy file is never modified; rolling back is running the previous
 * release on the same volume. Once hydro.db exists the legacy file is ignored.
 */
export function openDatabase(dataDir: string, log: (msg: string) => void = () => {}): OpenedDatabase {
  ensureDir(dataDir);
  const file = path.join(dataDir, DB_FILE);
  const legacyFile = path.join(dataDir, LEGACY_DB_FILE);
  const fresh = !fs.existsSync(file);
  const hasLegacy = fs.existsSync(legacyFile);

  const sqlite = openSqlite(file);
  applyAllMigrations(sqlite);

  let legacyImport: LegacyImportReport | null = null;
  if (fresh && hasLegacy) {
    log(`legacy ${LEGACY_DB_FILE} found and no ${DB_FILE} yet: importing its data (the legacy file is left untouched)`);
    try {
      legacyImport = importLegacyDatabase(sqlite, legacyFile);
    } catch (e) {
      // Leave no half-imported database behind: the next boot must retry from
      // a clean slate rather than skip the import because the file exists.
      sqlite.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.unlinkSync(file + suffix); } catch { /* absent */ }
      }
      throw e;
    }
    const rows = Object.values(legacyImport.tables).reduce((a, b) => a + b, 0);
    log(`legacy import complete: ${rows} rows across ${Object.keys(legacyImport.tables).length} tables`);
  } else if (hasLegacy) {
    log(`legacy ${LEGACY_DB_FILE} present but ${DB_FILE} already exists; the legacy file is ignored`);
  }

  return { db: drizzle(sqlite, { schema }), sqlite, legacyImport };
}

export { schema };
