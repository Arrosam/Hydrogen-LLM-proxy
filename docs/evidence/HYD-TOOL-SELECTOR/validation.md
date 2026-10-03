# Hosted tool selector validation

Temporary local ticket ID: **HYD-TOOL-SELECTOR**. Historical roadmap F002/F003 retain their existing meanings. The concurrent policy ticket uses HYD-TOOL-POLICY; no branches are merged. Actual GitHub issue numbers will be assigned later.

## Environment and commands

macOS Darwin arm64, Node `v22.22.2`, npm `10.9.7`. Baseline `47397d97c209af695b7fc01ed376f2ddeaeda06b`; branch `codex/hosted-tool-combobox-20261003`. React/ReactDOM `18.3.1`, TypeScript `5.9.3`, Vite `8.3.1`, Tailwind `3.4.19`, Headless UI React `2.2.10`. Official npm peer range supports React 18. No existing locked package version changed; 20 official-registry transitive packages were added. `tslib` moves from development-only to runtime metadata because of the new dependency.

Baseline install: `npm ci --ignore-scripts --cache /tmp/hydrogen-ui-npm-cache`, followed by explicitly reviewed `npm rebuild argon2 better-sqlite3 esbuild --cache /tmp/hydrogen-ui-npm-cache`. Reviewed lifecycle scripts: argon2's node-gyp-build, better-sqlite3's prebuild-install/local node-gyp build, esbuild's install.js; fsevents optional installation is not required for tests. Official sources only. Baseline lockfile SHA256 `3df96a79c6d76560baa49560f2884b7f3b61a6b39cf1be22e4dfab4c3194c2d2`.

Approved dependency install: `npm install @headlessui/react@2.2.10 --save-exact --workspace web --registry=https://registry.npmjs.org --cache /tmp/hydrogen-ui-npm-cache`. Resulting lock SHA256 `d729387152d3fa26330d8950d82fa3bf8ed06da028a5fedc5132b3abc5a93daa`.

| Gate | Actual evidence | Result |
| --- | --- | --- |
| Baseline `npm run typecheck` | Server and web tsc completed before UI implementation; `/tmp/hydrogen-ui-baseline-typecheck.txt` | Pass |
| Baseline `npm test` | 75 server files / 1,462 tests, 6 web files / 42 tests; `/tmp/hydrogen-ui-baseline-tests.txt` | Pass |
| Feature `npm test` | 75 server files / 1,462 tests (144.70s), 7 web files / 56 tests (2.54s); `/tmp/hydrogen-ui-final-tests.txt` | Pass |
| Post-visual-fix `npm run test:web` | 7 files / 56 tests (2.57s); `/tmp/hydrogen-ui-web-tests.txt` | Pass |
| Post-visual-fix `npm run typecheck` | Server and web tsc completed; `/tmp/hydrogen-ui-typecheck.txt` | Pass |
| Post-visual-fix `npm run build` | Vite production web + both server bundles; `/tmp/hydrogen-ui-build.txt` | Pass; large-chunk advisory reported |
| Final catalog-refresh `npm test --workspace web` | 7 files /57 tests (2.68s); `/tmp/hydrogen-ui-post-refresh-tests.txt` | Pass |
| Final catalog-refresh `npm run typecheck` | Server and web tsc completed; `/tmp/hydrogen-ui-post-refresh-typecheck.txt` | Pass |
| Final catalog-refresh `npm run build` | Vite production web and both server bundles; `/tmp/hydrogen-ui-post-refresh-build.txt` | Pass |
| Final-source full `npm test` | 75 server files /1,462 tests (144.77s), 7 web files /57 tests (2.57s); `/tmp/hydrogen-ui-final-source-tests.txt` | Pass, exit0 |
| `npm audit --json` | Five high findings: braces/chokidar/fast-glob/micromatch/tailwindcss; `/tmp/hydrogen-ui-audit.json` | Nonzero (existing dependency baseline); no new package affected |
| `git diff --check` | No whitespace errors after fixes | Pass |

Initial new tests failed because jsdom supplies zero layout/does not emit native option mousedown from fireEvent.click. A scoped test helper provides only scroll geometry, scrollTo and ResizeObserver; tests now exercise the actual Headless UI virtualizer and mouseDown handlers. No product/library implementation is mocked. Browser validation remains separate. Tests retain the ServiceEditor save assertion for exact IDs/config after collapsing and reopening Advanced.

