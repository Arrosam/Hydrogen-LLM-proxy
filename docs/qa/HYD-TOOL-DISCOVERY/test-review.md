# HYD-TOOL-DISCOVERY independent test audit

- Reviewer: `/root/discovery_test_audit`.
- Selected reviewer model: `gpt-6.1-sol`; reasoning effort: `max`.
- Review type: independently executed test audit; not an implementation self-review or a second code review.
- Scope: the discovery directory, real HTTP route tests and fixture, relevant reused policy-schema tests, and the feature card/workflow. No source/test edits, installs, production access, pushes, merges, releases, or child agents were performed by this reviewer. The only repository deliverable written by this reviewer is this report.
- Rules read: `AGENTS.md`, `docs/development-workflow.md`, `docs/feature-tool-discovery.md`. No applicable nested `AGENTS.md` was found. GraphFlow tools/installed CLI were unavailable; targeted reads and the explicit audit plan were used. No GraphFlow episode was started.

## Verdict

**PASS for the independently reviewed test scope.** The final diagnostic gate passes **103/103** cases (48 directory, 41 real-HTTP discovery, 14 reused policy-schema); independent supplemental probes pass **7/7**. The protocol parameter-code defect, independently discovered top-level batch acceptance defect, and batch regression-table mistake have been repaired and retested. The schema/repository coverage and SQL-write evidence follow-ups were promoted into permanent real-SDK regressions. No open P1/P2 test finding remains. Neither protocol defect involved observed tool/model execution.

This audit does not resolve the pending product decision about incompatible downstream-name unions or designate the feature accepted/released. The reviewed behavior explicitly rejects conflicts rather than choosing a lossy definition. Full root typecheck/test/build and dependency-audit evidence belongs to the implementation completion report; this reviewer ran narrow diagnostic gates only.

## Reviewed state

- Worktree: `/Users/samuel/Documents/Codex/2026-10-04/task/hydrogen-tool-discovery`.
- Branch: `codex/hydrogen-tool-discovery`.
- Dependency base: `8c12ff24b72767bcc7b0438a4091c36e7ecddccc`.
- HEAD during audit: `d35d7c2b6b5e9c09c3b5acad985cd9c35901a433` (`Record HYD-TOOL-DISCOVERY scope and acceptance criteria`). Implementation/tests were uncommitted; this is an audit of working-tree contents, not just HEAD.
- Runtime: Darwin arm64, Node `v22.22.2`, npm `10.9.7`, official `@modelcontextprotocol/sdk@1.32.0`.
- Final host UTC clock checked with `date -u`: `2026-10-03T13:57:06Z`. Vitest output's start-time fields are retained as emitted without assuming their timezone.

Final `git status --short` after the independently verified deletion-isolation assertion:

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

SHA-256 content pins for the final reviewed working-tree state:

| File | SHA-256 |
| --- | --- |
| `server/src/app.ts` | `f1741d32c3edb65133eeceebf1245d29868c8cb50e78d0eb43c1d39f2cd4fbb6` |
| `server/src/discovery/toolDirectory.ts` | `7038bf8210fb75c5e35287bad6c9b0ef35873754c6e205c535b9cf577fe9c105` |
| `server/src/transport/toolDiscoveryRoutes.ts` | `1315b0c9477329ec99180b96bd3a20959df9f2bb3451b3fcbc655aa0656ba4e4` |
| `server/src/persistence/hostedToolRepo.ts` | `e6783e887d66df51c9fb9d5872eaa710a1f8718d0708655dd5bd405e38a0ed9d` |
| `server/test/toolDirectory.test.ts` | `1a634e0a8589fe937c15776727fbdfbe29c434b240332f73b6b6669b6cb94c4b` |
| `server/test/toolDiscoveryRoutes.test.ts` | `9d06fe5264c05f70ff7edb134ff22aca8d8c37b61eed4b6129cfc87b1beb501f` |
| `server/test/fixtures/discoveryHarness.ts` | `0358270ecc78f6c953282bc011afd8b9b5f0ad23f6e7b8d9d6058eb2750cc2f0` |
| `package-lock.json` | `53f6a62f552bcc1b641716d68b568050203d52c482d155345c4670d5000c99f3` |
| `server/package.json` | `e4c222166cf901ca6ff9c9500481aae203e59816b7bf99865e9b4f88b790dca8` |
| `scripts/validate-tool-discovery.ts` | `b5dd3f8db4eebbd75cc40dc43c709b2247b5a020e49f1d311d048861bcf25644` |
| Disposable independent probe source retained in this report | `c73589aec17395de1222f72cd5e81b3538a500ef3e6f5b823dbe91aad483063e` |

