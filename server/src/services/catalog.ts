import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import { modelProviders, models, providers, type ModelProvider } from "../db/schema";
import { toUpstreamProvider } from "./providers";
import { familyForProviderType, type ProviderType } from "../core/formats";
import type { EgressFamily } from "../core/ir";
import type { UpstreamProvider } from "../core/upstream";

export interface MappingInput {
  modelId: number;
  providerId: number;
  upstreamModel: string;
  priority?: number;
  enabled?: boolean;
}

export function listMappings(): ModelProvider[] {
  return getDb().select().from(modelProviders).all();
}

export function listMappingsForModel(modelId: number): ModelProvider[] {
  return getDb().select().from(modelProviders).where(eq(modelProviders.modelId, modelId)).all();
}

export function createMapping(input: MappingInput): ModelProvider {
  return getDb()
    .insert(modelProviders)
    .values({
      modelId: input.modelId,
      providerId: input.providerId,
      upstreamModel: input.upstreamModel,
      priority: input.priority ?? 0,
      enabled: input.enabled ?? true,
    })
    .returning()
    .get();
}

export function updateMapping(
  id: number,
  input: Partial<Omit<MappingInput, "modelId" | "providerId">>,
): ModelProvider | undefined {
  const patch: Record<string, unknown> = {};
  if (input.upstreamModel !== undefined) patch.upstreamModel = input.upstreamModel;
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (Object.keys(patch).length === 0) {
    return getDb().select().from(modelProviders).where(eq(modelProviders.id, id)).get();
  }
  return getDb().update(modelProviders).set(patch).where(eq(modelProviders.id, id)).returning().get();
}

export function deleteMapping(id: number): void {
  getDb().delete(modelProviders).where(eq(modelProviders.id, id)).run();
}

export interface ResolvedMapping {
  modelName: string;
  providerName: string;
  providerType: ProviderType;
  family: EgressFamily;
  upstreamModel: string;
  upstream: UpstreamProvider;
}

export type MappingResolutionError =
  | "model_not_found"
  | "provider_not_found"
  | "mapping_not_found"
  | "model_disabled"
  | "provider_disabled"
  | "mapping_disabled";

export interface MappingResolution {
  ok: boolean;
  mapping?: ResolvedMapping;
  error?: MappingResolutionError;
}

/**
 * Resolve a service step's (modelName, providerName) pair to a concrete upstream
 * target with a decrypted key. Used by the service engine at request time.
 */
export function resolveMapping(modelName: string, providerName: string): MappingResolution {
  const db = getDb();
  const model = db.select().from(models).where(eq(models.name, modelName)).get();
  if (!model) return { ok: false, error: "model_not_found" };
  if (!model.enabled) return { ok: false, error: "model_disabled" };

  const provider = db.select().from(providers).where(eq(providers.name, providerName)).get();
  if (!provider) return { ok: false, error: "provider_not_found" };
  if (!provider.enabled) return { ok: false, error: "provider_disabled" };

  const mapping = db
    .select()
    .from(modelProviders)
    .where(and(eq(modelProviders.modelId, model.id), eq(modelProviders.providerId, provider.id)))
    .get();
  if (!mapping) return { ok: false, error: "mapping_not_found" };
  if (!mapping.enabled) return { ok: false, error: "mapping_disabled" };

  return {
    ok: true,
    mapping: {
      modelName: model.name,
      providerName: provider.name,
      providerType: provider.type,
      family: familyForProviderType(provider.type),
      upstreamModel: mapping.upstreamModel,
      upstream: toUpstreamProvider(provider),
    },
  };
}

/** Check that a (modelName, providerName) pair is a valid, mapped catalog entry. */
export function mappingExists(modelName: string, providerName: string): boolean {
  return resolveMapping(modelName, providerName).ok;
}
