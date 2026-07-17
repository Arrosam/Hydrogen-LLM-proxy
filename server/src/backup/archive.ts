import type Database from "better-sqlite3";
import { decryptProviderKey, encryptProviderKey } from "../security/providerKeys";
import { openWithPassphrase, sealWithPassphrase, type SealedPayload } from "../security/passphrase";

/**
 * Full-instance backup: export every row to one portable package, restore it to
 * get the instance back exactly as it was.
 *
 * Two things make this more than a table dump:
 *
 * 1. Provider API keys are encrypted under PROXY_MASTER_KEY, which lives outside
 *    the database. Copying the ciphertext would produce a package that only
 *    restores onto the machine that wrote it -- precisely the machine you no
 *    longer have. So keys are decrypted on export, sealed under the admin's
 *    passphrase, and re-encrypted under the *target's* master key on restore.
 *
 * 2. Rows are read and written through the raw sqlite connection rather than the
 *    ORM. A backup must reproduce stored values exactly; going through drizzle's
 *    type mapping would round-trip timestamps through Date and JSON columns
 *    through parse/stringify, and each conversion is a chance to change what was
 *    stored. Raw values move across untouched.
 */

/** Bumped only for a change that makes older packages unreadable. */
export const BACKUP_VERSION = 1;
export const BACKUP_FORMAT = "hydrogen-backup";

/**
 * Every table, ordered so a parent is always written before its children.
 * Restore inserts in this order and deletes in reverse, which is what keeps the
 * foreign keys satisfied at every point (they stay ON: a restore that needs them
 * off is a restore that is corrupting something).
 */
const TABLES = [
  "users",
  "providers",
  "models",
  "model_providers",
  "model_services",
  "tokens",
  "request_logs",
  "settings",
] as const;

type TableName = (typeof TABLES)[number];

/** Tables holding history rather than configuration; skippable on export. */
const LOG_TABLES: ReadonlySet<string> = new Set(["request_logs"]);

/** The provider columns that hold master-key-encrypted material. Never exported:
 * they are replaced by the sealed plaintext and rebuilt on restore. */
const PROVIDER_KEY_COLUMNS = ["key_ciphertext", "key_iv", "key_tag"] as const;

/**
 * Settings keys that describe *this* database rather than its configuration.
 * `master_key_check` is the sentinel proving which master key encrypted this
 * instance's secrets; importing a foreign one would tell the server its own key
 * is wrong and it would refuse to start. The local sentinel always stays.
 */
const LOCAL_ONLY_SETTINGS: ReadonlySet<string> = new Set(["master_key_check"]);

type Row = Record<string, unknown>;

export interface BackupPackage {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: number;
  appVersion: string;
  includesLogs: boolean;
  /** Row counts, so the UI can describe a package before restoring it. */
  counts: Record<string, number>;
  /** Provider API keys, sealed under the admin's passphrase. */
  secrets: SealedPayload;
  tables: Record<string, Row[]>;
}

/** The shape sealed inside `secrets`. */
interface SecretPayload {
  providerKeys: { id: number; apiKey: string }[];
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Export every table to a package whose secrets only `passphrase` can open. */
export function exportBackup(
  sqlite: Database.Database,
  masterKey: Buffer,
  opts: { passphrase: string; includeLogs: boolean; appVersion: string },
): BackupPackage {
  const tables: Record<string, Row[]> = {};
  const counts: Record<string, number> = {};
  const providerKeys: SecretPayload["providerKeys"] = [];

  for (const table of TABLES) {
    if (LOG_TABLES.has(table) && !opts.includeLogs) continue;
    const rows = sqlite.prepare(`SELECT * FROM ${quoteIdent(table)}`).all() as Row[];

    if (table === "providers") {
      for (const row of rows) {
        const apiKey = decryptProviderKey(
          {
            keyCiphertext: (row.key_ciphertext as string | null) ?? null,
            keyIv: (row.key_iv as string | null) ?? null,
            keyTag: (row.key_tag as string | null) ?? null,
          },
          masterKey,
        );
        if (apiKey != null) providerKeys.push({ id: row.id as number, apiKey });
        for (const col of PROVIDER_KEY_COLUMNS) delete row[col];
      }
    }

    if (table === "settings") {
      const kept = rows.filter((r) => !LOCAL_ONLY_SETTINGS.has(String(r.key)));
      tables[table] = kept;
      counts[table] = kept.length;
      continue;
    }

    tables[table] = rows;
    counts[table] = rows.length;
  }

  const secrets = sealWithPassphrase(JSON.stringify({ providerKeys } satisfies SecretPayload), opts.passphrase);

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    appVersion: opts.appVersion,
    includesLogs: opts.includeLogs,
    counts,
    secrets,
    tables,
  };
}

