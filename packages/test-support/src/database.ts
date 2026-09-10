import type Database from "better-sqlite3";
import { applyMigrations, openSqlite, type MigrationSet } from "@areelai/common";
import { supplierMigrations } from "@areelai/supplier-management";
import { userMigrations } from "@areelai/user-management";
import { modelServiceMigrations } from "@areelai/model-services";
import { microAgentMigrations } from "@areelai/micro-agent";

/** Every package's migration set, in dependency order. The gateway adds its own. */
export const PACKAGE_MIGRATIONS: MigrationSet[] = [supplierMigrations, userMigrations, modelServiceMigrations, microAgentMigrations];

/**
 * A database with every package's tables, for tests. In-memory by default;
 * pass a file path to keep it. Extra migration sets (the gateway's) are
 * applied after the packages'.
 */
export function openTestDatabase(file = ":memory:", extra: MigrationSet[] = []): Database.Database {
  const sqlite = openSqlite(file);
  for (const set of [...PACKAGE_MIGRATIONS, ...extra]) applyMigrations(sqlite, set);
  return sqlite;
}

/** A stable throwaway master key for tests. */
export const TEST_MASTER_KEY = Buffer.alloc(32, 7);
