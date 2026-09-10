import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * SQLite plumbing shared by every package that owns tables.
 *
 * Each package ships its own migration chain and records what it applied in
 * its own bookkeeping table, so several packages can share one database file
 * without knowing about each other: the gateway opens the file once and hands
 * the connection to every package's `applyMigrations`. A package used on its
 * own opens its own file the same way.
 */

export interface Migration {
  /** Stable name, unique within the set (e.g. "0000_initial"). */
  tag: string;
  /** One or more statements, separated by drizzle's `--> statement-breakpoint`. */
  sql: string;
}

export interface MigrationSet {
  /** The table this set records itself in. Unique per package. */
  table: string;
  migrations: Migration[];
}

/** Open (creating if needed) a database file with the pragmas every package expects. */
export function openSqlite(file: string, opts: { readonly?: boolean } = {}): Database.Database {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file, { readonly: opts.readonly ?? false, fileMustExist: opts.readonly ?? false });
  if (!opts.readonly) {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
  }
  sqlite.pragma("busy_timeout = 5000");
  return sqlite;
}

const BREAKPOINT = "--> statement-breakpoint";

/** Split a migration file into its statements. */
export function splitStatements(sql: string): string[] {
  return sql
    .split(BREAKPOINT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Apply every migration in `set` that this database has not seen yet, in
 * order, each in its own transaction. Returns how many were applied.
 */
export function applyMigrations(sqlite: Database.Database, set: MigrationSet): number {
  const table = quoteIdent(set.table);
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (` +
      `id INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT NOT NULL UNIQUE, applied_at INTEGER NOT NULL)`,
  );
  const applied = new Set(
    (sqlite.prepare(`SELECT tag FROM ${table}`).all() as { tag: string }[]).map((r) => r.tag),
  );
  const record = sqlite.prepare(`INSERT INTO ${table} (tag, applied_at) VALUES (?, ?)`);
  let count = 0;
  for (const m of set.migrations) {
    if (applied.has(m.tag)) continue;
    const run = sqlite.transaction(() => {
      for (const stmt of splitStatements(m.sql)) sqlite.exec(stmt);
      record.run(m.tag, Date.now());
    });
    run();
    count++;
  }
  return count;
}

/** The tags a database has applied from a set, for diagnostics. */
export function appliedMigrations(sqlite: Database.Database, set: MigrationSet): string[] {
  const exists = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(set.table) as { name: string } | undefined;
  if (!exists) return [];
  return (sqlite.prepare(`SELECT tag FROM ${quoteIdent(set.table)} ORDER BY id`).all() as { tag: string }[]).map((r) => r.tag);
}

/** Whether a table exists in the database. */
export function tableExists(sqlite: Database.Database, name: string): boolean {
  return Boolean(sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

/** The column names of a table, in declaration order. */
export function tableColumns(sqlite: Database.Database, name: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all() as { name: string }[]).map((c) => c.name);
}

export { quoteIdent };
