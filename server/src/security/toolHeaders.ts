import { decryptSecret, encryptSecret } from "./crypto";

/**
 * A tool endpoint's static request headers at rest: the same three-column
 * AES-256-GCM scheme as provider API keys, proxy passwords and client tokens,
 * under the same master key. A sibling of those files rather than a
 * generalization, for the reason given in security/proxySecret.ts.
 *
 * The value is a JSON object of header name -> value, because an operator's
 * endpoint may want more than one (`Authorization` plus a tenant id, say) and
 * Hydrogen has no opinion about which. It is stored encrypted because it is a
 * credential for a service Hydrogen does not own.
 */
export interface ToolHeaderColumns {
  headersCiphertext: string | null;
  headersIv: string | null;
  headersTag: string | null;
}

/** Encrypt a header map into the three columns stored on a tool row. */
export function encryptToolHeaders(headers: Record<string, string>, masterKey: Buffer): ToolHeaderColumns {
  const b = encryptSecret(JSON.stringify(headers), masterKey);
  return { headersCiphertext: b.ciphertext, headersIv: b.iv, headersTag: b.tag };
}

/**
 * Decrypt a tool's stored headers, or an empty map when it has none.
 *
 * All three columns must be present: a partially-written row is treated as "no
 * headers" rather than decrypted from fragments, matching decryptProviderKey.
 * A value that does not parse as an object is also treated as none — a corrupt
 * blob must not become a header whose name is a fragment of ciphertext.
 */
export function decryptToolHeaders(row: ToolHeaderColumns, masterKey: Buffer): Record<string, string> {
  if (!row.headersCiphertext || !row.headersIv || !row.headersTag) return {};
  const json = decryptSecret(
    { ciphertext: row.headersCiphertext, iv: row.headersIv, tag: row.headersTag },
    masterKey,
  );
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}
