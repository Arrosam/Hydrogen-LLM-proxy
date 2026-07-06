import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { asMillis } from "../util/time";
import { providers, type Provider } from "../db/schema";
import { getConfig } from "../context";
import { decryptProviderKey, encryptProviderKey } from "../security/providerKeys";
import { buildHeaders, getJson, modelsUrl, type UpstreamProvider } from "../core/upstream";
import { familyForProviderType, type ProviderType } from "../core/formats";

export interface ProviderInput {
  name: string;
  type: ProviderType;
  baseUrl: string;
  /** Plaintext API key. undefined = leave unchanged (update); null = clear. */
  apiKey?: string | null;
  extraHeaders?: Record<string, string> | null;
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
  enabled: boolean;
  createdAt: number;
}

export function toPublicProvider(p: Provider): PublicProvider {
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    baseUrl: p.baseUrl,
    hasKey: Boolean(p.keyCiphertext),
    extraHeaders: p.extraHeaders ?? null,
    enabled: p.enabled,
    createdAt: asMillis(p.createdAt),
  };
}

export function listProviders(): Provider[] {
  return getDb().select().from(providers).all();
}

export function getProvider(id: number): Provider | undefined {
  return getDb().select().from(providers).where(eq(providers.id, id)).get();
}

export function createProvider(input: ProviderInput): Provider {
  const cfg = getConfig();
  const keyCols =
    input.apiKey && input.apiKey.length > 0
      ? encryptProviderKey(input.apiKey, cfg.masterKey)
      : { keyCiphertext: null, keyIv: null, keyTag: null };
  const row = getDb()
    .insert(providers)
    .values({
      name: input.name,
      type: input.type,
      baseUrl: input.baseUrl,
      ...keyCols,
      extraHeaders: input.extraHeaders ?? null,
      enabled: input.enabled ?? true,
    })
    .returning()
    .get();
  return row;
}

export function updateProvider(id: number, input: Partial<ProviderInput>): Provider | undefined {
  const cfg = getConfig();
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.type !== undefined) patch.type = input.type;
  if (input.baseUrl !== undefined) patch.baseUrl = input.baseUrl;
  if (input.extraHeaders !== undefined) patch.extraHeaders = input.extraHeaders;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.apiKey !== undefined) {
    if (input.apiKey === null || input.apiKey === "") {
      Object.assign(patch, { keyCiphertext: null, keyIv: null, keyTag: null });
    } else {
      Object.assign(patch, encryptProviderKey(input.apiKey, cfg.masterKey));
    }
  }
  if (Object.keys(patch).length === 0) return getProvider(id);
  return getDb().update(providers).set(patch).where(eq(providers.id, id)).returning().get();
}

export function deleteProvider(id: number): void {
  getDb().delete(providers).where(eq(providers.id, id)).run();
}

/** Materialise a provider row (with decrypted key) for making upstream calls. */
export function toUpstreamProvider(p: Provider): UpstreamProvider {
  return {
    type: p.type,
    baseUrl: p.baseUrl,
    apiKey: decryptProviderKey(p, getConfig().masterKey),
    extraHeaders: p.extraHeaders ?? null,
  };
}

export interface ConnectionTestResult {
  ok: boolean;
  status: number;
  message: string;
}

/** Lightweight reachability/auth check by listing the provider's models. */
export async function testProviderConnection(p: Provider): Promise<ConnectionTestResult> {
  const up = toUpstreamProvider(p);
  try {
    const res = await getJson(modelsUrl(up), buildHeaders(up), { timeoutMs: 15_000 });
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status, message: "Connection OK" };
    }
    const family = familyForProviderType(p.type);
    return {
      ok: false,
      status: res.status,
      message: `Upstream returned ${res.status} for the ${family} models endpoint. ${shortText(res.text)}`,
    };
  } catch (e) {
    return { ok: false, status: 0, message: e instanceof Error ? e.message : String(e) };
  }
}

function shortText(t: string): string {
  const s = (t ?? "").trim();
  return s.length > 200 ? `${s.slice(0, 200)}...` : s;
}