## Findings and disposition

### T1 — P2, resolved: SDK request-schema parsing produced the wrong malformed-parameter error

Locations: handler registrations now at `server/src/transport/toolDiscoveryRoutes.ts:68` and `:79`; regression at `server/test/toolDiscoveryRoutes.test.ts:158`.

Reproduction: POST `tools/call` with `{name: 7}` or `tools/list` with a numeric cursor using an authenticated synthetic fixture. The initial narrow test run reported `expected -32602; received -32603`. The SDK's low-level handler schema parsed before the intended method-specific validation. This prevented the original route suite from passing.

Required regression: malformed method parameters must return `InvalidParams` (`-32602`) without definition reads, inference, or persistence. The implementer registered the method literals on generic `RequestSchema` and used safe validation for list parameters/the SDK call wrapper. Independent post-fix probes verified omitted/non-string call names, null/array call arguments, and numeric/boolean/null/empty-string cursors. All expected error codes passed; subsequent real SDK initialization, ping and listing remained usable. No expectation was weakened by this reviewer.

### T2 — P2, resolved: malformed-envelope EP omitted legacy SDK batch acceptance

Locations: `server/src/transport/toolDiscoveryRoutes.ts:60` before SDK dispatch; `server/test/toolDiscoveryRoutes.test.ts:168` HTTP batch cases.

Reproduction with `MCP-Protocol-Version: 2025-11-25` and valid authentication:

```json
[]
```

Initially returned HTTP 202 with an empty body. This body:

```json
[{"jsonrpc":"2.0","id":7,"method":"tools/list"}]
```

Initially returned HTTP 200 with a successful list. The official SDK retains unconditional legacy batch parsing. The negotiated [MCP Streamable HTTP specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) requires each POST body to contain one JSON-RPC request, notification or response. Relying only on SDK construction therefore left a contract blind spot.

Required regression: empty, one-item and multi-item arrays must be rejected before dispatch with HTTP 400 / `InvalidRequest` (`-32600`); no definition reads, side effects or database changes; a single initialized notification must retain HTTP 202 with no body. The implementer added an array guard and these cases. Independent reprobes now observe 400 / -32600 for all three array classes and 202 for the single notification. All execution counters and SQLite `total_changes()` remain unchanged in that sequence.

### T3 — P2, resolved: new batch regression supplied spread rows instead of batch bodies

Location: `server/test/toolDiscoveryRoutes.test.ts:168`, the newly added `it.each` batch table.

Reproduction: the first final diagnostic run used `it.each([[], [message], [message, message]])`. Vitest treats each array row as callback arguments: the tested body became `undefined` or the first individual message. Result: three failing cases, one `ParseError` and two HTTP 200 successes, even though the independent raw-array probes passed.

Required regression repair: wrap each row as an object carrying `body`, or a one-element tuple carrying the complete array. Preserve the 400 / -32600, no-read, no-state-change and no-execution assertions. The implementer changed the rows to `{body: [...]}` and destructured that field. All three batch cases pass in the independent final 103-case gate.

### T4 — P3, resolved: schema and repository EP are now durable integration regressions

Locations: final real-SDK regressions at `server/test/toolDiscoveryRoutes.test.ts:29`, `:38`, `:47`; the original unit case at `server/test/toolDirectory.test.ts:61`.

The original permanent real-client schema assertion covered a flat `query:string` object. The unit fixture receives already-available tools, so it cannot prove the repository's unbound filtering, despite that case's title. Nested-schema fidelity, disabled/unbound/no-declaration repository states, and OCR versus all media categories should not depend exclusively on reviewer probes.

Requested regressions: save and list one draft-7 schema containing local definitions/`$ref`, nested required properties, arrays/combinators/defaults and `additionalProperties`; assert deep equality through the actual SDK. Create bound-enabled, bound-disabled, unbound and non-declarable SQLite tools and assert only the declarable bound-enabled entry appears. Check `ocr` remains a chat pipeline while media roots list empty. The implementer added these real-SDK tests, including the 64-character downstream alias and all nine service-category classes. The reviewer also identified a deletion/unbinding assertion that would pass even if deletion had no effect; the implementer added an immediate `['disabled']` listing assertion after deletion and before rebinding, isolating the two changes. All regressions pass in the final independently pinned gate. Independent probes below also exercise these partitions and pass; no implementation defect was observed in them.

