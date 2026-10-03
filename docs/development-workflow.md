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

Root `npm test` runs server then web, so a server failure prevents the web command; run `npm run test:web` separately when needed and report both. Subset tests are diagnostic evidence, not the full gate. Root typecheck similarly runs server then web. There is no root lint script. `npm run db:generate` exists but changes migrations and is not a default baseline check. Development/start commands can bootstrap credentials and persistent data; they are not validation shortcuts.

Use a sanitized environment, temporary databases and synthetic test credentials. The repository's HTTP tests bind loopback and set private-upstream allowances inside the test process; this does not authorize persistent application security changes. If the sandbox blocks sockets or native builds, record the failing command and request only the narrowly required authorized execution capability. Never use an existing live server as a workaround. Do not print secrets. A fresh main may have failures: retain them and distinguish baseline defects from environment restrictions and change regressions.

For UI changes, automated tests do not replace stage 5. Validate a disposable instance with local mocks only after checking startup configuration and data paths. No paid providers, real adapter writes or production credentials. Record any unrun browser/Android/container/live checks rather than inferring success from release notes.
