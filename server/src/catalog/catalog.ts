import { familyForProviderType, type Family } from "../core/format/family";
import { buildHeaders, chatUrl, type UpstreamProvider } from "../core/upstream/endpoints";
import type { ModelRepo } from "../persistence/modelRepo";
import type { ProviderRepo } from "../persistence/providerRepo";
import type { MappingRepo } from "../persistence/mappingRepo";

/** A resolved upstream target: everything a send needs to reach one provider. */
export interface ResolvedTarget {
  family: Family;
  upstreamModel: string;
  url: string;
  headers: Record<string, string>;
  /** The provider's hard output-token cap, if configured. */
  providerMaxOutputTokens?: number;
  modelName: string;
  providerName: string;
  /** The provider's row id (media passthrough encodes it into video job ids). */
  providerId: number;
  /** The materialized provider (for media passthrough / model listing). */
  upstream: UpstreamProvider;
}

export type MappingResolutionError =
  | "model_not_found"
  | "provider_not_found"
  | "mapping_not_found"
  | "model_disabled"
  | "provider_disabled"
  | "mapping_disabled";

export type MappingResolution =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; error: MappingResolutionError };

/**
 * Resolves a step's (modelName, providerName) pair to a concrete upstream target
 * with a decrypted key and a built endpoint URL/headers. Reads through the
 * injected repos -- no global DB access.
 */
export class Catalog {
  constructor(
    private readonly models: ModelRepo,
    private readonly providers: ProviderRepo,
    private readonly mappings: MappingRepo,
  ) {}

  /**
   * Resolve a (model, provider) pair to a concrete endpoint. A provider may
   * serve several wire formats (its primary type plus altEndpoints); which of
   * them a mapping may use is chosen on the mapping (`families` — unset means
   * the primary type only). When the caller states a `preferredFamily` (the
   * client's own ingress format), a matching endpoint wins: same-format
   * pass-through beats translation. Otherwise the primary endpoint is used,
   * falling back to the first enabled family.
   */
  resolve(modelName: string, providerName: string, preferredFamily?: Family): MappingResolution {
    const model = this.models.getByName(modelName);
    if (!model) return { ok: false, error: "model_not_found" };
    if (!model.enabled) return { ok: false, error: "model_disabled" };

    const provider = this.providers.getByName(providerName);
    if (!provider) return { ok: false, error: "provider_not_found" };
    if (!provider.enabled) return { ok: false, error: "provider_disabled" };

    const mapping = this.mappings.getPair(model.id, provider.id);
    if (!mapping) return { ok: false, error: "mapping_not_found" };
    if (!mapping.enabled) return { ok: false, error: "mapping_disabled" };

    const upstream = this.providers.toUpstream(provider);

    // Endpoint selection: primary first, then declared alternates; filtered by
    // the mapping's enabled families (unset = primary only).
    const endpoints: Array<{ type: typeof provider.type; baseUrl: string }> = [
      { type: provider.type, baseUrl: provider.baseUrl },
      ...(provider.altEndpoints ?? []),
    ];
    const enabledFams = mapping.families && mapping.families.length ? mapping.families : [provider.type];
    const usable = endpoints.filter((e) => enabledFams.includes(e.type));
    const pool = usable.length ? usable : [endpoints[0]];
    const chosen =
      (preferredFamily && pool.find((e) => familyForProviderType(e.type) === preferredFamily)) ?? pool[0];
    const chosenUpstream = { ...upstream, type: chosen.type, baseUrl: chosen.baseUrl };

    return {
      ok: true,
      target: {
        family: familyForProviderType(chosen.type),
        upstreamModel: mapping.upstreamModel,
        url: chatUrl(chosenUpstream),
        headers: buildHeaders(chosenUpstream),
        providerMaxOutputTokens: provider.maxOutputTokens ?? undefined,
        modelName: model.name,
        providerName: provider.name,
        providerId: provider.id,
        upstream: chosenUpstream,
      },
    };
  }

  /** Whether a (modelName, providerName) pair is a valid, enabled, mapped entry. */
  exists(modelName: string, providerName: string): boolean {
    return this.resolve(modelName, providerName).ok;
  }
}
