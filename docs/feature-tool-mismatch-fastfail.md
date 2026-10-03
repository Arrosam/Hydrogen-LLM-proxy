# HYD-TOOL-MISMATCH-FASTFAIL — Immediate sequential failover for local tool mismatch

Status: implemented and tested; both independent reviews complete; overall acceptance pending at the prepass boundary described below. Owner: repository owner through the delegated approved request, 2026-10-03 UTC. Local tracked ticket only; GitHub Project access remains pending OAuth scope. No public ticket or remote claim.

## Inspiration and baseline

The owner requests that a Hydrogen-detected tool mismatch, found before any external request in an upstream step, immediately fail that step and give the next step its turn. The existing policy implementation makes every `ServerToolPreflightError` terminal. This prevents a compatible fallback from running; ordinary retries would also repeat the same local mismatch.

Owner-specified dependency base: `8c12ff24b72767bcc7b0438a4091c36e7ecddccc`. Branch: `codex/hydrogen-tool-mismatch-fastfail`. Worktree: `/Users/samuel/Documents/Codex/2026-10-04/task-2/hydrogen-tool-mismatch-fastfail`. This explicit baseline supersedes the generic fresh-main workflow rule. Preserve policy/style, selector and MCP discovery branches; do not merge their active work. No nested AGENTS.md or `.agents`/`.codex` skills exist in the inspected base. GraphFlow MCP and installed CLI are unavailable; targeted source inspection and an explicit plan substitute. Environment: macOS arm64, Node v22.22.2, npm 10.9.7. Committed lockfile SHA-256: `3df96a79c6d76560baa49560f2884b7f3b61a6b39cf1be22e4dfab4c3194c2d2`.

## Exact classification

| Category | Hydrogen source | Disposition |
| --- | --- | --- |
| Stage policy/availability mismatch | A valid server-tool declaration has no enabled Hydrogen match, and the effective stage whitelist excludes it or blacklist blocks it | Fail this upstream step without retry/backoff; advance to the immediately next step |
| Stage wire capability mismatch | A valid unreplaced native tool declaration or native tool choice cannot be represented by this step's egress family | Same immediate sequential failover |
| Malformed caller request or global conflict | Duplicate caller declarations in the same server/client namespace; duplicate enabled binding aliases; malformed tools/choice; choice references an undeclared tool | Terminal validation before stage overlays; no provider retries/fallback to evade validation |
| Malformed effective stage request | Duplicate names actually emitted by the selected stage; invalid emitted function name | Terminal validation; no provider retries/fallback to evade that failure |
| Upstream/model/transport failure | Provider 400/429/499/5xx, provider `tool_not_found` or similar text, timeouts, resets, incomplete/invalid model output | Existing retry, backoff, idempotency and advance rules |
| Failure after possible external dispatch | Local validation following attachment fetching, model execution or adapter execution | Never acquire the new pre-dispatch fast-fail provenance; preserve existing behavior |
| Authorization/global input failure | Key/service scope, quota, private history, caller validation | Existing global validation; no new retry/failover permission |

The internal signal must come from a typed Hydrogen capability error and a pre-dispatch conversion at the upstream-step boundary. HTTP status, provider error code and message text cannot establish provenance. Validate malformed inputs before exposing a recoverable capability error. Synchronous controller/hosted preflight must defer only this typed capability mismatch to actual sequential execution, without scanning ahead for a compatible step or granting new local tool ownership.

Caller-native and ordinary client functions have distinct ownership. A known native `web_search` declaration and a client `web_search` function can coexist when local rewriting emits a different adapter name. A client `provider_server_side_lookup` can also coexist with native `web_search` when a whitelist passes the native tool through or a stage drops the tools: that stage emits no local collision. Independent review confirmed the base whitelist behavior. A hypothetical default-map collision is not a malformed caller request; reject an emitted-name conflict only where that stage actually creates it. This classification refinement preserves valid native passthrough and avoids extra global routing/validation policy.

## Scope and acceptance criteria