### T5 — P3, resolved: add SQL-change evidence to unchanged final tables

Locations: `server/test/fixtures/discoveryHarness.ts:76` (`fingerprint`) and `:82` (`changes`); `server/test/toolDiscoveryRoutes.test.ts:18`–`:27` read/protocol sequence.

The SHA fingerprint proves the tables end with unchanged contents. It would not detect a write followed by compensating restoration. Dispatch spies and final usage checks are useful additional evidence, but do not convert that comparison into a count of SQL writes.

Requested regression: record `SELECT total_changes()` immediately before and after the read/protocol sequence, without fixture mutations between those samples, alongside the existing fingerprint/counters. The implementer added `changes()` to the fixture and equality assertions spanning initialize/list/ping/rejected known/unknown calls. That regression passes in the independent final gate. Independent schema, malformed-call/list and envelope/notification probes also use this evidence and pass. Ordinary Fastify access logging is visible in run logs; neither this audit nor `Cache-Control: no-store` claims zero infrastructure persistence.

## Risk-technique and acceptance coverage

| Criterion | Technique/evidence assessed | Result and boundary |
| --- | --- | --- |
| AC1 Key/target isolation | EP for missing/unknown/disabled/expired Keys and missing/disabled/unauthorized targets; null/empty all-service scopes; state changes after actual initialization; cross-Key cursor rejection; standalone child-target isolation | Supported. Existing exhausted Key is accepted without quota reservation. This is service authorization, not end-user identity or consent. |
| AC2 SDK/protocol | Actual `Client` + `StreamableHTTPClientTransport` over loopback; initialization, capabilities, notification, ping, JSON framing, calls, pagination and HTTP errors | Supported after T1/T2/T3 repairs and final gate. Raw HTTP negative probes supplement, rather than replace, real-client validation. |
| AC3 effective union | Eight-row blacklist/whitelist × listed/unlisted × local/no-local decision table; service/step inheritance/replacement; later/inline/named/nested stages; inherited bindings; `tools:none`; broken excluded descendants | Supported by unit tests and independent persisted SDK probes. Blacklist-listed locally bound entries stay local; exact whitelisted local names become declared-upstream placeholders. |
| AC4 truthful definitions | Exact downstream name/schema assertions, original-description preservation plus disclosure, namespace metadata, permissive upstream object placeholder, unknown-schema warnings; independent rich draft-7 schema fidelity | Supported. The SDK accepting a placeholder proves valid listing shape, not that the unknown upstream contract was validated or callable. |
| AC5 identity/conflicts | Same-identity deduplication; different local definitions/identities and local-versus-upstream collision errors; repeated upstream declaration deduplication | Supported for current explicit-error behavior. Product choice for incompatible same-name unions remains pending. No silent rename/schema replacement is inferred. |
| AC6 live pagination | BVA at 0/1/99/100/101/200/201 entries; deterministic repeats and uniqueness on unchanged catalogs; cursor format/tamper/canonical base64/binding/rotation; live definition/binding/policy edits and accepted shift duplication/omission | Supported. Independent 201-tool SDK probe reads persisted policy/enable edits on the next page and rejects another authorized target's cursor replay. No frozen snapshot/recovery is claimed. |
| AC7 empty/error | Valid empty versus malformed saved definition/schema, broken/disabled/non-chat references, cycles/depth, repository exceptions and conflicts; error sanitization | Supported. The earlier `tools:none` reference fix has a permanent unit regression and independent nested SDK reproduction. Remote `$ref` failure is explicit and does not fetch the loopback receiver. |
| AC8 execution/quota/persistence | Real loopback receiver; fail-fast model/transport/catalog/usage/log/quota counters; attempted known/unknown/malformed calls; subsequent usable SDK requests; whole-table fingerprints plus independent SQL-change count | Supported for exercised paths. Every supplemental probe ended with all eight execution counters at zero. No model wrapper or executable catalog tool was introduced. |
| AC9 data boundary | Synthetic credential/key/header ciphertext, adapter URL/template and model/provider/prompt sentinels; definition reads avoid materialization/decryption; sanitized errors and opaque MAC cursors | Supported for synthetic fixtures. Exact saved public schema/description content is intentionally exposed; infrastructure access logs are outside application-persistence claims. |
| AC10 audit/evidence | This independent selected Sol/max review, narrow gates, seven independent probe groups, implementer standalone SDK-01…SDK-12 evidence | This test audit is supported. Full root gates, dependency audit, independent code audit and final feature acceptance are separately reported by the implementer. No release was authorized or performed. |

