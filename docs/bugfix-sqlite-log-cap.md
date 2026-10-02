# SQLite log-cap scan investigation — 2026-10-02

## Card / triage

- ID: B001; status: implemented, locally accepted for the bounded scope; owner: Codex; independent reviewer: `sqlite_review` agent. Not released; incident root cause unresolved.
- Inspiration: delegated production incident: Hydrogen v2.2.2 running/unhealthy, Node main thread waiting in `pread64` on hydrogen.db, healthz and homepage have no first byte. Database ~6.32 GiB, WAL ~39 MiB, high IO PSI. The active SQL and storage cause are unknown. No production access is part of this task.
- Baseline: `768244c47f6655fea0e3d79bcad0c94c2329c92f`, branch `codex/fix-sqlite-log-scans-20261002`, isolated worktree. Preserve baseline uncommitted README/rules/docs; copied AGENTS/workflow into this worktree for local guidance.
- Proven defect: `LogPruner.capRows()` uses `ORDER BY id DESC LIMIT 1 OFFSET maxRows` even when there are too few rows to delete. SQLite scans the payload-bearing table B-tree on each startup/hourly tick. A synthetic 2,048-row fixture with 16 KiB bodies confirms `SCAN request_logs`; exact count uses an existing covering index.
- Scope: avoid the unnecessary table traversal when the row count is within budget. Above-budget pruning retains the existing exact newest-by-id behavior. No migrations, new indexes, dependency changes, API/UI changes, statistics redesign, production DB copy, server operation, deployment or release.
- Risks: count remains synchronous O(N) over a narrow index, and over-budget OFFSET/deletion remains synchronous and potentially expensive. Extra count slightly increases work on the over-budget path. This is a bounded mitigation of a proven code defect, not confirmation or resolution of the incident root cause.
- Rollback: revert the count guard and its regression tests; no database/schema rollback required.
- GraphFlow MCP/installed CLI unavailable; targeted source reads and explicit plan used; no episode started.

## Acceptance criteria / test design

1. Disabled (<=0) caps do not delete or scan; empty/below/equal-budget caps return 0 and preserve rows.
2. Above-budget caps retain exactly the newest N row IDs, including ID gaps and out-of-order timestamps; report the actual number deleted; repeat calls return 0.
3. A payload-heavy within-budget table performs no OFFSET table scan or DELETE. The executed count query uses a covering index in the locked better-sqlite3 runtime. Test plans/operations rather than unstable wall-clock thresholds.
4. Existing typecheck, server/web tests and build pass; local real HTTP health/log/stat read flows function after within-budget and over-budget maintenance.

ISTQB risk-based techniques: equivalence partitions (disabled, empty, within/over budget), boundary values (N-1/N/N+1), and lifecycle transitions (prune then repeat / gaps from prior deletion). Synthetic data only, bounded fixtures and cleanup. No live credentials/providers. Data recipients are local test processes only; log/stat semantics, cumulative cache history, identity/authorization and retention policies remain unchanged. Backend-only change: real loopback HTTP functional validation applies; visual/browser acceptance adds no coverage of this SQL path.

## Other code risks / uncertainty

- `/healthz` itself performs no DB query, but runs on the same main thread as better-sqlite3.
- Boot runs `StatsCache.init()` before listening; reseeding `StatsQueries.accumulateSince()` executes five synchronous aggregate statements, despite its one-pass comment. Exact date-range dashboard stats also run synchronous aggregates. No incident SQL was captured.
- Initial/hourly above-budget and age-based pruning, explicit log deletion, log pagination/filter counts, Responses cleanup, and backup/restore can still perform expensive synchronous work.
- Model/provider startup grouping may choose their indexes rather than the id-tail range; independently reproduced planner risk, not a captured production query plan.
- No evidence here establishes database corruption or a cloud disk hardware fault. Reproduce/measure on sanitized representative workloads before a broader worker/maintenance redesign.
- Follow-up field report: SSH connection/handshake timeouts produced neither REMOTE_CONNECTED nor RESTART_DISPATCH; a container restart and recovery are not confirmed. The last confirmed production blocking point remains the main-thread DB read.

## Evidence / final state

