import { loadConfig, type AppConfig } from "./config";
import { setConfig } from "./context";
import { openDatabase, type DB } from "./db";
import { seedAdminIfEmpty, type SeedResult } from "./db/bootstrap";
import { verifyOrInitMasterKey } from "./security/masterKey";
import { loadUpstreamAllowlist } from "./services/settings";

export interface BootResult {
  config: AppConfig;
  db: DB;
}

/**
 * Load config, open the database (applying migrations), verify the master key,
 * and seed the first admin. Throws a readable error on any misconfiguration.
 */
export async function bootstrap(): Promise<BootResult> {
  const config = loadConfig();
  setConfig(config);

  const db = openDatabase(config.dataDir);
  verifyOrInitMasterKey(db, config.masterKey);
  loadUpstreamAllowlist(); // populate the SSRF-guard allowlist cache from the DB

  const seed = await seedAdminIfEmpty(db, config.admin);
  if (seed.created) printInitialAdmin(seed);

  return { config, db };
}

/** Print the initial admin credentials prominently so the user can log in. */
function printInitialAdmin(seed: SeedResult): void {
  const line = "=".repeat(64);
  const rows = [
    "",
    line,
    "  Hydrogen - initial admin account created",
    `  URL:      http://localhost:<PORT>`,
    `  username: ${seed.username}`,
  ];
  if (seed.generated) {
    rows.push(`  password: ${seed.password}`);
    rows.push("  NOTE: this is a temporary password - you will be asked to");
    rows.push("        create a new one at first login.");
  } else {
    rows.push("  password: (the ADMIN_PASSWORD you set in the environment)");
  }
  rows.push(line, "");
  // eslint-disable-next-line no-console
  console.log(rows.join("\n"));
}
