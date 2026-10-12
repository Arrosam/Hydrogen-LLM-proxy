import type { DB } from "../db";
import { providers, type Provider } from "../db/schema";
import { asMillis } from "../util/time";
import { decryptProviderKey, encryptProviderKey, type ProviderKeyColumns } from "../security/providerKeys";
import { pickDefined, TableRepo } from "./tableRepo";
import type { UpstreamProvider } from "../core/upstream/endpoints";
import type { ProviderType } from "../core/format/family";
import type { EgressProxy } from "../core/upstream/egress/types";

export interface ProviderInput {
  name: string;
  type: ProviderType;
  baseUrl: string;
  /** Plaintext API key. undefined = leave unchanged (update); null/"" = clear. */
  apiKey?: string | null;
  extraHeaders?: Record<string, string> | null;
  /** Hard cap on output tokens the provider accepts (thinking budgets fit under it). */
  maxOutputTokens?: number | null;
  /** Additional wire-format endpoints (same key/headers, different family+URL). */
  altEndpoints?: Array<{ type: ProviderType; baseUrl: string }> | null;
  /** Egress proxy to route this provider's traffic through. null = direct. */
  proxyId?: number | null;
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
  altEndpoints: Array<{ type: ProviderType; baseUrl: string }> | null;
  proxyId: number | null;
  enabled: boolean;
  createdAt: number;
}

/** The plain columns an update may set; the API key has its own rule. */
const PATCHABLE = ["name", "type", "baseUrl", "extraHeaders", "maxOutputTokens", "altEndpoints", "proxyId", "enabled"] as const;

/** Provider persistence + key (de)cryption. The master key is injected. */
export class ProviderRepo extends TableRepo<typeof providers> {
  constructor(
    db: DB,
    private readonly masterKey: Buffer,
    /** Resolves a provider's egress proxy. Omitted = every provider is direct. */
    private readonly proxies?: { forProvider(id: number | null | undefined): EgressProxy | null },
  ) {
    super(db, providers);
  }

  getByName(name: string): Provider | undefined {
    return this.findBy(providers.name, name);
  }

  /** The key columns for a plaintext key; none (null, "" or absent) clears them. */
  private keyColumns(apiKey: string | null | undefined): ProviderKeyColumns {
    return apiKey ? encryptProviderKey(apiKey, this.masterKey) : { keyCiphertext: null, keyIv: null, keyTag: null };
  }

  create(input: ProviderInput): Provider {
    const keyCols = this.keyColumns(input.apiKey);
    return this.db
      .insert(providers)
      .values({
        name: input.name,
        type: input.type,
        baseUrl: input.baseUrl,
        ...keyCols,
        extraHeaders: input.extraHeaders ?? null,
        maxOutputTokens: input.maxOutputTokens ?? null,
        altEndpoints: input.altEndpoints ?? null,
        proxyId: input.proxyId ?? null,
        enabled: input.enabled ?? true,
      })
      .returning()
      .get();
  }

  update(id: number, input: Partial<ProviderInput>): Provider | undefined {
    const patch: Partial<typeof providers.$inferInsert> = pickDefined(input, PATCHABLE);
    if (input.apiKey !== undefined) Object.assign(patch, this.keyColumns(input.apiKey));
    return this.patch(id, patch);
  }

  toPublic(p: Provider): PublicProvider {
    return {
      id: p.id,
      name: p.name,
      type: p.type,
      baseUrl: p.baseUrl,
      // All three columns, as decryptProviderKey requires: a partial row has no usable key.
      hasKey: Boolean(p.keyCiphertext && p.keyIv && p.keyTag),
      extraHeaders: p.extraHeaders ?? null,
      maxOutputTokens: p.maxOutputTokens ?? null,
      altEndpoints: p.altEndpoints ?? null,
      proxyId: p.proxyId ?? null,
      enabled: p.enabled,
      createdAt: asMillis(p.createdAt),
    };
  }

  /**
   * Materialize a provider row (decrypted key) for making upstream calls.
   *
   * This is the single place a stored provider becomes network configuration,
   * so it is also where its egress proxy is attached. `proxies` is optional:
   * without it every provider materializes exactly as it did before proxies
   * existed, which is what keeps the ~10 hand-built ProviderRepo instances in
   * the test suite compiling and behaving unchanged.
   */
  toUpstream(p: Provider): UpstreamProvider {
    return {
      type: p.type,
      baseUrl: p.baseUrl,
      apiKey: decryptProviderKey(p, this.masterKey),
      extraHeaders: p.extraHeaders ?? null,
      proxy: this.proxies?.forProvider(p.proxyId) ?? null,
    };
  }
}
