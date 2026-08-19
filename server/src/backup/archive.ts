import type Database from "better-sqlite3";
import { STATS_CACHE_SETTINGS_KEY } from "../persistence/statsCache";
import { decryptSecret, encryptSecret } from "../security/crypto";
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
 *
 * `image_cache` comes last and is opt-in (see {@link CACHE_TABLES}): it is
 * neither configuration nor history, and every row can be rebuilt by re-running
 * OCR. Carrying it is only ever a way to spare the target that cost.
 */
const TABLES = [
  "users",
  "providers",
  "provider_available_models",
  "models",
  "model_providers",
  "model_services",
  "tokens",
  "request_logs",
  "settings",
  "image_cache",
] as const;

type TableName = (typeof TABLES)[number];

/** Tables holding history rather than configuration; skippable on export. */
const LOG_TABLES: ReadonlySet<string> = new Set(["request_logs"]);

/**
 * Tables holding a cache of what an upstream reported rather than anything the
 * user configured. Carried in a package when present, but never required on the
 * way back in: a package written before the table existed must still restore,
 * and re-testing the provider rebuilds the contents anyway.
 */
const DERIVED_TABLES: ReadonlySet<string> = new Set(["provider_available_models"]);

/**
 * Content-addressed caches: exported only when asked for, never required on the
 * way back in.
 *
 * Off by default, because the cache is the one table whose size is bounded by a
 * byte budget rather than by how much the instance is configured to do -- at the
 * default 64 MB it can dwarf every other table combined, and the exporter holds
 * the whole package in memory. Including it buys exactly one thing: the target
 * does not have to re-run OCR on images it has already seen.
 *
 * Restoring one is safe on any instance because the hash covers the image bytes
 * and a version tag, not the instance that wrote them; a foreign row either
 * matches an image byte-for-byte or is never looked up.
 */
const CACHE_TABLES: ReadonlySet<string> = new Set(["image_cache"]);

/** The configuration tables a valid package must carry (everything but history
 * and re-fetchable caches). A package missing any of these is rejected, so a
 * truncated or hand-edited file can never delete the target's accounts and
 * leave nothing to log back in with. */
const REQUIRED_TABLES: readonly TableName[] = TABLES.filter(
  (t) => !LOG_TABLES.has(t) && !DERIVED_TABLES.has(t) && !CACHE_TABLES.has(t),
);

/** The provider columns that hold master-key-encrypted material. Never exported:
 * they are replaced by the sealed plaintext and rebuilt on restore. */
const PROVIDER_KEY_COLUMNS = ["key_ciphertext", "key_iv", "key_tag"] as const;

/** Same treatment for client-token secrets (stored since v1.5.2 so issued keys
 * can be copied again): sealed as plaintext, re-encrypted under the target's
 * master key on restore. Hash-only tokens simply have nothing to seal. */
const TOKEN_KEY_COLUMNS = ["key_ciphertext", "key_iv", "key_tag"] as const;

/**
 * Settings keys that describe *this* database rather than its configuration, so
 * they neither leave in an export nor get replaced on restore.
 * - `master_key_check`: the sentinel proving which master key encrypted this
 *   instance's secrets; a foreign one would make the server reject its own key.
 * - `session_epoch`: the instance-wide session cutoff; it is bumped on restore,
 *   so a value carried in from the source would be meaningless here.
 * - `stats_cache`: incremental usage counters over THIS instance's request_logs
 *   (keyed by local row ids); foreign counters would describe a different log.
 */
const LOCAL_ONLY_SETTINGS: ReadonlySet<string> = new Set(["master_key_check", "session_epoch", STATS_CACHE_SETTINGS_KEY]);

type Row = Record<string, unknown>;

export interface BackupPackage {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: number;
  appVersion: string;
  includesLogs: boolean;
  /** Descriptive metadata for the UI only. Absent in packages written before the
   * image cache was exportable, so restore decides from the table's presence
   * rather than trusting this flag. */
  includesImageCache: boolean;
  /** Row counts, so the UI can describe a package before restoring it. */
  counts: Record<string, number>;
  /** Provider API keys, sealed under the admin's passphrase. */
  secrets: SealedPayload;
  tables: Record<string, Row[]>;
}

