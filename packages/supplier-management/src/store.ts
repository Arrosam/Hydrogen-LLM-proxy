import type Database from "better-sqlite3";
import { applyMigrations, openSqlite } from "@areelai/common";
import { supplierDb, type DB } from "./db.js";
import { supplierMigrations } from "./migrations.js";
import { ProviderRepo } from "./providerRepo.js";
import { ProxyRepo } from "./proxyRepo.js";
import { ProviderModelRepo } from "./providerModelRepo.js";
import { ModelRepo } from "./modelRepo.js";
import { MappingRepo } from "./mappingRepo.js";
import { Catalog } from "./catalog.js";

/** The public surface of a repository class: what a custom implementation must provide. */
export type PublicApi<T> = { [K in keyof T]: T[K] };
export type ProviderStore = PublicApi<ProviderRepo>;
export type ProxyStore = PublicApi<ProxyRepo>;
export type ProviderModelStore = PublicApi<ProviderModelRepo>;
export type ModelStore = PublicApi<ModelRepo>;
export type MappingStore = PublicApi<MappingRepo>;

export interface SupplierStores {
  db: DB;
  proxies: ProxyRepo;
  providers: ProviderRepo;
  providerModels: ProviderModelRepo;
  models: ModelRepo;
  mappings: MappingRepo;
  /** Resolves (model, provider) pairs to concrete upstream targets. */
  catalog: Catalog;
}

/** The default SQLite-backed stores over an already-open, already-migrated connection. */
export function createSupplierStores(sqlite: Database.Database, masterKey: Buffer): SupplierStores {
  const db = supplierDb(sqlite);
  // The proxy repo is built before the provider repo because a materialized
  // provider carries its egress proxy: toUpstream() asks this for it.
  const proxies = new ProxyRepo(db, masterKey);
  const providers = new ProviderRepo(db, masterKey, proxies);
  const providerModels = new ProviderModelRepo(db);
  const models = new ModelRepo(db);
  const mappings = new MappingRepo(db);
  const catalog = new Catalog(models, providers, mappings);
  return { db, proxies, providers, providerModels, models, mappings, catalog };
}

export interface OpenedSupplierStores extends SupplierStores {
  sqlite: Database.Database;
  close(): void;
}

/**
 * Open (or create) a database file for this package alone, apply its
 * migrations and return the stores. The gateway does not use this: it opens
 * one file for every package and calls {@link createSupplierStores}.
 */
export function openSupplierStores(opts: { file: string; masterKey: Buffer }): OpenedSupplierStores {
  const sqlite = openSqlite(opts.file);
  applyMigrations(sqlite, supplierMigrations);
  return { ...createSupplierStores(sqlite, opts.masterKey), sqlite, close: () => sqlite.close() };
}
