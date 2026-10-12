import { eq, sql } from "drizzle-orm";
import type { DB } from "../db";
import { tokens, type Token } from "../db/schema";
import { asMillis, asMillisOrNull } from "../util/time";
import { decryptSecret, encryptSecret } from "../security/crypto";
import { generateToken, hashToken } from "../security/tokens";
import { pickDefined, TableRepo } from "./tableRepo";

export interface TokenInput {
  name: string;
  ownerUserId?: number | null;
  scopeServices?: number[] | null; // null/empty = all services
  maxRequests?: number | null;
  maxTokens?: number | null;
  expiresAt?: number | null; // epoch ms
  enabled?: boolean;
}

export interface PublicToken {
  id: number;
  name: string;
  keyPrefix: string;
  ownerUserId: number | null;
  scopeServices: number[] | null;
  maxRequests: number | null;
  maxTokens: number | null;
  usedRequests: number;
  usedTokens: number;
  expiresAt: number | null;
  enabled: boolean;
  createdAt: number;
  /** Whether the secret is stored (encrypted) and can be copied again. False
   * on tokens issued before v1.5.2, which were hash-only. */
  hasStoredKey: boolean;
}

/** Client tokens: SHA-256 hash for lookup, master-key-encrypted secret so an
 * admin can copy an issued key again later. */
export class TokenRepo extends TableRepo<typeof tokens> {
  constructor(
    db: DB,
    private readonly masterKey: Buffer,
  ) {
    super(db, tokens);
  }

  toPublic(t: Token): PublicToken {
    return {
      id: t.id,
      name: t.name,
      keyPrefix: t.keyPrefix,
      ownerUserId: t.ownerUserId ?? null,
      scopeServices: t.scopeServices ?? null,
      maxRequests: t.maxRequests ?? null,
      maxTokens: t.maxTokens ?? null,
      usedRequests: t.usedRequests,
      usedTokens: t.usedTokens,
      expiresAt: asMillisOrNull(t.expiresAt),
      enabled: t.enabled,
      createdAt: asMillis(t.createdAt),
      hasStoredKey: Boolean(t.keyCiphertext && t.keyIv && t.keyTag),
    };
  }

  /** Create a token, returning the row plus the plaintext secret. */
  create(input: TokenInput): { token: Token; secret: string } {
    const gen = generateToken();
    const blob = encryptSecret(gen.token, this.masterKey);
    const row = this.db
      .insert(tokens)
      .values({
        name: input.name,
        keyHash: gen.hash,
        keyPrefix: gen.prefix,
        keyCiphertext: blob.ciphertext,
        keyIv: blob.iv,
        keyTag: blob.tag,
        ownerUserId: input.ownerUserId ?? null,
        scopeServices: input.scopeServices ?? null,
        maxRequests: input.maxRequests ?? null,
        maxTokens: input.maxTokens ?? null,
        expiresAt: input.expiresAt != null ? new Date(input.expiresAt) : null,
        enabled: input.enabled ?? true,
      })
      .returning()
      .get();
    return { token: row, secret: gen.token };
  }

  update(id: number, input: Partial<Omit<TokenInput, "ownerUserId">>): Token | undefined {
    const patch: Partial<typeof tokens.$inferInsert> = pickDefined(input, ["name", "scopeServices", "maxRequests", "maxTokens", "enabled"]);
    if (input.expiresAt !== undefined) patch.expiresAt = input.expiresAt != null ? new Date(input.expiresAt) : null;
    return this.patch(id, patch);
  }

  /** Decrypt a token's stored secret, or null when the token predates stored
   * keys (hash-only) and can never be shown again. */
  revealSecret(id: number): string | null {
    const t = this.get(id);
    if (!t?.keyCiphertext || !t.keyIv || !t.keyTag) return null;
    return decryptSecret({ ciphertext: t.keyCiphertext, iv: t.keyIv, tag: t.keyTag }, this.masterKey);
  }

  /** Look up a token by the presented secret (via the hash index). */
  authenticate(presented: string): Token | undefined {
    const hash = hashToken(presented);
    return this.findBy(tokens.keyHash, hash);
  }

  /** Atomically add to a token's usage counters. */
  incrementUsage(id: number, requests: number, tokensUsed: number): void {
    this.db
      .update(tokens)
      .set({
        usedRequests: sql`${tokens.usedRequests} + ${requests}`,
        usedTokens: sql`${tokens.usedTokens} + ${tokensUsed}`,
      })
      .where(eq(tokens.id, id))
      .run();
  }
}
