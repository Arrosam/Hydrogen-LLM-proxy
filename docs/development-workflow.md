# Development workflow

This workflow applies to Hydrogen. Hydrogen and Fishball are independent projects: each has its own purpose, roadmap, tests, acceptance and releases. Fishball is one application example of Hydrogen, not a required dependency in either direction. General interfaces may support interoperability; compatibility checks are required only for changes to an actually shared API contract and affected consumers, without mandatory joint acceptance or synchronized releases. This document does not change Fishball or introduce a new protocol. Small documentation and maintenance tasks may use a concise card in the final report; product changes require a durable card alongside relevant design documentation. F001 service-test disclosure remains proposed and is outside this baseline change.

## Six stages

1. **Inspiration:** record the user need and observable problem, with source/evidence. Suggestions are candidates, not permission for unrelated product changes.
2. **Triage and AC:** bound the first useful slice, exclusions, observable AC, compatibility, data/identity boundaries, risks, rollback and unresolved decisions. Resolve decisions that affect correctness before dependent implementation; continue independent authorized work.
3. **Development:** record starting SHA/branch and baseline health; implement only the card's scope. Preserve user changes and existing invariants. Use disposable fixtures; do not access production.
4. **Tests and review:** connect AC to tests/evidence. Apply ISTQB equivalence partitioning and boundary values for input classes/limits, decision tables for interacting conditions (roles/scope/consent), and state transitions for lifecycle/cancellation/retry. Choose techniques that address the actual risk, not every technique for every unit. Review both implementation and test omissions. Independent review is useful when available and authorized; otherwise label self-review and its limits.
5. **Manual interface/function validation:** exercise relevant real browser/client flows with isolated local fixtures. Check success, failure, cancellation, permissions and visible state as applicable. Record environment, expected/actual behavior and evidence (screenshots plus functional observations/counters). A screenshot does not prove a tool executed or data was deleted. Backend-only changes use observable local functional checks; explain why visual validation is not applicable. Blocked checks remain pending.
6. **Autonomous report:** summarize the result and evidence, risks/blockers and decisions. Distinguish implemented, tested (which scope), accepted (all AC supported), and released (explicitly authorized publication/deployment evidence). Completion of coding or automated tests alone does not imply acceptance or release.

Reference: ISTQB CTFL v4.0.1, sections 4.2 (black-box techniques) and 1.5.3 (risk-based prioritization): https://istqb.org/?download_id=3345&sdm_process_download=1 . This is a risk-informed engineering workflow, not a certification claim.

## Feature card

- ID/title/status; inspiration and evidence; owner/reviewer (label self-review).
- Baseline SHA/branch; problem and expected behavior; scope/exclusions.
- Observable numbered AC, each with test/manual evidence and result.
- API/client compatibility, categories/protocols, errors/timeouts/cancellation and rollback.
- Trusted identity/authorization, operator roles, tool side effects, quota/concurrency and version boundaries.
- Data sent to each recipient; local authority; log, Responses/conversation and cache persistence; retention/deletion/consent requirements.
- Risk-based test plan: input partitions/limits, interacting rules and lifecycle transitions as relevant.
- Manual scenarios/environment/expected/actual/evidence; blocked checks and unresolved decisions.
- Final state: implemented / tested scope / accepted or pending / released or not released.

## Release channel policy

This policy applies to future Hydrogen releases. The default channel is **preview**. Classify a specific release as **stable** only when the user explicitly designates that release as stable. Passing validation, version/tag names, merging to main, and authorization to publish or deploy do not themselves designate stability.

- Record the intended channel (`preview` or `stable`) in the release handoff, with the source of any explicit stable designation. When no stable designation is recorded, use preview.
- Apply the declared channel throughout the release pipeline, including automatic branch/tag builds, GitHub Releases, container/image publication and deployment. Publish previews as prereleases and never update stable/latest release or image pointers for a preview. Before any pipeline-triggering publication step, verify release metadata and mutable tags against the intended channel. If existing automation cannot preserve the declared channel, report the mismatch and obtain separately authorized workflow changes before publication.
- Preserve existing release classifications, including v2.2.3. This declaration does not authorize publication, deployment, version changes or CI/workflow edits.

