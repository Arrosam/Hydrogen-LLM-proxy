import { decryptSecret, encryptSecret } from "./crypto";

/**
 * A proxy's password at rest: the same three-column AES-256-GCM scheme as
 * provider API keys (security/providerKeys.ts) and client tokens, under the
 * same master key. Deliberately a sibling of that file rather than a
 * generalization of it -- the column names differ, and one shared helper with
 * a column-name parameter would be harder to audit than two short ones.
 */
export interface ProxyPasswordColumns {
  passwordCiphertext: string | null;
  passwordIv: string | null;
  passwordTag: string | null;
}

/** Encrypt a proxy password into the three columns stored on a proxy row. */
export function encryptProxyPassword(password: string, masterKey: Buffer): ProxyPasswordColumns {
  const b = encryptSecret(password, masterKey);
  return { passwordCiphertext: b.ciphertext, passwordIv: b.iv, passwordTag: b.tag };
}

/**
 * Decrypt a proxy's stored password, or null when it has none.
 *
 * All three columns must be present: a partially-written row is treated as
 * "no password" rather than decrypted from fragments, matching
 * decryptProviderKey.
 */
export function decryptProxyPassword(row: ProxyPasswordColumns, masterKey: Buffer): string | null {
  if (!row.passwordCiphertext || !row.passwordIv || !row.passwordTag) return null;
  return decryptSecret(
    { ciphertext: row.passwordCiphertext, iv: row.passwordIv, tag: row.passwordTag },
    masterKey,
  );
}
