# Development baseline — 2026-10-02

## Source and isolation

- Origin: `https://github.com/Arrosam/Hydrogen-LLM-proxy.git`.
- Fresh fetch resolved main and v2.2.2 to `768244c47f6655fea0e3d79bcad0c94c2329c92f`.
- Working branch: `codex/development-baseline-20261002`.
- Local worktree: `/Users/samuel/Documents/Codex/2026-10-02/task/hydrogen-dev-baseline`.
- Original checkout retained at `/Users/samuel/Documents/GitHub/Hydrogen-LLM-proxy`, on `codex/fix-core-audit-20260920`; no merge, reset or source edits there.
- Lockfile SHA-256: `e2d9e9cab5038f6f4d29357f682465a9eb06a19201abe8e1bad7a43118b15876`.
- Host: macOS / Darwin arm64; Node `22.22.2`, npm `10.9.7`. CI uses Node 22 on Ubuntu; exact local patch versions are recorded evidence, not a new supported-version constraint.

## Existing local rules

The original checkout has an untracked uppercase `AGENTS.md`; no tracked main version or inherited parent AGENTS.md was found. Its SHA-256 is `f6f77ce9ced78f6d7e5e1ad50bbc779f415e6a3246b7b508ff33264b67afaec3`, identical to untracked `.claude/rules/graphflow.md` and `.windsurfrules`. All show local modification time 2026-09-20 14:52:22. `GEMINI.md` contains a marked GraphFlow managed block; its hash is `31e7e154511d88d00ea8418a66dc1fa9bbd898d64adc60593daaca773b38c422`. Content and timestamps suggest shared tooling setup, but no Git provenance verifies who generated them. All originals are preserved.

GraphFlow context, planning, root-safety, indexing and episode reporting intent is retained in the new AGENTS.md. No GraphFlow MCP or installed CLI was available. The old `npm run start:mcp` example does not exist in Hydrogen's package scripts and was not copied as an executable instruction. No GraphFlow/plugin installation was performed. Targeted reads and an explicit plan were used instead.

## Installation

All remote `resolved` lockfile entries use `registry.npmjs.org`; workspace links have no remote host. Root/server/web have no install lifecycle scripts. Packages marked `hasInstallScript` were argon2, better-sqlite3, esbuild and fsevents. Scripts were inspected after inert extraction; fsevents ships its binary and its actual package scripts contain no install hook.

The execution author reports the following sanitized environment and separate temporary HOME/cache. The installation/rebuild commands were not redirected to retained logs; independent review has not verified their historical execution or exit codes. No reinstall was performed merely to recreate evidence. The reported invocation prefix was:

```sh
env -i PATH=/opt/homebrew/bin:/usr/bin:/bin HOME=/tmp/hydrogen-baseline-home TMPDIR=/tmp
```

The author reports running these commands from the isolated worktree (with that prefix):

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org --cache=/tmp/hydrogen-baseline-npm-cache --no-audit --no-fund
npm rebuild argon2 esbuild --offline --cache=/tmp/hydrogen-baseline-npm-cache
npm rebuild better-sqlite3 --build-from-source --nodedir=/opt/homebrew --offline --cache=/tmp/hydrogen-baseline-npm-cache
```

The execution author reports all three succeeded; this statement is not independently verified installation evidence. Retained typecheck/test/build logs independently support the resulting usable baseline, but do not prove the installation path. No historical exit codes are asserted here. argon2 uses bundled prebuilds; esbuild uses its locked platform package; better-sqlite3 was compiled with existing local Node headers to avoid the install script's GitHub prebuild download. This is a staged preparation of the exact lockfile, not a claim that an unmodified `npm ci` lifecycle path was tested. Deprecation warnings remain for whatwg-encoding, prebuild-install, Recharts 2 and esbuild-kit packages; no dependency upgrade was made.

## Validation record

See the results below and the local evidence directory `/Users/samuel/Documents/Codex/2026-10-02/task/hydrogen-baseline-evidence`. Logs are local artifacts rather than committed runtime output. Test subprocesses used synthetic fixture credentials and temporary databases; loopback listeners required narrowly approved unsandboxed execution. No production data, live paid providers or actual adapters were used.

| Check | Result |
|---|---|
| Root `npm run typecheck` | Server and web pass, exit 0 |
| `npm run test:server` | 73 files / 1,439 tests pass, exit 0; 144.97 s |
| `npm run test:web` | 6 files / 42 tests pass, exit 0 |
| Root `npm run build` | Web and server pass, exit 0; existing >500 kB web chunk warning |
| `npm audit` against official npm registry | 0 vulnerabilities, exit 0 |
| Document command/link check | All documented runnable root scripts and local links exist; absent `start:mcp` explicitly marked unavailable |
| `git diff --check` | Pass |

Server and web were invoked separately using the exact two root `npm test` component scripts; the root wrapper itself was not rerun. Total: 79 files / 1,481 passing tests, no failures or skips.

The previous snapshot's 11 web failures with reused jsdom 30 dependencies did not reproduce with locked jsdom 25.0.1 / Vitest 5.0.2. This validates the need for a lockfile baseline; no assertion or product code was changed.

## Review and limits

A separate final self-review pass checked scope, command existence, relative links, lifecycle preparation, authorization wording, workflow evidence and existing invariant preservation. No independent person/agent reviewed this change; do not treat that requirement as externally verified. The rule was clarified to apply fresh-main isolation to a *new baseline*, avoiding an instruction to reset an ongoing feature branch, and authorization wording explicitly distinguishes persistent security/real credentials from temporary synthetic fixtures.

Real browser/manual application acceptance, Android, Docker/container and live-provider checks were not run: this change edits development documentation, and neither product behavior nor startup/deployment configuration changed. Manual document review and link/command checks cover the changed surface. Full product acceptance remains separate. Existing audit documentation is historical evidence, not a current passing test record.

No source, package/lockfile, CI permissions or application security setting changed; no commit, push, merge or deployment occurred. No blocking product decision is needed for this documentation slice. Choosing permanent CI/runtime patch pinning or installing GraphFlow can be separate proposals; this baseline preserves CI's Node 22 policy and records exact local versions.

## Independent review follow-up

An independent review confirmed the source SHA/tag/main match, lockfile and preserved local-rule hashes, npm source host, existing validation logs (1,439 server and 42 web tests, typecheck/build/audit), diff whitespace and five-document scope. It found two documentation gaps: explicit GraphFlow episode closure and installation-history evidence. The final AGENTS.md now requires the actual outcome call with episodeId/success (or the checked CLI equivalent), and records unavailable closure as unclosed. Installation claims above are explicitly attributed to the execution author and are not independently verified; no historical log or exit code was fabricated. Real product UI acceptance remains unperformed.

## Product independence clarification

The user clarified that Hydrogen and Fishball are independent projects. The final rules explicitly separate their roadmaps, testing, acceptance and releases. Fishball is only one application example; Hydrogen has independent uses, and neither project is required to depend on the other. Only changes to an actually shared API contract require compatibility checks with affected consumers. This clarification changes documentation only and introduces no protocol, product code, coordinated-release requirement or joint-acceptance gate.