Environment: macOS arm64, Node v22.22.2, npm 10.9.7, locked better-sqlite3 SQLite 3.49.2. Lockfile SHA-256 remains `e2d9e9cab5038f6f4d29357f682465a9eb06a19201abe8e1bad7a43118b15876`. Installed separately with `npm ci --ignore-scripts --offline`, inspected argon2/better-sqlite3/esbuild/fsevents lifecycle scripts, then rebuilt argon2/esbuild offline and better-sqlite3 from source with existing `/opt/homebrew` Node headers. All stages exit 0, using a sanitized environment and temporary HOME/cache; no node_modules reuse or lockfile edit. No dependency baseline changes, so an additional npm audit was not required.

| AC / gate | Evidence / result |
|---|---|
| 1: disabled/empty/within budget | Tests for caps 0/-1 and counts 0/2/3 at budget 3 pass; disabled caps execute no SQL, within-budget paths execute only COUNT |
| 2: exact retention | N+1 boundary, cap=1, ID gaps, inverse timestamp order and repeat-call tests pass; exact deleted counts and remaining IDs asserted |
| 3: performance regression | 4 MiB fixture captures actual repository SQL; only COUNT executes, real EXPLAIN shows a covering index, no OFFSET/DELETE/table scan. Before fix 4/9 tests fail; after fix 9/9 pass |
| 4: baseline root `npm test` | Before product source edit: server 73 files / 1,439 tests, web 6 files / 42 tests pass; exit 0 |
| 4: final root `npm test` | Server 74 files / 1,448 tests, web 6 files / 42 tests pass; exit 0 (server 145.06 s, web 2.20 s) |
| 4: root typecheck/build | Server+web pass, exit 0; existing large web chunk warning remains |
| 4: real local HTTP | Loopback listener + real fetch, synthetic credentials/data. Health before/after and built homepage 200; unauthenticated logs 401; login 200; logs total 64→32, deleted=32, retained IDs=33..64, all-time statistics remain 64 |
| Independent review | Separate agent read the diff/tests/card, independently ran 9/9 tests, root typecheck and diff whitespace checks; no blocking finding. No source mutations by reviewer |
| Whitespace | `git diff --check` pass |

Bounded file-backed diagnostic: 4,096 rows × 32 KiB synthetic request body, database 137,211,904 bytes (<192 MiB guard), temporary data cleaned. Reopen per sample with 64 KiB SQLite cache, nine alternating samples: original OFFSET median 0.627 ms, patched capRows median 0.118 ms. OS cache is warm/uncontrolled; these values describe this host, are not an acceptance threshold, and do not model the production disk. Original EXPLAIN: `SCAN request_logs`; patched: `SCAN request_logs USING COVERING INDEX request_logs_status_idx`. The original ID-only OFFSET need not read every overflow body page: the query plan and DB page inventory do not establish that the entire database was read. This distinction prevents overstating the mitigation.

The same synthetic database confirms `accumulateSince(0)` issues five SQL statements (132.94 ms); tail catch-up `accumulateSince(4095)` returns one row but still issues five statements (1.535 ms). Model/provider statements select their group indexes, not the primary-key tail range. Default web Overview requests omit a date range and therefore use the existing memory cache; explicit date-range calls still use SQL. No changes to statistics were made.

Retained local evidence directory: `/Users/samuel/Documents/Codex/2026-10-03/task-8/`. Files: `install.log`, `rebuild.log`, `sqlite-rebuild.log`, `baseline-test.log`, `logpruner-red.log`, `logpruner-green.log`, `typecheck.log`, `build.log`, `final-test.log`, `manual-performance.log`, `verification-results.json`, and the repeatable bounded `verify-sqlite-log-cap.mts`. The local script checks free-space/fixture size, uses synthetic credentials, emits SQL/plans and HTTP results, and removes its temporary data in finally. Invocation from this worktree: `env -i PATH=/opt/homebrew/bin:/usr/bin:/bin HOME=/tmp/hydrogen-fix-home TMPDIR=/tmp node --import tsx ../verify-sqlite-log-cap.mts` (loopback capability required). Logs are supporting local artifacts, not committed runtime output.

Implemented/tested/accepted: the bounded B001 scope and AC 1–4 locally. Not reproduced/accepted: production-scale cold-cache/slow-storage failure, other-connection concurrency, unbounded above-budget deletion, remaining stats/maintenance paths, Docker/Linux parity or incident recovery. Visual validation is not applicable to this backend-only SQL change; real local HTTP function checks were performed. Released: no push, merge, deployment or production operation. Production recovery and any publishing require separate ownership/authorization.
