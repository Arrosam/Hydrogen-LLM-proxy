# Independent browser audit — HYD-TOOL-SELECTOR

Audit date: 2026-10-03. Reviewer canonical agent session: `/root/independent_browser_audit`.

Dedicated Chrome session: `🔎 F002 Independent Audit`; reviewer-created tab `239481626`; Chrome browser ID `1`; extension instance `0f16f77a-97d3-42df-b94d-a2c42440ff34`. This reviewer is separate from the implementation agent and has not edited product code, committed, pushed, accessed a live backend/provider, uploaded artifacts, or touched another Hydrogen worktree.

Scope reviewed: `AGENTS.md`, `docs/development-workflow.md`, `docs/features/HYD-TOOL-SELECTOR.md`, `HostedToolBinding`, `ServiceEditor`, `Modal`, fixture, combobox tests, and existing ink/brand/font styles. Worktree HEAD at review start: `456901240021db0413577f4a08c1bc29e19854cc`; branch `codex/hosted-tool-combobox-20261003`. Product changes were uncommitted during this audit. The feature card names baseline `47397d97c209af695b7fc01ed376f2ddeaeda06b`.

Final feature identifier: **HYD-TOOL-SELECTOR**. The developer clarified that both F002 and F003 already belong to other work. After both audits finished, the implementation agent renamed ticket/evidence paths consistently; report references were updated as bookkeeping without changing findings. The closed browser session name records the original temporary label. This audit does not modify the policy task.

## Environment and method

- Actual Chrome browser, default viewport 1600 × 687, dark Hydrogen theme.
- Local Vite fixture `http://127.0.0.1:5187/test/browser/hosted-tools.html` renders the actual `ServiceEditor`, `HostedToolBinding`, and scrolling `Modal`. Fetch is intercepted by the fixture and save returns synthetic payload only. Tools use an unreachable loopback URL and are never executed.
- Native AX pointer/keyboard actions and documented CUA Playwright locators. Read-only DOM observations confirm chip labels/counts, input value/focus, expanded/active/selected state, and accessibility associations. Screenshots provide visual evidence separately from the functional observations.
- Risk plan: state transitions for focus/open/filter/add/remove/blur/reopen; equivalence partitions for name/description/no-results/empty/disabled/missing/large catalogs; 63/64/65 limit boundaries; narrow-layout inspection and unchanged save/configuration contract.

## Observed functional results

