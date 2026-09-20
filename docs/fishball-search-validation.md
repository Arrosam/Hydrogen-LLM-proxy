# Hosted search migration validation — 2026-09-21

## Scope and baselines

Fishball: `origin/agent-loop-and-tiers`, commit `32ac823` (v0.4.1a), branch
`codex/server-search`. Hydrogen: `origin/main`, commit `6bd8a22`, isolated worktree
`/private/tmp/hydrogen-fishball-search`, branch `codex/fishball-server-search`.
The original Hydrogen audit checkout remains at `23f6247` with its original six
untracked entries; no source/configuration files there were edited.

Both repositories are required. Before, Android owned model → SearXNG → model
and reranking. Now Hydrogen's existing hosted loop owns those calls. Android
receives bounded provenance/status and the final answer, using a token-owned
response pointer for local page/quote/log continuations. See Fishball's `docs/hosted-search.md`
and `docs/fishball-search.md` for the versioned protocol and rollout.

## Deterministic measurement

`server/test/responsesController.test.ts`, test
`executes model-search-model in one mobile request and never returns raw tool rounds`:

- One search, one hit, two model turns: **3 → 1 mobile HTTP requests** (66.7% fewer).
- Fixture search-transfer budget: **10,885 → 1,770 UTF-8 bytes** (83.74% fewer).
- Legacy budget counts the model search call, raw SearXNG response (including a
  10,000-byte unused engine field), and repeated model context. Hosted budget
  counts the entire compact SSE response, including its final answer. The common
  initial model request, legacy final answer, HTTP/TLS headers and compression are
  excluded. This is a conservative synthetic comparison, not a production
  bandwidth or latency claim. The test asserts the reduction and prints counts.
- The model runs twice on Hydrogen while the mobile caller sends one request.
  No search call/result is handed back for the caller to execute.

## Fishball

A temporary JDK 17 and Android SDK were installed outside the repositories because
this machine had neither. Commands used this environment:

```sh
export JAVA_HOME=/private/tmp/fishball-jdk/Contents/Home
export GRADLE_USER_HOME=/private/tmp/fishball-gradle
export ANDROID_HOME=/private/tmp/fishball-android-sdk
export ANDROID_USER_HOME=/private/tmp/fishball-android-user
```

| Command/check | Exact outcome |
| --- | --- |
| `bash ./gradlew :core:test :app:testDebugUnitTest :app:assembleDebug :app:assembleRelease` | BUILD SUCCESSFUL; 154 core tests and 37 Android JVM tests, zero failures/errors/skips; debug and unsigned release APKs built |
| `bash ./gradlew :core:test --tests '*Hosted*' --tests '*TruncatedStreamTest*' :app:assembleDebug :app:assembleRelease` | BUILD SUCCESSFUL after terminal-event handling change; 10 affected tests passed; both APKs rebuilt |
| `bash ./gradlew :core:test --tests '*Hosted*' --tests '*TruncatedStreamTest*'` | BUILD SUCCESSFUL; 12 tests passed after adding terminal-socket and hosted cancellation regressions |
| `bash ./gradlew :app:lintDebug` | FAILED: 107 errors, 38 warnings; identical issue/message multiset to untouched release baseline |
| `bash /private/tmp/fishball-lint-baseline/gradlew -p /private/tmp/fishball-lint-baseline :app:lintDebug` | FAILED: same 107 errors, 38 warnings on `git archive origin/agent-loop-and-tiers`; 106 MissingTranslation and 1 ProduceStateDoesNotAssignValue errors |
| `git diff --check` | Passed |

Existing lint debt is not suppressed globally or folded into this migration. The
only new suppression documents the synchronous, durable removal of legacy search
credentials before restore; this leaves no new lint warnings. Release vital lint
passes as part of the release build.

Boundary tests cover version acknowledgement, old/unconfigured servers, failure
without fallback, final streaming, cancellation, truncated streams, terminal
completion before socket close, compact continuation, trusted sources, quotation
verification, profile secret removal and checkpoint/reopen persistence.

## Hydrogen

| Command/check | Exact outcome |
| --- | --- |
| `npm ci --cache /private/tmp/fishball-npm-cache` | Passed; lockfile unchanged |
| `npm run typecheck` | Passed, server TypeScript |
| `npm run typecheck --workspace web` | Passed |
| `npm test` | 65 test files, **1,123 tests passed**, zero failures |
| `npm run test --workspace server -- --run test/fishballSearch.test.ts test/responsesController.test.ts` | Adapter/protocol tests passed after fixture cleanup; final full suite above includes all 26 tests in these files |
| `npm run build` | Web Vite and server esbuild succeeded; existing web chunk-size advisory only |
| ESLint command below | Passed on every changed TypeScript source/test file |
| `git diff --check` | Passed |

This baseline has no configured lint/format script. Targeted lint used the already
installed ESLint and TypeScript parser read-only, with `no-debugger`,
`no-constant-binary-expression`, `no-dupe-else-if`, `no-duplicate-case`,
`no-unsafe-finally`, and `no-unreachable` set to error:

```sh
/Users/samuel/Documents/GitHub/Hydrogen-LLM-proxy/node_modules/.bin/eslint \
  --config /private/tmp/hydrogen-fishball-lint.config.mjs \
  server/src/execution/fishballSearch.ts server/src/execution/hostedToolLoop.ts \
  server/src/execution/toolHttp.ts server/src/transport/responsesController.ts \
  server/src/transport/fishballAnswerStream.ts server/test/fishballSearch.test.ts \
  server/test/responsesController.test.ts
```

Tests include Unicode/options/pagination, strict malformed response handling,
empty/degraded/failed states, authorization, bounded timeout/retry, cancellation,
response size limits, server reranking/fallback, safe trust defaults, legacy client
compatibility, local-tool continuations, early live final-answer deltas, and mobile
disconnect cancellation without another model call.

## Verification limits and rollout

No `HYDROGEN_KEY` was available; opt-in live-provider tests were not exercised.
Deployment and on-device testing were not performed. Configure/bind SearXNG and
ranking on Hydrogen first, then distribute the APK. Incompatible deployments fail
explicitly, never fall back to client search or model knowledge. Keep the old
search endpoint/legacy activation codes during the old-client rollback window.

Both source registries were byte-compared: version 5, SHA-256
`f9e7f43f00951361479d9f721761ada126fe6c2815a0fdd951c84dec4568da20`.
GraphFlow indexing completed for both changed worktrees. Generated GraphFlow
cache/output directories are retained locally and excluded from the commits.

The migration is implemented on both sides. The remaining validation limitation
is the independently verified pre-existing Android lint debt; live deployment
verification requires deployment credentials and operator configuration.
