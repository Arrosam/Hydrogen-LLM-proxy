# HYD-TOOL-POLICY follow-up — Parameter overrides fieldset

Status: implemented, freshly tested and locally accepted after independent code/test and live visual/functional review; not released. This card's scope and AC were recorded before source edits.

Owner-approved inspiration: the actual `stage-advanced-inherit.jpg` screenshot shows Parameter overrides as a compact inset panel above the outlined Upstream step policy fieldset. Match the outlined grouping and dark-theme spacing while retaining editing behavior.

Baseline: `8c12ff24b72767bcc7b0438a4091c36e7ecddccc`, branch `codex/hydrogen-tool-policy-preview`, worktree `/Users/samuel/Documents/Codex/2026-10-03/task-11/hydrogen-tool-policy`. Preserve that commit; create a separate local follow-up commit. Prior cloud results concern that exact baseline and do not validate this follow-up.

## Scope and AC

1. Parameter overrides uses the existing policy fieldset's outline, legend typography and padding, with readable hint, modes and input spacing in the dark theme. Actual local before/after screenshots support visual acceptance.
2. Fields and JSON modes retain parameter/content coercion, add/remove controls and edits across mode transitions. Existing request/save semantics stay unchanged; verify real browser save, reload, validation and recovery with synthetic data.
3. The fieldset is named accessibly, controls remain keyboard-operable, and the grouping and rows remain usable at desktop and narrow widths. Check empty and populated Fields plus JSON states. The shared editor's existing Model Service and Micro Agent consumers retain their controls.
4. Full repository typecheck/tests/build and diff checks pass; independent review assesses the bounded change and actual visual/functional evidence before a separate local commit.

Exclusions: policy behavior, tool execution, schema, dependencies, release pipeline, HostedToolBinding selector, broad UI redesign, new abstraction/component hierarchy and unrelated edits. Reuse the shared editor directly; no new component layer. No source/screenshot upload is authorized for this changed batch. No push, release, production request or paid inference.

Compatibility/data: presentation and semantic grouping only; existing admin authorization, request serialization, parameter semantics and persistence remain. Use the existing disposable SQLite fixture, synthetic credentials and loopback fake provider. No recipient or retention change. Rollback is a revert of the follow-up commit.

Risk-based validation: empty/populated Fields and valid/editing-invalid JSON are equivalence partitions; desktop/narrow available widths are layout boundaries; Fields → JSON → Fields → validate/save → reload and save failure → retry are state transitions. Existing coercion regressions and focused integration checks address accidental control/persistence changes. Do not test CSS class implementation details.

## Evidence and final state

Implementation is confined to JSX grouping and layout in the existing shared `OverridesEditor`; coercion, handlers, state and request serialization are unchanged. Model Service steps, Micro Agent stages and OCR advanced settings use that shared editor without a new component layer.

Fresh local gates on the follow-up source: `npm run typecheck` passed; `npm test` passed **1,633 server tests / 80 files, 83 web tests / 8 files, 9 release tests**; `npm run build` passed with the existing large-chunk advisory; `git diff --check` passed. Node v22.22.2 and npm 10.9.7; lockfile SHA-256 remains `3df96a79c6d76560baa49560f2884b7f3b61a6b39cf1be22e4dfab4c3194c2d2`. Fresh logs are outside the repository in `/Users/samuel/Documents/Codex/2026-10-03/task-11/evidence/overrides-fieldset-{typecheck,full-tests,build}.log`. The root integration test adds Fields → JSON → Fields → remove → collapse → save coverage with unchanged policy inheritance. These are fresh local results; parent cloud checks for `8c12ff24` do not validate this follow-up.

| AC | Local evidence | Result |
| --- | --- | --- |
| 1 | Actual 1280×720 browser [before](validation/HYD-TOOL-POLICY/overrides-fieldset-before.jpg) and [after](validation/HYD-TOOL-POLICY/overrides-fieldset-after.jpg); legend, border, padding, hint and modes inspected | Pass |
| 2 | Real browser keyboard Add/Fields/JSON/Remove, typed numeric and object edits, invalid temperature Validate/Save → correction → successful save → reload; [populated screenshot](validation/HYD-TOOL-POLICY/overrides-fieldset-populated.jpg); [real HTTP counter evidence](validation/HYD-TOOL-POLICY/overrides-fieldset-functional.json) confirms saved `temperature: 0.5`, removed extra absent, one fake-provider request and zero adapter requests | Pass |
| 3 | Named fieldset in actual AX; keyboard mode/add/remove activation and parameter → content → Remove Tab order; actual 375×812 empty Fields, populated Fields and JSON views inspected independently; [narrow Fields](validation/HYD-TOOL-POLICY/overrides-fieldset-narrow-fields.jpg) and [narrow JSON](validation/HYD-TOOL-POLICY/overrides-fieldset-narrow-json.jpg). Fieldset client/scroll widths both 258px; control edges stay within its border. Viewport override reset after review. Shared callers/handlers unchanged. | Pass within stated scope |
| 4 | Fresh full gates above; independent AGENT SESSION `/root/overrides_fieldset_review` (`gpt-6.1-sol`, max) reviewed source/test diff, independently passed 83 web tests / 8 files, used its own actual browser tab and a separate fixture service, inspected before/after and narrow images, and found no new blocking issue | Pass |

Manual environment: macOS arm64, Codex in-app browser, fresh disposable SQLite database, synthetic admin credentials, loopback fake provider. The initial fixture served the baseline build for the before screenshot; a new fixture process registered the rebuilt asset hashes for the after screenshots. The old process's startup-time static-route inventory required this restart after rebuild; no application source change was added for that unrelated fixture lifecycle behavior. No paid or external inference/adapter calls occurred.

Independent live functional coverage additionally included typed numbers/objects/text/arrays/booleans, keyboard mode/add/remove controls and Tab order, invalid temperature Validate and Save preserving the editor, correction/retry, save toast, reload/reopen persistence, removal of a boolean row and adjacent policy inheritance. Its separate No binding fixture persisted temperature `0.5`, stop `["END"]`, user `"review-text"` and nested extra `{fixture:"kept"}`, with removed `logprobs` absent. This is independent live validation, in addition to its screenshot inspection and automated tests.

Existing behavior retained: incomplete/invalid JSON drafts remain editable without replacing the last accepted overrides object; Validate/Save use that accepted object until valid object JSON is entered. Both root and independent reviewer observed this. The surrounding modal's translucent backdrop remains unchanged. At 375×812 the unchanged modal footer clips Raw JSON and part of Validate; the refined fieldset and its controls fit without horizontal overflow. These existing behaviors are outside the scoped styling follow-up. Actual live validation covered Model Service step editors; Micro Agent/OCR uses share the unchanged controls and handlers but were not separately exercised in the browser. No live provider, Android/device or container acceptance is claimed.

Final state: implemented **yes**; fresh local full gates **passed**; scoped local AC acceptance **supported** by independent review and actual browser/HTTP evidence; no new unresolved blocking finding; released **no**. A separate follow-up commit preserves `8c12ff24`. No release or artifact transfer performed.
