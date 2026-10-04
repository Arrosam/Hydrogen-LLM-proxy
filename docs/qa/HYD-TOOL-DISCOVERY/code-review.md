# HYD-TOOL-DISCOVERY independent code review

Reviewer: `/root/discovery_code_audit`. Actual selected model/effort, confirmed by the delegating agent: `gpt-6.1-sol`, `max`. This is an independent source audit, not the implementer's self-review or the separate test audit. English only.

**Final source-audit verdict: pass for the latest patched working-tree state fingerprinted below, including the single-message HTTP follow-up. C1 is fixed and independently rechecked; no concrete source finding remains open.** Full acceptance still depends on the separate AC10 evidence and the pending owner decision for ambiguous catalog unions.

## Initial reviewed state

- Review state captured at `2026-10-03T13:36:47Z`.
- Workspace: `/Users/samuel/Documents/Codex/2026-10-04/task/hydrogen-tool-discovery`.
- Branch: `codex/hydrogen-tool-discovery`.
- Dependency base: `8c12ff24b72767bcc7b0438a4091c36e7ecddccc`.
- HEAD: `d35d7c2b6b5e9c09c3b5acad985cd9c35901a433` (`Record HYD-TOOL-DISCOVERY scope and acceptance criteria`). The implementation was uncommitted; this report does not claim that HEAD contains it.
- Modified tracked files: `package-lock.json`, `server/package.json`, `server/src/app.ts`, `server/src/persistence/hostedToolRepo.ts`.
- Untracked files at capture: `server/src/discovery/toolDirectory.ts`, `server/src/transport/toolDiscoveryRoutes.ts`, `server/test/fixtures/discoveryHarness.ts`, `server/test/toolDirectory.test.ts`, `server/test/toolDiscoveryRoutes.test.ts`. Tests were being added concurrently and are outside this independent source audit's completion claim.
- Compared the base-to-working-tree diff and separately read the new untracked source files. Read tracked `AGENTS.md`, `docs/development-workflow.md`, `docs/feature-tool-discovery.md`, relevant declared-tool policy/validation documentation, authorization and repository code, tool schema/definition code, and existing model/agent execution and snapshot paths.
- No nested `AGENTS.md` or local `.agents` files were found. GraphFlow MCP and installed CLI were unavailable; the review used targeted source reads and the explicit sequence source/contract inspection → isolated diagnostic probes → findings → fix recheck. No GraphFlow episode was started.

Mid-review SHA-256 fingerprints at the capture time above (the implementer changed files concurrently; the ToolDirectory reference fix was already present by this fingerprint capture, although the initial finding had been reproduced against the earlier source):

| File | SHA-256 |
| --- | --- |
| `server/src/discovery/toolDirectory.ts` | `7038bf8210fb75c5e35287bad6c9b0ef35873754c6e205c535b9cf577fe9c105` |
| `server/src/transport/toolDiscoveryRoutes.ts` | `6304ee1b092e661a709255c423a65f6b902ab53124c99c8e4b3c8065d73acfab` |
| `server/src/app.ts` | `f1741d32c3edb65133eeceebf1245d29868c8cb50e78d0eb43c1d39f2cd4fbb6` |
| `server/src/persistence/hostedToolRepo.ts` | `e6783e887d66df51c9fb9d5872eaa710a1f8718d0708655dd5bd405e38a0ed9d` |
| `server/package.json` | `e4c222166cf901ca6ff9c9500481aae203e59816b7bf99865e9b4f88b790dca8` |
| `package-lock.json` | `53f6a62f552bcc1b641716d68b568050203d52c482d155345c4670d5000c99f3` |

## Initial finding

### C1 — P2 / acceptance blocker: tools-disabled stages conceal broken references

Location in the initial source: `server/src/discovery/toolDirectory.ts:78`.

`if (stage.tools === "none") continue` executes before resolving or validating the stage's referenced service. A valid saved Micro Agent can consequently return a successful empty catalog after its referenced service is disabled, deleted, changed to a non-chat category, or given a malformed definition. This violates AC7's explicit distinction between an empty catalog and broken configuration. A tools-disabled stage still invokes its referenced service in the existing Micro Agent execution path; disabling client tool declarations does not establish reference validity.

Reproduction:

