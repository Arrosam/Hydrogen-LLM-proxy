# HYD-TOOL-MISMATCH-FASTFAIL — Immediate sequential failover for local tool mismatch

Status: implemented and tested, including owner-corrected OCR/ASR separation; independent followup reviews complete; overall acceptance remains pending for the retained pending-adapter case below. Owner: repository owner through the delegated approved request, 2026-10-03 UTC. Local tracked ticket only; GitHub Project access remains pending OAuth scope. No public ticket or remote claim.

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

## Retained pending-adapter blocker

The selected Model Service owns the existing sequential upstream step loop. A hosted loop can resume a privately retained pending adapter call before that loop. Its synchronous tool preflight still rejects a mismatching first model step before executing the pending operation. Simply removing that guard could dispatch an adapter using the wrong stage's tool map; repeating the wrapper on another provider could replay an operation.

This implementation retains the pending-adapter terminal guard; tests prove zero provider/adapter/file calls for that case. This is a separate unmet core case, not an approved exclusion. Completed adapter results proceed through later model-round mismatch failover without replay. No pending-adapter execution ordering or guard changes are made in the OCR/ASR followup.

The concrete unresolved dependency is handing an actual sequential stage's prepared request/tool ownership to the already-pending adapter before dispatch, while maintaining no replay. Searching ahead, jumping to a matching stage or retrying the wrapper would violate the owner's instructions. No new preparation/routing framework is introduced. AC6 remains partial at this boundary; this report does not claim acceptance of the exception.

OCR/ASR have different semantics: each is an independent tool-free internal request. Their completed child work does not count as dispatch by the outer request's model step. The outer tool-bearing request subsequently attempts each model step in order and never reruns preprocessing during that failover. Its child can fail/retry under the child's own ordinary policy; invalid outer input is still rejected before preprocessing.

## ISTQB risk-based test plan

Equivalence: policy mismatch, protocol mismatch, ordinary function/no tools, malformed/global conflicts, upstream-lookalike and post-dispatch failures. Boundaries: 1/2/100 attempts, zero/nonzero interval and jitter backoff, first/middle/last step, all mismatch, empty/disabled availability, valid/invalid choice references. Decision table: local provenance × pre-dispatch × valid input × advance/retry filters. State transitions: mismatch → next mismatch → compatible success; all mismatch → final failure; upstream failure → retry → fallback; model/tool result → next round mismatch → no operation replay; cancellation → no next dispatch. Counter/timer assertions plus real local HTTP observations map each numbered AC to evidence.

## Evidence ledger

### Owner correction followup (after 7bb72eb)

The owner clarified that OCR and ASR are independent requests originating inside Hydrogen, carrying no tools. The earlier blanket OCR/ASR exclusion conflated the tool-bearing outer request with its tool-free child and is not an accepted scope exclusion. Preserve commit `7bb72eb492e736b3c93d1a0611e0d65b61b813f1`; implement a separate followup on the same isolated branch.

9. Build OCR/ASR child input without outer tools, tool_choice, passthrough/extra tool fields, caller-validation or ownership maps. OCR executes the ordinary Model Service path; ASR uses the ordinary stt-compatible multipart step executor with its own retry/error rules. No new request kind, routing or upstream-stage jumps.
10. Child hosted-loop budgets/context and caller validation are independent from the outer declared-tool run. After translation, the outer request resumes with its original tools, choice and ownership context; its own mismatching model stage advances exactly one sequential step without retry delay. Completed preprocessing is not repeated during that failover.
11. Preserve existing trusted operator service resolution, outer API key scope/quota checks, cancellation, attachment limits and frozen service snapshots. Internal calls do not fabricate APIKey/end-user identity or recursively enter public HTTP authorization. Existing child call/attempt/usage records aggregate into the single outer logging/quota lifecycle; no duplicate billing or new top-level log entry.
12. Red/green equivalence tests distinguish tool-free OCR versus multipart ASR from tool-bearing outer calls; fake timers/counters cover ordinary child upstream retry and outer local fast-fail, child-context separation, translated input retention, invalid outer validation and unchanged pending-adapter guards. Real synthetic HTTP checks verify both child paths and outer scope/log/usage boundaries. Independent Sol max reviews map each new AC explicitly.

Inspection: `buildOcrRequest` already constructed a fresh ordinary canonical request with only OCR generation parameters; `transcribeAudio` framed only model/audio into multipart and ran `runSteps`. No general request-origin/APIKey identity field exists in these executors. Internal origin remains the trusted in-process service reference and nested `(ocr)`/`(asr)` call metadata. The prior OCR call shared `opts.hosted`; the followup now passes a fresh child options object and child caller-validation context, without outer tool maps, budgets or round state. Its requested service identifies the configured OCR service. Signal, timeout, attachment limit, thinking setting and the enclosing HTTP progress observer remain applicable. The blanket image/audio mismatch guard from 7bb72eb is removed. ASR keeps its ordinary independent multipart retry/error executor and shares only the progress observer for HTTP lifecycle handling.