1. A first-step local capability mismatch with retries configured (`maxAttempts > 1`, nonzero fixed interval or backoff, broad retry triggers) makes zero provider/adapter/attachment requests and waits zero retry time. The immediately next compatible step runs once.
2. Multiple mismatching steps are each attempted once in strict order. Do not search ahead, select a matching step, or add jumps/routing. The typed mismatch gives the next sequential step its turn even if ordinary `advanceOn` filters would stop on a provider error.
3. When every step mismatches, return the final step's existing native failure status/message/error envelope, including established Hydrogen codes. Keep cancellation and final-failure conventions.
4. Arbitrary upstream 400s and tool-mismatch text/codes, network/timeouts, incomplete/model errors and post-dispatch failures retain normal retries/backoff and idempotency behavior.
5. Duplicate caller names within their namespace, malformed declarations/choices, undeclared choice references, global binding conflicts and unauthorized/global invalid requests cannot be hidden by overlays or reach a permissive fallback. Effective emitted-name conflicts are terminal at the stage that creates them. Validation failures make zero external calls; valid native passthrough and tool-dropping overlays remain valid.
6. Buffered, streaming/reliable-streaming and existing Responses/Anthropic hosted and nested entrypoints use sequential failover. A completed tool side effect is never replayed by mismatch failover. Do not introduce Micro Agent routing changes or new tool-loop retries.
7. Independent Sol max implementation and test reviews resolve material findings and record IDs/retests. Full root typecheck, tests, build and diff checks pass, or concrete baseline/environment blockers are reported.
8. A disposable local Hydrogen HTTP server plus synthetic loopback providers demonstrates mismatching steps, compatible fallback, all-mismatch failure, upstream retries and invalid-input boundaries. No paid/live models, production data, credentials or adapter writes. Backend only; visual/UI validation is not applicable.

## Compatibility, trust, data and rollback

No new endpoint, dependency, configuration, UI, persistent security setting or release/version change. Existing declaration ownership, frozen session maps/policies, names-only matching, scope/quota/SSRF, adapter safeguards, history and cancellation remain. Step attempt records should explain mismatch retry suppression. Request recipients and log/Responses/conversation/cache retention are unchanged; `store:false` does not imply zero persistence. Validation uses temporary SQLite files and synthetic secrets. Roll back this branch's commits; preserve the dependency commit and all other branches. Push, merge, public ticket, release and deployment are excluded.

## Concrete scope blocker

The selected Model Service owns the existing sequential upstream step loop. Two existing wrappers can perform external work before that loop: Micro Agent OCR/ASR preprocessing for actual image/audio input, and a hosted loop resuming a privately retained pending adapter call. Their former synchronous tool preflight rejected a mismatching first step before that work. Merely deferring that rejection would permit external work before selecting a compatible step; rerunning an entire wrapper on the next provider could replay operations.

This bounded implementation preserves their existing terminal prepass rejection whenever that prepass is pending and initial tool preflight mismatches. Tests prove zero provider/adapter/file calls. Completed adapter results can proceed through later model-round mismatch failover without replay. Empty OCR/ASR prepasses and hosted loops without a pending operation reach the ordinary sequential model chain.

To make the pending-prepass cases also advance before any external work, orchestration needs a preparation checkpoint that shares the chosen stage, rewritten request and tool map with OCR/ASR/pending adapter execution. Searching ahead, jumping to a later matching stage, or invoking the wrapper again would violate the owner's minimal behavior or side-effect boundary. No such machinery is implemented. AC6 therefore remains partial: owner acceptance of this bounded slice or separately authorized checkpoint scope is needed for broader entrypoint acceptance. This is a reported blocker, not an implicit expansion or an accepted exception.

## ISTQB risk-based test plan

Equivalence: policy mismatch, protocol mismatch, ordinary function/no tools, malformed/global conflicts, upstream-lookalike and post-dispatch failures. Boundaries: 1/2/100 attempts, zero/nonzero interval and jitter backoff, first/middle/last step, all mismatch, empty/disabled availability, valid/invalid choice references. Decision table: local provenance × pre-dispatch × valid input × advance/retry filters. State transitions: mismatch → next mismatch → compatible success; all mismatch → final failure; upstream failure → retry → fallback; model/tool result → next round mismatch → no operation replay; cancellation → no next dispatch. Counter/timer assertions plus real local HTTP observations map each numbered AC to evidence.

## Evidence ledger