1. Save enabled Model Service `child` and enabled Micro Agent `parent` with stage `{ name: "silent", service: "child", tools: "none" }`.
2. Disable or delete `child` after saving the agent.
3. Authenticate with an otherwise valid Key scoped to `parent` and issue `tools/list` to `/v1/services/parent/mcp`.
4. Initial actual result: successful `tools: []`, with `mayOmitUnknownUpstreamTools: false`. Expected: a sanitized MCP configuration error such as `unavailable_reference`, without exposing the referenced name or topology.

The auditor independently reproduced the equivalent missing-reference configuration with in-memory sources. The implementer agreed this is an AC7 defect and is preparing the fix. Validate references and definitions throughout the relevant stage graph while keeping tool contributions disabled for `tools: "none"` descendants; add regression cases for missing/disabled/malformed/non-chat references and ensure successful excluded stages still contribute no entries.

Status: **fixed and independently rechecked; closed**. This was a correctness blocker, not an optional suggestion. See the final recheck below.

## Source conclusions apart from C1

- Effective policy selection uses the complete step policy when present, otherwise the service policy, otherwise empty blacklist. Exact-name matching and whitelist bypass precedence agree with existing `hostedServerTools`; listed blacklist names do not suppress a real local equivalent. Model fallbacks and nested/inline Micro Agent stages are unioned; inherited local identities are combined.
- A known Hydrogen entry exposes its downstream `serverTool.name` and cloned real `parameters`, without the internal emitted-name prefix or adapter identity. The repository projection omits encrypted header columns and does not call `materialize` or decrypt secrets. Public output is built explicitly from allowed definition fields.
- Upstream whitelist entries use `{ type: "object", additionalProperties: true }` only as the approved format placeholder. Their description and namespaced metadata disclose unknown real schema, unprobed availability, non-validation and non-executability. Blacklist pages disclose that permitted upstream tools cannot all be enumerated.
- Same known identity/definition is deduplicated. Different local identities or local/upstream provenance sharing one public name produce sanitized `catalog_conflict`, with no renaming or schema replacement. The pending product decision for ambiguous unions remains pending; this audit does not invent a resolution.
- Every HTTP request revalidates enabled/expiry/target/scope through existing Key authentication and `tokenAllowsService`. List dispatch rereads them as well. The discovery route does not reserve inference quotas; otherwise valid exhausted Keys remain usable.
- Every page rereads configuration and bindings. Sorted paging is deterministic for unchanged configuration. The cursor is bounded, canonical, HMAC-authenticated, bound to target and Key ID, and excludes plaintext service/Key IDs or configuration. Owner-accepted duplicates/omissions after edits are disclosed; no frozen discovery snapshot is introduced.
- Official SDK `Server` and stateless `StreamableHTTPServerTransport` supply initialization/version/capabilities, ping and initialized notifications. A fresh server/transport is created for each POST; `tools/call` always throws an explicit MCP protocol error. No catalog tool, callable business tool, model wrapper, executor, upstream resolver or paid provider is wired into the route.
- HTTP size limits, Origin rejection, no-store responses, sanitized parser/repository/configuration errors and disposable transport close paths were inspected. Ordinary clients can ignore metadata or attempt calls, so the explicit call rejection remains the authority.
- The base-to-working-tree diff in `server/src/execution`, `proxyController.ts`, `responsesController.ts`, `responseRepo.ts` and `conversationHistory.ts` is empty. Existing inference-session snapshot files and behavior were not modified. The discovery code imports the existing `DEFAULT_SERVER_TOOL_POLICY`; it adds no executor export or implementation change.
- Exact SDK dependency is `@modelcontextprotocol/sdk@1.32.0`. Installed SDK package metadata and server/protocol/transport source were inspected. Lockfile comparison found 69 added package records, no existing package version changes, no added `hasInstallScript` packages and no new non-`registry.npmjs.org` resolved sources. Root/server version stays `2.2.3`.

## Auditor validation

Environment: Node `v22.22.2`, npm `10.9.7`. No install, push, merge, release, production access, live provider, application database write, implementation/test edit or security-setting change was performed by this reviewer. The only intentional repository write is this report.