Shared `serverToolPolicyConfig.test.ts` already checks invalid/qualified names, 64/65-character and 200/201-name boundaries and preservation of absent versus explicit empty policies. Discovery reuses those schemas; duplication of every parser boundary is unnecessary.

Normal fixture/client/application/receiver/database disposal completed for the independent probes. This reviewer did not perform an abrupt-socket-abort resource-leak experiment; no abort/cancellation acceptance beyond normal closure is inferred from a successful SDK list.

## Commands and observed results

All commands were run in the reviewed worktree. No dependency installation was attempted. Initial sandboxed loopback binds failed with `listen EPERM: operation not permitted 127.0.0.1`; only the already-authorized disposable loopback tests/probes were escalated, and those escalations were approved.

| Command | Observed result |
| --- | --- |
| `npm test --workspace server -- --run test/toolDirectory.test.ts test/toolDiscoveryRoutes.test.ts` (sandbox) | Directory 48 passed; routes 26 fixture-start failures solely from loopback EPERM. Not counted as feature failures. |
| Same command, narrow approved loopback execution, before T1 repair | 73 passed / 1 failed; malformed parameter expected -32602, got -32603. |
| `node --import tsx /tmp/hydrogen-discovery-test-audit.mts` before T2 repair | Six probe groups passed; malformed/batch-envelope group failed because latest-version arrays were accepted. |
| Same reviewed probe script after T2 repair | **Seven groups passed**, zero execution counters in every group. The script source and compact assertions/evidence are retained below. |
| `npm test --workspace server -- --run test/toolDirectory.test.ts test/toolDiscoveryRoutes.test.ts test/serverToolPolicyConfig.test.ts` before T3 repair | 89 passed / 3 failed, all caused by spread array rows in the newly added batch table. |
| Same command after T3 repair and promoted coverage | **103 passed / 0 failed** across three files; emitted start `02:54:10`, duration 2.16s. |
| Same command after the final deletion-isolation assertion; output `/tmp/hydrogen-discovery-test-audit.vitest-pinned.log` | **103 passed / 0 failed** across three files; emitted start `02:56:44`, duration 2.11s, exit 0. This run matches the content pins above. |
| `git diff --check` | Passed on the reviewed working tree. |

The implementer's `scripts/validate-tool-discovery.ts` and `docs/qa/HYD-TOOL-DISCOVERY/protocol-client.json` were also read. That standalone run reports SDK-01…SDK-12 passing with all eight counters zero. It is implementer evidence, not mislabelled as this reviewer's separate run.

At review completion, the implementer separately reported final root typecheck and web/server/stats-worker builds passing; 1,722 server, 82 web and 9 release-plan tests passing; and the refreshed 12-group standalone SDK run passing with zero SQL changes and execution counters. This reviewer did not independently rerun those broader gates. The independently pinned 103-case gate and seven probe groups are the reviewer's own evidence.

## Independent probe evidence

1. **Rich-schema fidelity and name BVA:** three saved schemas, including minimal object; draft-7 local definitions/`$ref`, nested integer bounds/required fields, arrays/`anyOf`, enum/default and extension metadata; `allOf`/`oneOf`/constant/additional-property schemas. The actual SDK retained deep-equal schemas and a 64-character downstream name. SQL `total_changes()` was unchanged across initialize/list.
2. **Repository/category EP:** bound-enabled `valid`, bound-disabled `disabled`, unbound `unbound`, and ordinary/no-declaration tools. The real SDK returned only `valid` for `chat`/`ocr`; `image`, `video`, `tts`, `stt`, `embedding`, `rerank`, `classification` returned empty and did not claim unknown upstream enumeration.
3. **Nested decision/state coverage:** root → middle Micro Agent → leaf Model Service with root/middle/leaf bindings, inherited service policy and full per-step empty-whitelist/blacklist replacements. Expected names: `inherited_remote`, `leaf_local`, `middle_local`, `root_local`. A root `tools:none` ancestor excluded all descendants; replacing a descendant with a broken reference produced `unavailable_reference` instead of empty success.
4. **Live paging state changes:** 201 saved local tools; after page 1, a persisted whitelist bypass changed page 2's `t_100` to the approved unknown-schema placeholder and changed upstream-incompleteness metadata. Disabling a tool removed it on the next request. Replaying the first cursor at another authorized target returned -32602.
5. **Saved-schema error/privacy EP:** malformed JSON-schema type and an unresolved remote `$ref` pointing at the actual private loopback receiver returned -32603 with only `reason: invalid_configuration`. Neither synthetic secret nor URL was serialized; receiver counter remained zero.
6. **Malformed method-parameter EP after repair:** omitted/numeric call name and null/array call arguments returned -32602; string unknown/empty names still returned explicit -32601 call rejection. Numeric, boolean, null and empty-string cursors returned -32602. Subsequent actual SDK connect/ping/list succeeded; fingerprint and SQL `total_changes()` remained unchanged.
7. **Envelope/notification EP after repair:** `null`, numeric/string values, empty object, wrong JSON-RPC version and object IDs returned explicit HTTP 400 errors; empty/one-/multi-item batches returned HTTP 400 / -32600. A single initialized notification returned 202 with an empty body. SQL `total_changes()` and all execution counters remained unchanged.

