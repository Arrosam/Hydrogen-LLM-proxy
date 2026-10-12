import crypto from "node:crypto";

const CIPHER = "aes-256-gcm";
/** Key size of AES-256: the master key and every passphrase-derived key. */
export const AES_256_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;

export interface EncryptedBlob {
  ciphertext: string; // base64
  iv: string; // base64 (12 bytes)
  tag: string; // base64 (16 bytes)
}

/** Encrypt a UTF-8 secret with AES-256-GCM using a fresh random IV. */
export function encryptSecret(plaintext: string, masterKey: Buffer): EncryptedBlob {
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv(CIPHER, masterKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: enc.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/** Decrypt an AES-256-GCM blob. Throws if the tag/key is wrong (tamper-evident). */
export function decryptSecret(blob: EncryptedBlob, masterKey: Buffer): string {
  const iv = Buffer.from(blob.iv, "base64");
  const tag = Buffer.from(blob.tag, "base64");
  const decipher = crypto.createDecipheriv(CIPHER, masterKey, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}
