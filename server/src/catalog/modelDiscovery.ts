import { buildHeaders, modelsUrl, type UpstreamProvider } from "../core/upstream/endpoints";
import { familyForProviderType } from "../core/format/family";
import type { TransportJsonResult, TransportOptions } from "../core/upstream/transport";

/** The slice of the transport model discovery needs (a plain GET). */
export interface ModelListTransport {
  getJson(url: string, headers: Record<string, string>, opts: TransportOptions): Promise<TransportJsonResult>;
}

export interface ModelDiscovery {
  ok: boolean;
  /** Upstream HTTP status, or 0 when the request never completed. */
  status: number;
  /** Human-readable outcome — shown verbatim by the dashboard on failure. */
  message: string;
  models: string[];
}

/** Upper bound on how many ids we keep from one response. A gateway fronting
 * every model on the internet must not be able to write an unbounded list. */
export const MAX_DISCOVERED_MODELS = 2000;

/** Longest model id we keep; anything past this is not a real model id. */
export const MAX_MODEL_ID_LENGTH = 200;

const DISCOVERY_TIMEOUT_MS = 15_000;

/** The array of entries in a /models response, whichever shape it arrived in. */
function entriesOf(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;
  // OpenAI and Anthropic both use `data`; several self-hosted gateways use `models`.
  for (const key of ["data", "models"]) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }
  return [];
}

/** The id of one entry: a bare string, or the first id-ish field of an object. */
function idOf(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return null;
  const obj = entry as Record<string, unknown>;
  for (const key of ["id", "name", "model"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/**
 * Pull the model ids out of a /models response. Deliberately lenient: providers
 * agree on `data[].id` but plenty of OpenAI-compatible gateways answer with a
 * bare array, a `models` key, or plain strings, and a list we can't read makes
 * the picker useless. Order is preserved (providers tend to send their own
 * ranking) and duplicates dropped.
 */
export function parseModelList(json: unknown): string[] {
  const seen = new Set<string>();
  for (const entry of entriesOf(json)) {
    const id = idOf(entry)?.trim();
    if (!id || id.length > MAX_MODEL_ID_LENGTH || seen.has(id)) continue;
    seen.add(id);
    if (seen.size >= MAX_DISCOVERED_MODELS) break;
  }
  return [...seen];
}

/**
 * Ask a provider what it serves. This is also the provider connection test:
 * reaching the models endpoint exercises the base URL, the key and the extra
 * headers in one call, so a readable list is proof the provider is usable.
 */
export async function discoverModels(
  transport: ModelListTransport,
  provider: UpstreamProvider,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<ModelDiscovery> {
  const family = familyForProviderType(provider.type);
  try {
    const res = await transport.getJson(modelsUrl(provider), buildHeaders(provider), { timeoutMs });
    if (res.status < 200 || res.status >= 300) {
      const text = (res.text ?? "").trim();
      const short = text.length > 200 ? `${text.slice(0, 200)}...` : text;
      return {
        ok: false,
        status: res.status,
        message: `Upstream returned ${res.status} for the ${family} models endpoint. ${short}`.trim(),
        models: [],
      };
    }
    const models = parseModelList(res.json);
    return {
      ok: true,
      status: res.status,
      message: models.length
        ? `Connection OK — ${models.length} model${models.length === 1 ? "" : "s"} reported.`
        : "Connection OK, but the models endpoint reported no models.",
      models,
    };
  } catch (e) {
    return { ok: false, status: 0, message: e instanceof Error ? e.message : String(e), models: [] };
  }
}