## Root browser observations

Chrome extension browser, default viewport `1600 × 687`, responsive override `390 × 844` (reset afterward). Disposable Vite port **5187**, started with `npm run dev --workspace web -- --host 127.0.0.1 --port 5187 --strictPort`. Strict port and loopback prevent collisions; sandbox loopback restriction needed narrowly reviewed execution escalation. No Hydrogen backend starts. `web/test/browser/hosted-tools.html` imports the real ServiceEditor/Modal and uses a synthetic catalog plus fully intercepted API fetch; any unexpected API request throws. The URL `http://127.0.0.1:1/never-called` is synthetic and never called. This proves real browser interaction/layout and frontend save payload, not actual persistence on a running backend or paid tool execution.

| Scenario / AC | Observed actual behavior | Evidence |
| --- | --- | --- |
| Before / AC7 | Checkbox list visually inspected inside the scrolled ServiceEditor Advanced section, 18 synthetic tools | `before-checkbox-list.jpg` |
| Focus/click/search/chips / AC1–2 | Input opens library listbox; report search finds summarize_report and long inventory report tool; native filtered Select all unions `[1,2]` to `[1,2,3,9]`; successful additions clear query, focus input, keep expanded | `after-combobox-desktop.jpg`; DOM focus/aria-expanded observed |
| Description/case / AC1 | INVENTORY finds check_inventory plus long description/name; description to verify matches long tool; keyboard bulk after Tab unions only those results | `after-long-description-desktop.jpg`; visible selected IDs |
| Keyboard / AC6 | ArrowDown/Enter selects get_weather; Escape closes; click reopens while input remains focused; Tab moves to Streaming delivery, closes popup, retains query; Enter on bulk unions filter | AX snapshots and selected chips |
| No results / AC1,6 | No matching tools status, Select all disabled. After prior active selection, zero-result Enter closes without changing IDs | `after-no-results.jpg`; regression test |
| Clear / AC3 | Clear removes all chips, displays 0 / 64, becomes disabled; current query clears and input focuses | Visible counter/AX state |
| Cap / AC4 | 63 → 64 individual succeeds; attempting ID65 at 64 is rejected, counter stays64, input invalid and help/error IDs resolve. Removal at64 succeeds and clears error | `after-cap-rejection.jpg` |
| Atomic batch / AC4 | From IDs1..63, catalog_tool_6 matches IDs60..65; native bulk click rejects union65, keeps exactly63 chips; no partial addition | `after-atomic-batch-rejection.jpg`; DOM remove-button count63 |
| Disabled/missing / AC5,8 | `[8,999]` remains visible as disabled_archive (disabled) and Missing tool #999; adding summarize_report yields `[8,999,3]`. Synthetic frontend save payload preserves exactly those IDs and `hostedTools:{streamMode:'final',maxRounds:8,maxCalls:16}` | `after-disabled-missing-bindings.jpg`; rendered saved fixture JSON |
| Disabled whole control / AC6–7 | Input, chevron, chips, bulk actions and config controls expose disabled state; no mutation available | `after-control-disabled.jpg`; DOM isEnabled=false |
| Long text/narrow / AC7 | Chip name wraps; full long name and description wrap in215px popup. Popup scrollWidth213 equals clientWidth213; no horizontal overflow | `after-narrow-long-name.jpg` |
| Modal scrolling / AC7 | Native parent scroll moves anchored popup top from537 to134 while preserving list and viewport containment. Portal popup escapes card-pad clipping | `after-narrow-modal-scroll.jpg`; measured DOM rectangles |
| Virtual catalog / AC1,6–7 | 300 tools render17 options initially. End scrolls to284..300; Enter binds stable ID300, preserves prior1/2, shows3 /64 | `after-virtual-catalog.jpg`; DOM/AX list positions |

Automation limitation: the Chrome semantic click helper can recenter a scrolling modal before clicking and occasionally hit a visible option instead of the requested bulk toolbar. The incorrect changes were detected, state was reset, and native AX/screenshot-grounded clicks verified the intended pointer interactions. This was not treated as passing evidence; native rechecks passed. No HTTP-only check was used for visual acceptance.

