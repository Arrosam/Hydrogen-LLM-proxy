# F002 — Searchable hosted tool selection

Status: triaged; implementation and acceptance pending. Local tracked ticket only; no remote issue exists (Project OAuth approval is pending).

Owner: repository owner. Developer: Codex UI task. Reviewer: independent review requested by owner, to be recorded after implementation.

## Inspiration and scope

The owner approved the official Headless UI React multiple Combobox to replace the growing checkbox list in `HostedToolBinding`, shared by `ServiceEditor`. Existing bindings are numeric IDs. Preserve Hydrogen's ink/teal colors, Inter/system fonts, spacing and controls. Official reference: https://headlessui.com/react/combobox#selecting-multiple-values .

Baseline: `47397d97c209af695b7fc01ed376f2ddeaeda06b` (v2.2.3 release-description baseline), branch `codex/hosted-tool-combobox-20261003`, isolated worktree `/Users/samuel/Documents/Codex/2026-10-03/task-13/hydrogen-hosted-tool-ui`. Use the expressly specified baseline; do not establish a different main baseline or modify the concurrent tool-policy checkout.

Scope: searchable existing-tool multiple selection, removable chips inside the control, explicit bulk actions, 64-binding guard, English/Chinese labels, tests and browser evidence. No arbitrary tool creation, backend contract/routing/settings change, production data, paid provider calls, push, remote issue, release or deployment.

Bulk-action decision communicated by the owner: **Select all search results** unions the filtered catalog with current IDs (empty query means all); **Clear** removes all IDs. Reject an over-limit union atomically with a clear error. Disabled tools are still available as marked bindings, consistent with the existing checkbox behavior; they do not execute while disabled. Preserve missing IDs visibly until the operator removes them.

## Acceptance criteria

1. Focus/click opens the official Headless UI multiple Combobox; case-insensitive search matches name and description. Existing tools only; no-results message and registration link when catalog is empty.
2. Click/Enter toggles a stable numeric ID without duplicates. Additions create removable chips inside the bordered control, clear query immediately and keep input focused/dropdown usable for consecutive additions.
3. Select all search results unions current selection and filtered IDs; empty query selects all. Clear removes everything, including missing IDs. Empty/no-result and disabled-control actions are safe.
4. Boundary checks at 63/64/65: at most 64 unique bindings; reject individual/bulk additions over 64 atomically with visible/announced feedback; removals work at the cap.
5. Deduplicate catalog IDs and incoming selected IDs; show disabled tool status and preserve disabled/missing bindings across searching and additions. Missing IDs remain removable.
6. Headless UI provides arrows, Enter, Escape, Tab and active/selected accessibility states. Label/help/error associations, chip remove-button names and focus return after removal are verified. Disabled component cannot mutate selection/configuration.
7. Dropdown escapes the actual scrolling Modal's clipping and positions within viewport. Long names/descriptions, many chips/options, narrow viewport and Hydrogen's supported theme/focus/error/disabled states remain usable.
8. Existing `ServiceEditor` callback/server ID-array contract and streaming/round/call options remain intact. No unrelated tool-policy change.

## Compatibility and boundaries

No API/schema change; `onIds(number[])` and stable server IDs remain authoritative. The server's 64-binding cap is mirrored locally. Existing registered tools only. All tests use a synthetic catalog and local disposable state. Search and selection transmit no data independently; normal ServiceEditor save remains unchanged. Existing tool recipient/log/continuation/cache/retention behavior is unchanged. UI selection does not establish trusted identity, grant permissions, alter quotas or execute tools. Rollback: revert the feature commit and dependency lockfile update.

## Risk-based verification plan

Equivalence partitions: name/description/mixed-case search, empty query/catalog/results, duplicate names/IDs, disabled/missing values. Boundary values: 63/64/65 IDs and long labels/narrow viewport. State transitions: focus/open/search/add/clear-query/add/remove/close/reopen; keyboard arrows/Enter/Escape/Tab; bulk union/rejection/clear. Regression: unchanged config callbacks and real ServiceEditor modal. Run prescribed root typecheck/tests/build/audit and diff check; distinguish baseline defects from regressions. Independent review after code and tests, then recheck fixes.

## Evidence and final state

Pending: baseline screenshot, implementation, automated gates, independent review, real-browser functional/visual observations, before/after screenshots, overlapping-file report. GraphFlow MCP/CLI unavailable in this environment; targeted reads and an explicit task plan are used. `.agents/skills` availability is checked separately. Implemented: no. Tested: no. Accepted: pending. Released: no.
