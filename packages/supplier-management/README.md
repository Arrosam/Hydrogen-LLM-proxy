# @areelai/supplier-management

Providers (upstream API endpoints), egress proxies, the model ids a provider reports, the internal model catalogue and the model-to-provider mappings, stored in this package's own SQLite tables with every API key and proxy password encrypted at rest. `Catalog.resolve` turns a `(model, provider)` pair into a concrete upstream target: URL, headers carrying the decrypted key, upstream model id, wire family and any egress proxy. It deliberately makes no network calls of its own: model discovery and the provider connection test take an HTTP fetcher interface from the caller, and sending requests is the job of `@areelai/model-services`.

## Install

```
npm install @areelai/supplier-management
```

Runtime dependencies: `@areelai/common`, `@areelai/wire-format` (for the `Family`/`ProviderType` identity only), `drizzle-orm`, `better-sqlite3`. Node 20 or newer, ESM only.

## Ten-line adoption example

```ts
import crypto from "node:crypto";
import { openSupplierStores } from "@areelai/supplier-management";

const masterKey = crypto.randomBytes(32); // persist this; without it no stored key can be decrypted
const stores = openSupplierStores({ file: "./data/hydro.db", masterKey });

const provider = stores.providers.create({ name: "openai", type: "openai_completion", baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY });
const model = stores.models.create({ name: "gpt-4o", description: "flagship chat model" });
stores.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "gpt-4o-2024-08-06" });

const res = stores.catalog.resolve("gpt-4o", "openai");
if (res.ok) console.log(res.target.url, res.target.upstreamModel, res.target.headers.authorization);
stores.close();
```

`res.target` is a `ResolvedTarget`: `family`, `upstreamModel`, `url` (`/chat/completions`, `/v1/messages` or `/responses` under the provider's base URL, by family), `headers` (auth already applied by `buildHeaders`), `providerMaxOutputTokens`, `modelName`, `providerName`, `providerId`, `endpointIndex` and the materialized `upstream: UpstreamProvider`. On failure `res.error` is one of `model_not_found`, `provider_not_found`, `mapping_not_found`, `model_disabled`, `provider_disabled`, `mapping_disabled`. A provider may declare `altEndpoints` in other families and a mapping may enable them through `families`; `resolve(model, provider, preferredFamily)` picks a same-family endpoint when it can, and `resolveWithin(model, provider, allowedFamilies)` narrows to a set (adding the `no_endpoint_in_family` error). `MEDIA_FAMILIES` is the OpenAI-shaped pair the embeddings, image, audio, rerank and video routes need.

## Keys at rest

`ProviderInput.apiKey` is plaintext on the way in and is stored as AES-256-GCM ciphertext in `key_ciphertext`, `key_iv` and `key_tag` under the caller's 32-byte master key (`encryptProviderKey`). `ProviderRepo.toPublic(row)` exposes only `hasKey`; `ProviderRepo.toUpstream(row)` decrypts for a call and attaches the provider's `EgressProxy`, if any. Proxy passwords use the same scheme (`encryptProxyPassword` / `decryptProxyPassword`, `ProxyRepo`). The package never writes the master key anywhere.

## Sharing a connection

`openSupplierStores({ file, masterKey })` opens its own file and applies the migrations. To share one already-open, already-migrated connection with other packages, run `applyMigrations(sqlite, supplierMigrations)` from `@areelai/common` yourself and call `createSupplierStores(sqlite, masterKey)`; it returns the same `SupplierStores` (`db`, `proxies`, `providers`, `providerModels`, `models`, `mappings`, `catalog`) without `sqlite` or `close`.

## Model discovery

`discoverModels(transport, upstreamProvider, timeoutMs?)` GETs the provider's models endpoint (`modelsUrl`) and returns `{ ok, status, message, models }`; a readable list doubles as the provider connection test. `transport` is any `ModelListTransport`:

```ts
import { discoverModels, type ModelListTransport } from "@areelai/supplier-management";

const transport: ModelListTransport = {
  async getJson(url, headers, { timeoutMs }) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json: unknown; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, text };
  },
};
const found = await discoverModels(transport, stores.providers.toUpstream(provider));
console.log(found.ok, found.message, found.models.length);
```

This fetcher ignores `opts.proxy` and does no address checking. `UpstreamClient` from `@areelai/model-services` satisfies the same interface, honours the proxy and runs its SSRF guard; the gateway injects it. `parseModelList(json)` is the lenient reader behind `models` (`data[].id`, `models[]`, bare arrays, plain strings). `ProviderModelRepo` caches the reported ids in `provider_available_models`.

## What it stores

Tables: `proxies`, `providers`, `provider_available_models`, `models`, `model_providers` (listed parents-first in `SUPPLIER_TABLES`). The migrations are embedded in `supplierMigrations` and recorded in this package's own bookkeeping table `__migrations_supplier_management`, so these tables can live in one SQLite file next to those of `@areelai/user-management`, `@areelai/model-services` and `@areelai/micro-agent`. Foreign keys stay inside the package: deleting a provider cascades to its mappings and cached model list; deleting a proxy sets the provider's `proxy_id` to null.

## Swapping the store

`PublicApi<T>` is the public surface of a repository class. `ProviderStore`, `ProxyStore`, `ProviderModelStore`, `ModelStore` and `MappingStore` are `PublicApi<ProviderRepo>`, `PublicApi<ProxyRepo>`, `PublicApi<ProviderModelRepo>`, `PublicApi<ModelRepo>` and `PublicApi<MappingRepo>`: what a custom implementation must provide. A custom backend hands its instances to `new Catalog(models, providers, mappings)`; nothing else in the package touches SQLite.

## License

MIT
