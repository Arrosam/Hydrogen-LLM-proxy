# HYD-PREVIEW-DEPENDENCIES — Preview build dependency remediation

Status at candidate preparation: implemented; final exact-commit verification and independent acceptance pending. Temporary descriptive card ID; no existing roadmap ID is changed.

## Inspiration, baseline and accepted scope

The combined local `2.3.0-preview.1` at `2426033a315f7279683eac67ab42cf92b0e956cd` passed aggregate functional checks but failed full npm audit. One inherited advisory, [GHSA-vfj7-8cjw-p6xm / CVE-2026-93687](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), affects `braces <=3.0.3` through recursive stack exhaustion. It propagates into five high package records: braces, chokidar, fast-glob, micromatch and Tailwind. The paths originate in the web build/dev dependency `tailwindcss@3.4.19`; those packages are absent from the tested production runtime image. Build scope does not waive the full audit gate.

Official registry/independent review found no published compatible patched version. A manifest-only scratch Tailwind 4 graph audited clean, but application and visual acceptance had not been performed. The owner explicitly accepted the bounded `tailwindcss@4.3.3` + `@tailwindcss/postcss@4.3.3` migration, Safari 16.4+/Chrome 111+/Firefox 128+ support, the historical-session exception, and audit dependency-name/version export to registry.npmjs.org. Approval: 2026-10-04 04:40 UTC, owner message `Sentinel_3fd3a9393d988191a5cc8f0d09b5f741`, source thread `01a0fa97-234d-744a-b992-afc652f53017`.

Keep Vite, React, backend routing and the four integrated ticket contracts. Replace the existing PostCSS plugin, remove redundant Autoprefixer, use Tailwind's import/config/source directives and preserve the dashboard theme. Shared buttons, inputs/selects and badges use grouped ordinary component selectors so custom-class `@apply` chains do not change layer precedence. Preserve used Tailwind 3 status colors, radius/shadow scales, pointer cursor and default border behavior. Use `outline-hidden` for the former transparent focus outline. No redesign, F002, provider call, database access, OAuth expansion or production deployment is included.

## Acceptance criteria and risk plan

1. Commit one reviewed official-registry lockfile with synchronized `2.3.0-preview.2` root/server/web metadata. Remove all vulnerable transitive paths; inspect new package/lifecycle/native-platform records. Full unfiltered npm audit must pass.
2. Mac Node 22 committed-lock installation, complete server/web/release tests, typecheck, build and strict fixture checks pass on the final SHA. Existing HTTP 78, official MCP SDK 12 and combined HTTP/SDK 15 scenarios run against that SHA; original branch results are context only.
3. Preserve observed theme/control styling and real desktop/narrow functionality. Validate shared button/input/select/badge composition and size overrides, all modal footer actions, anchored long-name lists, keyboard/focus, cap 63/64/65, repeated/interrupted selection, save failure/retry/reload, policy/parameter fieldsets and affected global pages. Record actual screenshots, observations and untested variants.
4. Separate English Sol 6.1 max code and ISTQB reviews assess final source/dependency/data boundaries and coverage. A Sol xhigh browser session validates built assets; fix concrete findings and retest the final code.
5. Freeze supported snapshot-bearing sessions; historical used identities without snapshots return native 409/new-session without deleting records or fabricating configuration, under the accepted AC7 exception. An unused conversation may capture its initial configuration. Recheck zero model/adapter calls on historical refusal.
6. Preserve the local-only preview.1 tag and original branches. Publish preview.2 only after all gates pass. Verify remote SHA/tag, required Actions, GitHub prerelease/latest flags, GHCR digest and disposable runnable image. Never mutate stable/latest or deploy production.

ISTQB techniques: equivalence partitions for shared controls and lifecycle classes; boundary values for viewport and binding limits; decision tables for style/state and policy inheritance; transitions for search/add/remove/interruption and save-error/retry/reload. Compare old compiled assets/screenshots with new rendering, not jsdom alone. Validate Mac arm64 and Linux amd64 native build dependencies. The original denied reviewer's literal call was unavailable after compaction; its exact retry status is recorded separately, and no flags are invented.

## Evidence, trust and rollback

Raw execution logs, independent reports, original/revised fingerprints and screenshots remain in the sibling task `evidence/` directory. Retain failed and superseded observations without claiming them as final passes. Current candidate verification and release completion are reported there and in the GitHub release handoff. Synthetic credentials, temporary SQLite data and loopback providers only. Audit sends package names/versions; source and credentials are not audit payloads. Rollback is reverting this bounded migration on the integration branch; preserve source branches, old tags and stored records.
