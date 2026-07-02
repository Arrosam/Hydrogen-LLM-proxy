import { eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { tokens, type Token } from "../db/schema";
import { generateToken, hashToken } from "../security/tokens";

export interface TokenInput {
  name: string;
  ownerUserId?: number | null;
  scopeMubs?: number[] | null; // null/empty = all MUBs
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
  scopeMubs: number[] | null;
  maxRequests: number | null;
  maxTokens: number | null;
  usedRequests: number;
  usedTokens: number;
  expiresAt: number | null;
  enabled: boolean;
  createdAt: number;
}

function asMillis(v: Date | number | null): number | null {
  if (v == null) return null;
  return v instanceof Date ? v.getTime() : Number(v);
}

export function toPublicToken(t: Token): PublicToken {
  return {
    id: t.id,
    name: t.name,
    keyPrefix: t.keyPrefix,
    ownerUserId: t.ownerUserId ?? null,
    scopeMubs: t.scopeMubs ?? null,
    maxRequests: t.maxRequests ?? null,
    maxTokens: t.maxTokens ?? null,
    usedRequests: t.usedRequests,
    usedTokens: t.usedTokens,
    expiresAt: asMillis(t.expiresAt),
    enabled: t.enabled,
    createdAt: asMillis(t.createdAt) ?? 0,
  };
}

export function listTokens(): Token[] {
  return getDb().select().from(tokens).all();
}

export function getToken(id: number): Token | undefined {
  return getDb().select().from(tokens).where(eq(tokens.id, id)).get();
}

/** Create a token, returning the row plus the one-time plaintext secret. */
export function createToken(input: TokenInput): { token: Token; secret: string } {
  const gen = generateToken();
  const row = getDb()
    .insert(tokens)
    .values({
      name: input.name,
      keyHash: gen.hash,
      keyPrefix: gen.prefix,
      ownerUserId: input.ownerUserId ?? null,
      scopeMubs: input.scopeMubs ?? null,
      maxRequests: input.maxRequests ?? null,
      maxTokens: input.maxTokens ?? null,
      expiresAt: input.expiresAt != null ? new Date(input.expiresAt) : null,
      enabled: input.enabled ?? true,
    })
    .returning()
    .get();
  return { token: row, secret: gen.token };
}

export function updateToken(
  id: number,
  input: Partial<Omit<TokenInput, "ownerUserId">>,
): Token | undefined {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.scopeMubs !== undefined) patch.scopeMubs = input.scopeMubs;
  if (input.maxRequests !== undefined) patch.maxRequests = input.maxRequests;
  if (input.maxTokens !== undefined) patch.maxTokens = input.maxTokens;
  if (input.expiresAt !== undefined)
    patch.expiresAt = input.expiresAt != null ? new Date(input.expiresAt) : null;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (Object.keys(patch).length === 0) return getToken(id);
  return getDb().update(tokens).set(patch).where(eq(tokens.id, id)).returning().get();
}

export function deleteToken(id: number): void {
  getDb().delete(tokens).where(eq(tokens.id, id)).run();
}

/** Look up a token by the presented secret (constant-time-ish via hash index). */
export function authenticateToken(presented: string): Token | undefined {
  const hash = hashToken(presented);
  return getDb().select().from(tokens).where(eq(tokens.keyHash, hash)).get();
}

/** Atomically add to a token's usage counters. */
export function incrementUsage(id: number, requests: number, tokensUsed: number): void {
  getDb()
    .update(tokens)
    .set({
      usedRequests: sql`${tokens.usedRequests} + ${requests}`,
      usedTokens: sql`${tokens.usedTokens} + ${tokensUsed}`,
    })
    .where(eq(tokens.id, id))
    .run();
}
