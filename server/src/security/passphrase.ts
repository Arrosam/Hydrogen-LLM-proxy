import crypto from "node:crypto";
import { promisify } from "node:util";
import { decryptSecret, encryptSecret, type EncryptedBlob } from "./crypto";

/**
 * Seal a payload under a human-chosen passphrase.
 *
 * The master key never leaves the server, so a backup that carried provider keys
 * as-is would only ever restore onto the instance that wrote it -- useless for
 * the case backups exist for. Re-sealing under a passphrase makes the package
 * portable without putting a usable secret in a downloaded file.
 *
 * scrypt (not a raw hash) is what stands between a stolen package and the keys
 * inside it: a passphrase is low-entropy, so the KDF has to be expensive enough
 * that guessing it in bulk costs real money. The cost parameters travel in the
 * package so a future increase can still open an old backup. Derivation runs
 * async (on the libuv pool) so the ~100ms KDF never stalls the event loop while
 * the same process is relaying live traffic.
 */

/** scrypt cost. N=2^15 with r=8 needs ~32MB and ~100ms per guess. */
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
/** Memory ceiling for scrypt. scrypt needs ~128*N*r bytes; this both sizes our
 * own derivation and bounds what a package may ask for (see openWithPassphrase). */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

const scrypt = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

/** A passphrase-sealed payload. Self-describing so it can be opened later. */
export interface SealedPayload extends EncryptedBlob {
  kdf: "scrypt";
  n: number;
  r: number;
  p: number;
  salt: string; // base64
}

/** Wrong passphrase, or a package someone edited. Both are the user's problem
 * to fix, and neither should be reported as an internal error. */
export class PassphraseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PassphraseError";
  }
}

function deriveKey(passphrase: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return scrypt(passphrase.normalize("NFKC"), salt, KEY_BYTES, { N: n, r, p, maxmem: SCRYPT_MAXMEM });
}

/** Seal `plaintext` so only this passphrase can open it. */
export async function sealWithPassphrase(plaintext: string, passphrase: string): Promise<SealedPayload> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await deriveKey(passphrase, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return {
    kdf: "scrypt",
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    salt: salt.toString("base64"),
    ...encryptSecret(plaintext, key),
  };
}

/**
 * Open a sealed payload. Throws {@link PassphraseError} for a wrong passphrase
 * or a tampered package -- AES-GCM's auth tag makes those the same failure, and
 * we cannot tell them apart (nor should we say which, to a caller who may be
 * guessing).
 */
export async function openWithPassphrase(sealed: SealedPayload, passphrase: string): Promise<string> {
  if (sealed?.kdf !== "scrypt") {
    throw new PassphraseError("unsupported key-derivation function in this backup");
  }
  // The cost parameters come from the file, so clamp them: a malicious package
  // could otherwise pin the process on a huge scrypt call. Both the individual
  // bounds AND the memory product matter -- scrypt throws (not returns) when
  // 128*N*r exceeds maxmem, and that throw must surface as a clean rejection.
  const n = Number(sealed.n);
  const r = Number(sealed.r);
  const p = Number(sealed.p);
  if (
    !isPowerOfTwo(n) ||
    n > 1 << 20 ||
    !Number.isInteger(r) ||
    r < 1 ||
    r > 32 ||
    !Number.isInteger(p) ||
    p < 1 ||
    p > 16 ||
    128 * n * r > SCRYPT_MAXMEM
  ) {
    throw new PassphraseError("invalid key-derivation parameters in this backup");
  }
  let salt: Buffer;
  try {
    salt = Buffer.from(sealed.salt, "base64");
  } catch {
    throw new PassphraseError("malformed backup: unreadable salt");
  }
  let key: Buffer;
  try {
    key = await deriveKey(passphrase, salt, n, r, p);
  } catch {
    // Any residual KDF failure (e.g. an unforeseen parameter combination) is the
    // package's fault, not ours -- report it as a bad backup, never a 500.
    throw new PassphraseError("invalid key-derivation parameters in this backup");
  }
  try {
    return decryptSecret(sealed, key);
  } catch {
    throw new PassphraseError("wrong passphrase, or this backup has been modified");
  }
}

function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;
}
