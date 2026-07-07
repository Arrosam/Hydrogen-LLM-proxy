import { decryptSecret, encryptSecret } from "./crypto";

export interface ProviderKeyColumns {
  keyCiphertext: string | null;
  keyIv: string | null;
  keyTag: string | null;
}

/** Encrypt an API key into the three columns stored on a provider row. */
export function encryptProviderKey(apiKey: string, masterKey: Buffer): ProviderKeyColumns {
  const b = encryptSecret(apiKey, masterKey);
  return { keyCiphertext: b.ciphertext, keyIv: b.iv, keyTag: b.tag };
}

/** Decrypt a provider's stored API key, or null if the provider is keyless. */
export function decryptProviderKey(row: ProviderKeyColumns, masterKey: Buffer): string | null {
  if (!row.keyCiphertext || !row.keyIv || !row.keyTag) return null;
  return decryptSecret(
    { ciphertext: row.keyCiphertext, iv: row.keyIv, tag: row.keyTag },
    masterKey,
  );
}
