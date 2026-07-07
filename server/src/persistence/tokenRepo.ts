import { eq, sql } from "drizzle-orm";
import type { DB } from "../db";
import { tokens, type Token } from "../db/schema";
import { asMillis, asMillisOrNull } from "../util/time";
import { generateToken, hashToken } from "../security/tokens";

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
}

/** Client tokens: secrets stored only as a SHA-256 hash + short display prefix. */
export class TokenRepo {
  constructor(private readonly db: DB) {}

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
    };
  }

  list(): Token[] {
    return this.db.select().from(tokens).all();
  }

  get(id: number): Token | undefined {
    return this.db.select().from(tokens).where(eq(tokens.id, id)).get();
  }

  /** Create a token, returning the row plus the one-time plaintext secret. */
  create(input: TokenInput): { token: Token; secret: string } {
    const gen = generateToken();
    const row = this.db
      .insert(tokens)
      .values({
        name: input.name,
        keyHash: gen.hash,
        keyPrefix: gen.prefix,
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
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.scopeServices !== undefined) patch.scopeServices = input.scopeServices;
    if (input.maxRequests !== undefined) patch.maxRequests = input.maxRequests;
    if (input.maxTokens !== undefined) patch.maxTokens = input.maxTokens;
    if (input.expiresAt !== undefined) patch.expiresAt = input.expiresAt != null ? new Date(input.expiresAt) : null;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (Object.keys(patch).length === 0) return this.get(id);
    return this.db.update(tokens).set(patch).where(eq(tokens.id, id)).returning().get();
  }

  delete(id: number): void {
    this.db.delete(tokens).where(eq(tokens.id, id)).run();
  }

  /** Look up a token by the presented secret (via the hash index). */
  authenticate(presented: string): Token | undefined {
    const hash = hashToken(presented);
    return this.db.select().from(tokens).where(eq(tokens.keyHash, hash)).get();
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