| Scenario | Actual result | Evidence |
| --- | --- | --- |
| Click and keyboard focus open | Input click opens; after Tab to streaming control, Shift+Tab returns input focus and immediately opens. Clicking focused input after Escape reopens. | Browser AX expanded state and `reviewer-desktop-open.jpg` |
| Name and description filtering | `ReFeReNcE` matched only lookup_customer by description; `LOOKUP` and `sUmMaRiZe` matched names case-insensitively. | AX option names/filtered counts |
| Existing selection toggle and no duplicates | Enter on lookup_customer removed ID 2; selecting it again returned one chip. Pointer/Enter additions did not duplicate existing IDs. | Chip labels/count changes |
| Consecutive additions | summarize_report then check_inventory added; each cleared query immediately, kept combobox input focused and left dropdown usable. | AX input value/focus and 2→3→4 chips |
| No-results Enter | `no_such_fixture_tool` displayed No matching tools, disabled bulk select, and had no active option. Enter added nothing; selection stayed at four and popup closed. Clicking input reopened the empty state. | `reviewer-no-results.jpg`; four unchanged chip labels |
| Filtered union by native pointer after Tab | Started with IDs 1–4; query `catalog_tool_1`, native Tab to streaming, native AX click Select all search results produced IDs 1–4 plus 10–18 (13 unique chips). | Read-only chip-label list and query cleared/focus input |
| Filtered union by native keyboard after Tab | From empty selection searched get_weather; Tab/Shift+Tab reached bulk button with query preserved; native Enter selected only get_weather. Searched translate, Tab/Shift+Tab reached bulk button; Enter preserved get_weather and added translate_text. | Focused bulk-button text, retained query, resulting two chip labels |
| Clear | Native Clear removed all 13 chips, showed 0/64, disabled Clear, returned focus to input. | AX/DOM count and focus |
| Chip keyboard removal | Escape then Shift+Tab focused Remove translate_text with visible ring; Enter removed it and returned input focus. | `reviewer-chip-focus.jpg`; one remaining chip |
| Arrow/Enter/Escape/Tab | Down/Down/Up set active descendant to lookup_customer, Enter added it. Escape closed only popup while editor remained; Tab closed popup and moved to Streaming delivery; focus return reopened. | Browser active ID/text and focused element |
| Interrupted/repeated modal flow | Synthetic Save closed editor; Reopen fixture showed original fixture IDs. Search/cancel/reopen restored IDs 1,2 and blank query; input still opened normally. | Browser state after Cancel/Reopen |
| 63→64 individual addition | count=65&cap=63, searched catalog_tool_64 and Enter: 64 chips, ID 64 present, blank query, previous error cleared. | DOM count/name |
| 65th individual addition | At 64, catalog_tool_65 Enter preserved 64 IDs and excluded ID 65; input invalid=true, retained query, alert visible above chips; described-by includes help and error IDs. | `reviewer-cap-error.jpg` |
| 65-item bulk atomic rejection | At 63, empty-query Select all against 65 tools left 63 unchanged with alert. At 64 after replacing ID 1 with ID 65, whole-catalog bulk left exact chip-label array unchanged. | Before/after serialized array equality, counts 63 and 64 |
| Removal at cap/recovery | Removing search_documents at 64 reduced count to 63, cleared error/query and focused input; adding ID 65 then succeeded to 64. | Browser counts/focus |
| 64-item bulk acceptance | count=64&cap=63, empty-query native bulk selected all 64 including ID 64 without error. | DOM count/name |
| Disabled/missing preservation | missing=1 begins with disabled ID 8 and missing ID 999. Added get_weather: both prior chips persisted with disabled/missing labels. | `reviewer-disabled-missing.jpg` |
| ServiceEditor contract/configuration | Changed stream mode final, rounds 12, calls 24; synthetic Save payload contained toolIds `[6,2]` and hostedTools `{streamMode:"final",maxRounds:12,maxCalls:24}`. | `reviewer-saved-payload.jpg` |
| Fresh replay after catalog-refresh fix | Reloaded fixture after source fix; additions, no-results Enter, missing removal, disabled binding, Clear, native keyboard filtered bulk and native pointer filtered union all still passed. Fresh cap replay selected ID 64 and rejected ID 65 at 64; alert/help associations remained correct. | Final `reviewer-cap-error.jpg`; browser observations |
| Missing chip removal and Clear | Native removal of Missing tool #999 preserved disabled_archive and get_weather, returned input focus. Reload then native Clear removed both disabled ID 8 and missing ID 999. | Post-fix chip-label lists, counts and focus |
| Explicit binding of disabled registered tool | Cleared selection, searched disabled_archive, Enter added one chip marked `(disabled)` and cleared query. | Browser chip text, blank query/input focus |
| 300-option catalog | Initially only 17 virtual option rows were mounted with a 240-pixel list. Native End scrolled to IDs 284–300, active descendant named catalog_tool_300. Enter added ID 300, kept focus and cleared query. | `reviewer-large-catalog.jpg`; rendered count 17 and scrollTop 12274 |
| Mobile long text | At 390×844, monthly name query produced the long ID 9 tool; its name and description wrapped inside a 215-pixel popup at x=80..295 and y=425..593. Document/body scroll widths stayed 390. Enter added its chip; Shift+Tab focused its named remove button, scrolled chips internally and Enter removed it. | `reviewer-mobile-long-option.jpg`, `reviewer-mobile-long-chip.jpg`, `reviewer-mobile-chip-focus.jpg` |
| Scrolling actual Modal with popup open | Native scroll on modal body moved input to y=100..128; popup repositioned to y=134..302 and remained usable outside the body clipping. Popup uses the Headless UI portal. | `reviewer-mobile-scrolled-popup.jpg`; read-only bounds/portal parent |
| Chinese labels/mobile cap | lang=zh showed translated field/help/bulk/chip labels. At 64, Enter on ID 65 preserved 64 chips and showed the complete Chinese alert above the chips, within the 390×844 viewport. | `reviewer-mobile-zh-cap.jpg`; help/error described-by IDs |
| Standalone disabled component | All fieldset input/select/button controls matched `:disabled`. Native attempts to click Clear, remove a chip and open combobox plus Down/Enter did not mutate two IDs or progress/8/16 config; popup stayed closed. Fixture mutation guards and browser error log remained quiet. | `reviewer-disabled-control.jpg`; unchanged chip/config observations; error log `[]` |
| Empty catalog | count=0 preserved missing IDs 1 and 2, showed No matching tools, disabled bulk and a registration link to `/tools`. Enter added nothing. Clear removed all missing chips; Escape revealed registration link and 0/64 state. | `reviewer-empty-catalog.jpg`, `reviewer-empty-catalog-cleared.jpg` |
| Incoming legacy 65 bindings | count=66&cap=65: individual ID 66 rejected at 65; empty-query bulk preserved the exact 65-chip array. Native removal of ID 1 reduced to 64, cleared error/query and returned input focus. | `reviewer-legacy-65-cap.jpg`; exact before/after equality and 65→64 count |