Only Hydrogen's existing dark theme is supported. There is no light-theme toggle/style system to validate. The unchanged ServiceEditor footer overflows horizontally at390px; this is adjacent layout outside the requested UI change. Its classification is based on unchanged footer source, not an independent historical mobile render. Selector chips/list/input stay contained. Chromium was tested; Safari/Firefox and a screen-reader session were not run. Independent agent browser review is recorded separately; owner personal visual acceptance remains pending.

## Findings and rechecks

1. Independent source review found blur clearing the filtered bulk action and unassociated help text. Fixed by preserving query across close/blur until successful selection and using Headless UI Field/Label/Description; pointer and keyboard regressions pass.
2. Root browser found zero-result Enter selecting a stale active option when virtual mode was disabled. Fixed by always supplying virtual options (including an empty array) and rendering empty status through the library's forwarded options root. Independent probe and real-browser post-fix repeat pass.
3. Root visual inspection found bottom popup covering the rejection message. Moved the library error Description inside the bordered control above chips; screenshot shows the clear error without closing popup. Post-fix web56, full typecheck/build pass.
4. Final independent max code audit reproduced a refresh crash: Headless UI briefly rendered an old virtual ID after its tool disappeared, and the current catalog lookup used a non-null assertion. Fixed with a disabled missing fallback element, current-catalog virtual disabled predicate and new-ID selection guard. Existing missing bindings stay visible/removable. New open-refresh regression covers `[1,2] → [2] → []`, remaining-tool selection, empty Enter and removal focus; final web57/full typecheck/build pass. Reviewer post-fix probe is recorded in its report.

No tests were removed, weakened or bypassed. No server semantics, settings, schema, tool policy or production operations changed.

## Independent final reviews

| Separate agent session | Model / effort | Final result and evidence |
| --- | --- | --- |
| `/root/final_code_audit` | `gpt-6.1-sol` / `max` | Pass after catalog-refresh remediation. Original reproduction now exits0; independent web57, full typecheck and diff checks pass. See [code audit](reviewer-code-audit.md), including reviewed Git blob IDs. |
| `/root/independent_browser_audit` | `gpt-6.1-sol` / `xhigh` | Pass after fresh source reload/replay. 16 screenshots and actual native Chrome checks cover keyboard/bulk/cap/legacy65/disabled/missing/empty/mobile/Chinese/300-options/save flows. See [browser audit](reviewer-browser-audit.md). |

An earlier separate source-review session `/root/independent_ui_review` found blur/filter and association gaps, then rechecked relevant32 tests and source after fixes. It did not perform browser validation. The two final reviewers above independently own the final code and browser scopes.

Browser duplicate-input and exact catalog-prop-refresh transitions rely on automated source/probe evidence because the fixture exposes neither transition as an interface action. The browser reviewer explicitly records this boundary. Screenshots are indexed in [screenshots.md](screenshots.md); 27 actual JPEG files are retained. Owner personal visual acceptance is pending. No blocking feature findings remain in the final reviews. No release is claimed.

## Artifact delivery

All 27 JPEG screenshots were offered as one ordered create batch using the current Library skill's freshly downloaded helper and companions. The operation exited1 before returning results: Library saving is unavailable to that helper in this local execution environment. No Library save is confirmed. The skill forbids switching a started helper write to direct actions; no retry or duplicate upload was attempted. Local screenshot files, their index and both independent review reports remain complete and tracked for owner inspection.

An attempted cross-thread milestone message was rejected by automatic approval review because it lacked direct human authorization for messaging that thread. No message was sent and no retry/bypass was attempted. Progress remained in this task; the platform's automatic final handoff notifies the parent without a cross-thread send. This did not interrupt implementation/tests/review.

## Integration overlap

Read-only snapshot of concurrent `codex/hydrogen-tool-policy-preview`: shared product-source file **`web/src/components/HostedToolBinding.tsx` only**. That task changes the introductory English/Chinese copy from automatic injection to declaration-only availability. Preserve the policy task's copy when combining the selector; resolve this one component deliberately. UI branch does not edit ServiceEditor, i18n or types (the policy branch does). Both carry identical AGENTS.md; policy workflow documentation has additional release implementation and must be preserved during integration. UI-only dependency/test/fixture/ticket changes are otherwise separate. Snapshot may change as the policy task continues; recheck at integration.

HYD-TOOL-SELECTOR is a local tracked ticket. GitHub Project/remote ticket remains blocked on pending OAuth approval; no remote ticket, push, merge, release or deployment is claimed.
