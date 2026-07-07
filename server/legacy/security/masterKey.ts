import { eq } from "drizzle-orm";
import type { DB } from "../db";
import { settings } from "../db/schema";
import { decryptSecret, encryptSecret, type EncryptedBlob } from "./crypto";

const SENTINEL_KEY = "master_key_check";
const SENTINEL_PLAINTEXT = "hydrogen-master-key-ok";

/**
 * On first boot, store an encrypted sentinel so we can later detect a changed
 * master key. On subsequent boots, decrypt and compare; a mismatch means the
 * provided PROXY_MASTER_KEY cannot decrypt this database's provider keys, so
 * we refuse to start rather than silently corrupt behaviour.
 */
export function verifyOrInitMasterKey(db: DB, masterKey: Buffer): void {
  const row = db.select().from(settings).where(eq(settings.key, SENTINEL_KEY)).get();
  if (!row) {
    const blob = encryptSecret(SENTINEL_PLAINTEXT, masterKey);
    db.insert(settings).values({ key: SENTINEL_KEY, value: JSON.stringify(blob) }).run();
    return;
  }
  try {
    const blob = JSON.parse(row.value) as EncryptedBlob;
    if (decryptSecret(blob, masterKey) === SENTINEL_PLAINTEXT) return;
  } catch {
    /* fall through to the error below */
  }
  throw new Error(
    "PROXY_MASTER_KEY does not match the key that initialised this database. " +
      "Stored provider keys would be undecryptable. Refusing to start. " +
      "Restore the original key, or wipe the data volume to start fresh.",
  );
}
