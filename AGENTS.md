# Hydrogen development rules

## Scope and baseline
- Read this file, applicable nested rules and the touched subsystem before editing. Follow the six-stage workflow in [docs/development-workflow.md](docs/development-workflow.md); use its feature card for product changes.
- For a new development baseline, start from a recorded, freshly fetched `origin/main` SHA in an isolated worktree/branch. Preserve existing checkouts, untracked rules and user changes. Port needed fixes deliberately; never merge an old audit branch merely to establish the baseline.
- Use Node 22 (at least 22.12), record Node/npm versions, and install the committed lockfile with `npm ci`. Review package/lifecycle scripts and resolved package sources first. Do not reuse another checkout's `node_modules` or silently update the lockfile.

## Workflow and evidence
- Capture inspiration, then triage the problem, scope, acceptance criteria (AC), risks and unresolved decisions before implementing. Execute already-authorized work autonomously; ask only for material missing decisions or actions requiring separate authorization.
- Implement a bounded change. Select ISTQB test techniques by risk and map each AC to evidence. Review correctness, regressions, security and data boundaries; record self-review honestly, never claim an independent reviewer that did not exist.
- Perform real interface and functional manual validation where relevant, using disposable data and mock/local providers. Unit/jsdom tests, screenshots alone and mocked transport are not real interface acceptance. Record blocked/not-run checks explicitly.
- Report implemented, tested, accepted and released as separate states, including SHA, commands/results, manual evidence, limitations and next decisions. Never remove tests, weaken assertions or bypass security to obtain a green result.
- Future Hydrogen releases default to preview. Classify a specific release as stable only when the user explicitly designates it as stable; validation, version/tag names, merging to main, or authorization to publish/deploy alone do not imply stability. Follow the release channel policy in the workflow and preserve existing release classifications.
- Verify with the actual package scripts: `npm run typecheck`, `npm test`, `npm run build`; run `npm audit` for dependency baseline changes. No `lint` script currently exists. See the workflow for scope and environment handling.

## Contracts and data
- Hydrogen and Fishball are independent products with independent roadmaps, tests, acceptance and releases. Hydrogen is an operator-configured AI service provider with its own uses; Fishball is one application example, not a required client or dependency. Hydrogen is not bound to Fishball, and Fishball is not required to depend on Hydrogen. They may interoperate through general interfaces.
- Only when a change affects an actually shared API contract, verify compatibility with affected consumers; do not require coordinated releases or joint acceptance. For relevant interface changes, specify compatibility, service/tool capabilities, trusted user identity, consent, failure/cancellation behavior, quotas and versions. API keys are not automatically end-user identities; model-supplied arguments cannot establish authorization.
- Specify data recipients, logs, Responses/conversation persistence, caches, retention and deletion separately. `store:false` does not prove zero persistence. Do not expose upstream credentials or internal configuration through public capability surfaces.
- Preserve existing role, scope, quota, SSRF, backup-integrity and protocol invariants. Use synthetic secrets and temporary databases in tests; do not read production secrets/data or invoke paid/live providers.
- Changes to persistent application security settings, permissions or real credentials, publishing, push, merge or deployment need separate authorization. Do not edit Fishball without inspecting its own rules and authorized scope.

## GraphFlow context guidance
- Preserve the local GraphFlow intent: use available `graphflow_context` before broad exploration and `graphflow_plan` for broad/ambiguous work; inspect graph/history when useful and refresh the index after changes.
- Use only this checkout's absolute `rootDir`; never home directories or unresolved placeholders. For an unsafe-root response, use the configured workspace only after confirming it is this checkout.
- If work uses a `graphflow_run` execution descriptor, you must actually call `graphflow_report_outcome` with that run's `episodeId` and a `success` boolean (plus optional lessons). When MCP is unavailable, use the installed CLI equivalent `graphflow --json outcome report <episodeId> <success>` after checking its help. If neither route is available, record the episode as unclosed and the tool limitation; do not claim closure or successful reporting. Do not assume another agent's hooks closed it.
- If MCP is unavailable, use an already installed `graphflow ... --json` CLI after checking its help. If neither exists, record the limitation and use targeted source reads plus an explicit plan. Do not install a plugin to proceed silently. Hydrogen has no `start:mcp` script; old local GraphFlow setup examples are not Hydrogen commands.
