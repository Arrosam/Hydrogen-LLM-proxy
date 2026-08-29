import { familyForProviderType, type Family } from "../core/format/family";
import {
  buildHeaders,
  chatUrl,
  providerEndpoints,
  type ProviderEndpoint,
  type UpstreamProvider,
} from "../core/upstream/endpoints";
import type { ModelRepo } from "../persistence/modelRepo";
import type { ProviderRepo } from "../persistence/providerRepo";
import type { MappingRepo } from "../persistence/mappingRepo";
import type { Model, ModelProvider as Mapping, Provider } from "../db/schema";

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
  /** Which of the provider's endpoints was chosen (0 = primary). Media
   * passthrough encodes it into video job ids so a later poll reaches the same
   * endpoint the job was created on. */
  endpointIndex: number;
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

/** {@link Catalog.resolveWithin} adds one failure the plain resolve cannot have:
 * every endpoint this mapping enables speaks a family the caller cannot use. */
export type ConstrainedResolutionError = MappingResolutionError | "no_endpoint_in_family";

export type ConstrainedResolution =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; error: ConstrainedResolutionError };

/**
 * The families whose providers expose the OpenAI media/passthrough surface.
 * Embeddings, rerank, images, video, TTS and STT are all OpenAI-shaped routes;
 * an Anthropic endpoint serves none of them.
 */
export const MEDIA_FAMILIES: readonly Family[] = ["openai_completion", "openai_responses"];

/** Same-format pass-through beats translation, so an endpoint matching the
 * caller's own family wins; otherwise the pool's first (the provider's own
 * order, primary first) is used. */
function pick(pool: ProviderEndpoint[], preferred?: Family): ProviderEndpoint {
  return (preferred && pool.find((e) => familyForProviderType(e.type) === preferred)) ?? pool[0];
}

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
    const looked = this.lookup(modelName, providerName);
    if (!looked.ok) return looked;
    const { model, provider, mapping } = looked;
    const chosen = pick(this.endpointPool(provider, mapping), preferredFamily);
    return { ok: true, target: this.materialize(model, provider, mapping, chosen) };
  }

  /**
   * Resolve to an endpoint whose family is one the caller can actually speak.
   *
   * The media/passthrough categories and the ASR pre-pass call OpenAI-shaped
   * routes that an Anthropic endpoint does not serve, so "any enabled endpoint"
   * is the wrong question for them: a provider whose PRIMARY is Anthropic but
   * which also declares an OpenAI alternate can serve them perfectly well, and
   * plain `resolve()` would hand back the Anthropic one and get a 404 (or worse,
   * a request posted at an Anthropic base URL).
   *
   * The candidate pool is exactly the one `resolve()` builds -- same enabled
   * families, same primary fallback when the mapping's families match nothing --
   * and then narrowed to `allowed`. Narrowing never falls back outside the set:
   * when no enabled endpoint qualifies the caller gets a diagnosable error
   * instead of a misrouted request.
   */
  resolveWithin(
    modelName: string,
    providerName: string,
    allowed: readonly Family[],
    preferredFamily?: Family,
  ): ConstrainedResolution {
    const looked = this.lookup(modelName, providerName);
    if (!looked.ok) return looked;
    const { model, provider, mapping } = looked;
    const pool = this.endpointPool(provider, mapping).filter((e) => allowed.includes(familyForProviderType(e.type)));
    if (!pool.length) return { ok: false, error: "no_endpoint_in_family" };
    return { ok: true, target: this.materialize(model, provider, mapping, pick(pool, preferredFamily)) };
  }

  /** Whether a (modelName, providerName) pair is a valid, enabled, mapped entry. */
  exists(modelName: string, providerName: string): boolean {
    return this.resolve(modelName, providerName).ok;
  }

  /** The model/provider/mapping rows behind a step, or the reason there are none. */
  private lookup(
    modelName: string,
    providerName: string,
  ):
    | { ok: true; model: Model; provider: Provider; mapping: Mapping }
    | { ok: false; error: MappingResolutionError } {
    const model = this.models.getByName(modelName);
    if (!model) return { ok: false, error: "model_not_found" };
    if (!model.enabled) return { ok: false, error: "model_disabled" };

    const provider = this.providers.getByName(providerName);
    if (!provider) return { ok: false, error: "provider_not_found" };
    if (!provider.enabled) return { ok: false, error: "provider_disabled" };

    const mapping = this.mappings.getPair(model.id, provider.id);
    if (!mapping) return { ok: false, error: "mapping_not_found" };
    if (!mapping.enabled) return { ok: false, error: "mapping_disabled" };

    return { ok: true, model, provider, mapping };
  }

  /**
   * The endpoints a mapping may use: the provider's own list (primary first,
   * then alternates) filtered by the mapping's enabled families -- unset means
   * the primary only. A mapping whose families match nothing the provider still
   * serves falls back to the primary rather than resolving to nothing, so
   * editing a provider's endpoints cannot silently take every mapping offline.
   */
  private endpointPool(provider: Provider, mapping: Mapping): ProviderEndpoint[] {
    const endpoints = providerEndpoints(provider);
    const enabledFams = mapping.families && mapping.families.length ? mapping.families : [provider.type];
    const usable = endpoints.filter((e) => enabledFams.includes(e.type));
    return usable.length ? usable : [endpoints[0]];
  }

  private materialize(model: Model, provider: Provider, mapping: Mapping, chosen: ProviderEndpoint): ResolvedTarget {
    const upstream: UpstreamProvider = {
      ...this.providers.toUpstream(provider),
      type: chosen.type,
      baseUrl: chosen.baseUrl,
    };
    return {
      family: familyForProviderType(chosen.type),
      upstreamModel: mapping.upstreamModel,
      url: chatUrl(upstream),
      headers: buildHeaders(upstream),
      providerMaxOutputTokens: provider.maxOutputTokens ?? undefined,
      modelName: model.name,
      providerName: provider.name,
      providerId: provider.id,
      endpointIndex: chosen.index,
      upstream,
    };
  }
}
