# @areelai/common

Shared primitives for the `@areelai` packages: AES-256-GCM secret encryption, id and timestamp helpers, a zod `parse` wrapper, credential-redacting log serialization, and the SQLite plumbing every package that owns tables builds on (`openSqlite` plus a per-package migration runner). It deliberately owns no tables and no schema, speaks no HTTP and no wire format, and never generates or stores a master key: every caller passes its own 32-byte `Buffer` and is responsible for keeping it.

## Install

```
npm install @areelai/common
```

Runtime dependencies: `better-sqlite3`, `zod`. No sibling `@areelai` packages. Node 20 or newer, ESM only.

## Ten-line adoption example

```ts
import crypto from "node:crypto";
import { applyMigrations, decryptSecret, encryptSecret, openSqlite, type MigrationSet } from "@areelai/common";

const masterKey = crypto.randomBytes(32); // persist this; it is the only way to decrypt what you encrypt
const blob = encryptSecret("sk-live-abc123", masterKey); // { ciphertext, iv, tag } in base64
console.log(decryptSecret(blob, masterKey)); // "sk-live-abc123"; throws on a wrong key or a tampered blob

const notes: MigrationSet = {
  table: "__migrations_notes", // this set's own bookkeeping table
  migrations: [{ tag: "0000_initial", sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)" }],
};
const sqlite = openSqlite("./data/app.db"); // creates the directory, sets WAL + foreign_keys + busy_timeout
console.log(applyMigrations(sqlite, notes)); // 1 on the first run, 0 on every run after
sqlite.close();
```

## What it provides

- `encryptSecret(plaintext, masterKey)` and `decryptSecret(blob, masterKey)`: AES-256-GCM with a fresh 12-byte IV per call. The `EncryptedBlob` is `{ ciphertext, iv, tag }`, all base64. The store packages persist those three fields as columns.
- `openSqlite(file, { readonly? })`: opens or creates the file with `journal_mode = WAL`, `foreign_keys = ON` and a 5 second busy timeout. `":memory:"` is accepted.
- `applyMigrations(sqlite, set)`: creates `set.table` if it is missing, applies every `Migration` whose `tag` is not recorded there yet, each in its own transaction, and returns how many ran. Statements inside one migration are split on drizzle's `--> statement-breakpoint` marker (`splitStatements`).
- `appliedMigrations(sqlite, set)`, `tableExists(sqlite, name)`, `tableColumns(sqlite, name)` and `quoteIdent(name)`: the diagnostics around the runner.
- `genId(prefix)` (`"chatcmpl-<32 hex>"` style ids), `nowSeconds()`, `asMillis(v)` and `asMillisOrNull(v)` for drizzle timestamp values.
- `parse(schema, body)`: runs a zod schema and returns `{ ok: true, data }` or `{ ok: false, error }` with a flat `path: message; ...` string. `toId(v)` and `idParam(req)` parse positive-integer route params.
- `serializeForLog(value, maxChars)` and `safeStringify(value)`: valid JSON under a size budget with credential-named keys (`authorization`, `api_key`, `password`, ...) replaced by `[redacted]` and long strings shortened rather than the JSON cut mid-way.

## Sharing one database file

Every `MigrationSet` names its own bookkeeping table, so several packages can run `applyMigrations` against the same connection without knowing about each other. The `@areelai` store packages follow this convention (`__migrations_supplier_management`, `__migrations_user_management`, `__migrations_model_services`, `__migrations_micro_agent`); a package of your own can join the same file by naming a table nobody else uses.

## License

MIT
