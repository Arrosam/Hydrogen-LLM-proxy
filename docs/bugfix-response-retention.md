# HYD-RESPONSE-RETENTION: bounded background expiry

Status: implemented, tested and accepted against the local synthetic acceptance criteria; both independent reviews complete; not released. Intended channel: preview. No publication or deployment authorized by this card.

## Inspiration and evidence

The owner requests permanent resolution of recurring database-read/event-loop blocking after approving a temporary `response_retention_days=0` recovery. The production mutation owner is task `01a0fd0f-29a3-72ef-80bc-42140e9b4029`; this task uses synthetic local databases only.

Production evidence supplied by the coordinator: preview.2 `32f2d872cad440cc4b007659b1e3f69cece7c29a` started on October 7 at 07:12:19 UTC; startup `responses.prune` took 16m57s. Health briefly succeeded near 07:30 and then stalled again. The same prune executes synchronously every 60 seconds. Main Node database reads and high I/O pressure were observed. The active SQL was not captured; temporal correlation is not proof of the exact recurring statement. A third synchronous entry point is the response-retention settings PUT.

Runtime-owner report, independently retrieved through task history: the approved temporary recovery saved `response_retention_days="0"` at 07:51:39 and restarted the same container/image once. Startup prune fell from 1,017,249 ms to 1 ms; three spaced checks stayed healthy across multiple minute ticks, database physical reads did not grow, and unauthenticated MCP calls correctly returned 401. This supports the cleanup hypothesis but still does not identify the previously active SQL. The original key was absent, with effective default 30 days. Owner evidence: task-7 `preview-retention0-recovery-20261007-evidence.txt`, `preview-retention0-watch-20261007-evidence.txt`, and `preview-prune-plan-20261007-evidence.txt`. This task did not connect to production or independently mutate it.

Coordinator's later verified owner report: public health remained 200 at 07:57:59 and local health remained healthy at 08:12:51; physical read bytes stayed at 4,030,464. The 6.79 GB database includes approximately 3.02 GB free pages with `auto_vacuum=NONE`. These observations validate the zero-retention bypass, not positive-retention cleanup. Broad history deletion remains pending scope confirmation, with configuration and image cache preserved. Do not automatically restore the former effective 30-day policy or perform another production experiment from this task.

v2.2.3 commits `35bf324` and `fcf5482` addressed unnecessary request-log OFFSET scans below the cap and startup statistics aggregation. Production statistics use a dedicated readonly worker after listen, a fixed ID boundary and scalar iteration. They did **not** change response expiry, conversation deletion, startup `responses.prune`, or the 60-second response timer. This path remains unchanged in preview.2.

Local query-plan reproduction on the original indexes confirms status-first terminal expiry and a correlated conversation subquery. Hypotheses: (1) synchronous expiry prevents event-loop progress; (2) filtering time after status walks nonexpired payload pages; (3) per-conversation active checks repeat the status scan; (4) disk pressure amplifies these costs. Synthetic results can demonstrate these mechanisms but cannot prove which statement was active in production.

## Baseline and bounded scope

- Base: `32f2d872cad440cc4b007659b1e3f69cece7c29a`, isolated branch `codex/response-retention-worker-20261007`.
- Implementation commit: `f19ae5feb3d089a7145291cdb41e53d2dbab5cd5`. This is a deliberate patch of the deployed preview.2 baseline; no fresh `origin/main` baseline, branch merge, push or version change is claimed.
- Preserve existing Mac checkouts and user changes. Node v22.22.2, npm 10.9.7, Darwin arm64.
- Lockfile SHA256: `06d76087ceecc4e499f23d80ef56fe4c67ac2c9623f4fa8267c2b6012ee14212`. All external package sources are registry.npmjs.org; workspace links are local. Review lifecycle scripts before rebuilding native packages; own lockfile install only.
- Existing preview AGENTS.md and development workflow apply. Repository `.agents/skills` is absent. The only discovered global local skill is webtesting; this is a backend-only change. GraphFlow MCP/CLI is unavailable; use targeted source reads and the recorded plan.
- Move **only response retention maintenance** off the main thread, defer it until listen, use bounded batches and existing indexes, and integrate its lifecycle with close/restore. Preserve startup interruption recovery and other subsystems.
- Exclude production SQL/SSH/data/secrets/backup copies, model inference, request-log policy changes, health masking, broad persistence rewrites, new index construction at startup, and publishing/deploying.

## Proposed implementation and risk

Use a dedicated short-lived worker connection with foreign keys enabled and no lock-wait retry. Age candidates project only indexed `rowid,touched_at`, use the existing touch indexes and keyset cursors, and delete only bounded selected rows after rechecking eligibility inside a write transaction. Conversation protection uses one noncorrelated active-conversation set from the existing status index per batch, avoiding a scan per conversation. Re-read operator retention between batches; preserve zero/default/invalid setting behavior. Yield between batches and bound work per cycle; keep cursors across budget-limited cycles so old active rows cannot starve later expired rows.