CR-09 concrete divergence: the internal ASR multipart helper omits configured STT `extra.language`/`extra.prompt` that the public MediaController applies. It also retains existing zero-token STT accounting. This followup changes context separation, retry/error semantics and outer mismatch behavior; it does not establish full public STT parameter parity. The omitted operator overrides remain relevant when judging the requested normal applicable execution semantics, rather than being silently dismissed as unrelated. They are reported before any expansion; no parameter-parity change is included in this correction. Public Responses/background input cannot express Completion `input_audio`; actual ASR HTTP acceptance therefore uses Chat Completions buffered and streaming entrypoints. No synthetic special request type or artificial APIKey/user identity is introduced.

The card and exact categories were written and shown locally before production changes; they are durable tracked artifacts in this ticket's commit. Coordination informed the separate MCP task of the touched executor/controller files; no MCP/style/selector changes were integrated. There is no GitHub Project update while OAuth scope is pending.

### Development and environment

- Untouched base: `npm run test:server -- --run test/serverToolPolicyRuntime.test.ts test/sessionSnapshots.test.ts test/steps.test.ts test/retryPolicy.test.ts` — **228 passed / 4 files**.
- Reviewed package scripts, committed lockfile sources (official npm registry) and native lifecycle scripts first. `npm ci --ignore-scripts --cache /tmp/hydrogen-fastfail-npm-cache --prefer-offline --no-audit --no-fund` initially failed in the restricted network (`ENOTFOUND`/npm exit-handler error); the identical approved install succeeded with **398 packages**. Reviewed `npm rebuild esbuild argon2 better-sqlite3 --cache /tmp/hydrogen-fastfail-npm-cache --no-audit --no-fund` then succeeded with approved execution. No dependency/lockfile/version update or shared `node_modules`.
- Backend UI files, other branches, CI/release configuration and production settings are unchanged. No `lint` script exists; `npm audit` is not a required changed-dependency gate because no dependency baseline changed.

### Original 7bb72eb gates (historical)

| Command | Result |
| --- | --- |
| `npm run test:server -- --run test/toolMismatchFastfail.test.ts test/serverToolPolicyRuntime.test.ts test/sessionSnapshots.test.ts` | **165 passed / 3 files**, including 49 ticket regressions |
| `npm run typecheck` | Passed server and web |
| `npm run build` | Passed web and server bundles; existing web chunk-size advisory |
| `./node_modules/.bin/tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --strict --skipLibCheck --esModuleInterop --resolveJsonModule --noUnusedLocals --noUnusedParameters scripts/validate-tool-mismatch-fastfail.ts server/test/toolMismatchFastfail.test.ts` | Passed strict check of new fixtures (outside normal source-only server tsconfig) |
| `npm test` | **1682 server / 81 files**, **82 web / 8 files**, **9 release-plan** tests passed; exit 0. Server 144.89s; web 4.30s. |
| `git diff --check` | Passed on final source/tests/docs; staged check before commit |

AC mapping retained in the final followup: AC1/2 fake timers and counters cover 1/2/100 attempts, fixed/backoff delay, strict step order and `advanceOn:[]`; AC3 preserves final Responses/Anthropic envelopes, all-local stream/background HTTP400 and cancellation; AC4 preserves ordinary upstream 400/503 lookalikes, network/timeout/invalid output, late validation and live-family changes after prior dispatch; AC5 preserves raw/caller/overlay validation, namespace and actual emitted conflicts, private history and key scope. AC6 supports buffered/stream/reliable/nested/hosted flow, independent preprocessing and completed tool side-effect retention; the retained pending-adapter case remains unmet. AC7/8 and new AC9–12 evidence are recorded below.

### Original 7bb72eb independent Sol max reviews (historical)

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

For 7bb72eb: code reviewer **124 independent focused tests passed**, server typecheck and diff check; test reviewer **146 independent focused tests passed**, with baseline/current conflict probes. Socket-restricted code-audit run had one `listen EPERM` on an existing HTTP test; authorized root checks exercised that boundary. Those reviews recorded the then-unresolved prepass gap; the owner's subsequent OCR/ASR correction supersedes that interpretation. Original production diff SHA-256: `680774180cc0b3fb8f687c3250c390e8df3c76f552747f7f96e6c28612eaebdb`.

### Followup red/green and final gates

