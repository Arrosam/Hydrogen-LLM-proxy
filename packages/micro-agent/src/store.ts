import type Database from "better-sqlite3";
import { applyMigrations, openSqlite } from "@areelai/common";
import { microAgentDb, type DB } from "./db.js";
import { microAgentMigrations } from "./migrations.js";
import { ImageCacheRepo } from "./imageCacheRepo.js";
import { ImageDescriptionCache } from "./ocrCache.js";

export interface MicroAgentStores {
  db: DB;
  imageCache: ImageCacheRepo;
  /** The OCR pre-pass cache over `imageCache`, budgeted by the live getter. */
  ocrCache(maxBytes: () => number): ImageDescriptionCache;
}

/** The default SQLite-backed stores over an already-open, already-migrated connection. */
export function createMicroAgentStores(sqlite: Database.Database): MicroAgentStores {
  const db = microAgentDb(sqlite);
  const imageCache = new ImageCacheRepo(db);
  return { db, imageCache, ocrCache: (maxBytes) => new ImageDescriptionCache(imageCache, maxBytes) };
}

export interface OpenedMicroAgentStores extends MicroAgentStores {
  sqlite: Database.Database;
  close(): void;
}

/**
 * Open (or create) a database file for this package alone, apply its
 * migrations and return the stores. The gateway does not use this: it opens
 * one file for every package and calls {@link createMicroAgentStores}.
 */
export function openMicroAgentStores(opts: { file: string }): OpenedMicroAgentStores {
  const sqlite = openSqlite(opts.file);
  applyMigrations(sqlite, microAgentMigrations);
  return { ...createMicroAgentStores(sqlite), sqlite, close: () => sqlite.close() };
}
