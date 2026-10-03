# Independent code audit — HYD-TOOL-SELECTOR

Reviewer session: `/root/final_code_audit`. This is a separate agent session from implementation and browser validation. Audit date: 2026-10-03. Review scope: the agreed hosted tool Combobox acceptance criteria, source correctness, ISTQB-informed test adequacy, interrupted/repeated flows, stable IDs, the binding cap, accessibility wiring, and dependency/lockfile changes. Browser work was expressly excluded from this session.

**Final code-audit verdict: pass after remediation.** One confirmed catalog-refresh crash was found, fixed by the implementation agent, and independently rechecked. The final reviewed source has no remaining code findings. Browser/interface acceptance remains the responsibility of the independent browser/visual audit.

Baseline: `47397d97c209af695b7fc01ed376f2ddeaeda06b`. Branch: `codex/hosted-tool-combobox-20261003`. HEAD throughout review: `456901240021db0413577f4a08c1bc29e19854cc`; implementation was uncommitted. Initial reviewed `HostedToolBinding.tsx` Git blob: `bd88d88d2dc9030dfa2f7665cfec1cff2cd12c2f`. Final reviewed component Git blob: `3757842863f03e30c05904448e10af0a00e8dc30`; final component-test Git blob: `2b28c107802ce40ef0e89f45d602627068528c95`. Lockfile SHA-256 remained `d729387152d3fa26330d8950d82fa3bf8ed06da028a5fedc5132b3abc5a93daa`.

Read repository `AGENTS.md`, `docs/development-workflow.md`, and `docs/features/HYD-TOOL-SELECTOR.md`, plus the touched component/tests, ServiceEditor integration, actual scrolling Modal, library implementation, package scripts, and lockfile delta. No nested AGENTS files were found under the reviewed source/docs paths. GraphFlow MCP/CLI were unavailable; targeted source reads and an explicit audit plan were used. No implementation edits, installs, commits, pushes, paid providers, production data, or remote actions were performed. This report is the only authorized repository write by this session.

## Confirmed finding

**P2 — Catalog refresh could crash the open editor; resolved.** In the initial `web/src/components/HostedToolBinding.tsx`, the virtual option callback obtained `catalog.get(id)!` and then read `tool.name`. Headless UI updates its virtual options in a layout effect, so it can render a previous option ID with the current catalog for one render. Opening catalog `[1, 2]` with selected `[1]`, then replacing the tools prop with catalog `[2]`, caused the real component and installed Headless UI to throw `TypeError: Cannot read properties of undefined (reading 'name')`, instead of preserving the removable `Missing tool #1` chip. ServiceEditor refreshes `/tools` on opening and service changes; an old catalog can remain visible until the new response arrives. This was a regression from the checkbox renderer and a missing-value/lifecycle gap relevant to AC5/AC8.

Reproduction: `TSX_TSCONFIG_PATH=web/tsconfig.json node --import tsx /tmp/f002-code-audit-probe.mjs`, run from the repository root. The probe uses the actual component and real installed Headless UI in jsdom, with synthetic tools, local state, and a mocked language fetch. The initialized probe exited 1 with the component error at line 86. Two earlier harness-only attempts failed before testing this transition because the standalone loader used the wrong JSX config and lacked window animation-frame support; those were corrected and are not product findings.

The implementation agent fixed this by rendering a disabled missing-option fallback until virtual configuration catches up, applying a virtual disabled predicate for absent catalog IDs, and guarding the selection handler against adding newly absent IDs while retaining existing missing bindings. The callback still returns an element, satisfying the library's `cloneElement` requirement. A new regression covers an open catalog `[1,2]` changing to `[2]`, selecting the remaining tool while preserving the missing chip, then changing to `[]`, pressing Enter safely, and removing a missing chip with focus return. The original independent probe now exits 0 and reports that catalog removal preserved the missing binding without an error.

## Verification performed

Environment: Darwin arm64, Node `v22.22.2`, npm `10.9.7`.

| Exact command | Result |
| --- | --- |
| `npm run test:web` | Initial pass: 7 files/56 tests (2.91 seconds). Post-fix independent pass: 7 files/57 tests (2.69 seconds). |
| `npm run typecheck` | Passed both before and after remediation: server and web `tsc --noEmit`, exit 0. |
| `npm ls @headlessui/react @floating-ui/react @tanstack/react-virtual --depth=3` | Passed: installed Headless UI 2.2.10, Floating UI React 0.26.28, React Virtual 3.14.13 match the reviewed lockfile. |
| `git diff --check` | Passed before and after remediation, exit 0. |
| `TSX_TSCONFIG_PATH=web/tsconfig.json node --import tsx /tmp/f002-code-audit-probe.mjs` | Initially exited 1 with the confirmed component crash; post-fix independent recheck exited 0. |