The card and exact categories were written and shown locally before production changes; they are durable tracked artifacts in this ticket's commit. Coordination informed the separate MCP task of the touched executor/controller files; no MCP/style/selector changes were integrated. There is no GitHub Project update while OAuth scope is pending.

### Development and environment

- Untouched base: `npm run test:server -- --run test/serverToolPolicyRuntime.test.ts test/sessionSnapshots.test.ts test/steps.test.ts test/retryPolicy.test.ts` — **228 passed / 4 files**.
- Reviewed package scripts, committed lockfile sources (official npm registry) and native lifecycle scripts first. `npm ci --ignore-scripts --cache /tmp/hydrogen-fastfail-npm-cache --prefer-offline --no-audit --no-fund` initially failed in the restricted network (`ENOTFOUND`/npm exit-handler error); the identical approved install succeeded with **398 packages**. Reviewed `npm rebuild esbuild argon2 better-sqlite3 --cache /tmp/hydrogen-fastfail-npm-cache --no-audit --no-fund` then succeeded with approved execution. No dependency/lockfile/version update or shared `node_modules`.
- Backend UI files, other branches, CI/release configuration and production settings are unchanged. No `lint` script exists; `npm audit` is not a required changed-dependency gate because no dependency baseline changed.

### Automated gates

| Command | Result |
| --- | --- |
| `npm run test:server -- --run test/toolMismatchFastfail.test.ts test/serverToolPolicyRuntime.test.ts test/sessionSnapshots.test.ts` | **165 passed / 3 files**, including 49 ticket regressions |
| `npm run typecheck` | Passed server and web |
| `npm run build` | Passed web and server bundles; existing web chunk-size advisory |
| `./node_modules/.bin/tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --strict --skipLibCheck --esModuleInterop --resolveJsonModule --noUnusedLocals --noUnusedParameters scripts/validate-tool-mismatch-fastfail.ts server/test/toolMismatchFastfail.test.ts` | Passed strict check of new fixtures (outside normal source-only server tsconfig) |
| `npm test` | **1682 server / 81 files**, **82 web / 8 files**, **9 release-plan** tests passed; exit 0. Server 144.89s; web 4.30s. |
| `git diff --check` | Passed on final source/tests/docs; staged check before commit |

AC mapping: AC1/2 fake timers and request counters cover 1/2/100 attempts, fixed/backoff delay, strict step order, and `advanceOn:[]`; AC3 tests preserve final Responses/Anthropic envelopes, all-local stream/background HTTP400 and cancellation; AC4 upstream 400/503 lookalikes, network/timeout/invalid output, late rendered validation, and buffered/stream live-family changes after a prior dispatch; AC5 original duplicates/choice and raw shapes, overlay/agent tool removal, missing mapping/router-only OCR validation, binding conflicts, actual emitted collisions, private history and key scope; AC6 normal buffered/stream/reliable/nested/hosted flow plus completed side effect retention is supported, pending external prepasses are explicitly excluded above. AC7/8 are evidenced below; broad AC6 acceptance is pending.

### Independent Sol max reviews

Reviewers were separate read-only agents using `gpt-6.1-sol`, reasoning effort `max`, English prompts. These are actual independent reviews, not self-review. Review IDs are their canonical agent IDs plus finding IDs.

| Reviewer / finding | Resolution and retest |
| --- | --- |
| `/root/code_review` — CR-01 | Slow SSE/background headers were held by waiting for the entire deferred job. Added a progress latch that releases existing HTTP handling at a viable step or ordinary mapping failure; it never selects/jumps to a step. HTTP headers released before the 800ms provider/backoff delay. |
| `/root/code_review` — CR-02 | Caller duplicates/undeclared choice could be hidden by step/agent overlays. Preserve caller validation context and validate before overlays. Negative zero-call tests pass. |
| `/root/code_review` — CR-03 | Permissive IR parsing could drop malformed entries/coerce nested names or schema roots. Check raw recognized shapes before parsing; native/custom provider options stay opaque. Positive and negative tests pass. |
| `/root/code_review` — CR-04 | Later tools:none child could revalidate legal caller native/client names using a different binding context after execution. Validate original caller once and preserve namespace ownership. Two-child positive regression passes. |
| `/root/code_review` — CR-05 | Live family changes between retries could incorrectly label a mismatch after an earlier dispatch as local fast-fail. Per-step invocation dispatch sets cover attachments and model sends. Buffered/stream regressions preserve terminal existing behavior with one prior send and the original retry delay. |
| `/root/code_review` — CR-06 | All-unresolved/no-selected-model preflight could omit original global validation before OCR. Validate original caller in fallback preflight; missing-mapping/router-only zero-call regressions pass. |
| `/root/code_review` — CR-07; `/root/test_review` — TR-FINAL-01 | Initial card wording implied potential default-map emitted-name conflicts were globally malformed. Direct baseline/current probes proved native whitelist passthrough and dropped tools valid, actual emission conflicts terminal. Refined the contract and added two positive regressions; no broad rejection/routing introduced. |
| `/root/test_review` — HTTP evidence note (P3) | Added actual observed response.status assertions/recording for slow background and ordinary mapping jobs; all 28 HTTP cases reran successfully. |