Schedule one cycle after listen, then a completion-relative 60-second timer. No overlapping worker, no queued missed ticks, no inline fallback. Cancel and confirm worker exit before restore; stop on shutdown, and do not restart while an old native worker is still stopping. Failure retains data and retries on a later scheduled cycle. Diagnostics contain operation/count/timing metadata only.

SQLite writer serialization, an individual foreign-key cascade, and the noncorrelated active-conversation set can still scale with matching child/active rows and delay application writes under severely slow I/O. The 32-row limit bounds age candidates per batch; 64 batches and 1 second bound scheduling between native calls. They do not cap the active set, cascade work, or a native call's wall-clock time. Validate concurrent local HTTP reads/writes, document actual latency and resource bounds, and do not promise synthetic performance as a production guarantee.

Adding a second writer requires two narrow consistency changes: main ORM write transactions default to `immediate` before guard reads, preserving explicit behavior and nested savepoints; backup export collects one readonly snapshot before asynchronous passphrase sealing. This prevents stale WAL read-to-write upgrades and mixed parent/child backups. No external effects are retried.

## Observable acceptance criteria

1. Startup expiry never scans/deletes on the main thread or delays listen; real local HTTP remains responsive while maintenance runs, including authenticated DB-backed operations. Health behavior stays unchanged.
2. Nonexpired and running (`queued`, `in_progress`) responses survive. All four terminal states expire at the existing strict deletion boundary (`touched_at < cutoff`); read expiry retains its existing `<=` boundary. Zero keeps forever; missing/invalid settings use 30 days. Settings changes are applied between batches without restarting.
3. Expired conversations without active responses are deleted; active reservations protect them. Response events and conversation items cascade correctly; snapshots, independent response history, owners and manual deletion retain their current semantics.
4. Candidate scans use covering age indexes with bounded pages/keyset progression; active protection is noncorrelated. No payload-wide terminal status scan, OFFSET scan, or new full-table index build is introduced.
5. One maintenance cycle/worker at a time, bounded batch/cycle resources, completion-relative periodic scheduling, and backlog progress across cycles. Errors/busy writers retry later without crashing, deleting unrelated rows, or an inline fallback.
6. Cancellation/close prevent subsequent batches; worker exit is confirmed before restore modifies the same database. Shutdown and late worker outcomes cannot reschedule or publish stale state.
7. Required typecheck/tests/build pass; independent code and ISTQB reviews completed and findings resolved. Synthetic real-client functional validation supports AC and explicitly records limitations. No release/publication/deployment occurs.

## Test strategy and evidence to collect

ISTQB risk selection: equivalence partitions for terminal/running/unknown status and valid/zero/invalid retention; boundary values around cutoff and batch/cycle limits; decision tables for conversation age plus active reservation, live settings changes and writer contention; state transitions for idle/running/stopping/stopped, failure/retry and restore pause/resume. Use a bounded payload fixture and an independent legacy-SQL oracle on a copy of the same synthetic fixture. Explain query plans and record timer/HTTP latency and deletion/cascade counts. Run actual repository package gates with low test worker concurrency to preserve DF priority.

Review ownership: implementation/self-review by this task; independent code reviewer and independent ISTQB reviewer completed sequentially, using English prompts. Visual/browser validation is not applicable because no UI or protocol surface is changed; real loopback HTTP/client checks are required.

Rollback: revert local logical-unit commits. Cancelling maintenance leaves already committed expiry deletions intact; it cannot restore deleted data. Production retention policy restoration and backup/deployment choices remain with the mutation owner after review.

## Implemented behavior

- `responseRetention.ts`: covering age-index candidate pages; separate equal-timestamp rowid and later-time seeks; bounded primary-key deletes with fresh age/status/active checks under a writer transaction. No OFFSET, terminal payload scan, or migration/index build.
- `responsePruneWorker.ts` and `responsePruner.ts`: one short-lived worker after `onListen`, 10 ms yields, 32 candidates per batch, at most 64 batches per cycle, a 1-second between-call budget, and a completion-relative 60-second timer. A busy or failing later batch returns already committed cursors/counts with a sanitized reason, so protected prefixes cannot erase progress.
- Startup and settings-save synchronous prune paths and the controller interval are removed. Foreground response read expiry, owner checks, manual deletion, snapshots and interruption recovery retain their existing semantics. Cleanup may finish asynchronously after settings PUT returns; expired records are still hidden immediately by foreground reads.
- Close cancels without awaiting a stuck native call; no replacement starts until actual worker exit. Restore confirms exit first and returns 503 after 5 seconds if it cannot; its target stays unchanged and admission is released on failure. Cancellation cannot undo committed expiry deletions.
- Main write transactions reserve before guard reads; backup export uses one readonly snapshot. Other retention strategies and configuration/cache contents are unchanged.

## Review and validation record

Independent code reviewer `/root/code_review` completed read-only review and small synthetic SQLite experiments. Four findings were resolved and independently rechecked: P1 WAL snapshot upgrade failure; P2 inconsistent backup export; P2 equal-time prefix rescans; P2 lost committed cursor/counts after contention. Final review reported no remaining blocking findings, with native-call/production-performance limits explicit.