Root server tests, build, npm audit, npm ci, and browser/manual validation were not rerun by this audit session. Their release/acceptance evidence must come from the implementation and browser-validation sessions; none is inferred here. Root typecheck and full web tests are the source-relevant gates explicitly delegated to this reviewer.

## Acceptance criteria and test adequacy

| AC | Audit assessment |
| --- | --- |
| 1 — existing-tool search/open/empty states | Real Headless UI multiple Combobox is used. Name/description matching is case-insensitive; empty and no-result states, registration link, and no arbitrary typed option are covered. Search emits no network requests. |
| 2 — stable IDs/chips/consecutive additions | Controlled values and option values remain numbers. Incoming/catalog IDs are deduplicated. Pointer selection, Enter selection, query reset, chip creation, focus return, and consecutive additions have automated evidence. |
| 3 — bulk union/clear/safe empty actions | Tests cover filtered union, empty-query union, clearing missing IDs, disabled/empty actions, and pointer/keyboard bulk activation after blur. The filter is retained until activation, addressing the earlier reset-on-blur bug. |
| 4 — 63/64/65 atomic cap | Boundary-value tests cover reaching 64, rejecting individual/bulk additions over 64, rejecting a two-item batch at 63 without partial selection, and removal at/above the cap. Existing over-limit input can be reduced without silently truncating IDs. |
| 5 — deduplication/disabled/missing values | Static deduplication and preservation of disabled/missing bindings are tested. Disabled registered tools remain bindable and visibly marked. The catalog-refresh crash is fixed, with new transition coverage and a passing independent reproduction. |
| 6 — keyboard/accessibility/disabled state | Headless UI owns arrows/Enter/Escape/Tab and active/selected semantics. Tests verify accessible label, help/error `aria-describedby`, `aria-invalid`, named remove buttons, and input focus return. The error uses `role=alert` and is inside the bordered control. Virtual mode remains active at zero results; the stale-Enter regression test passes. Native disabled fieldset semantics cover configuration controls; the selection handler also guards disabled callbacks. Browser keyboard/screen-reader behavior is outside this session. |
| 7 — Modal clipping/viewport/long content/theme | Source uses an anchored portal, nonmodal dropdown, viewport padding, bounded option height, wrapping labels, and bounded chip scrolling with existing ink/teal styling. jsdom layout is synthetic; actual geometry/scrolling acceptance belongs to the independent visual/browser audit. |
| 8 — callback/server/config compatibility | `onIds(number[])` and ServiceEditor save contract remain intact. The existing collapse/expand save regression now uses the Combobox and still verifies IDs, stream mode, and attachment budget. Round/call configuration source is unchanged. No server/API/tool-policy source changed in this implementation; the concurrent policy task's declaration-only introduction must be preserved during later integration. |

The test selection follows equivalence partitions (name/description/case, empty catalog/results, duplicates, disabled/missing values), boundary values (63/64/65 and 63+2), and state transitions (focus/search/select/query reset/repeat, blur to bulk action, Escape, chip removal, collapse/expand/save). Independent probing discovered the missing catalog-update transition; the final test suite now covers it. Automated coverage does not itself establish browser acceptance. Duplicate-name and localized Combobox interactions are less explicit in unit tests; stable numeric values and bilingual source are clear, and these are suitable browser evidence items rather than separate proven defects.

## Dependency and scope audit

`web/package.json` pins the official `@headlessui/react` dependency to `2.2.10`. Lockfile version 3 adds 20 packages, all resolved from `registry.npmjs.org` with integrity hashes. No new packages are flagged with install lifecycle scripts. Registry package manifests contain development `prepare` scripts for `aria-hidden` and `tabbable`; these are not registry-tarball npm-ci install hooks. Existing package changes are limited to `tslib` becoming a runtime dependency and the web dependency declaration. Existing resolved versions were not rewritten. No unexplained package source, custom download hook, API/schema change, credential exposure, or tool execution path was found.

The descriptive temporary ID is `HYD-TOOL-SELECTOR`; historical roadmap F002/F003 retain their existing meanings. After both audits finished, the implementation agent renamed ticket/evidence paths consistently; references in this report were updated as bookkeeping, without altering the findings. The original probe command remains its actual historical filename. No branches were merged.

## Remediation and final state

The catalog-refresh finding is closed after source review, a passing independent reproduction, and a full 57-test web-suite/typecheck recheck. The earlier filter-on-blur, help/error association, and zero-result Enter fixes remain covered and pass. No additional implementation defects were established. Code is implemented and the delegated automated gates pass. Browser acceptance, other root verification gates, release status must be established by the responsible sessions; this code audit does not claim an accepted or released feature.
