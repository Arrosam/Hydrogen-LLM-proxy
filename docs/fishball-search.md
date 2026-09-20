# Fishball hosted search v1

This extends `runHostedTools`, `HttpToolSchema`, and `ResponsesController`; it is
not a second agent framework. Deploy this server before the matching Fishball
Android client. The normal `/v1/messages` contract is unchanged for old clients.

## Operator setup

Create a hosted tool with the authenticated admin hosted-tool API (the same
`/admin/api/tools/` API used by the dashboard), then bind its ID to each Fishball
chat service using the existing service `toolIds` setting at `/admin/api/services/:id`. Example configuration:

```json
{
  "name": "fishball_search",
  "description": "Fishball SearXNG search",
  "parameters": {"type": "object"},
  "url": "https://search.example.org/search",
  "headers": {"X-FishBall-Token": "SET_SERVER_SIDE_ONLY"},
  "bodyTemplate": {},
  "timeoutMs": 30000,
  "maxResultBytes": 1048576,
  "enabled": true,
  "adapter": {"kind": "fishball_search_v1", "rerankTool": "fishball_rank"}
}
```

The URL must include `/search`; JSON search must be enabled in SearXNG. Headers
are encrypted by the existing HostedToolRepo and never included in client
responses. Network access uses Hydrogen's existing DNS-pinned, SSRF-checked GET
transport. Configure the deployment's existing upstream host/private-network
allowlist if the SearXNG instance is private. Do not bypass the guard.

Optional ranker: create and bind a second ordinary HTTP tool called
`fishball_rank`. Its URL targets the existing reranking service, its encrypted
headers authenticate there, `resultPath` is `/results`, and its body template is:

```json
{"model":"YOUR_RERANK_MODEL","query":"{{arguments.query}}","documents":"{{arguments.documents}}"}
```

The ranker is not offered as a model tool. Its timeout is capped at eight seconds;
missing/unavailable ranking retains engine order, matching Fishball's previous
behavior. Omit `rerankTool` only on deployments without a reranker. Do not point
it back at the chat endpoint. Bind both IDs via the chat service's `toolIds`.
Do not set `serverTool` on these bindings: the compact product contract replaces
full provider-executed tool-result replay.

Only the dedicated contract activates this adapter. Bind it at the top-level
Fishball chat services (flash and pro), not to nested Micro Agent stages or the
memory/system service. Existing non-search hosted bindings are not executed on
the Fishball endpoint. Other clients and endpoints keep their ordinary behavior.

## Wire contract

`POST /v1/fishball/messages`, authenticated and quota-checked with the existing
client key, accepts Anthropic messages with:

```json
{"hydrogen":{"search":"fishball_search_v1"},"stream":true}
```

It requires a compatible search binding even on a turn that does not search.
Unknown versions return 400; missing binding returns 409; unauthorized keys are
rejected before model/search execution. This dedicated endpoint makes an old
server fail with 404 rather than ignore an unknown feature flag. No capability
probe round trip is needed. The first SSE event acknowledges the exact contract:

```json
{"type":"hydrogen.session","search":"fishball_search_v1","response_id":"resp_..."}
```

Search accepts up to five Unicode queries, optional language (default `zh-CN`),
categories, `time_range` (`day`, `month`, `year`) and page (1–100). The adapter
sends `format=json`, `safesearch=1`, and a browser-compatible user agent. Each query
has one total timeout across at most two attempts; only connection errors and
429/502/503/504 retry, with a cancellable 100 ms delay. Unauthorized, malformed and
oversized responses are not retried. All response streams are destroyed on every
exit; disconnect aborts search and the hosted model loop.

The loop emits `hydrogen.search.started`, then one compact `hydrogen.search`
record per tool call: `id`, aggregate `status`, per-query status/engine errors and
ranking mode, and selected `hits`. Raw engine fields and internal traces stay on
the server. Snippets (maximum 2,000 characters) are needed for the client's
existing quotation verifier. URL, title, engine and account preserve source
opening, publisher-first trust and source history. At most 30 hits per call are
returned after ranking/interleaving; no server credentials are returned.

`success` is usable results, `empty` is healthy zero results, `degraded` includes
partial engine/query failure, and `failed` means all queries failed. Missing or
malformed results are never normalized to empty. A wholly failed search aborts
the response before another model answer; the client must display the failure,
never substitute model knowledge. A degraded result instructs the model to
state its limitation and is separately narrated by the client.

The explicit final `answer` tool streams live as normal Anthropic block events.
A model that requests more work after committing that final tool fails the turn.
Plain prose and mixed local-tool batches are buffered until their round finishes;
intermediate research text and tool arguments do not leak into the answer.
Final content is not repeated in a second response envelope. The completion event
contains only `response_id` and the contract version. A truncated stream, failure
event or absent completion must not be accepted as a completed hosted turn.

Page reading, local log lookup and quotation checking stay on the phone. Their
calls may cross the protocol; search calls/results never do. The client continues
with only new local tool results and `hydrogen.previous_response_id`. Responses
storage, token ownership, retention, cancellation and bounded event buffering are
reused. A continuation with another model/contract, expired ID or foreign key
fails. Configure normal Responses retention to cover active turns; history is
persisted server-side rather than retransmitted from the phone.

## Rollout and verification

1. Deploy Hydrogen; configure and bind search/ranking to both chat models.
2. Exercise success, empty, degraded and failed search with a deployment test key.
   Check that the search service only sees server requests.
3. Distribute the new client. Legacy clients retain their old search path during
   rollout; retain their endpoint until those clients retire.
4. Stop putting SearXNG URL/credentials into profiles. New clients discard legacy
   fields and re-encode stored custom profiles. New profiles are not compatible
   with old clients; keep legacy activation codes separately for APK rollback.
5. Rotate retired mobile search credentials and restrict search ingress to the
   server once old clients are retired.

The checked-in `server/src/execution/fishball-source-tiers.json` is Fishball's
`data/source-tiers.json` version 5. Synchronize it whenever that policy changes.
Model annotations use its default-context domain/platform/account rules; the
Android resolver remains authoritative for UI tiering, scope rules and quotes.

Run `npm run typecheck`, `npm run typecheck --workspace web`, `npm test`, and
`npm run build`. Protocol/integration tests are in `responsesController.test.ts`;
adapter regressions are in `fishballSearch.test.ts`. The one-search traffic
fixture prints actual encoded byte counts and asserts that the mobile search leg
and second model request disappear. This is a deterministic fixture, not a
production latency or compression benchmark.