### Local channel implementation (HYD-TOOL-POLICY)

The owner separately authorized local pipeline isolation in HYD-TOOL-POLICY. `.github/workflows/docker-publish.yml` uses the validated `scripts/release-plan.mjs` output. Automatic main and version-tag builds default to preview. Their mutable pointer is `preview`; branch/version and commit images are `preview-<ref>` and `preview-sha-<commit>`. Docker metadata explicitly sets `latest=false`, so automatic tag handling cannot create a stable/latest pointer. A `workflow_dispatch` with `release_channel: stable` is an explicit designation and must select a final `vMAJOR.MINOR.PATCH` tag. Only that path may emit the version, `stable`, and `latest` tags. The new helper refuses historical releases through v2.2.3 and tags longer than 100 characters. A future publication must select a new commit/tag containing this workflow. Historical tags contain their original workflow; dispatching at an old tag can still load its old rules. Do not dispatch, republish or reclassify existing releases to validate this change.

For a future preview, prefer the version convention `MAJOR.MINOR.PATCH-preview.N` and a matching `v` tag; neither a plain final-looking version nor a tag push implies stable. Keep root/server/web package versions and lockfile versions synchronized when a separately authorized version change occurs. No version is changed by HYD-TOOL-POLICY.

`npm run release:plan -- --ref refs/tags/v2.2.4-preview.1 --sha <full-commit-sha>` prints a local plan and never publishes. The plan includes the future GitHub CLI arguments: previews require both `--prerelease` and `--latest=false`, plus `--verify-tag`; stable plans require explicit dispatch and `--latest`. The repository currently has no automatic GitHub Release creation job. Any future authorized release creation must follow these flags and the recorded designation, using an exact notes file. Do not run a publication command merely to validate this plan. See the [Docker metadata flavor documentation](https://github.com/docker/metadata-action#flavor-input) and [GitHub release-create flags](https://cli.github.com/manual/gh_release_create).

## Reproducible local baseline

Run from an isolated checkout of a freshly fetched, recorded main commit. Record OS/architecture, `node --version`, `npm --version`, SHA and lockfile hash. CI currently uses Node 22, `npm ci`, typecheck, tests, build and audit in `.github/workflows/docker-publish.yml`; its publish job is separate. Do not trigger that workflow as a local verification shortcut.

Review root/workspace package scripts, lockfile sources and lifecycle scripts before installing. Use the committed `package-lock.json` and `npm ci`; do not use `npm install` for baseline reproduction. A staged `npm ci --ignore-scripts` followed by explicitly reviewed native-package rebuilds is acceptable if recorded. Native packages need their installation/build steps before meaningful runtime tests. Use only declared official package sources; stop on unexplained URLs or scripts. Exact lockfile dependencies do not make arbitrary install scripts trustworthy.

```sh
node --version
npm --version
npm ci
npm run typecheck
npm test
npm run build
npm audit
git diff --check
```

Root `npm test` runs server, web, then the local release-plan suite, so an earlier failure prevents later commands; run affected commands separately when needed and report each result. Subset tests are diagnostic evidence, not the full gate. Root typecheck similarly runs server then web. There is no root lint script. `npm run db:generate` exists but changes migrations and is not a default baseline check. Development/start commands can bootstrap credentials and persistent data; they are not validation shortcuts.

Use a sanitized environment, temporary databases and synthetic test credentials. The repository's HTTP tests bind loopback and set private-upstream allowances inside the test process; this does not authorize persistent application security changes. If the sandbox blocks sockets or native builds, record the failing command and request only the narrowly required authorized execution capability. Never use an existing live server as a workaround. Do not print secrets. A fresh main may have failures: retain them and distinguish baseline defects from environment restrictions and change regressions.

For UI changes, automated tests do not replace stage 5. Validate a disposable instance with local mocks only after checking startup configuration and data paths. No paid providers, real adapter writes or production credentials. Record any unrun browser/Android/container/live checks rather than inferring success from release notes.