Before correction, the child-separation reproduction failed three cases: image/audio mismatch prevented the independent child call, and OCR reduced the shared outer hosted budget from 11 rounds to 10. After removing the blanket guard and passing a fresh OCR context, those cases passed. Existing outer malformed-input and retained pending-adapter tests remained terminal with zero IO.

Independent review then reproduced completed OCR usage loss: **3 failed / 56 passed** in the ticket file; buffered, fabricated stream and hosted all-mode failure returned 0 instead of the completed child's 2 tokens. The fix attaches existing aggregate usage to MicroAgent/HostedToolService failure outcomes, preserves it through fabricated conversion, includes streamed hosted failures in the aggregate, and passes it to canceled stateless-stream bookkeeping. Five failure conversion modes now preserve 2 tokens. A separate control removing only the canceled-stream usage handoff reproduced **1 failed / 62 passed**: stream cancellation lost the charge while buffered cancellation preserved it. Restoring the fix passes both cases with exactly one 499 log, one 2-token charge and no replay after draining 600,000ms on the fake clock. No new identity, request kind or accounting lifecycle is added.

TR-OCR-02 also reproduced nested attempt totals being dropped by hosted failure conversion: **2 failed / 61 passed**, with wrapper modes reporting0 instead of child1 + outer2 =3. The existing recursive `countAttempts` helper replaces the shallow count. A new actual HTTP aggregate-counter assertion found the same issue in the Responses failure catch; it now counts the typed `HostedRunError.calls`. Strict checking first caught passing the log accumulator typed `unknown`; using the already-narrowed error's calls fixes that compile error without a cast. Final HTTP logs record3 attempts, or5 when the child uses3 ordinary upstream attempts, on both success and failure. No stage retry/routing behavior changes.

| Final command | Result |
| --- | --- |
| `npm run test:server -- --run test/toolMismatchFastfail.test.ts test/serverToolPolicyRuntime.test.ts test/asr.test.ts test/reviewExecutionRegressions.test.ts test/imageCache.test.ts test/sessionSnapshots.test.ts test/hostedToolLoop.test.ts test/responsesController.test.ts` | **249 passed / 8 files**, including **63 ticket regressions**; authorized socket run |
| `npm run typecheck` | Passed server and web |
| `npm run build` | Passed web and server; existing web chunk-size advisory |
| Strict fixture `tsc` command above | Passed; noUnusedLocals/noUnusedParameters included |
| `npm test` | **1696 server / 81 files**, **82 web / 8 files**, **9 release-plan**, exit 0 |
| Real local HTTP script below | **39 passed, 0 failed** |
| `git diff --check` | Passed; staged check repeated before commit |

AC9 evidence: child wires omit tools/choice and outer extras; child availability/budgets/caller context are independent even with operator-bound child tools. Child OCR/ASR upstream503 uses its own attempts and 100ms fake delay; outer mismatch consumes zero retry time and only one compatible request. AC10: original outer tools/choice/owned bindings and translated media text remain; child executes once while outer step order is `[1,2]`. AC11: root-only key permits trusted child reference but direct child HTTP is403, with zero calls; each successful/failing child-plus-outer HTTP request produces one top-level log/usage charge. Exhaustion/cancel cases make 2/1 child calls and no outer dispatch; completed OCR failure/cancel usage is preserved. Existing snapshot tests and resolver/limit checks pass. AC12: equivalence, 1/2/100 attempt boundaries, isolation/ownership decisions and cancellation/no-replay state transitions are covered by focused and full suites plus actual HTTP evidence. No claim is made for unsupported ASR Responses/background input or full STT configuration parity.

### Followup independent Sol max reviews

The same two independent read-only English-prompt reviewers retested the correction with `gpt-6.1-sol`, effort `max`.

| Reviewer / finding | Resolution and retest |
| --- | --- |
| `/root/code_review` — CR-08 | Fresh child context initially omitted the shared HTTP progress observer, holding Responses SSE/background lifecycle until child completion. Share only that observer. Independent gated-controller control/green checks and slow real HTTP observations confirm prompt headers. No outer tool/ownership context is shared. |
| `/root/code_review` — CR-09 | Existing internal ASR omits public STT language/prompt fields. Baseline parity caveat recorded above; not silently repaired or claimed equivalent beyond the tested ordinary retry/error path. |
| `/root/code_review` — CR-10; `/root/test_review` — TR-OCR-01 | Independently reproduced completed OCR usage2 becoming0 on final failure. Existing usage propagation corrected at the bounded wrappers/controller; five failure modes plus both cancellation cases pass. |
| `/root/test_review` — TR-OCR-02 | Nested failed-wrapper attempts dropped from3 to0. Reuse recursive `countAttempts` in HostedToolService and the Responses failure catch; unit3-attempt and actual HTTP3/5-attempt assertions pass. Strict compile checking of the typed error calls also passes. |