Final code reviewer: **124 independent focused tests passed**, server typecheck and diff check; no open material code findings. Final test reviewer: **146 independent focused tests passed**; baseline/current conflict classification probes agree. Socket-restricted code-audit run had one `listen EPERM` on an existing controller HTTP test; the authorized root full socket suite and real HTTP checks exercise that boundary. Both reviewers retain the explicit pending-prepass AC6 acceptance gap. Self-review additionally checked typed provider-field conversion, sequential-only execution, tool map ownership, caller context, cancellation and guarded external work. Production diff SHA-256 reviewed independently: `680774180cc0b3fb8f687c3250c390e8df3c76f552747f7f96e6c28612eaebdb`.

### Real local HTTP acceptance

Run `node --import tsx scripts/validate-tool-mismatch-fastfail.ts docs/validation/HYD-TOOL-MISMATCH-FASTFAIL/http-validation.json`. The script boots the actual app and transport with temporary SQLite data, synthetic token/provider credentials and two ephemeral loopback servers; it closes pools/sockets/databases and deletes fixture data on completion. Evidence: [HTTP observations and request counters](validation/HYD-TOOL-MISMATCH-FASTFAIL/http-validation.json). Latest retest: **28 passed, 0 failed**.

- First mismatch: progress `[1,2]`, only one compatible request. Multiple mismatches: `[1,2,3]`, one compatible request. Configured retry interval/backoff is 600,000ms; successful mismatch cases completed in milliseconds.
- All policy/wire mismatches: native final HTTP400, no external requests; streaming/background also stay HTTP400 before commitment.
- Provider400/503 with the same tool-not-found code/text: three external attempts each, normal nonzero retry delay.
- Caller malformed/duplicate/undeclared selection, session-field conflict, reserved private history, Completion `n>1`, malformed Completion/Anthropic declarations: HTTP400 and no external requests. Scoped synthetic key denial: HTTP403 and no external requests.
- Slow compatible fallback: stream headers **4ms**, completed **850ms** with one 800ms synthetic provider request. Background reply **3ms**, completed **814ms**. Mapping retry background headers **5ms**, failed job completion **819ms**, configured retry **800ms** and zero external calls.
- Completed operation: exact request order `compatible → adapter → compatible`, counts **2 model / 1 adapter**, model step order `[1,2,1,2]`. The adapter's synthetic result is retained once across the next model round. Anthropic native fallback calls its compatible provider once.

The first HTTP script run stopped on incorrectly endpoint-specific `n`/private-field fixture assumptions; fixtures were corrected to existing Chat Completions and reserved canonical-history validation. No unrelated endpoint contract was changed to obtain a pass. New fixture strict typecheck found an unused import; removed and retested. No browser/visual validation applies because the UI is unchanged. Live providers, paid calls, production acceptance, remote/public tickets, publishing and deployment were not run.

Final state: implemented **bounded sequential Model Service slice**; tested **all relevant root gates, 49 targeted ticket regressions, two independent audits and 28 disposable real HTTP scenarios**; accepted **pending, AC6 requires prepass scope decision**; released **no**. Final local commit contains this card, implementation, tests and HTTP fixture/evidence; obtain its exact SHA from `git log -1` on the ticket branch. Production diff hash is independently pinned above. No push, merge, integration, release or deployment.
