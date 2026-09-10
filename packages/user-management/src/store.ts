import type Database from "better-sqlite3";
import { applyMigrations, openSqlite } from "@areelai/common";
import { userDb, type DB } from "./db.js";
import { userMigrations } from "./migrations.js";
import { UserRepo } from "./userRepo.js";
import { TokenRepo } from "./tokenRepo.js";
import { UsageMeter } from "./usageMeter.js";

/** The public surface of a repository class: what a custom implementation must provide. */
export type PublicApi<T> = { [K in keyof T]: T[K] };
export type UserStore = PublicApi<UserRepo>;
export type TokenStore = PublicApi<TokenRepo>;

export interface UserStores {
  db: DB;
  users: UserRepo;
  tokens: TokenRepo;
  /** Bumps a token's request/token usage counters. */
  usage: UsageMeter;
}

/** The default SQLite-backed stores over an already-open, already-migrated connection. */
export function createUserStores(sqlite: Database.Database, masterKey: Buffer): UserStores {
  const db = userDb(sqlite);
  const tokens = new TokenRepo(db, masterKey);
  return { db, users: new UserRepo(db), tokens, usage: new UsageMeter(tokens) };
}

export interface OpenedUserStores extends UserStores {
  sqlite: Database.Database;
  close(): void;
}

/**
 * Open (or create) a database file for this package alone, apply its
 * migrations and return the stores. The gateway does not use this: it opens
 * one file for every package and calls {@link createUserStores}.
 */
export function openUserStores(opts: { file: string; masterKey: Buffer }): OpenedUserStores {
  const sqlite = openSqlite(opts.file);
  applyMigrations(sqlite, userMigrations);
  return { ...createUserStores(sqlite, opts.masterKey), sqlite, close: () => sqlite.close() };
}
