import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { quoteIdent, tableColumns, tableExists } from "@areelai/common";
import { SUPPLIER_TABLES } from "@areelai/supplier-management";
import { USER_TABLES } from "@areelai/user-management";
import { MODEL_SERVICE_TABLES } from "@areelai/model-services";
import { MICRO_AGENT_TABLES } from "@areelai/micro-agent";
import { GATEWAY_TABLES } from "./schema.js";
import { resolveLegacyMigrationsDir } from "../util/paths.js";

/**
 * One-time import of a pre-split hydrogen.db into the package-owned tables.
 *
 * The legacy file is never opened for writing, and never opened at all by the
 * connection that imports it: it is copied byte for byte (with its WAL and
 * shm sidecars when present), the COPY is brought up to the last legacy schema
 * with the legacy migration chain, and the copy's rows are inserted table by
 * table through an ATTACH. Column sets are intersected, so a legacy database
 * from any release the legacy chain can upgrade imports cleanly, and the
 * original stays exactly as the previous release left it.
 */

/** Settings key under which the import is recorded in the new database. */
export const LEGACY_IMPORT_SETTING = "legacy_import";

export interface LegacyImportReport {
  source: string;
  at: number;
  /** Rows copied per table. */
  tables: Record<string, number>;
  /** Legacy tables that were not present (older release) and so had nothing to copy. */
  missing: string[];
  /** Whether the legacy copy was upgraded with the legacy migration chain first. */
  migrated: boolean;
}

/** Every table, in insert order (parents before children within a package). */
const IMPORT_ORDER: readonly string[] = [
  ...USER_TABLES,
  ...SUPPLIER_TABLES,
  ...MODEL_SERVICE_TABLES,
  ...MICRO_AGENT_TABLES,
  ...GATEWAY_TABLES,
];

function copySidecars(from: string, to: string): void {
  fs.copyFileSync(from, to);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(from + suffix)) fs.copyFileSync(from + suffix, to + suffix);
  }
}

function removeSidecars(file: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(file + suffix); } catch { /* absent */ }
  }
}

/**
 * Import `legacyFile` into `target`, which must already carry every package's
 * current schema. Returns what was copied. Throws (and copies nothing) if the
 * legacy copy cannot be prepared.
 */
export function importLegacyDatabase(
  target: Database.Database,
  legacyFile: string,
  opts: { migrationsDir?: string | null } = {},
): LegacyImportReport {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-legacy-")), "legacy.db");
  copySidecars(legacyFile, tmp);

  let migrated = false;
  const migrationsDir = opts.migrationsDir === undefined ? resolveLegacyMigrationsDir() : opts.migrationsDir;
  try {
    // Bring the copy up to the last legacy schema, so a database from an older
    // release than the last legacy one imports with every column it should have.
    const copy = new Database(tmp);
    try {
      copy.pragma("journal_mode = DELETE"); // checkpoint the copied WAL into the copy itself
      if (migrationsDir) {
        migrate(drizzle(copy), { migrationsFolder: migrationsDir });
        migrated = true;
      }
    } finally {
      copy.close();
    }

    const report: LegacyImportReport = { source: legacyFile, at: Date.now(), tables: {}, missing: [], migrated };
    target.prepare("ATTACH DATABASE ? AS legacy").run(tmp);
    try {
      const legacyHas = (t: string): boolean =>
        Boolean(target.prepare("SELECT 1 FROM legacy.sqlite_master WHERE type = 'table' AND name = ?").get(t));
      const legacyColumns = (t: string): string[] =>
        (target.prepare(`PRAGMA legacy.table_info(${quoteIdent(t)})`).all() as { name: string }[]).map((c) => c.name);

      const run = target.transaction(() => {
        for (const table of IMPORT_ORDER) {
          if (!legacyHas(table) || !tableExists(target, table)) {
            report.missing.push(table);
            continue;
          }
          const cols = tableColumns(target, table).filter((c) => legacyColumns(table).includes(c));
          if (!cols.length) {
            report.missing.push(table);
            continue;
          }
          const list = cols.map(quoteIdent).join(", ");
          const info = target
            .prepare(`INSERT INTO main.${quoteIdent(table)} (${list}) SELECT ${list} FROM legacy.${quoteIdent(table)}`)
            .run();
          report.tables[table] = info.changes;
        }
        target
          .prepare(`INSERT INTO main."settings" ("key", "value") VALUES (?, ?) ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"`)
          .run(LEGACY_IMPORT_SETTING, JSON.stringify(report));
      });
      run();
    } finally {
      target.exec("DETACH DATABASE legacy");
    }
    return report;
  } finally {
    removeSidecars(tmp);
    try { fs.rmdirSync(path.dirname(tmp)); } catch { /* not empty or gone */ }
  }
}

/** The import record a database carries, if this instance was ever imported. */
export function legacyImportRecord(sqlite: Database.Database): LegacyImportReport | null {
  if (!tableExists(sqlite, "settings")) return null;
  const row = sqlite.prepare(`SELECT "value" FROM "settings" WHERE "key" = ?`).get(LEGACY_IMPORT_SETTING) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as LegacyImportReport;
  } catch {
    return null;
  }
}