| Check run by this reviewer | Result / limit |
| --- | --- |
| `git diff --check` | Pass. |
| `npm run typecheck:server` | Pass after the implementer corrected the scoped Fastify error handler type. The initial temporary typing issue is resolved and is not an open finding. |
| `node --import tsx --input-type=module` with an inline, in-memory `ToolDirectory` fixture | 18 diagnostic scenarios passed: policy table/replacement, nested inherited union/deduplication, schema result parsing, 201-entry paging, changed configuration, cursor syntax/tampering/cross-Key/cross-target rejection, and explicit alias/provenance conflicts. Separately reproduced C1. |
| Same Node command with Fastify injection and installed SDK, synthetic repository doubles | 14 diagnostic scenarios passed: initialization/capability/no-session/no-store result; list, ping, initialized notification; explicit call and malformed-call errors; invalid cursor; browser Origin rejection; invalid Key, scope change, disabled Key and disabled target; GET/Allow handling; malformed JSON. No socket was opened. |
| Same Node command with Fastify injection | 6 additional diagnostic scenarios passed: oversized request, unsupported protocol version, unsupported content type, rejected `list_service_tools`, sanitized malformed private definition and safe public output from a secret-laden synthetic tool. |
| Lockfile package-record comparison against the dependency base | Pass for the source/lifecycle/version boundaries stated above. This is not a vulnerability audit. |

These are narrow source-audit probes. They do not replace the separate test audit, full repository gates, dependency vulnerability audit or real official MCP client acceptance over loopback HTTP. Those are being completed by the implementer and separate reviewer; this audit does not claim their results as its own.

## Verdict and pending recheck

**Initial verdict: hold local acceptance for C1.** No additional concrete source finding was identified in the reviewed state. C1 must be fixed and independently rechecked. The owner-facing product decision for ambiguous catalog unions and the full AC10 validation/evidence remain separate acceptance requirements. Release is not authorized or performed.

## Final patched-state recheck

Final state captured at `2026-10-03T13:43:30Z`. Branch and HEAD remain `codex/hydrogen-tool-discovery` / `d35d7c2b6b5e9c09c3b5acad985cd9c35901a433`; the audited implementation is still in the working tree, not in that HEAD. Any later commit should be checked against these source fingerprints before reusing this verdict.

Final `git status --short` before this final report append:

```text
 M package-lock.json
 M server/package.json
 M server/src/app.ts
 M server/src/persistence/hostedToolRepo.ts
?? docs/qa/
?? scripts/validate-tool-discovery.ts
?? server/src/discovery/
?? server/src/transport/toolDiscoveryRoutes.ts
?? server/test/fixtures/discoveryHarness.ts
?? server/test/toolDirectory.test.ts
?? server/test/toolDiscoveryRoutes.test.ts
```

Final audited source SHA-256 fingerprints:

| File | SHA-256 |
| --- | --- |
| `server/src/discovery/toolDirectory.ts` | `7038bf8210fb75c5e35287bad6c9b0ef35873754c6e205c535b9cf577fe9c105` |
| `server/src/transport/toolDiscoveryRoutes.ts` | `1a9381637672c266f5126ae1266e63db41057793ff747a9eb03610c57d15fd99` |
| `server/src/app.ts` | `f1741d32c3edb65133eeceebf1245d29868c8cb50e78d0eb43c1d39f2cd4fbb6` |
| `server/src/persistence/hostedToolRepo.ts` | `e6783e887d66df51c9fb9d5872eaa710a1f8718d0708655dd5bd405e38a0ed9d` |
| `server/package.json` | `e4c222166cf901ca6ff9c9500481aae203e59816b7bf99865e9b4f88b790dca8` |
| `package-lock.json` | `53f6a62f552bcc1b641716d68b568050203d52c482d155345c4670d5000c99f3` |

The corrected traversal at `toolDirectory.ts:73` carries `includeTools = false` through descendants of tools-disabled stages while continuing to validate named service existence, enabled state, category, definition, cycles and depth. Excluded descendants do not contribute local or upstream entries, and their tool bindings are not read. Later active stages continue to contribute normally. C1's direct and nested reproductions now produce sanitized configuration errors.

The transport patch at `toolDiscoveryRoutes.ts:65` registers the official SDK generic request schema with the official list method literal, then validates through `ListToolsRequestSchema.safeParse`. Invalid cursor parameter types now return `InvalidParams` rather than the low-level SDK's generic schema-error mapping. The analogous generic registration for `tools/call` retains `Server.setRequestHandler`'s built-in `CallToolRequestSchema` wrapper validation: malformed calls return `InvalidParams`; well-formed known or unknown calls reach the explicit unsupported handler and return `MethodNotFound`. Neither path executes a business tool.

Independent final validation:

- **21 patched-state diagnostic scenarios passed** using inline Node/tsx in-memory sources and Fastify injection: tools-disabled missing/disabled/non-chat/malformed references; missing nested descendants and cycles; valid excluded nested graph with no binding reads or entries; later active stage contribution; six non-string cursor classes (`null`, number, boolean, object, empty array, string array); six malformed/well-formed call cases; successful list after rejected calls.
- `npm run typecheck:server` and `git diff --check` passed in the patched state.
- Read the new regression test `validates broken references inside tools:none stages and their descendants`. The implementer reported 48 passing directory tests; that suite result is not claimed as an auditor-run gate.
- The first two final diagnostic attempts exposed incorrect auditor harness expectations: an MCP error message includes the SDK's `MCP error -32602:` prefix, and malformed calls are rejected by the SDK wrapper with `InvalidParams`. After inspecting the SDK wrapper source, those expectations were corrected and all 21 scenarios passed. No implementation or repository test was changed by this reviewer to satisfy the probes.
- Reconfirmed an empty base diff for the existing execution/snapshot/controller/repository paths listed above. Source changes remain confined to discovery, its registration/projection, and the SDK dependency.

**Final verdict: no open concrete code finding.** C1 is closed. The sanitized `catalog_conflict` behavior for ambiguous unions is the explicitly bounded draft behavior; the owner's product decision remains unresolved and must not be silently replaced by renaming, schema substitution or invented union semantics. Full repository gates, dependency vulnerability audit, separate test audit and real SDK-client loopback acceptance remain the implementer's/other reviewer's evidence obligations. This code audit alone does not mark the feature accepted or released.

## Single-message HTTP follow-up

Independently reviewed the additional guard at `server/src/transport/toolDiscoveryRoutes.ts:60`. The [MCP 2025-11-25 transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) requires one JSON-RPC request, notification or response in each POST body, and a bodyless HTTP 202 for an accepted notification. The installed SDK's legacy batch handling does not enforce that current single-message boundary itself.

The new guard rejects every top-level array with HTTP 400 / JSON-RPC `InvalidRequest` (`-32600`), a null ID and a fixed sanitized message. It runs after existing authentication/scope checks and before creating the SDK server/transport or dispatching any message. It does not interfere with single requests or notifications. Read the three added batch regression cases and the single initialized-notification case; this remains a source audit, not a replacement for the separate test audit.

**Nine independent follow-up scenarios passed** using inline Node/tsx, synthetic sources and Fastify injection: empty array; singleton list array; list/call multi-message array; notification array; single initialized notification with bodyless 202; single initialization; single list; single call explicitly rejected; unauthorized batch returning 401. No array case read tool definitions. The single list performed exactly one definition read, and later call/auth-error probes performed none. No socket or database was used. `npm run typecheck:server` and `git diff --check` also passed.

Latest reviewed state captured at `2026-10-03T13:48:22Z`: branch `codex/hydrogen-tool-discovery`, HEAD `d35d7c2b6b5e9c09c3b5acad985cd9c35901a433`. The dirty status is unchanged from the preceding final-state block; the implementation remains uncommitted. Only `toolDiscoveryRoutes.ts` changed among the audited source fingerprints since that preceding pass.

| File | Latest audited SHA-256 |
| --- | --- |
| `server/src/discovery/toolDirectory.ts` | `7038bf8210fb75c5e35287bad6c9b0ef35873754c6e205c535b9cf577fe9c105` |
| `server/src/transport/toolDiscoveryRoutes.ts` | `1315b0c9477329ec99180b96bd3a20959df9f2bb3451b3fcbc655aa0656ba4e4` |
| `server/src/app.ts` | `f1741d32c3edb65133eeceebf1245d29868c8cb50e78d0eb43c1d39f2cd4fbb6` |
| `server/src/persistence/hostedToolRepo.ts` | `e6783e887d66df51c9fb9d5872eaa710a1f8718d0708655dd5bd405e38a0ed9d` |
| `server/package.json` | `e4c222166cf901ca6ff9c9500481aae203e59816b7bf99865e9b4f88b790dca8` |
| `package-lock.json` | `53f6a62f552bcc1b641716d68b568050203d52c482d155345c4670d5000c99f3` |

**Latest verdict: pass for these source fingerprints, with no open concrete code finding.** The ambiguous-catalog owner question remains a product limitation; it grants no authority to rename tools, replace schemas or invent union semantics. The implementer reports a successful standalone real SDK client run with 12 scenarios and full gates in progress. The implementer also reports five high dependency-audit findings in the existing Tailwind chain, with the exact-base comparison still in progress at this review update. Those reported results are not independently completed audit gates in this source review, and no dependency-remediation scope or release authorization is inferred.
