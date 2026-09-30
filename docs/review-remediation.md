# Full-review remediation

This patch addresses the supplied review of main at `ff1ef42`, while preserving the existing unfinished working-tree changes and the 2.1.7 incremental SSE/tool-argument fixes. No subagents were used. Applicable runtime changes were ported from `origin/codex/fix-core-audit-20260920`; the older branch was not merged or used to replace main.

## Operator-visible changes

- **Bootstrap:** blank `ADMIN_PASSWORD` generates a random temporary password in local startup logs. The anonymous setup endpoint never returns credentials. Setup sessions can only read themselves, change their password, or log out. Password setup requires the current temporary secret.
- **Sessions:** password changes revoke copied cookies immediately. Logout revokes all sessions for that account. Existing pre-remediation cookies require a new login. New session/cookie lifetimes use the runtime Settings value.
- **Proxy targets:** proxied traffic must pass local target-address validation too. Only administrators may select an egress proxy in provider tests. Because the remote proxy resolves targets independently, its own destination ACLs are still required to prevent remote DNS rebinding.
- **Quotas:** bounded keys reserve admission before asynchronous execution. Keys with a token budget allow only one outstanding metered request, since final usage is not knowable at admission; one completion can still exceed the remaining token budget. All consumed attempt usage is charged, including blank/retried failures.
- **Attachments:** omitted/zero `maxAttachmentBytes` means a **50 MiB aggregate default**, not unlimited. Positive per-service overrides remain supported. Each pass permits at most 32 distinct URLs and shares one wall-clock deadline; remaining bytes are checked during reading, before base64 retention.
- **Backups:** exports use **format v2** with a passphrase-sealed digest covering every table and restore-affecting metadata. Unauthenticated v1 packages are refused. Keep a filesystem/database copy of the original trusted instance before upgrading, then export a new v2 package from it after upgrading in place; do not rely on a transferred v1 package as authenticated evidence. Export preflights table sizes and stops within a 128 MiB serialized budget (the restore HTTP envelope is 512 MiB). Restore requires at least one enabled admin and holds an instance admission barrier through KDF/preparation. Session invalidation is transactional.
- **Video jobs:** IDs are owner-bound, HMAC-signed capabilities. Unsigned legacy job IDs cannot safely establish ownership and are refused. Jobs created after upgrading remain pollable across restarts when `SESSION_SECRET` is stable, subject to current video-service mappings.
- **Dashboard tests:** spending stored provider credentials through Bench and service/OCR test endpoints is admin-only. Managers retain intended non-secret read surfaces, not provider extra-header values.
- **Retention/deployment:** the hourly log pruner enforces a 100,000-row safety cap by default (`log_max_rows` persisted setting can select a positive alternative). Clearing logs no longer runs synchronous `VACUUM`; physical compaction belongs in offline maintenance. Docker runs as UID/GID 1000 (`node`) and Compose allows 35 seconds to stop. Existing bind-mounted data may need `chown -R 1000:1000 data` before the upgraded container can write it. Node 22.12+ is required.

## Critical / High

| ID | Remediation | Regression evidence |
|---|---|---|
| C1 | Random local-only bootstrap secret, rotation of legacy default hashes, server-side setup gate, current-secret proof | `reviewHttpSecurity`, `reviewRemediation` |
| H1 | Validate target on proxied path; admin-gate explicit and inherited proxy selection | `reviewHttpSecurity`, `reviewRemediation`, `egressProxy` |
| H2 | Normalize Anthropic/Chat/Responses stream errors; retain provider message/status, suppress deterministic retries, emit protocol errors after commit | `reviewRemediation`, `protocolRegression`, `hostedToolLoop` |
| H3 | Persist private canonical snapshots per conversation item, separate from public wire presentation; retain signed/redacted/opaque parts | `responsesController`, `reviewRemediation` |
| H4 | Safe aggregate cap, count cap, shared deadline, remaining-byte enforcement while reading | `fileFetch`, `reviewRemediation` |
| H5 | Delay raw commit until an actual frame; return an HTTP error for zero-frame truncation | `proxyStreaming`, `upstreamResilience` |

## Medium