Every supplemental group ended with:

```json
{"upstreamHttp":0,"modelFactory":0,"upstreamTransport":0,"catalogResolve":0,"quotaReserve":0,"usage":0,"requestLog":0,"decryptingToolRead":0}
```

Final supplemental summary:

```json
{"passed":7,"failed":false}
```


## Reproducible independent probe source

The disposable audit script was written outside the repository and executed with the already-installed `tsx`. Its imports deliberately pin this reviewed worktree. To repeat, save the following as a temporary `.mts` file and run `node --import tsx <temporary-file>` from the worktree, with only the required loopback capability. The script opens disposable SQLite databases and local app/receiver sockets, uses pre-existing synthetic fixture Keys, disposes the fixtures, and prints one result per probe group.

```typescript
import assert from 'node:assert/strict';
import { eq } from '/Users/samuel/Documents/Codex/2026-10-04/task/hydrogen-tool-discovery/node_modules/drizzle-orm/index.js';
import { createDiscoveryHarness, modelDefinition, SYNTHETIC_KEY } from '/Users/samuel/Documents/Codex/2026-10-04/task/hydrogen-tool-discovery/server/test/fixtures/discoveryHarness.ts';
import { hostedTools, modelServices } from '/Users/samuel/Documents/Codex/2026-10-04/task/hydrogen-tool-discovery/server/src/db/schema.ts';
import { parseService } from '/Users/samuel/Documents/Codex/2026-10-04/task/hydrogen-tool-discovery/server/src/execution/definition.ts';

const names = result => result.tools.map(tool => tool.name);
const noExecution = f => assert(Object.values(f.counts).every(value => value === 0), JSON.stringify(f.counts));
const changes = f => f.sqlite.prepare('SELECT total_changes() AS changes').get().changes;
let passed = 0;
async function check(label, run) {
  const f = await createDiscoveryHarness();
  try { const evidence = await run(f); noExecution(f); console.log('AUDIT ' + JSON.stringify({ label, outcome: 'PASS', evidence, counts: f.counts })); passed++; }
  catch (error) { console.log('AUDIT ' + JSON.stringify({ label, outcome: 'FAIL', error: error.message, stack: error.stack })); process.exitCode = 1; }
  finally { await f.close(); }
}

await check('SDK exact rich schemas and 64-character downstream name', async f => {
  const schemas = [
    { type: 'object' },
    { type: 'object', definitions: { record: { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['n'] } }, properties: { nested: { $ref: '#/definitions/record' }, mode: { enum: ['a', 'b'], default: 'a' }, values: { type: 'array', minItems: 1, items: { anyOf: [{ type: 'string' }, { type: 'number' }] } } }, required: ['nested'], additionalProperties: false, 'x-extension': { preserve: true } },
    { type: 'object', allOf: [{ required: ['choice'] }], properties: { choice: { oneOf: [{ const: 'first' }, { const: 'second' }] } }, additionalProperties: { type: 'boolean' } },
  ];
  const tools = schemas.map((parameters, i) => f.addTool(i === 2 ? 'x'.repeat(64) : `schema_${i}`, { name: `schema_adapter_${i}`, parameters }));
  f.tools.bind(f.root.id, tools.map(t => t.id)); const baseline = changes(f);
  const client = await f.connect(); const result = await client.listTools();
  for (const tool of tools) assert.deepEqual(result.tools.find(t => t.name === tool.serverTool.name).inputSchema, tool.parameters);
  assert.equal(changes(f), baseline);
  return { schemas: schemas.length, names: names(result), actualSdk: true, totalChangesUnchanged: true };
});

await check('SQLite disabled/unbound/nondeclarable partitions and all categories', async f => {
  const valid = f.addTool('valid'), disabled = f.addTool('disabled', { enabled: false }), unbound = f.addTool('unbound'), ordinary = f.addTool('ordinary', { serverTool: undefined });
  f.tools.bind(f.root.id, [valid.id, disabled.id, ordinary.id]);
  const client = await f.connect(), observed = {};
  for (const category of ['chat', 'ocr', 'image', 'video', 'tts', 'stt', 'embedding', 'rerank', 'classification']) {
    f.services.update(f.root.id, { definition: modelDefinition({ category }) });
    const result = await client.listTools(); observed[category] = names(result);
    assert.deepEqual(names(result), ['chat', 'ocr'].includes(category) ? ['valid'] : []);
    assert.equal(result._meta['hydrogen/discovery'].mayOmitUnknownUpstreamTools, ['chat', 'ocr'].includes(category));
  }
  return { observed, unboundId: unbound.id };
});

await check('SDK nested parent/child binding inheritance and complete step-policy replacement', async f => {
  const rootTool = f.addTool('root_local'), middleTool = f.addTool('middle_local'), leafTool = f.addTool('leaf_local');
  f.tools.bind(f.root.id, [rootTool.id]);
  const leaf = f.services.create({ name: 'leaf', definition: modelDefinition({ serverToolPolicy: { mode: 'whitelist', names: ['inherited_remote'] }, steps: [
    { model: 'm', provider: 'p', serverToolPolicy: { mode: 'whitelist', names: [] } },
    { model: 'm', provider: 'p', serverToolPolicy: { mode: 'blacklist', names: ['leaf_local'] } },
    { model: 'm', provider: 'p' },
  ] }) });
  const middle = f.services.create({ name: 'middle', definition: parseService({ kind: 'micro_agent', stages: [{ name: 'nested', service: 'leaf', tools: 'inherit' }] }) });
  f.tools.bind(leaf.id, [leafTool.id]); f.tools.bind(middle.id, [middleTool.id]);
  f.services.update(f.root.id, { definition: parseService({ kind: 'micro_agent', stages: [{ name: 'router' }, { name: 'nested', service: 'middle' }] }) });
  const client = await f.connect(); const result = await client.listTools();
  assert.deepEqual(names(result), ['inherited_remote', 'leaf_local', 'middle_local', 'root_local']);
  f.services.update(f.root.id, { definition: parseService({ kind: 'micro_agent', stages: [{ name: 'silent', service: 'middle', tools: 'none' }] }) });
  assert.deepEqual(names(await client.listTools()), []);
  f.services.update(middle.id, { definition: parseService({ kind: 'micro_agent', stages: [{ name: 'broken_descendant', service: 'missing' }] }) });
  await assert.rejects(client.listTools(), error => error.code === -32603 && error.data.reason === 'unavailable_reference');
  return { offeredNames: names(result), noneExcludesDescendants: true, brokenDescendantRejected: true };
});

await check('SDK live persisted policy and enabled state after cursor', async f => {
  const tools = Array.from({ length: 201 }, (_, i) => f.addTool(`t_${String(i).padStart(3, '0')}`)); f.tools.bind(f.root.id, tools.map(t => t.id));
  const client = await f.connect(); const first = await client.listTools(); assert.equal(first.tools.length, 100);
  f.services.update(f.root.id, { definition: modelDefinition({ serverToolPolicy: { mode: 'whitelist', names: ['t_100'] } }) });
  const second = await client.listTools({ cursor: first.nextCursor }); assert.equal(second.tools.length, 100);
  assert.deepEqual(second.tools[0].inputSchema, { type: 'object', additionalProperties: true });
  assert.equal(second.tools[0]._meta['hydrogen/discovery'].provenance, 'admin-declared-upstream');
  assert.equal(second._meta['hydrogen/discovery'].mayOmitUnknownUpstreamTools, false);
  f.db.update(hostedTools).set({ enabled: false }).where(eq(hostedTools.id, tools[101].id)).run();
  const edited = await client.listTools({ cursor: first.nextCursor }); assert(!names(edited).includes('t_101'));
  const other = f.services.create({ name: 'other', definition: modelDefinition() }); f.tokens.update(f.owner.id, { scopeServices: [] });
  const otherClient = await f.connect(other.name); await assert.rejects(otherClient.listTools({ cursor: first.nextCursor }), error => error.code === -32602);
  return { policyReadOnNextPage: true, disabledReadOnNextPage: true, crossTargetCursorRejected: true };
});

await check('SDK malformed persisted schema and unresolved remote reference remain sanitized', async f => {
  const tool = f.addTool('valid'); f.tools.bind(f.root.id, [tool.id]); const client = await f.connect();
  const remoteRef = f.tools.get(tool.id).config.url + '?private_marker=synthetic_secret';
  const observed = [];
  for (const parameters of [{ type: 'object', properties: { x: { type: 'not-a-type' } } }, { type: 'object', properties: { x: { $ref: remoteRef } } }]) {
    f.db.update(hostedTools).set({ config: { ...f.tools.get(tool.id).config, parameters } }).where(eq(hostedTools.id, tool.id)).run();
    await assert.rejects(client.listTools(), error => {
      observed.push({ code: error.code, message: error.message, data: error.data });
      assert(!JSON.stringify(error).includes('synthetic_secret'));
      return error.code === -32603 && error.data.reason === 'invalid_configuration';
    });
  }
  return { observed, remoteSchemaFetchNotPerformed: true };
});

await check('Protocol malformed call/list input partitions after SDK handler repair', async f => {
  const cases = [
    ['tools/call', undefined, -32602], ['tools/call', { name: 7 }, -32602],
    ['tools/call', { name: 'unknown', arguments: null }, -32602],
    ['tools/call', { name: 'unknown', arguments: [] }, -32602],
    ['tools/call', { name: 'unknown' }, -32601], ['tools/call', { name: '' }, -32601],
    ['tools/list', { cursor: 7 }, -32602], ['tools/list', { cursor: false }, -32602],
    ['tools/list', { cursor: null }, -32602], ['tools/list', { cursor: '' }, -32602],
  ];
  const before = f.fingerprint(), baseline = changes(f), observed = [];
  for (const [method, params, expected] of cases) {
    const result = await f.rpc(method, params); observed.push({ method, params, code: result.body.error?.code }); assert.equal(result.body.error?.code, expected);
  }
  const client = await f.connect(); await client.ping(); assert.deepEqual(names(await client.listTools()), []);
  assert.equal(f.fingerprint(), before); assert.equal(changes(f), baseline);
  return { observed, totalChangesUnchanged: true };
});

await check('Malformed envelope and notification framing with no execution or persistence', async f => {
  const envelopes = [null, 7, 'synthetic-string', [], {}, { jsonrpc: '1.0', id: 7, method: 'tools/list' }, { jsonrpc: '2.0', id: {}, method: 'tools/list' }, [{ jsonrpc: '2.0', id: 7, method: 'tools/list' }], [{ jsonrpc: '2.0', id: 7, method: 'tools/list' }, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'unknown' } }]];
  const baseline = changes(f), observed = [], invalidAccepted = [];
  for (const body of envelopes) {
    const response = await fetch(f.endpoint(), { method: 'POST', headers: { Authorization: `Bearer ${SYNTHETIC_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' }, body: JSON.stringify(body) });
    const text = await response.text(), result = text ? JSON.parse(text) : null;
    const item = { body, status: response.status, code: result?.error?.code, result: result?.result, text }; observed.push(item);
    if (response.status < 400 || !result?.error) invalidAccepted.push(item);
  }
  const notification = await fetch(f.endpoint(), { method: 'POST', headers: { Authorization: `Bearer ${SYNTHETIC_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(notification.status, 202); assert.equal(await notification.text(), ''); assert.equal(changes(f), baseline);
  console.log('AUDIT ENVELOPES ' + JSON.stringify({ observed, invalidAccepted, initializedNotification: notification.status, counts: f.counts, totalChangesUnchanged: true }));
  assert.deepEqual(invalidAccepted, [], 'Malformed/batch bodies must be rejected for 2025-11-25');
  return { observed, initializedNotification: 202, totalChangesUnchanged: true };
});

console.log('AUDIT SUMMARY ' + JSON.stringify({ passed, failed: process.exitCode === 1 }));

```