Independent ISTQB reviewer `/root/istqb_review` identified three P2 validation gaps and one weaker oracle: timing-dependent retained-row expectations, cancellation before actual work, absent restore-route stop ordering/timeout checks, and shared-parser-derived settings expectations. The reviewer rechecked the revised tests, their 27-test passing log and bundled manual evidence, closed all findings, and reported no additional acceptance blocker. The reviewer did not run the full package gates; those were subsequently run by the implementation owner.

| AC | Evidence | Current result |
| --- | --- | --- |
| 1 | `responseRetentionHttp.test.ts`; startup no prune marker/no pre-listen deletion; real authenticated HTTP while a worker is observed active; bundled manual script | Passed |
| 2 | `responseRetention.test.ts`: explicit setting partitions, all statuses, strict delete/read boundaries, deterministic zero change between committed batches; HTTP 0/1 setting transitions | Passed |
| 3 | Independent legacy-SQL oracle for complete row/cascade results; active/null conversation cases; existing ResponseRepo/snapshot tests; manual config/cache/FK checks | Passed in targeted tests and manual check |
| 4 | Actual SQLite EXPLAIN QUERY PLAN and VM full tie-key `SeekGT`; bounded backlog test; manual plan evidence | Passed |
| 5 | Controlled clock single-flight/exit/retry tests; actual busy-writer deferral; preserved-cursor regression; bounded backlog, actual HTTP overlap | Passed |
| 6 | Actual worker cancellation after partial deletion; no writes after exit; real restore route with stopping-worker control, success ordering and 503 timeout/unchanged target/admission release; bundled SIGTERM | Passed |
| 7 | Both independent reviews complete with findings closed; typecheck/build and full package tests passed; scripted functional evidence | Passed locally; not released |

Disposable local functional check: `node --import tsx scripts/validate-response-retention.mjs`, after `npm run build`. It launches the actual CJS server and adjacent CJS worker from outside repository cwd, with synthetic credentials, loopback only and a 128 MiB JavaScript heap ceiling. This is not a process RSS or native SQLite memory cap. No provider/model is used. [Recorded output](validation/response-retention-bundled.json):

- 1,024 expired and 2,048 fresh response rows, 4 KiB synthetic payloads, 100 old conversations and real events/items; database/WAL fixture total 44,134,864 bytes (<128 MiB).
- Startup/listen 456 ms; old synchronous statements on a separate synthetic oracle 12.65 ms. These SSD timings do not reproduce the production 17-minute stall.
- 64 health HTTP responses: all 200, maximum 2.77 ms; 8 DB-backed conversation writes: all 200, maximum 3.36 ms; retention settings saves: maximum 5 ms.
- Cleanup 570 ms, 37 batches, 1,124 scanned candidates: 1,024 responses and 100 conversations deleted with exact events/items cascades. All 2,048 fresh responses and 8 new conversations survived. Configuration and image cache preserved; foreign-key check passed.
- Graceful SIGTERM: exit 0 in 8 ms. No Docker image was built or published; no production performance claim.

Final commands/results: `npm run typecheck` passed; `npm run build` passed, including the new worker (existing web chunk-size warning). Revised targeted retention/HTTP/restore suite: 3 files/27 tests passed. Final `VITEST_MAX_WORKERS=1 npm test`: 86 server files/1,887 tests, 9 web files/99 tests, and all 10 release-guard tests passed. `git diff --check` passed. First full run had 1,883 passing server tests and one backup-size test failure because its SQLite test double lacked the new transaction method. The double now supplies a readonly transaction, preserving its budget/no-materialization assertions; the full rerun passed. Initial unprivileged loopback test was blocked by sandbox EPERM; narrowly approved local-socket execution passed. Lockfile and dependency versions are unchanged; dependency-baseline audit is not required for this patch.

Pre-change full package gates were not run in this new worktree; baseline SHA, dependency scripts/sources and original query plans were recorded before implementation. Do not describe the post-change run as a fresh pre-change baseline.

Final state: implemented, tested and accepted against all seven local synthetic AC; independent code and ISTQB reviews complete with findings resolved; **not released or production-validated**. History-volume policy or clearing all old sessions is a separate owner decision. Production retention changes, deletion, publication and deployment remain with the runtime owner/coordinator after this handoff. Keep the approved production retention-0 recovery in place until that owner coordinates a reviewed preview and explicitly selects the retention policy.

## Authorized release follow-up

After local acceptance, the owner approved the explained fix and explicitly requested deployment again. The coordinator authorized this task to prepare and publish the next unused preview through the full workflow; production deployment remains separately owned. Fresh remote refs/releases show preview.2 as the newest preview, so [preview.3](releases/v2.3.0-preview.3.md) is selected. Reconcile the original 1,996 passing tests with final-version CI/build/audit and immutable-image smoke; publication is not complete until those checks pass. A current audit exposed two development-only transitive advisories, requiring narrowly pinned official `shell-quote@1.11.0` and `source-map-js@1.2.2` fixes. No history deletion, production retention policy change, new migration or schema/index change is included.
