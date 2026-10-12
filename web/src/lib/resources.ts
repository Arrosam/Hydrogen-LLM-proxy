import { api } from "../api";
import { API } from "./endpoints";
import type { HostedTool, Mapping, Model, ModelService, Provider, ProviderModels, Proxy, Token, User } from "../types";

/**
 * Typed list fetchers: each names its endpoint and unwraps its response
 * envelope, so a page asks for "the providers" rather than spelling both.
 */

export const fetchServices = (): Promise<ModelService[]> => api.get<{ services: ModelService[] }>(API.services).then((r) => r.services);
export const fetchModels = (): Promise<Model[]> => api.get<{ models: Model[] }>(API.models).then((r) => r.models);
export const fetchProviders = (): Promise<Provider[]> => api.get<{ providers: Provider[] }>(API.providers).then((r) => r.providers);
export const fetchMappings = (): Promise<Mapping[]> => api.get<{ mappings: Mapping[] }>(API.mappings).then((r) => r.mappings);
export const fetchProviderModels = (): Promise<ProviderModels[]> =>
  api.get<{ providerModels: ProviderModels[] }>(API.providerModels).then((r) => r.providerModels);
export const fetchTokens = (): Promise<Token[]> => api.get<{ tokens: Token[] }>(API.tokens).then((r) => r.tokens);
export const fetchProxies = (): Promise<Proxy[]> => api.get<{ proxies: Proxy[] }>(API.proxies).then((r) => r.proxies);
export const fetchTools = (): Promise<HostedTool[]> => api.get<{ tools: HostedTool[] }>(API.tools).then((r) => r.tools);
export const fetchUsers = (): Promise<User[]> => api.get<{ users: User[] }>(API.users).then((r) => r.users);

/**
 * Run several fetchers at once and return their results under the same keys:
 * `loadAll({ models: fetchModels, providers: fetchProviders })`. Requests go
 * out in key order; any failure rejects the whole load.
 */
export async function loadAll<S extends Record<string, () => Promise<unknown>>>(
  sources: S,
): Promise<{ [K in keyof S]: Awaited<ReturnType<S[K]>> }> {
  const keys = Object.keys(sources);
  const values = await Promise.all(keys.map((k) => sources[k]()));
  return Object.fromEntries(keys.map((k, i) => [k, values[i]])) as { [K in keyof S]: Awaited<ReturnType<S[K]>> };
}
