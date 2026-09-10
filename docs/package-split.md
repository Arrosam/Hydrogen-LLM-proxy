# Package split: requirements

Status: SIGNED OFF 2026-09-10, BUILT 2026-09-11 on branch `package-split`. npm scope is `@areelai` (org created by the user). Defaults accepted: `hydro.db`, import everything, gateway on Docker only. Version number still open: the manifests carry 2.0.0 until the release is named.

## Problem

Hydrogen is one process, one schema, one image. A developer who wants only the wire-format
translation, or only the retry/fallback chain, or only supplier management, has to take all of it:
Fastify, SQLite, the dashboard, the migrations. Nothing is adoptable in isolation, and the console
cannot be left out.

## Decisions already made

| Question | Decision |
|---|---|
| What is a "service" | An npm package with a public interface and its own tests. One gateway app composes them into today's single container. No separate processes, no network RPC between packages. |
| Persistence | Each package ships its own tables, migrations and default SQLite store behind a store interface. All packages share one database file in the gateway. Adopters pass a data directory and a master key and it works. |
| Request/response adapter | One package, `@areelai/wire-format`, pure translation. Request and response are separate entry points of the same package. The upstream round-trip moves out of the format classes into model-services. |
| Model services | Reads supplier data and sends/receives every request type: chat, image, video, TTS, STT, embeddings, rerank. Owns the upstream transport, SSRF guard, egress proxy pool and hosted-tool loop. |
| Console | Optional GUI over the admin API. The backend is fully usable by API calls alone. |
| Admin auth | `/admin/api/login` also returns the session JWT in the body; `Authorization: Bearer <jwt>` is accepted wherever the cookie is. Cookie login stays. |
| Upgrade from v2.0.0 | Automatic. A legacy database is detected at boot and its data is copied into the new database. The old file is kept untouched. |
| Publishing | Every package under the npm scope `@areelai`, versions in lockstep. |

## Package map

| Package | Owns (code today) | Owns (tables) | Depends on |
|---|---|---|---|
| `@areelai/common` | `security/crypto`, `util/ids`, `util/time`, `util/validate`, SQLite open + per-package migration runner | none | nothing |
| `@areelai/wire-format` | `core/ir/*`, `core/format/*` minus `send`/`relay`, `core/proxy/errors` | none | nothing |
| `@areelai/supplier-management` | `persistence/{provider,proxy,providerModel,model,mapping}Repo`, `catalog/*`, `security/{providerKeys,proxySecret}`, `core/upstream/endpoints`, the egress-proxy type | `proxies`, `providers`, `provider_available_models`, `models`, `model_providers` | common, wire-format (a provider is typed by the wire family it speaks; wire-format has no dependencies of its own) |
| `@areelai/model-services` | `execution/{definition,modelService,steps,outcome,serviceCall,serviceFactory,serviceValidator,fileFetch,toolHttp,toolSchema,hostedToolLoop,hostedToolService}`, `core/upstream/*` incl. `roundtrip`, media passthrough execution from `mediaController`, `persistence/{service,hostedTool}Repo` | `model_services`, `hosted_tools`, `service_tools` | common, wire-format, supplier-management |
| `@areelai/micro-agent` | `execution/{microAgent,agentContext,ocrCache,asr}`, `persistence/imageCacheRepo` | `image_cache` | model-services |
| `@areelai/user-management` | `auth/*`, `persistence/{user,token}Repo`, `security/{passwords,tokens}`, `observability/usageMeter`, Key Check logic | `users`, `tokens` | common |
| `@areelai/gateway` (app) | `app.ts`, `index.ts`, `config`, `composition`, all `transport/*` routes and controllers, `observability/{requestLogger,activeRequests,progressRecorder,redactor}`, `persistence/{requestLog,settings,response}Repo`, stats, `logPruner`, `backup/*`, `update/*`, `security/masterKey` | `settings`, `request_logs`, `response_conversations`, `conversation_items`, `stored_responses`, `response_events` | every package |
| `@areelai/console` (app) | `web/*` | none | gateway HTTP API only |

Rules of the map:

- A package never imports another package's tables or repos. It calls the other package's public interface.
- A Micro Agent definition is stored in `model_services` with `kind = micro_agent`. model-services treats the definition as opaque and asks a registered kind handler to parse and build it. micro-agent registers that handler. Without micro-agent installed, a `micro_agent` row is rejected with "unknown service kind".
- References that cross a package line are plain ids, not foreign keys: `tokens.scope_services`, `request_logs.token_id/service_id`, `stored_responses.token_id/service_id`. Each cascade that used to cross a line becomes an explicit call in the gateway: deleting a token deletes its stored responses and conversations.
- Model discovery and the provider test live in supplier-management and take an HTTP fetcher interface. The gateway injects model-services' guarded transport as that fetcher.
- Executors report progress through an interface declared in model-services; the gateway's active-request registry implements it.
- Deviation recorded while building: `endpoints` (URL and header building for a materialized provider) and the egress-proxy type live in supplier-management, not model-services, because the catalogue materializes targets with them and model-services depends on supplier-management, not the other way round. model-services still owns the transport, the SSRF guard, the proxy dispatcher pool and the round-trip.
- Settings stay one key/value table in the gateway. Packages receive getters, as they do today.
- `server/legacy/` is deleted. It moves into no package.

## Behavior

1. A fresh project that installs only `@areelai/wire-format` can parse an Anthropic Messages request into the canonical form and render it as OpenAI Chat, and serialize an OpenAI stream as Anthropic events. Its `node_modules` contains no fastify, undici or better-sqlite3.
2. A fresh project that installs only `@areelai/supplier-management` can create a provider with an API key, map a model to it, and resolve `model@provider` to an upstream id and base URL. The key is ciphertext in the package's SQLite file, decryptable only with the master key the adopter passed.
3. A fresh project that installs `@areelai/model-services` and `@areelai/supplier-management` can run a Model Service step chain against a real upstream, with retry and fallback, streaming or buffered. Adding `@areelai/micro-agent` and registering it makes `micro_agent` definitions runnable.
4. A fresh project that installs only `@areelai/user-management` can create dashboard users, issue and verify sessions, issue client API keys with scopes and quotas, and verify a key from an `Authorization` header.
5. The gateway exposes exactly today's HTTP contracts: `/v1/*`, `/admin/api/*`, `/healthz`, same request and response bodies. Every existing test keeps its assertions; tests move into the package that owns the code under test.
6. Upgrade: at boot, if `DATA_DIR/hydrogen.db` exists and `DATA_DIR/hydro.db` does not, the gateway creates `hydro.db`, applies every package's migrations, copies every row of every table from the legacy file verbatim, records the import in the new database, and starts. `hydrogen.db` and `hydrogen-secrets.json` are left byte-for-byte unchanged. If `hydro.db` already exists, the legacy file is ignored and one log line says so. Rolling back is running the previous image on the same volume.
7. A v2.0.0 backup file restores on the new version. Restore routes each table to its owning package's store.
8. `POST /admin/api/login` returns `{ user, token }`. A request carrying `Authorization: Bearer <token>` is authorized exactly as one carrying the session cookie, with the same TTL and the same restore-time invalidation.
9. Images: the all-in-one image is today's image, gateway plus console, unchanged for Rainyun. Two more tags ship: an API-only gateway image, and a console image that serves the dashboard and forwards `/admin/api`, `/v1` and `/healthz` to `BACKEND_URL`. The console container therefore works on a hostname of its own with no auth or CORS change.
10. Publishing: every package carries the same version and is published to npm under `@areelai` from a tag build in GitHub Actions. Each package has a README with a ten-line adoption example.

## Non-goals

- No separate processes or network RPC between packages. One-container deploy remains the product.
- No store implementation other than SQLite. The interface exists so an adopter can write one.
- No CORS and no CDN hosting of the console without the console container.
- No long-lived admin API keys.
- No change in translation, retry, streaming, agent or tool behavior. This is a re-homing, and the test suite is the proof.
- No product rename in this stream. Package names carry no product name, so the later Hydro AI station rename does not touch them.

## Done when

1. Behaviors 1 to 4 each pass as a script run in an empty directory against the published packages.
2. The all-in-one image started on a copy of a real v2.0.0 `/data` volume boots, imports, serves the same answer to the same client key for the same Model Service name, and the SHA-256 of `hydrogen.db` is identical before and after. A v2.0.0 backup file restores on it.
3. `curl -H "Authorization: Bearer <token from /login>" /admin/api/providers` returns 200.
4. A console container with `BACKEND_URL` pointing at an API-only gateway container logs in and edits a provider.
5. Root `npm test` runs every package's suite and is green: 59 files, 980 tests as of v2.0.0, plus new tests for the import, the bearer path and the kind-handler rejection.

## Open

- **Version number** and whether this ships as the v2.0.0b "Hydro AI station" release. The user names versions.
- **New database filename.** `hydro.db` is proposed.
- **Import scope.** The proposal copies everything, including `request_logs`, which doubles disk use until the operator deletes the legacy file and can take minutes on a large log. Alternative: copy configuration and history but leave logs behind.
- **npm org.** `@areelai` must exist on npmjs.com before the first publish. Availability could not be checked anonymously.
- **Gateway on npm.** Proposal: Docker only, not published to npm.
