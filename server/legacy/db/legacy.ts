import type Database from "better-sqlite3";

/**
 * v0.3 renamed "Model Use Behavior (MUB)" to "Model Service" across the DB,
 * but the rename shipped as a loose SQL file that was never registered in the
 * Drizzle journal -- so fresh installs kept creating the old names from the
 * 0000 baseline, and already-renamed databases must not run it twice. This
 * applies the rename by inspecting the live schema instead: each rename runs
 * only when its old name is still present, making it a no-op on databases
 * that already use the new names.
 */
export function applyLegacyRenames(sqlite: Database.Database): void {
  const hasTable = (name: string): boolean =>
    sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  const hasColumn = (table: string, column: string): boolean =>
    hasTable(table) &&
    (sqlite.pragma(`table_info(${table})`) as { name: string }[]).some((c) => c.name === column);

  const stmts: string[] = [];
  if (hasTable("model_use_behaviors") && !hasTable("model_services")) {
    stmts.push(
      "ALTER TABLE model_use_behaviors RENAME TO model_services",
      "DROP INDEX IF EXISTS mub_name_idx",
      "CREATE UNIQUE INDEX IF NOT EXISTS service_name_idx ON model_services (name)",
    );
  }
  if (hasColumn("request_logs", "mub_id")) {
    stmts.push(
      "ALTER TABLE request_logs RENAME COLUMN mub_id TO service_id",
      "DROP INDEX IF EXISTS request_logs_mub_idx",
      "CREATE INDEX IF NOT EXISTS request_logs_service_idx ON request_logs (service_id)",
    );
  }
  if (hasColumn("request_logs", "mub_name")) {
    stmts.push("ALTER TABLE request_logs RENAME COLUMN mub_name TO service_name");
  }
  if (hasColumn("tokens", "scope_mubs_json")) {
    stmts.push("ALTER TABLE tokens RENAME COLUMN scope_mubs_json TO scope_services_json");
  }
  if (stmts.length === 0) return;

  sqlite.transaction(() => {
    for (const s of stmts) sqlite.exec(s);
  })();
}