Followup code reviewer independently reports **208 tests / 6 socket-free files**, server typecheck and diff check; test reviewer reports **232 tests / 7 socket-free files**, strict fixture typecheck and diff check. The additional eight-file controller run independently produced **248 passed / 1 environment failure**: the existing live text-delta test could not bind loopback (`listen EPERM`). The parent authorized focused249-test run, full root suite and actual HTTP validation cover that boundary separately. CR-08/CR-10/TR-OCR-01/TR-OCR-02 are resolved; CR-09 is the explicit baseline parity caveat, and pending adapters remain an unmet core case. Followup production diff versus preserved 7bb72eb SHA-256: `5db6886c9cdcebd2c2c80050ff410754bc0794708716ebcb0c37a3921f15ce0c`.

### Real local HTTP acceptance

Run `node --import tsx scripts/validate-tool-mismatch-fastfail.ts docs/validation/HYD-TOOL-MISMATCH-FASTFAIL/http-validation.json` (equivalently `./node_modules/.bin/tsx ...`, used for the final run). The script boots the actual app/transport with temporary SQLite data, synthetic credentials and two ephemeral loopback servers; it closes pools/sockets/databases and deletes fixture data. Evidence: [HTTP observations and request counters](validation/HYD-TOOL-MISMATCH-FASTFAIL/http-validation.json). Latest retest: **39 passed, 0 failed**.

- First mismatch: progress `[1,2]`, only one compatible request. Multiple mismatches: `[1,2,3]`, one compatible request. Configured retry interval/backoff is 600,000ms; successful mismatch cases completed in milliseconds.
- All policy/wire mismatches: native final HTTP400, no external requests; streaming/background also stay HTTP400 before commitment.
- Provider400/503 with the same tool-not-found code/text: three external attempts each, normal nonzero retry delay.
- Caller malformed/duplicate/undeclared selection, session-field conflict, reserved private history, Completion `n>1`, malformed Completion/Anthropic declarations: HTTP400 and no external requests. Scoped synthetic key denial: HTTP403 and no external requests.
- Slow compatible fallback: the recorded stream/background headers precede the 800ms synthetic provider request; ordinary mapping retry background headers precede the configured800ms retry delay with zero external calls. Exact timings are retained per scenario in the JSON.
- Completed operation: exact request order `compatible → adapter → compatible`, counts **2 model / 1 adapter**, model step order `[1,2,1,2]`. The adapter's synthetic result is retained once across the next model round. Anthropic native fallback calls its compatible provider once.
- Tool-free OCR buffered/retry/SSE/background and ASR buffered/retry/SSE: child call count1, or3 under its ordinary503 retry policy; compatible outer model count1, mismatching outer count0, no adapters. Wire text includes prepared OCR/ASR output plus original outer tools/choice. OCR child2 + outer2 tokens aggregate to4; existing ASR usage0 + outer2 aggregate to2. Each logs/charges exactly one root request and records3/5 aggregate attempts. Root-only keys still reject direct child HTTP403 with zero calls.
- Slow OCR SSE/background: headers **6/9ms**, completion **847/818ms**. Slow OCR then all outer mismatches: headers **6/5ms**, final failure **840/824ms**, one child call, zero outer/adapter calls, one root charge retaining **2 tokens**, aggregate attempts3 and semantic log status400. Since the child actually dispatches, SSE carries `response.failed` on committed HTTP200 and background returns a queued ID then failed job; this preserves ordinary lifecycle behavior. All-local mismatches remain precommit HTTP400 as above. Chat Completions ASR stream buffers under its existing grace policy (**810ms** headers), without inventing a Responses/background audio path.

Historical HTTP fixture corrections fixed endpoint-specific `n`/private-field assumptions and an unused import. Followup strict checking corrected an async-emitter fixture type; real HTTP caught wrong token-result access and cached image/audio reuse. Unique synthetic media now force each scenario's own measured child dispatch/retries while preserving normal caching in production. No product contract/security validation was weakened to obtain a pass. No browser/visual validation applies because UI is unchanged. Live providers, paid calls, production acceptance, remote/public tickets, publishing and deployment were not run.

Final state: implemented **sequential local mismatch failover plus owner-corrected independent OCR/ASR child contexts and preserved accounting**; tested **full root gates, 63 targeted regressions and 39 disposable real HTTP scenarios**; accepted **pending at the retained pending-adapter core case**; released **no**. Preserve original `7bb72eb492e736b3c93d1a0611e0d65b61b813f1` and commit the correction separately on this isolated branch. Obtain followup SHA from `git log -1`; reviewed production diff hashes are pinned above. No push, merge, integration, release or deployment.
