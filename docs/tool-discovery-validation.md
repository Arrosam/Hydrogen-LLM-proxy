# HYD-TOOL-DISCOVERY contract and local validation

## Endpoint and client contract

`/v1/services/:serviceName/mcp` exposes read-only MCP discovery for one existing enabled Model Service or Micro Agent. Use its URL with an existing Hydrogen Key authorized for that target in `Authorization: Bearer <existing-key>` or `x-api-key`. No credential provisioning is added. The Key is rechecked on every HTTP request and at list dispatch; it establishes service access, not end-user identity or consent. An otherwise valid exhausted inference budget does not prevent this read.

The official `@modelcontextprotocol/sdk@1.32.0` implements stateless Streamable HTTP with JSON responses. Initialize normally, send the initialized notification, then request `tools/list`; use returned `nextCursor` until absent. `ping` is supported. The only advertised capability is `tools` with `listChanged: false`. A new disposable protocol server/transport is created for each POST; there is no session ID, discovery snapshot or server-push stream. The tested native SDK client tolerates authenticated GET returning 405 while attempting its optional stream.

Example for an existing caller's process (never save its actual Key in source):

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "catalog-query", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(discoveryUrl, {
  requestInit: { headers: { Authorization: `Bearer ${existingKey}` } },
}));
let cursor: string | undefined;
do {
  const page = await client.listTools(cursor ? { cursor } : undefined);
  // Inspect these definitions only; every entry is discovery-only.
  console.log(page.tools);
  cursor = page.nextCursor;
} while (cursor);
await client.close();
```

All well-formed `tools/call` requests fail with MCP `MethodNotFound` (`-32601`), including known and unknown names. Malformed call/list parameters fail with `InvalidParams` (`-32602`). No handler can execute a business tool, wrap/invoke a model, probe an upstream, add an inference tool/context, reserve quota or persist Responses/conversation/request-log records. Ordinary clients can ignore custom metadata and attempt calls: the actual SDK did so in validation and the endpoint rejected them. This is a listing-compatible interface, not a complete callable MCP server.

HTTP behavior: one JSON-RPC message per POST, 65,536-byte body limit, SDK validation of JSON/Accept/protocol headers, bodyless 202 for an initialized notification. Arrays are rejected with HTTP 400 / `InvalidRequest` before SDK dispatch because SDK v1 retains legacy batch support. Authorized GET/DELETE return 405 with `Allow: POST`. Origin-bearing requests return 403; browser/CORS access is unsupported. Replies use `Cache-Control: no-store`; successful hijacked protocol replies also use `X-Content-Type-Options: nosniff`. HTTP authentication failures use sanitized MCP errors: 401 / `-32001` for invalid/expired/disabled Keys, 403 / `-32003` for target-scope denial, and 404 / `-32004` for missing/disabled targets. Provider inference error envelopes are never used.

## Directory semantics

Each list/page reads the latest persisted target definition, relevant referenced definitions and bound enabled tool definitions. It unions all contributing Model Service steps and named/inline/nested Micro Agent stages. A step's explicit policy replaces the service mode/list together; otherwise it inherits, with empty blacklist as the default. Matching remains exact names only. `tools: none` excludes the stage and descendants' tool contributions but does not conceal invalid references. Model Services in non-chat media categories offer no client-declarable tools; OCR remains a chat pipeline. Broken/disabled/non-chat references, malformed definitions/schemas, cycles and excessive nesting fail explicitly.

Known entries retain the downstream `serverTool.name`, original description (with a discovery warning appended), and a clone of the existing saved `parameters` object as `inputSchema`. The new repository projection reuses `HttpToolSchema` fields and never selects/decrypts saved adapter header secrets or constructs execution adapters. Disabled/unbound tools and tools lacking a declaration contract are omitted. No internal generated provider prefix, adapter URL/template, internal prompt, model/provider identity or graph topology is returned. Saved public descriptions and schemas are intentionally exposed and should contain only the operator's intended public contract.

An exact whitelisted name bypasses a local equivalent and becomes admin-declared upstream availability, without probing. Its schema is the owner-approved format placeholder `{ "type": "object", "additionalProperties": true }`. Description and `_meta["hydrogen/discovery"]` state that the real schema is unknown, discovery-only, unprobed, non-executable and not a validated/callable contract. Every known entry is also marked discovery-only and non-executable. Blacklist-permitted unknown upstream names cannot be enumerated; result metadata sets `mayOmitUnknownUpstreamTools` and includes a warning. These disclosures do not claim that every agent application will display or honor them.

Identical known identity/definition and repeated identical upstream declarations are deduplicated. Successful catalogs have unique names. Actual schema invariants permit different tools to share a downstream alias. For example, operator tools `search_a` with `{query:string}` and `search_b` with `{term:string}` can both declare `web_search` in different stages; a local `web_search` in one stage can also collide with an upstream whitelist declaration in another. The owner was asked for disposition. Current bounded behavior is a sanitized `InternalError` with `data.reason: "catalog_conflict"`; no rename or lossy schema replacement is invented. This product decision remains pending.

Names sort deterministically in ASCII order, 100 entries per page. The cursor contains a validated offset and HMAC, bound to the authorized Key and target using the existing session secret; it discloses neither internal ID. It is bounded, canonical, tamper checked and rejects replay under another Key/target. Every cursor request rereads current configuration. Owner-accepted edits may cause duplicate/omitted entries, and a shrinking catalog may yield an empty later page. No snapshot recovery or compensation exists. Existing inference-session frozen policy semantics and execution code are unchanged.

## Environment and dependency inspection

Worktree `/Users/samuel/Documents/Codex/2026-10-04/task/hydrogen-tool-discovery`, branch `codex/hydrogen-tool-discovery`, dependency base `8c12ff24b72767bcc7b0438a4091c36e7ecddccc`. The explicit owner base supersedes the workflow's usual fresh-main baseline. The ticket/AC commit precedes implementation (`d35d7c2b6b5e9c09c3b5acad985cd9c35901a433`). The UI selector `bd779fa9f19894950ff743bcf86eb3ff84b4af93` is not an ancestor. Runtime: Darwin arm64, Node `v22.22.2`, npm `10.9.7`.

The committed base lockfile was installed independently with `npm ci --ignore-scripts` after package-source/lifecycle review, followed by the reviewed native rebuilds (argon2, better-sqlite3, esbuild). No other checkout's node_modules were reused. SDK v1/v2 package engines, dependencies and source were inspected before the exact v1 dependency was added. The official [v1 SDK documentation](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x) describes its maintained support window. It fits the existing Zod 3.25.76 dependency without a Zod 4 migration; SDK v2 would broaden this change and protocol/version certification. This implementation was validated against v1's 2025-11-25 protocol, not certified for the newer 2026 SDK v2 protocol.

The lockfile adds 69 entries, changes no existing package versions, uses only `registry.npmjs.org`, and adds no lifecycle-script entries. The SDK install was performed with scripts disabled, reviewed, then reproduced via `npm ci` and reviewed native rebuilds. Base lock SHA-256: `3df96a79c6d76560baa49560f2884b7f3b61a6b39cf1be22e4dfab4c3194c2d2`; final: `53f6a62f552bcc1b641716d68b568050203d52c482d155345c4670d5000c99f3`.

`npm audit --json` exits 1 on both base and feature. The complete vulnerability objects are identical: five high findings in the existing braces/chokidar/fast-glob/micromatch/tailwindcss chain, including [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). No new SDK finding was introduced. Existing Tailwind remediation is outside this ticket. The sanitized tracked [gate evidence](qa/HYD-TOOL-DISCOVERY/gates.json) records the comparison and command outcomes; raw local logs remain in `/tmp/hydrogen-discovery-evidence` and are not required to understand the result.

## AC evidence and risk techniques

| AC | Evidence | Result / practical limit |
| --- | --- | --- |
| AC1 Key/target | HTTP tests for missing/invalid/disabled/expired Keys and missing/disabled/unauthorized targets; actual SDK revocation and root-versus-child target; cross-Key/target cursor tests | Pass. Existing auth reused; exhausted valid Key permitted without inference quota. |
| AC2 MCP transport | Official `Client` + `StreamableHTTPClientTransport` initialize/notification/ping/list/pages/rejected calls; raw HTTP malformed-envelope/parameter/Accept/version/body/method tests | Pass. Native listing compatibility validated; no complete callable MCP server or browser support. |
| AC3 effective union | Eight-case policy decision table; whole step replacement, all fallback steps, later inline/named/nested stages, inherited bindings and tools-disabled descendants | Pass. Existing names-only policy preserved. |
| AC4 definitions | Persisted rich draft-7 nested/local-ref schema deep equality through actual SDK; original downstream names/descriptions; unknown schema placeholder and warning assertions | Pass. Placeholder shape valid for listing; real upstream schemas/availability unverified. |
| AC5 identity | Same-identity dedup, repeated upstream dedup, conflicting identity/schema and local-versus-upstream errors | Tested. Explicit-conflict product disposition pending owner decision. |
| AC6 live pages | 0/1/99/100/101/200/201 boundaries; stable full traversal; cursor syntax/length/canonicality/tamper/rotation/binding; current schema/policy/binding/enable changes, accepted edit duplicates/omissions | Pass. Fresh reads each page; no cross-page snapshot or recovery. |
| AC7 empty/errors | Empty whitelist/no bound entries/media; malformed saved schema/definition, failed repo, broken/excluded graph refs, cycles/depth and ambiguity | Pass. Sanitized failures stay distinguishable from empty. |
| AC8 zero execution | Real receiver and eight fail-fast counters; known/unknown/malformed attempted calls; continued SDK usability; whole-DB fingerprint and SQLite `total_changes()` unchanged during protocol-only sequence | Pass. No inference counters, reservation, execution, adapter/model/upstream or DB writes observed. Infrastructure access logging remains. |
| AC9 data boundary | Corrupt encrypted header remains unread; synthetic secret, URL, template, prompt, topology and generated-name sentinels absent from response/error; opaque scoped cursors | Pass for disposable fixtures. Public description/schema content intentionally returned. |
| AC10 evidence | Full root gates, baseline comparison, dependency audit, standalone 12-case actual SDK run, independently executed Sol/max code/test reports and fixed-finding retests | Pass for evidence. Product acceptance/release remain separate. |

Equivalence partitions cover valid/invalid identity/configuration/cursors and offered/absent/disabled/non-declarable/local/upstream tools. Boundary values cover pages, names/policy limits through reused policy-schema tests, cursor limits and depth. Decision tables address policy mode/list/local match and stage inheritance. State transitions cover initialize → list → page, configuration or authorization edits → next request, and attempted call → rejection → usable list. Error guessing addresses same-name ambiguity, broken references, malformed saved schemas and private exception text. Tests use disposable SQLite, existing fixed synthetic fixture Keys and a local receiver; no production data or paid/live providers.

## Commands, functional validation and audits

| Gate / command | Base result | Feature result |
| --- | --- | --- |
| `npm run typecheck` | Pass (server/web) | Pass (server/web) |
| `npm test` | 1,633 server + 82 web + 9 release passed | 1,722 server + 82 web + 9 release passed (1,813 total) |
| `npm run build` | Pass (web/server/stats-worker) | Pass (web/server/stats-worker) |
| `npm audit --json` | Exit 1: five high findings | Exit 1: identical five high findings, zero added |
| Focused server directory/routes/reused policy-schema tests | Not a base feature | 103/103 pass; independent reviewer reran final pinned state |
| `./node_modules/.bin/tsx scripts/validate-tool-discovery.ts` | Not a base feature | 12/12 standalone actual SDK functional cases pass |
| `git diff --check` | Pass | Pass |

The initial sandboxed baseline socket test run could not bind loopback and was interrupted; it is not reported as passed. Narrowly authorized loopback execution then completed baseline and feature gates. Registry metadata/install/audit also required network escalation. No automatic-review rejection occurred. The settled production source matches the full gates and both review content pins. One deletion-isolation assertion was strengthened after the full run, and the affected 103-test suite was rerun by implementer and independent reviewer without production changes.

Stage 5 used a standalone actual SDK client against real `buildApp`, SQLite and HTTP loopback, independent of Vitest. [protocol-client.json](qa/HYD-TOOL-DISCOVERY/protocol-client.json) records initialize/list/pages, live configuration edits, upstream placeholders, rejected calls, empty/error distinction, later-stage union and current Key access. All eight execution counters were zero, inference request/token usage zero, and protocol-only SQL writes zero. The permanent HTTP suite additionally tests rich schemas, persisted filtering/deletion, all service categories and protocol boundaries. This backend surface has no visual UI acceptance. Production/live provider, browser/CORS, abrupt-abort leak, older GUI client and SDK v2 protocol certification checks were not run.

Independent selected `gpt-6.1-sol`, effort `max` sessions:

- `/root/discovery_code_audit`: [code-review.md](qa/HYD-TOOL-DISCOVERY/code-review.md), pass on final source fingerprints. Found a tools-disabled-stage reference error hidden as empty; fixed and independently rechecked. Independently ran directory/policy/cursor and injected protocol probes, final 21-scenario recheck and nine single-message follow-up checks.
- `/root/discovery_test_audit`: [test-review.md](qa/HYD-TOOL-DISCOVERY/test-review.md), pass on final source/test fingerprints. Verified 103 tests and seven independent real-SDK/SQLite probe groups. Malformed-parameter code, legacy batches, batch-table shape and coverage/SQL-write/deletion-isolation follow-ups were fixed and retested. No concrete code/test finding remains open.

## Handoff state and limits

Implemented locally; tested as above; acceptance of the conflicting-alias product disposition remains pending; not released. No push, main merge, deployment, public ticket, GitHub Projects write, persistent security-setting change or real credential generation occurred. GitHub Projects remains outside authorization. Package version remains 2.2.3; future release channel is preview unless separately designated stable.

The separate mismatch-fastfail work remains independent on the same dependency base. No `execution/serverTools.ts` export or other execution/proxy/Responses file is changed here; discovery imports only the existing default-policy constant and schema validator. Shared changes are limited to app registration, an additional read-only HostedToolRepo projection and the SDK manifest/lock entries. Integration must preserve each branch's separate scope; no integration was performed.

GraphFlow tools/CLI were unavailable; no episode was started or falsely reported closed. The final git commit identifies these fingerprinted sources/tests and tracked evidence. Rollback requires reverting this local feature change and SDK dependency, with no migration or persisted discovery state to clean up.
