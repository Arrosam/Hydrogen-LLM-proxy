# @areelai/model-services

Model Services: a saved step chain (`try model@provider; else the next; else fail`) with per-step retry, backoff and advance triggers, resolved against an `@areelai/supplier-management` catalogue and executed through this package's guarded upstream transport, buffered or streamed. It also owns the SSRF guard with DNS pinning, the egress proxy pool, the OpenAI-shaped media passthroughs (embeddings, images, audio, rerank, video), operator-hosted HTTP tools, and the service-kind registry other packages plug into. It deliberately stores no providers, users or logs, serves no HTTP routes, and treats any definition whose `kind` is not `model_service` as opaque until a package registers a handler for it.

## Install

```
npm install @areelai/model-services @areelai/supplier-management
```

Runtime dependencies: `@areelai/common`, `@areelai/wire-format`, `@areelai/supplier-management`, `drizzle-orm`, `better-sqlite3`, `undici`, `zod`, `ajv`. Node 20 or newer, ESM only.

## Ten-line adoption example

```ts
import crypto from "node:crypto";
import { applyMigrations, openSqlite } from "@areelai/common";
import { buildRequest } from "@areelai/wire-format";
import { createSupplierStores, supplierMigrations } from "@areelai/supplier-management";
import { createModelServiceStores, EgressProxyPool, modelServiceMigrations, ServiceFactory, ServiceValidator, SsrfGuard, UpstreamClient } from "@areelai/model-services";

const masterKey = crypto.randomBytes(32);
const sqlite = openSqlite("./data/hydro.db"); // one file, both packages' tables
applyMigrations(sqlite, supplierMigrations);
applyMigrations(sqlite, modelServiceMigrations);
const supplier = createSupplierStores(sqlite, masterKey);
const stores = createModelServiceStores(sqlite, masterKey);

const p = supplier.providers.create({ name: "openai", type: "openai_completion", baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY });
const m = supplier.models.create({ name: "gpt-4o" });
supplier.mappings.create({ modelId: m.id, providerId: p.id, upstreamModel: "gpt-4o" });

const transport = new UpstreamClient(new SsrfGuard({ allowPrivate: false, allowlist: () => [] }), new EgressProxyPool());
const validator = new ServiceValidator(supplier.catalog, stores.services);
const factory = new ServiceFactory(stores.services, { catalog: supplier.catalog, transport }, 100_000);

const { def, summary } = validator.validate({ steps: [{ model: "gpt-4o", provider: "openai", retry: { maxAttempts: 2 } }] });
const row = stores.services.create({ name: "chat", definition: def });
console.log(summary); // try gpt-4o@openai (retry 2x); else fail

const request = buildRequest("openai_completion", { requestedService: "chat", messages: [{ role: "user", content: [{ type: "text", text: "Say hello" }] }], params: {}, stream: false });
const resolved = factory.resolve("chat");
if (!resolved.ok) throw new Error(resolved.message);
const inv = await resolved.executor.invoke(request);
console.log(inv.result.ok ? inv.result.value.response.text() : `${inv.result.status} ${inv.result.message}`, inv.attempts);
```

## Pieces

- `ServiceValidator.validate(raw)` parses the definition (`parseService`, zod) and checks every `(model, provider)` step against the live catalogue, throwing `ServiceValidationError` with the unmapped pairs. It returns `{ def, summary }`; save `def` with `ServiceRepo.create({ name, description?, definition, enabled? })`. Media categories (`category: "embedding" | "image" | "video" | "tts" | "stt" | "rerank"`) are validated against an OpenAI-shaped endpoint the way the runtime resolves them.
- `ServiceFactory` builds a runnable executor from a saved row (`forRow`), an ad-hoc definition (`buildDef`) or a name (`resolve`), and is the `ServiceResolver` nested kinds use. Its constructor takes the `ServiceRepo`, the `ServiceDeps` (`catalog`, `transport`, optional `simulatedStreamingTokenRate` and `promptCacheTtlMinutes`, each a number or a live getter), the per-call log budget (`logMaxChars`, number or getter) and an optional `HostedToolRepo` to wrap executors in `HostedToolService` when tools are bound.
- `ModelService.invoke(request, overrides?, opts?)` runs the chain buffered and returns an `Invocation` (`result`, `attemptPath`, `attempts`); `stream(...)` returns a `StreamInvocation` whose `result.value.events` is the committed upstream stream, or a fabricated paced stream when `reliableStreaming` is on. `InvokeOptions` carries `signal`, `timeoutMs` and a `ProgressSink`. Precedence is caller override, then step `overrides`, then the client's own params.
- `UpstreamClient` is the `Transport` (`postJson`, `postStream`, `postRaw`, `getStream`, `getJson`). `SsrfGuard({ allowPrivate, allowlist })` rejects non-HTTP schemes and private, loopback and link-local addresses unless allowlisted, and the client pins each connection to the addresses that passed, closing the DNS-rebinding window. `EgressProxyPool` caches one undici `ProxyAgent` per distinct proxy and validates the proxy host the same way; `closeAll()` on shutdown.
- `sendBuffered(req, transport, target)` and `relayStream(req, transport, target)` are the wire round-trip under every step (`SendTarget`: `upstreamModel`, `url`, `headers`, `timeoutMs`, `signal`, `proxy`). `runSteps` is the retry and fallback engine (`DEFAULT_RETRY_ON`, `computeRetryDelay`, `classifyError`).
- `HostedToolRepo` stores `HttpTool` definitions with their auth headers encrypted under the master key; `runHostedTools` and `HostedToolService` execute the tool loop for a service.

## The kind registry

A step chain (`kind: "model_service"`, or no `kind`) is the one definition this package understands. Any other kind is stored in the same `model_services` table under its own `kind` and is handled by whoever registered it:

```ts
import { registerServiceKind, registeredKinds, type ServiceKindHandler } from "@areelai/model-services";
registerServiceKind(handler); // a ServiceKindHandler: kind, aliases?, parse, category, summarize, references, validate, build
console.log(registeredKinds()); // ["model_service", ...]
```

Until a handler is registered, `parseService`, `ServiceValidator.validate`, `ServiceRepo.def` and `ServiceFactory.forRow` throw `UnknownServiceKindError` with the message `unknown service kind "micro_agent"` for a Micro Agent row. Installing `@areelai/micro-agent` and calling its `registerMicroAgentKind()` once at startup is what makes such rows parse, validate and run; nothing in this package imports that package.

## What it stores

Tables: `model_services` (name, `kind`, `definition_json`, enabled), `hosted_tools` and `service_tools` (`MODEL_SERVICE_TABLES`). The migrations are embedded in `modelServiceMigrations` and recorded in this package's own bookkeeping table `__migrations_model_services`, so the tables can share one SQLite file with `@areelai/supplier-management`, `@areelai/user-management` and `@areelai/micro-agent`. Step definitions reference models and providers by name, not by foreign key. `openModelServiceStores({ file, masterKey })` opens a private file for this package alone; the example above uses `createModelServiceStores(sqlite, masterKey)` on a shared connection instead.

## Swapping the store

`PublicApi<T>` is the public surface of a repository class. `ServiceStore` is `PublicApi<ServiceRepo>` and `HostedToolStore` is `PublicApi<HostedToolRepo>`: what a custom implementation must provide. `ServiceValidator` needs only the `ServiceLookup` slice (`getByName`, `def`).

## License

MIT
