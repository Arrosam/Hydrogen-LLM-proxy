# HYD-TOOL-SELECTOR — Searchable hosted tool selection

Status: implemented and tested; independent final reviews passed; owner visual acceptance pending. Local tracked ticket only; no remote issue exists (Project OAuth approval is pending). This descriptive temporary ID does not replace historical roadmap F002/F003; a GitHub issue number will be assigned later.

Owner: repository owner. Developer: Codex UI task. Reviewers: `/root/final_code_audit` (gpt-6.1-sol, max) and `/root/independent_browser_audit` (gpt-6.1-sol, xhigh), each in a separate agent session.

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
5. Deduplicate catalog IDs and incoming selected IDs; show disabled tool status and preserve disabled/missing bindings across searching, additions and catalog refresh while open. Missing IDs remain removable; stale virtual options cannot add absent catalog IDs.
6. Headless UI provides arrows, Enter, Escape, Tab and active/selected accessibility states. Label/help/error associations, chip remove-button names and focus return after removal are verified. Disabled component cannot mutate selection/configuration.
7. Dropdown escapes the actual scrolling Modal's clipping and positions within viewport. Long names/descriptions, many chips/options, narrow viewport and Hydrogen's supported theme/focus/error/disabled states remain usable.
8. Existing `ServiceEditor` callback/server ID-array contract and streaming/round/call options remain intact. No unrelated tool-policy change.

## Compatibility and boundaries

No API/schema change; `onIds(number[])` and stable server IDs remain authoritative. The server's 64-binding cap is mirrored locally. Existing registered tools only. All tests use a synthetic catalog and local disposable state. Search and selection transmit no data independently; normal ServiceEditor save remains unchanged. Existing tool recipient/log/continuation/cache/retention behavior is unchanged. UI selection does not establish trusted identity, grant permissions, alter quotas or execute tools. Rollback: revert the feature commit and dependency lockfile update.

## Risk-based verification plan

Equivalence partitions: name/description/mixed-case search, empty query/catalog/results, duplicate names/IDs, disabled/missing values. Boundary values: 63/64/65 IDs and long labels/narrow viewport. State transitions: focus/open/search/add/clear-query/add/remove/close/reopen; keyboard arrows/Enter/Escape/Tab; bulk union/rejection/clear. Regression: unchanged config callbacks and real ServiceEditor modal. Run prescribed root typecheck/tests/build/audit and diff check; distinguish baseline defects from regressions. Independent review after code and tests, then recheck fixes.

## Evidence and final state

Implementation uses exact official `@headlessui/react@2.2.10` with React18-supported peer range, library keyboard/virtual/anchoring primitives, Hydrogen's existing ink/teal theme, removable chips, filtered bulk union, atomic cap rejection and stable numeric IDs. API/config callbacks remain unchanged.

| AC | Automated evidence | Real browser evidence |
| --- | --- | --- |
| 1–2 | Name/description/case, consecutive selection, no-results/stale-active Enter, exact IDs | Search, pointer/Enter, query reset/focus, chips, click/focus reopen |
| 3 | Filtered/empty-query union, duplicate catalog/IDs, pointer/keyboard blur, Clear | Native filtered pointer/keyboard bulk, Clear, interrupted edit/reopen |
| 4 | Individual/batch boundary63/64/65, atomic rejection, legacy65/removals | 63→64, rejected65, whole-catalog65 batch, visible error/invalid association |
| 5 | Disabled/missing IDs preserved, open catalog refresh→remaining/empty, removals | Disabled/missing chips and exact synthetic save payload |
| 6 | Field/label/help/error associations, disabled state, focus return | Arrows/Enter/Escape/Tab, keyboard chip removal, input/click reopen |
| 7 | Scoped jsdom geometry only; actual library virtualizer | Before/after desktop, narrow390px long names, scrolling Modal positioning,300-option virtualization, disabled/error states |
| 8 | ServiceEditor IDs/config save assertion after Advanced collapse/reopen | Real ServiceEditor with synthetic fetch and exact saved ID/config JSON |

See `../evidence/HYD-TOOL-SELECTOR/validation.md`, `gates.txt`, independent code/browser reports and before/after screenshots for exact commands, observations, findings and limitations. Final-source full prescribed `npm test` passes 1,462 server plus 57 web tests. Post-fix full typecheck/build pass. Audit retains five existing high findings; no new package is affected. No tests were removed or weakened.

GraphFlow MCP/CLI unavailable in this environment; targeted reads and an explicit plan were used. No repo `.agents/skills` was present. Only the existing dark theme exists; narrow ServiceEditor footer overflow is adjacent unchanged layout. Safari/Firefox, screen-reader session and real backend persistence were not exercised. All browser data/network responses are synthetic; no paid or production operation occurred.

Implemented: yes. Tested: automated gates and actual Chrome functional/visual checks; independent code and browser reviews passed. Accepted: owner personal visual acceptance pending. Released: no. Remote ticket: no. Push/deploy/merge: none.