/** The shape sealed inside `secrets`. */
interface SecretPayload {
  providerKeys: { id: number; apiKey: string }[];
  /** Absent in packages written before v1.5.2. */
  tokenKeys?: { id: number; secret: string }[];
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
export async function exportBackup(
  sqlite: Database.Database,
  masterKey: Buffer,
  opts: { passphrase: string; includeLogs: boolean; includeImageCache: boolean; appVersion: string },
): Promise<BackupPackage> {
  const tables: Record<string, Row[]> = {};
  const counts: Record<string, number> = {};
  const providerKeys: SecretPayload["providerKeys"] = [];
  const tokenKeys: NonNullable<SecretPayload["tokenKeys"]> = [];

  for (const table of TABLES) {
    if (LOG_TABLES.has(table) && !opts.includeLogs) continue;
    if (CACHE_TABLES.has(table) && !opts.includeImageCache) continue;
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

    if (table === "tokens") {
      for (const row of rows) {
        const ciphertext = (row.key_ciphertext as string | null) ?? null;
        const iv = (row.key_iv as string | null) ?? null;
        const tag = (row.key_tag as string | null) ?? null;
        if (ciphertext && iv && tag) {
          const secret = decryptSecret({ ciphertext, iv, tag }, masterKey);
          tokenKeys.push({ id: row.id as number, secret });
        }
        for (const col of TOKEN_KEY_COLUMNS) delete row[col];
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

  const secrets = await sealWithPassphrase(JSON.stringify({ providerKeys, tokenKeys } satisfies SecretPayload), opts.passphrase);

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    appVersion: opts.appVersion,
    includesLogs: opts.includeLogs,
    includesImageCache: opts.includeImageCache,
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
  // A config table missing entirely would let restore wipe the target's accounts
  // and repopulate nothing -- reject before touching the database.
  for (const t of REQUIRED_TABLES) {
    if (!Array.isArray(p.tables[t])) throw new BackupError(`malformed backup: missing required table "${t}"`);
  }
}

export interface RestoreReport {
  restored: Record<string, number>;
  includedLogs: boolean;
  /** True when the package carried an image cache, and so replaced the target's.
   * False leaves whatever the target had already cached exactly where it was. */
  includedImageCache: boolean;
  providerKeysRestored: number;
}

/**
 * Replace the entire database with `pkg`. All-or-nothing: one transaction, so a
 * package that fails halfway leaves the instance exactly as it was rather than
 * half-overwritten.
 */
export async function restoreBackup(
  sqlite: Database.Database,
  masterKey: Buffer,
  pkg: unknown,
  passphrase: string,
): Promise<RestoreReport> {
  validate(pkg);

  // Open the secrets first: a wrong passphrase must fail before we delete
  // anything, not after.
  const secrets = JSON.parse(await openWithPassphrase(pkg.secrets, passphrase)) as SecretPayload;
  const keyById = new Map<number, string>();
  for (const { id, apiKey } of secrets.providerKeys ?? []) keyById.set(id, apiKey);
  // Absent in pre-v1.5.2 packages: their tokens restore hash-only, exactly as
  // they were on the instance that wrote the package.
  const tokenKeyById = new Map<number, string>();
  for (const { id, secret } of secrets.tokenKeys ?? []) tokenKeyById.set(id, secret);

  const restored: Record<string, number> = {};

  const run = sqlite.transaction(() => {
    // Children first, so nothing is ever orphaned mid-restore. Only clear tables
    // the package will repopulate: a config-only package (no request_logs, no
    // image_cache) must leave the target's history and cached descriptions in
    // place, not wipe them and put nothing back.
    for (const table of [...TABLES].reverse()) {
      if (!(table in pkg.tables)) continue;
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

        if (table === "tokens") {
          // Same rebuild for stored client-token secrets.
          const secret = tokenKeyById.get(values.id as number);
          const blob = secret != null ? encryptSecret(secret, masterKey) : null;
          values.key_ciphertext = blob?.ciphertext ?? null;
          values.key_iv = blob?.iv ?? null;
          values.key_tag = blob?.tag ?? null;
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
    // The table's presence, not the flag: a hand-assembled package can carry the
    // rows without the metadata, and the caller has to re-check the budget
    // whenever rows actually landed.
    includedImageCache: Array.isArray(pkg.tables.image_cache),
    providerKeysRestored: keyById.size,
  };
}
