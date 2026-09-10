import type Database from "better-sqlite3";
import { applyMigrations, openSqlite } from "@areelai/common";
import { modelServiceDb, type DB } from "./db.js";
import { modelServiceMigrations } from "./migrations.js";
import { ServiceRepo } from "./serviceRepo.js";
import { HostedToolRepo } from "./hostedToolRepo.js";

/** The public surface of a repository class: what a custom implementation must provide. */
export type PublicApi<T> = { [K in keyof T]: T[K] };
export type ServiceStore = PublicApi<ServiceRepo>;
export type HostedToolStore = PublicApi<HostedToolRepo>;

export interface ModelServiceStores {
  db: DB;
  services: ServiceRepo;
  hostedTools: HostedToolRepo;
}

/** The default SQLite-backed stores over an already-open, already-migrated connection. */
export function createModelServiceStores(sqlite: Database.Database, masterKey: Buffer): ModelServiceStores {
  const db = modelServiceDb(sqlite);
  return { db, services: new ServiceRepo(db), hostedTools: new HostedToolRepo(db, masterKey) };
}

export interface OpenedModelServiceStores extends ModelServiceStores {
  sqlite: Database.Database;
  close(): void;
}

/**
 * Open (or create) a database file for this package alone, apply its
 * migrations and return the stores. The gateway does not use this: it opens
 * one file for every package and calls {@link createModelServiceStores}.
 */
export function openModelServiceStores(opts: { file: string; masterKey: Buffer }): OpenedModelServiceStores {
  const sqlite = openSqlite(opts.file);
  applyMigrations(sqlite, modelServiceMigrations);
  return { ...createModelServiceStores(sqlite, opts.masterKey), sqlite, close: () => sqlite.close() };
}