## Visual assessment and adjacent limitation

Desktop control, chips, bulk buttons and dropdown use the established ink surfaces/borders, teal selected/focus state, Inter/system typography and compact spacing. The cap state has an explicit red border and alert above the scrollable chips, so the downward popup does not hide the error. The dropdown overlays the actual modal body and stays within the viewport. 64 chips use a bounded internal scroll area rather than extending the full editor.

Long option text and chips wrap inside the mobile control. Chip and option lists scroll independently; keyboard focus reaches the long-name chip removal button. Chinese cap feedback remains readable without being covered by the popup. Disabled controls visibly dim and do not mutate state. Hydrogen only exposes a dark theme in this source; a light theme was not applicable.

**Adjacent mobile limitation:** at 390×844, the existing ServiceEditor footer's five action buttons extend left beyond the viewport: Raw JSON is hidden and Validate is partly clipped in English, while Save/Cancel remain visible. Chinese footer buttons also wrap densely. See the mobile screenshots. `Modal.tsx` and the ServiceEditor footer layout are unchanged by this feature, so this is an existing source-layout issue outside the combobox change. The reviewer did not render a separate historical baseline, so classification is based on the unchanged footer source, not an independent before/after browser comparison. This does not block the tested hosted-tool control, but it warrants a separate narrow-footer follow-up.

## Tool limitations and evidence boundaries

- The developer identified that CUA semantic locator click may mis-hit after scrolling this Modal. This reviewer used fresh native AX indices for bulk pointer checks and verified results; no locator mis-hit is recorded as a product defect. One reviewer AX-index parse used a diff lacking the unchanged target and was rejected before clicking; obtaining the full fresh AX tree resolved it without changing the product.
- Catalog/incoming duplicate fixtures are not exposed by this browser fixture. Source/test review covers duplicate-ID construction; actual browser review covers repeated toggle/addition and resulting unique chips. No hidden React state or DOM was injected to manufacture fixtures.
- Mid-audit the developer reported a stale virtual row crash when a catalog prop removes an option while the dropdown is open. The reviewer paused, read the final fallback/virtual-disabled/selection guard, then reloaded before remaining checks and replayed the ordinary flows. The fixture has no UI catalog-refresh trigger, so the exact prop-refresh transition is covered by the developer's regression and independent code audit, not claimed as an actual-browser execution here.
- Actual screen-reader speech, other browsers, physical mobile/IME behavior, a live backend, provider/tool execution and owner personal visual acceptance were not exercised. They are not inferred from screenshots. Backend/tool execution is outside this UI change and was deliberately excluded by the authorized synthetic-fixture scope.
- Automated full-gate execution and code-audit results belong to the parent/relevant reviewer reports; this browser reviewer did not independently run those suites.

## Verdict and cleanup

**PASS for the authorized real-browser functional and visual scope of HYD-TOOL-SELECTOR.** No blocking feature defect observed after the final catalog-refresh fix. The adjacent narrow-footer issue and the evidence boundaries above remain explicit. This verdict is an independent browser review, not owner acceptance or a release claim.

Sixteen reviewer JPEG screenshots were saved and checked as valid files: eleven at 1600×687 and five at 390×844. Browser screenshots were visually inspected at their relevant states. The original six desktop screenshots were captured before the catalog-refresh fix; the final cap screenshot and remaining states were captured after reload, and the refresh fix does not change their visual styling.

Temporary viewport override reset and confirmed at 1600×687. Only reviewer-created tab `239481626` was explicitly closed; a final tab listing confirmed it absent. Ticket/evidence identifiers were renamed consistently by the implementation agent after this audit finished.

Final status: browser scope tested and reviewed; owner personal visual acceptance pending; not released.
