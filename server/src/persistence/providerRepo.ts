import { eq } from "drizzle-orm";
import type { DB } from "../db";
import { providers, type Provider } from "../db/schema";
import { asMillis } from "../util/time";
import { decryptProviderKey, encryptProviderKey } from "../security/providerKeys";
import type { UpstreamProvider } from "../core/upstream/endpoints";
import type { ProviderType } from "../core/format/family";

export interface ProviderInput {
  name: string;
  type: ProviderType;
  baseUrl: string;
  /** Plaintext API key. undefined = leave unchanged (update); null/"" = clear. */
  apiKey?: string | null;
  extraHeaders?: Record<string, string> | null;
  /** Hard cap on output tokens the provider accepts (thinking budgets fit under it). */
  maxOutputTokens?: number | null;
  enabled?: boolean;
}

/** Provider shape safe to return over the API (no secret material). */
export interface PublicProvider {
  id: number;
  name: string;
  type: ProviderType;
  baseUrl: string;
  hasKey: boolean;
  extraHeaders: Record<string, string> | null;
  maxOutputTokens: number | null;
  enabled: boolean;
  createdAt: number;
}

/** Provider persistence + key (de)cryption. The master key is injected. */
export class ProviderRepo {
  constructor(
    private readonly db: DB,
    private readonly masterKey: Buffer,
  ) {}

  list(): Provider[] {
    return this.db.select().from(providers).all();
  }

  get(id: number): Provider | undefined {
    return this.db.select().from(providers).where(eq(providers.id, id)).get();
  }

  getByName(name: string): Provider | undefined {
    return this.db.select().from(providers).where(eq(providers.name, name)).get();
  }

  create(input: ProviderInput): Provider {
    const keyCols =
      input.apiKey && input.apiKey.length > 0
        ? encryptProviderKey(input.apiKey, this.masterKey)
        : { keyCiphertext: null, keyIv: null, keyTag: null };
    return this.db
      .insert(providers)
      .values({
        name: input.name,
        type: input.type,
        baseUrl: input.baseUrl,
        ...keyCols,
        extraHeaders: input.extraHeaders ?? null,
        maxOutputTokens: input.maxOutputTokens ?? null,
        enabled: input.enabled ?? true,
      })
      .returning()
      .get();
  }

  update(id: number, input: Partial<ProviderInput>): Provider | undefined {
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.type !== undefined) patch.type = input.type;
    if (input.baseUrl !== undefined) patch.baseUrl = input.baseUrl;
    if (input.extraHeaders !== undefined) patch.extraHeaders = input.extraHeaders;
    if (input.maxOutputTokens !== undefined) patch.maxOutputTokens = input.maxOutputTokens;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.apiKey !== undefined) {
      if (input.apiKey === null || input.apiKey === "") {
        Object.assign(patch, { keyCiphertext: null, keyIv: null, keyTag: null });
      } else {
        Object.assign(patch, encryptProviderKey(input.apiKey, this.masterKey));
      }
    }
    if (Object.keys(patch).length === 0) return this.get(id);
    return this.db.update(providers).set(patch).where(eq(providers.id, id)).returning().get();
  }

  delete(id: number): void {
    this.db.delete(providers).where(eq(providers.id, id)).run();
  }

  toPublic(p: Provider): PublicProvider {
    return {
      id: p.id,
      name: p.name,
      type: p.type,
      baseUrl: p.baseUrl,
      hasKey: Boolean(p.keyCiphertext),
      extraHeaders: p.extraHeaders ?? null,
      maxOutputTokens: p.maxOutputTokens ?? null,
      enabled: p.enabled,
      createdAt: asMillis(p.createdAt),
    };
  }

  /** Materialize a provider row (decrypted key) for making upstream calls. */
  toUpstream(p: Provider): UpstreamProvider {
    return {
      type: p.type,
      baseUrl: p.baseUrl,
      apiKey: decryptProviderKey(p, this.masterKey),
      extraHeaders: p.extraHeaders ?? null,
    };
  }
}
