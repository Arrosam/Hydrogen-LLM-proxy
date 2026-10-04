# HYD-INTEGRATION-PREVIEW — Aggregate development preview

Status: integrated local candidate; aggregate verification and independent review in progress; not published or deployed.

## Inspiration, scope and baseline

The owner authorized merging all four completed development tickets and the parameter override fieldset follow-up into a new isolated Mac worktree, preparing a preview, then comprehensively validating the combined result before remote publication. Freshly fetched `origin/main` on 2026-10-04 is `47397d97c209af695b7fc01ed376f2ddeaeda06b`. Integration branch: `codex/hydrogen-integration-preview-20261004`; worktree: `/Users/samuel/Documents/Codex/2026-10-04/task-4/hydrogen-integration`. Original checkouts, branch refs and user changes are preserved.

Verified clean source heads: policy/styling `20ff8cbd18b6e0b6044444039079ff20fbec1e17` (contains `8c12ff24b72767bcc7b0438a4091c36e7ecddccc`); selector `bd779fa9f19894950ff743bcf86eb3ff84b4af93`; discovery `98bf2a8f5f57c03755ebdae5d8315ddd553e2edf` (contains implementation `1c3d5e8bcee09970aadb96a2b8d2ee9d4d212259`); mismatch/media/pending durability `a2265e06855ab675ee74232026e47be6e4dd7aa7`. The latter two descend from the policy feature. Selector descends from the release baseline. All four are merged with ancestry preserved.

Preview version: `2.3.0-preview.1`, matching tag `v2.3.0-preview.1`. A minor feature preview follows the repository's documented `MAJOR.MINOR.PATCH-preview.N` convention and existing latest tag `v2.2.3`. Root/server/web and lock metadata are synchronized. Existing tags and release classifications remain intact. Local preparation does not authorize remote release, push, production deployment, OAuth changes, paid inference or production data access.

Read tracked `AGENTS.md`, `docs/development-workflow.md`, each feature card and acceptance/review evidence. No checkout `.agents/skills` or nested rules exist. GraphFlow MCP/installed CLI are unavailable; no execution episode started. Prior branch evidence is context, not aggregate acceptance. Historical sessions lacking stored snapshots have an unresolved owner decision; no universal preservation claim is made.

## Acceptance criteria and risk plan

1. All verified ticket heads and styling commits are ancestors of the final candidate; originals remain unchanged. Merge overlap retains explicit declaration wording and both exact dependency sets.
2. Bindings only describe availability. Ordinary client functions retain ownership. Prefix defaults to `provider_server_side_`; explicit empty is preserved. Model Service stage policy remains in Advanced with whole inheritance/replacement and no duplicate Micro Agent editor.
3. Supported saved inference sessions retain frozen graph, tool/executor ownership and policy after edits. Discovery reads current configuration on every page, is read-only, rejects calls, reports `catalog_conflict`, and marks upstream placeholder schemas unverified.
4. Typed local mismatches advance strictly to the next stage with no retry/backoff. Upstream retry remains. Pending adapters execute at most once across retry, failure, cancellation and saved continuation. OCR/ASR remain independent ordinary internal-origin requests without caller tools; configured ASR language/prompt match public requests.
5. Root full typecheck, server/web/release tests and build run against the final combined commit on Node 22. Real synthetic HTTP and official SDK scenarios validate final code, including interactions between discovery, edits, inference snapshots and tool ownership. Dependency sources/lifecycle/diff/audit are compared to baseline. Never weaken tests for a green result.
6. Separate English-prompt Sol max code and ISTQB test reviews examine aggregate code and omissions; concrete findings are fixed and rechecked. Sol xhigh real browser review covers desktop/narrow, repeated/interrupted selection, policy/fieldset persistence and visual state. Provide fresh inspectable screenshots through the supported delivery path when available.
7. Package metadata, matching local tag, release notes/plan and image tags isolate preview. GitHub future publication requires prerelease and latest=false; image pointers never include stable/latest. Remote Actions/container publication and production deployment remain unrun.

ISTQB techniques: equivalence partitions for native/local/client/no declarations, prefixes, known/upstream catalog entries, Key scope and saved/unsaved identities; boundaries for 0/1/99/100/101 pages, 63/64/65 bindings, empty policy and field modes; decision tables for policy × availability × protocol × owner; state transitions for edit→discovery/current versus continuation/frozen, mismatch→next, pending→claim→receipt→retry/cancellation, search→add/remove→interrupt→reopen→save/reload. Counters establish zero discovery IO/writes/quota and at-most-once adapters. Disposable SQLite, synthetic credentials and loopback mocks only.

## Trust, data, rollback and exclusions

Existing service/API-key scope, quota, SSRF, backup integrity, cancellation and public/private receipt boundaries remain. No credentials or topology are exposed by catalog projection. No inference session or discovery pagination guarantees beyond the source cards are added. F002 model filtering remains discussed and unimplemented. No production access, real adapter effects, OAuth expansion or stable reclassification. Rollback is discarding/reverting the isolated integration branch; do not rewrite original refs. Local test fixtures and raw logs live outside tracked runtime source.

## Evidence and final state

Aggregate evidence is recorded in `docs/qa/HYD-INTEGRATION-PREVIEW/` and the sibling task `evidence/` directory. Update this section only from actual final executions. Implemented: local integration/version prepared. Tested/accepted: pending final aggregate evidence. Released: no.