/** Reject anything that isn't a package we wrote, before touching the database. */
function validate(pkg: unknown): asserts pkg is BackupPackage {
  if (!pkg || typeof pkg !== "object") throw new BackupError("not a backup file");
  const p = pkg as Partial<BackupPackage>;
  if (p.format !== BACKUP_FORMAT) throw new BackupError("not a Hydrogen backup file");
  if (p.version !== BACKUP_VERSION) {
    throw new BackupError(`unsupported backup version ${String(p.version)} (this server reads version ${BACKUP_VERSION})`);
  }
  if (!p.secrets || typeof p.secrets !== "object") throw new BackupError("malformed backup: missing sealed secrets");
  if (!p.tables || typeof p.tables !== "object") throw new BackupError("malformed backup: missing table data");
  for (const [name, rows] of Object.entries(p.tables)) {
    if (!TABLES.includes(name as TableName)) throw new BackupError(`malformed backup: unknown table "${name}"`);
    if (!Array.isArray(rows)) throw new BackupError(`malformed backup: table "${name}" is not a list of rows`);
  }
}

export interface RestoreReport {
  restored: Record<string, number>;
  includedLogs: boolean;
  providerKeysRestored: number;
}

/**
 * Replace the entire database with `pkg`. All-or-nothing: one transaction, so a
 * package that fails halfway leaves the instance exactly as it was rather than
 * half-overwritten.
 */
export function restoreBackup(
  sqlite: Database.Database,
  masterKey: Buffer,
  pkg: unknown,
  passphrase: string,
): RestoreReport {
  validate(pkg);

  // Open the secrets first: a wrong passphrase must fail before we delete
  // anything, not after.
  const secrets = JSON.parse(openWithPassphrase(pkg.secrets, passphrase)) as SecretPayload;
  const keyById = new Map<number, string>();
  for (const { id, apiKey } of secrets.providerKeys ?? []) keyById.set(id, apiKey);

  const restored: Record<string, number> = {};

  const run = sqlite.transaction(() => {
    // Children first, so nothing is ever orphaned mid-restore.
    for (const table of [...TABLES].reverse()) {
      if (table === "settings") {
        const keep = [...LOCAL_ONLY_SETTINGS].map(() => "?").join(",");
        sqlite.prepare(`DELETE FROM ${quoteIdent(table)} WHERE "key" NOT IN (${keep})`).run(...LOCAL_ONLY_SETTINGS);
        continue;
      }
      sqlite.prepare(`DELETE FROM ${quoteIdent(table)}`).run();
    }

    for (const table of TABLES) {
      const rows = pkg.tables[table];
      if (!rows?.length) {
        restored[table] = 0;
        continue;
      }
      let written = 0;
      for (const row of rows) {
        const values: Row = { ...row };

        if (table === "settings" && LOCAL_ONLY_SETTINGS.has(String(values.key))) continue;

        if (table === "providers") {
          // Rebuild the key columns under THIS instance's master key, which is
          // what makes the package portable between installs.
          const apiKey = keyById.get(values.id as number);
          const cols = apiKey
            ? encryptProviderKey(apiKey, masterKey)
            : { keyCiphertext: null, keyIv: null, keyTag: null };
          values.key_ciphertext = cols.keyCiphertext;
          values.key_iv = cols.keyIv;
          values.key_tag = cols.keyTag;
        }

        const columns = Object.keys(values);
        const sql =
          `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(", ")}) ` +
          `VALUES (${columns.map(() => "?").join(", ")})`;
        try {
          sqlite.prepare(sql).run(columns.map((c) => values[c] as never));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new BackupError(`could not restore table "${table}": ${msg}`);
        }
        written++;
      }
      restored[table] = written;
    }
  });

  run();

  return {
    restored,
    includedLogs: Boolean(pkg.includesLogs),
    providerKeysRestored: keyById.size,
  };
}