| ID | Remediation | Regression evidence |
|---|---|---|
| M1 | Numeric `TRUST_PROXY` becomes a Fastify trust callback; `1` means one hop, not every hop | `reviewHttpSecurity` |
| M2 | Ref-counted per-token admission reservations survive detached jobs/disconnects | `reviewRemediation` |
| M3 | Opaque password/revocation revision claim checked against live user; password change/logout invalidation | `reviewHttpSecurity`, `sessionEpoch` |
| M4 | Sealed digest binds tables, identifiers, flags and metadata | `reviewRemediation`, `backup` |
| M5 | Provider extra headers only appear in admin-authorized presentations | `reviewHttpSecurity` |
| M6 | Instance-wide request/job admission barrier acquired before asynchronous KDF | `reviewHttpSecurity`, `reviewRemediation` |
| M7 | Active registry finalized before bookkeeping; logger failures cannot interrupt delivery; jobs/leases released in finalizers | `proxyStreaming`, `responsesController` |
| M8 | Preflight table sizes and incrementally enforce export budget below restore limit | `backup`, `reviewRemediation` |
| M9 | Reject packages lacking an enabled admin/password hash | `reviewRemediation`, `backup` |
| M10 | Read runtime TTL at every login/password-change issuance and cookie creation | `reviewHttpSecurity` |
| M11 | Clamp translated manual thinking budget strictly below caller ceiling; disable when minimum cannot fit | `thinking`, `reviewRemediation` |
| M12 | Preserve content filtering and pause status across Responses; context-window exhaustion maps to length | `reviewRemediation`, `protocolRegression`, wire suites |
| M13 | Authenticate owner-bound video capability, require video category/current provider mapping/endpoint | `mediaServices`, `mediaEndpointSelection` |
| M14 | Enforce the nested loop's local maxCalls as well as inherited shared allowance | `hostedToolLoop` |
| M15 | Use first nonempty reasoning alias for Chat request replay | `reviewRemediation` |
| M16 | Restore tool input from Anthropic block_start when JSON deltas are absent | `reviewRemediation`, wire suites |

## Low / hygiene

| Finding | Remediation |
|---|---|
| IPv6 transition addresses | Classify NAT64/6to4 embedded IPv4; refuse ambiguous local translation/Teredo; handle unspecified/multicast |
| Manager credential-spend tests | Admin gates on Bench and service/OCR test endpoints; Bench hidden for managers |
| Post-commit exception / leaked job slots | Safe logger wrapper; committed heartbeat error close; unconditional job/registry/lease cleanup |
| Unbounded upstream error bodies | Shared 64 KiB error reader with early destruction; buffered successful JSON bounded to 25 MiB |
| AbortSignal fallback | Node 22 contract and direct `AbortSignal.any`, preserving external cancellation |
| TTS split UTF-8 | Shared streaming decoder across chunks |
| Query-string endpoint corruption | Append to URL pathname, preserving search query |
| Invalid n | Reject non-numeric, non-integral and nonpositive values instead of silently dropping/forwarding |
| Model enumeration scope | Filter enabled models against token scope; read operation does not consume quota |
| Bench multipart MIME injection | Strip CR/LF from MIME header |
| Concurrent DELETE during follow | Emit terminal response.failed when replayed state disappears |
| OCR/ASR hit eviction | Touch successful hits before inserting misses; OCR single-flight acquisition retained |
| OCR routing input_has_image | Evaluate routing predicates against the original request |
| Canonical override omissions | Exhaustive typed key manifest and schema for canonical controls |
| Forced declared server tool | Remap tool_choice alongside declaration binding |
| HostedToolService pacing | Start fabrication budget before invoking the run |
| Media delivery logging | Record after raw delivery finish/close/error, then observe late socket reset; accounting independent of logger |
| Restore stats flags | Determine log replacement from authenticated table presence rather than includesLogs metadata |
| Log deletion blocking VACUUM / dead row cap | Remove request-path VACUUM and enforce hourly row cap |
| Image detail / logprobs / paused server call | Preserve image detail on both OpenAI adapters; canonical logprobs buffered/streaming roundtrip; emit pending server-call items |
| Thinking-only fallback | Validate buffered answer at attempt boundary, enabling configured 502 retry/fallback and retaining billed usage |
| Docker root / shutdown / mutable CI actions | Non-root runtime; locked npm ci installs; 35s Compose stop grace; immutable action SHAs; verify-before-publish and job-scoped package write |
| Public check data / browser headers | Minimize self-service key response; no-store; CSP/nosniff/frame deny/referrer headers |
| Dead legacy / scratch files | Delete unreferenced legacy tree; ignore root review scratch scripts and exclude them from image context |

## Validation

Validation uses disposable test databases only; no deployment or user database was modified.

| Check | Final result |
|---|---|
| `npm run typecheck` | Server and web pass |
| `npm test` | Server: 68 files / 1,197 tests; web: 1 file / 2 tests. **1,199 passed**, zero failures/skips |
| `npm run build` | Server and web production builds pass; non-blocking large web chunk warning remains |
| `npm audit` | Zero vulnerabilities across production and development dependencies |
| Dependency tree | Patched Fastify static, Drizzle ORM, Undici, React Router, Vite and Vitest; esbuild override resolves cleanly |
| Built runtime smoke | Bundled server starts with temporary data; SPA, CSP and health endpoint pass; clean SIGTERM shutdown |
| Drizzle generator | Upgraded CLI generates all 17 schema tables into a disposable output directory |
| Deployment YAML | CI and both Compose configurations parse successfully |
| `git diff --check` | Pass |

Docker is not installed on this host, so image build and `docker compose config` verification cannot be claimed here; CI builds the actual runtime image. At remediation validation time, no repository commit, branch merge, service deployment, or application restart had been performed. The fixes are being packaged in release v2.1.8; see its release notes for upgrade requirements.
