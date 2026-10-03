/** Disposable real HTTP acceptance; no production configuration or live models.
 * Run: node --import tsx scripts/validate-tool-mismatch-fastfail.ts [evidence.json]
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import "../server/src/core/format";
import { buildResponse, serializeStream } from "../server/src/core/format/registry";
import { fabricateStream } from "../server/src/core/ir/stream";
import type { Family } from "../server/src/core/ir/params";
import type { ContentPart } from "../server/src/core/ir/content";
import { parseService, parseServiceSteps } from "../server/src/execution/definition";
import { HttpToolSchema } from "../server/src/execution/toolHttp";
import { buildTranscriptionForm } from "../server/src/execution/asr";
import { readMultipartField, upsertMultipartField } from "../server/src/core/upstream/multipart";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-fastfail-http-"));
Object.assign(process.env, { NODE_ENV: "test", DATA_DIR: dataDir, ALLOW_PRIVATE_UPSTREAMS: "1", LOG_PAYLOAD_MAX_CHARS: "0",
  ADMIN_PASSWORD: "synthetic-fastfail-admin", SESSION_SECRET: "synthetic-fastfail-session", PROXY_MASTER_KEY: Buffer.alloc(32, 19).toString("hex"),
  SIMULATED_STREAMING_TOKEN_RATE: "2000000", STREAM_COMMIT_GRACE_MS: "600000", JSON_COMMIT_GRACE_MS: "50" });
const calls: Array<{ provider: string; body: Record<string, unknown> }> = [];
const evidence: Array<Record<string, unknown>> = [];
const families: Record<string, Family> = { wire: "openai_completion", anthropic: "anthropic", completion: "openai_completion",
  asr: "openai_completion", retryAsr: "openai_completion", slowAsr: "openai_completion" };
const slowMs = 800;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const synthetic = http.createServer((req, res) => {
  let raw = ""; req.setEncoding("utf8"); req.on("data", chunk => { raw += chunk; });
  req.on("end", () => { void (async () => {
    const provider = req.url!.split("/")[1];
    const multipart = String(req.headers["content-type"]).startsWith("multipart/form-data");
    const body = multipart ? { multipart: raw, contentType: String(req.headers["content-type"]) } : JSON.parse(raw) as Record<string, unknown>;
    calls.push({ provider, body });
    if (provider === "adapter") { res.setHeader("content-type", "application/json"); res.end('{"results":[]}'); return; }
    const count = calls.filter(call => call.provider === provider).length;
    if (provider.startsWith("retry") && count < 3) {
      res.writeHead(provider === "retry400" ? 400 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "tool_not_found", message: "Tool 'web_search' not found" } })); return;
    }
    if (provider.startsWith("slow")) await sleep(slowMs);
    if (res.destroyed) return;
    if (multipart) { res.setHeader("content-type", "application/json"); res.end('{"text":"ASR text"}'); return; }
    const family = families[provider] ?? "openai_responses";
    const local = (body.tools as Array<{ name?: string }> | undefined)?.some(tool => tool.name === "provider_server_side_lookup");
    const done = JSON.stringify(body).includes('"function_call_output"');
    const wantsLocal = local && !done && (body.tool_choice as { name?: string } | undefined)?.name !== "client";
    const content: ContentPart[] = wantsLocal ? [{ type: "tool_use", id: "operation_1", name: "provider_server_side_lookup", input: {} }]
      : [{ type: "text", text: provider.toLowerCase().includes("ocr") ? '[{"index":1,"image":"OCR text"}]' : "Synthetic answer" }];
    const response = buildResponse(family, { id: "synthetic", model: "up", created: 1, content, stopReason: wantsLocal ? "tool_use" : "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
    if (!body.stream) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(response.renderSelf("up"))); return; }
    res.setHeader("content-type", "text/event-stream");
    for await (const chunk of serializeStream(family, fabricateStream(response.data(), Infinity), { model: "up" })) res.write(chunk);
    res.end();
  })().catch(() => { res.writeHead(500); res.end(); }); });
});

let app: Awaited<ReturnType<typeof import("../server/src/app")["buildApp"]>> | undefined;
let container: Awaited<ReturnType<typeof import("../server/src/composition/container")["boot"]>> | undefined;
try {
  await new Promise<void>(resolve => synthetic.listen(0, "127.0.0.1", resolve));
  const upstream = `http://127.0.0.1:${(synthetic.address() as AddressInfo).port}`;
  const { boot } = await import("../server/src/composition/container");
  const { buildApp } = await import("../server/src/app");
  const c = container = await boot();
  const model = c.models.create({ name: "m" });
  for (const name of ["first", "second", "compatible", "wire", "anthropic", "retry400", "retry503", "slow", "completion", "ocr", "asr", "retryOcr", "retryAsr", "slowOcr", "slowAsr"]) {
    const provider = c.providers.create({ name, type: families[name] ?? "openai_responses", baseUrl: `${upstream}/${name}/v1`, apiKey: "synthetic-provider-key" });
    c.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "up" });
  }
  const owner = c.tokens.create({ name: "synthetic-http-acceptance" });
  app = await buildApp(c); app.log.level = "silent";
  await app.listen({ port: 0, host: "127.0.0.1" });
  const local = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const retry = { maxAttempts: 100, on: ["error"], intervalMs: 600_000, backoff: { initialMs: 600_000, maxMs: 600_000 } };
  const blocked = (provider: string) => ({ model: "m", provider, retry, advanceOn: [], serverToolPolicy: { mode: "whitelist", names: [] } });
  const compatible = (provider = "compatible") => ({ model: "m", provider, retry });
  const add = (name: string, steps: unknown[]) => c.services.create({ name, definition: parseServiceSteps({ timeoutMs: 3000, steps }) });
  const request = async (service: string, patch: Record<string, unknown> = {}, family: Family = "openai_responses", secret = owner.secret) => {
    const start = Date.now();
    const payload = family === "anthropic" ? { model: service, messages: [{ role: "user", content: "hello" }], max_tokens: 100, tools: [{ type: "web_search_20250305", name: "web_search" }], ...patch }
      : family === "openai_completion" ? { model: service, messages: [{ role: "user", content: "hello" }], tools: [{ type: "web_search" }], ...patch }
        : { model: service, input: "hello", tools: [{ type: "web_search" }], store: false, ...patch };
    const response = await fetch(`${local}${family === "anthropic" ? "/v1/messages" : family === "openai_completion" ? "/v1/chat/completions" : "/v1/responses"}`, {
      method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000),
    });
    const headersMs = Date.now() - start;
    return { response, start, headersMs };
  };
  const record = (id: string, status: number, elapsedMs: number, extra: Record<string, unknown> = {}) => {
    const counts: Record<string, number> = {};
    for (const call of calls) counts[call.provider] = (counts[call.provider] ?? 0) + 1;
    const completed = c.activeRequests.listCompleted(1)[0];
    const stages = completed?.events.filter(event => event.node === "step.start").map(event => Number(event.message.match(/step (\d+)/)?.[1])) ?? [];
    const row = { id, status, elapsedMs, requests: counts, requestOrder: calls.map(call => call.provider), stages, passed: true, ...extra };
    evidence.push(row); console.log(JSON.stringify(row));
    calls.length = 0;
    c.activeRequests.clear();
  };
  const check = async (id: string, service: string, expectedStatus: number, expectedProviders: string[], patch: Record<string, unknown> = {}, family: Family = "openai_responses", expectedStages?: number[]) => {
    const hit = await request(service, patch, family);
    const body = await hit.response.text();
    assert.equal(hit.response.status, expectedStatus, `${id}: ${body}`);
    assert.deepEqual(calls.map(call => call.provider), expectedProviders, id);
    if (expectedStages) {
      const completed = c.activeRequests.listCompleted(1)[0];
      const stages = completed?.events.filter(event => event.node === "step.start").map(event => Number(event.message.match(/step (\d+)/)?.[1]));
      assert.deepEqual(stages, expectedStages, `${id}: sequential stage order`);
    }
    assert(!body.includes("synthetic-provider-key"));
    const elapsedMs = Date.now() - hit.start;
    assert(elapsedMs < 2500, `${id}: retry backoff was not skipped`);
    record(id, hit.response.status, elapsedMs, { headersMs: hit.headersMs });
    return body;
  };

  add("one", [blocked("first"), compatible()]);
  await check("first mismatch to immediate compatible stage", "one", 200, ["compatible"], {}, "openai_responses", [1, 2]);
  add("many", [blocked("first"), blocked("second"), compatible()]);
  await check("multiple mismatches preserve strict order", "many", 200, ["compatible"], {}, "openai_responses", [1, 2, 3]);
  add("all", [blocked("first"), { ...blocked("second"), overrides: { extra: { tools: [{ type: "web_fetch" }] } } }]);
  const all = JSON.parse(await check("all policy mismatches keep final native error", "all", 400, [], {}, "openai_responses", [1, 2]));
  assert.equal(all.error.code, "tool_not_found"); assert.equal(all.error.message, "Tool 'web_fetch' not found");
  for (const patch of [{ stream: true }, { background: true, store: true }]) {
    const failed = JSON.parse(await check(`all mismatch ${patch.stream ? "stream" : "background"} stays HTTP 400`, "all", 400, [], patch));
    assert.equal(failed.error.code, "tool_not_found");
  }
  add("all-wire", [blocked("first"), compatible("wire")]);
  const wire = JSON.parse(await check("all mismatches report last wire failure", "all-wire", 400, []));
  assert.equal(wire.error.code, null); assert(wire.error.message.includes("cannot be sent to openai_completion"));
  add("native-wire", [compatible("wire"), compatible()]);
  await check("wire mismatch to next native stage", "native-wire", 200, ["compatible"]);
  for (const provider of ["retry400", "retry503"]) {
    add(provider, [{ ...compatible(provider), retry: { maxAttempts: 3, on: ["error"], intervalMs: 20 } }]);
    await check(`${provider} tool-error lookalike retains 3 upstream attempts`, provider, 200, [provider, provider, provider]);
  }

  add("erase", [{ ...blocked("first"), overrides: { extra: { tools: [], tool_choice: "none" } } }, compatible()]);
  for (const [label, patch] of Object.entries({ duplicate: { tools: [{ type: "web_search" }, { type: "web_search" }] },
    missingChoice: { tool_choice: { type: "function", name: "missing" } }, droppedEntry: { tools: [{}, { type: "web_search" }] },
    badName: { tools: [{ type: "function", name: 42 }] }, badSchema: { tools: [{ type: "function", name: "f", parameters: 42 }] },
    badAllowed: { tool_choice: { type: "allowed_tools", tools: [{ type: "function", name: 42 }] } },
    conflictingSession: { previous_response_id: "synthetic", conversation: "synthetic" },
    privateHistory: { input: [{ type: "function_call", name: "f", call_id: "x", arguments: "{}", __hydrogenCanonicalMessages: [] }] } })) {
    await check(`caller ${label} cannot evade global validation`, "erase", 400, [], patch);
  }
  await check("Completion n>1 cannot evade global validation", "erase", 400, [], { n: 2 }, "openai_completion");
  for (const family of ["openai_completion", "anthropic"] as const) {
    await check(`${family} malformed declaration stays terminal`, "erase", 400, [], { tools: [{}, { type: "web_fetch", name: "web_fetch" }] }, family);
  }
  const other = add("other", [compatible()]);
  const denied = c.tokens.create({ name: "synthetic-scope", scopeServices: [other.id] });
  const deniedHit = await request("one", {}, "openai_responses", denied.secret);
  await deniedHit.response.text(); assert.equal(deniedHit.response.status, 403); assert.equal(calls.length, 0);
  record("key scope cannot use fallback", 403, Date.now() - deniedHit.start);
  await check("no tools uses ordinary first stage", "one", 200, ["first"], { tools: [] });
  await check("compatible streaming fallback", "one", 200, ["compatible"], { stream: true });

  add("slow", [blocked("first"), compatible("slow")]);
  const streamed = await request("slow", { stream: true });
  assert.equal(streamed.response.status, 200); assert(streamed.headersMs < slowMs / 2, "stream headers waited for the fallback model");
  assert((await streamed.response.text()).includes("response.completed"));
  assert(Date.now() - streamed.start >= slowMs, "synthetic provider delay did not run");
  assert.deepEqual(calls.map(call => call.provider), ["slow"]);
  record("slow compatible fallback releases stream headers", 200, Date.now() - streamed.start, { headersMs: streamed.headersMs, providerDelayMs: slowMs });
  const background = await request("slow", { background: true, store: true });
  assert.equal(background.response.status, 200);
  assert(background.headersMs < slowMs / 2, "background waited for the fallback model");
  const queued = await background.response.json() as { id: string; status: string }; assert.equal(queued.status, "queued");
  for (let i = 0; i < 100; i++) {
    const response = await fetch(`${local}/v1/responses/${queued.id}`, { headers: { authorization: `Bearer ${owner.secret}` } });
    const body = await response.json() as { status: string };
    if (body.status === "completed") break;
    assert.equal(i === 99, false); await sleep(20);
  }
  assert.deepEqual(calls.map(call => call.provider), ["slow"]);
  assert(Date.now() - background.start >= slowMs, "synthetic background delay did not run");
  record("slow compatible fallback returns background ID immediately", background.response.status, Date.now() - background.start, { headersMs: background.headersMs, providerDelayMs: slowMs });

  const missing = { ...blocked("first"), model: "absent", retry: { maxAttempts: 2, on: ["error"], intervalMs: slowMs } };
  add("mapping", [missing, blocked("second")]);
  const mapped = await request("mapping", { background: true, store: true });
  assert.equal(mapped.response.status, 200);
  assert(mapped.headersMs < slowMs / 2, "ordinary mapping retry blocked background reply");
  const mappingJob = await mapped.response.json() as { id: string };
  for (let i = 0; i < 100; i++) { const response = await fetch(`${local}/v1/responses/${mappingJob.id}`, { headers: { authorization: `Bearer ${owner.secret}` } });
    if ((await response.json() as { status: string }).status === "failed") break;
    assert.equal(i === 99, false); await sleep(20);
  }
  assert.equal(calls.length, 0);
  record("ordinary mapping retry releases existing background lifecycle", mapped.response.status, Date.now() - mapped.start, { headersMs: mapped.headersMs, configuredRetryMs: slowMs });

  const withTool = add("effect", [{ ...blocked("first"), serverToolPolicy: { mode: "blacklist", names: ["web_fetch"] } }, compatible()]);
  const adapter = c.hostedTools.create(HttpToolSchema.parse({ name: "lookup", url: `${upstream}/adapter`, parameters: { type: "object" }, bodyTemplate: {}, serverTool: { name: "web_search", resultPath: "/results" } }));
  c.hostedTools.bind(withTool.id, [adapter.id]);
  await check("model-round failover never replays completed tool side effect", "effect", 200, ["compatible", "adapter", "compatible"], { tools: [{ type: "web_search" }, { type: "web_fetch" }] });
  add("anthropic-fallback", [blocked("anthropic"), { ...compatible("anthropic"), serverToolPolicy: { mode: "whitelist", names: ["web_search"] } }]);
  await check("Anthropic native sequential fallback", "anthropic-fallback", 200, ["anthropic"], {}, "anthropic");

  for (const kind of ["ocr", "asr"] as const) for (const mode of kind === "ocr" ? ["normal", "retry", "stream", "background", "all-stream", "all-background"] : ["normal", "retry", "stream"]) {
    const allMismatch = mode.startsWith("all-");
    const provider = mode === "retry" ? `retry${kind === "ocr" ? "Ocr" : "Asr"}` : mode.endsWith("stream") || mode.endsWith("background") ? `slow${kind === "ocr" ? "Ocr" : "Asr"}` : kind;
    const child = c.services.create({ name: `child-${kind}-${mode}`, definition: parseServiceSteps({ category: kind === "ocr" ? "ocr" : "stt", timeoutMs: 3000,
      steps: [{ ...blocked(provider), retry: { maxAttempts: 3, on: ["error"], intervalMs: 20 } }] }) });
    if (kind === "ocr") c.hostedTools.bind(child.id, [adapter.id]);
    const leaf = add(`outer-model-${kind}-${mode}`, [{ ...blocked("first"), serverToolPolicy: { mode: "blacklist", names: ["web_fetch"] } },
      allMismatch ? { ...blocked("second"), serverToolPolicy: { mode: "blacklist", names: ["web_fetch"] } } : compatible(kind === "ocr" ? "compatible" : "completion")]);
    const root = c.services.create({ name: `internal-${kind}-${mode}`, definition: parseService({ kind: "micro_agent", timeoutMs: 3000,
      ...(mode === "all-stream" ? { hostedTools: { streamMode: "all" } } : {}),
      [kind]: { service: child.name }, stages: [{ name: "model", service: leaf.name }] }) });
    if (kind === "ocr") c.hostedTools.bind(root.id, [adapter.id]);
    const scoped = c.tokens.create({ name: `synthetic-${kind}-${mode}`, scopeServices: [root.id] });
    const family = kind === "ocr" ? "openai_responses" : "openai_completion";
    // Distinct synthetic media prevent the normal content cache from satisfying
    // later scenarios that must measure their own child dispatch/retry count.
    const content = kind === "ocr" ? { type: "input_image", image_url: `data:image/png;base64,${Buffer.from(`synthetic-${mode}`).toString("base64")}` }
      : { type: "input_audio", input_audio: { data: Buffer.from(`RIFFsyntheticWAVE-${mode}`).toString("base64"), format: "wav" } };
    const message = { role: "user", content: [content] };
    const patch = { ...(kind === "ocr" ? { input: [message] } : { messages: [message] }),
      tools: [{ type: "web_search" }, { type: "web_fetch" }, kind === "ocr" ? { type: "function", name: "client", parameters: {} } : { type: "function", function: { name: "client", parameters: {} } }],
      tool_choice: kind === "ocr" ? { type: "function", name: "client" } : { type: "function", function: { name: "client" } },
      stream: mode.endsWith("stream"), background: mode.endsWith("background"), store: mode.endsWith("background") };
    const beforeLogs = c.logs.query({}).total;
    const hit = await request(root.name, patch, family, scoped.secret); assert.equal(hit.response.status, 200);
    if (kind === "ocr" && (mode.endsWith("stream") || mode.endsWith("background"))) assert(hit.headersMs < slowMs / 2, "internal child held Responses headers");
    let wire = await hit.response.text();
    if (mode.endsWith("background")) {
      const queued = JSON.parse(wire); assert.equal(queued.status, "queued");
      for (let i = 0; i < 100; i++) { const response = await fetch(`${local}/v1/responses/${queued.id}`, { headers: { authorization: `Bearer ${scoped.secret}` } });
        wire = await response.text(); if (JSON.parse(wire).status === (allMismatch ? "failed" : "completed")) break; assert(i < 99); await sleep(20); }
    }
    assert(wire.includes(allMismatch ? "web_fetch" : "Synthetic answer"));
    if (allMismatch) assert(wire.includes(mode.endsWith("stream") ? "response.failed" : '"status":"failed"'));
    const childCalls = calls.filter(call => call.provider === provider);
    assert.equal(childCalls.length, mode === "retry" ? 3 : 1);
    for (const call of childCalls) {
      assert.equal(call.body.tools, undefined); assert.equal(call.body.tool_choice, undefined);
      if (kind === "asr") { const form = String(call.body.multipart); assert(form.includes('name="file"')); assert(!form.includes('name="tools"')); assert(!form.includes("client")); }
    }
    assert.deepEqual(calls.map(call => call.provider), [...Array(mode === "retry" ? 3 : 1).fill(provider), ...(allMismatch ? [] : [kind === "ocr" ? "compatible" : "completion"])]);
    if (!allMismatch) { const outerBody = calls.at(-1)!.body;
      assert(JSON.stringify(outerBody).includes(kind === "ocr" ? "OCR text" : "ASR text"));
      assert(JSON.stringify(outerBody.tools).includes(kind === "ocr" ? "provider_server_side_lookup" : "web_search"));
      assert(JSON.stringify(outerBody.tool_choice).includes("client")); }
    const logs = c.logs.query({}); assert.equal(logs.total - beforeLogs, 1);
    const row = logs.rows[0]; assert.equal(row.serviceId, root.id); assert.equal(row.tokenId, scoped.token.id);
    assert.equal(row.httpStatus, allMismatch ? 400 : 200);
    assert.equal(row.attempts, childCalls.length + 2); // child attempts plus both outer sequential stages
    const expectedTokens = kind === "ocr" ? allMismatch ? 2 : 4 : 2; assert.equal(row.totalTokens, expectedTokens);
    const meter = c.tokens.get(scoped.token.id)!; assert.equal(meter.usedRequests, 1); assert.equal(meter.usedTokens, expectedTokens);
    record(`independent tool-free ${kind} ${mode}; outer sequential mismatch`, 200, Date.now() - hit.start,
      { headersMs: hit.headersMs, childAttempts: childCalls.length, totalAttempts: row.attempts, childToolCount: 0, topLevelLogRows: 1, requestCharges: meter.usedRequests, tokenCharges: meter.usedTokens, finalJobStatus: row.httpStatus });
    if (mode === "normal") {
      const denied = await request(child.name, {}, "openai_responses", scoped.secret); await denied.response.text();
      assert.equal(denied.response.status, 403); assert.equal(calls.length, 0);
      record(`${kind} root scope permits internal reference but denies direct child API`, 403, Date.now() - denied.start);
    }
  }

  const fieldCases = [
    { name: "nested", overrides: { extra: { language: "en", prompt: "Recognize English proper names.\r\nKeep punctuation." } }, expected: { language: "en", prompt: "Recognize English proper names.\r\nKeep punctuation." } },
    { name: "direct-precedence", overrides: { language: "en", prompt: "Use direct English hint.", extra: { language: "fr", prompt: "Use nested English hint." } }, expected: { language: "en", prompt: "Use direct English hint." } },
    { name: "direct-null-empty", overrides: { language: null, prompt: "", extra: { language: "en", prompt: "Use nested English hint." } }, expected: { language: null, prompt: "" } },
    { name: "empty", overrides: { extra: { language: "", prompt: "" } }, expected: { language: "", prompt: "" } },
    { name: "null", overrides: { extra: { language: null, prompt: null } }, expected: { language: null, prompt: null } },
  ];
  for (const sample of fieldCases) {
    const child = c.services.create({ name: `configured-asr-${sample.name}`, definition: parseServiceSteps({ category: "stt", timeoutMs: 3000,
      steps: [{ model: "m", provider: "asr", overrides: sample.overrides }] }) });
    const audio = { data: Buffer.from(`RIFFconfigured-asr-${sample.name}`).toString("base64"), format: "wav" };
    const control = buildTranscriptionForm(child.name, audio);
    let publicForm = control.body;
    for (const field of ["language", "prompt"] as const) if (sample.expected[field] !== null) publicForm = upsertMultipartField(publicForm, control.contentType, field, "Caller English hint.")!;
    const publicResponse = await fetch(`${local}/v1/audio/transcriptions`, { method: "POST", headers: {
      authorization: `Bearer ${owner.secret}`, "content-type": control.contentType,
    }, body: new Uint8Array(publicForm), signal: AbortSignal.timeout(5000) });
    assert.equal(publicResponse.status, 200); assert.equal((await publicResponse.json() as { text: string }).text, "ASR text");
    assert.deepEqual(calls.map(call => call.provider), ["asr"]);
    const fields = (call: typeof calls[number]) => {
      const form = Buffer.from(String(call.body.multipart)); const contentType = String(call.body.contentType);
      assert.equal(readMultipartField(form, contentType, "model"), "up");
      assert(form.includes(Buffer.from(audio.data, "base64")));
      for (const field of ["tools", "tool_choice"]) assert.equal(readMultipartField(form, contentType, field), null);
      return { language: readMultipartField(form, contentType, "language"), prompt: readMultipartField(form, contentType, "prompt") };
    };
    const publicFields = fields(calls[0]); assert.deepEqual(publicFields, sample.expected);
    calls.length = 0; c.activeRequests.clear();
    const leaf = add(`configured-asr-model-${sample.name}`, [blocked("first"), compatible("completion")]);
    const root = c.services.create({ name: `configured-asr-root-${sample.name}`, definition: parseService({ kind: "micro_agent", asr: { service: child.name }, stages: [{ name: "model", service: leaf.name }] }) });
    const scoped = c.tokens.create({ name: `synthetic-configured-${sample.name}`, scopeServices: [root.id] });
    const beforeLogs = c.logs.query({}).total;
    const hit = await request(root.name, { language: "caller-only", prompt: "Outer English hint.",
      messages: [{ role: "user", content: [{ type: "input_audio", input_audio: audio }] }],
      tools: [{ type: "web_search" }, { type: "function", function: { name: "client", parameters: {} } }],
      tool_choice: { type: "function", function: { name: "client" } },
    }, "openai_completion", scoped.secret);
    assert.equal(hit.response.status, 200); assert((await hit.response.text()).includes("Synthetic answer"));
    assert.deepEqual(calls.map(call => call.provider), ["asr", "completion"]);
    const internalFields = fields(calls[0]);
    console.log(JSON.stringify({ probe: "ASR configured-field parity", case: sample.name, publicFields, internalFields }));
    assert.deepEqual(internalFields, publicFields, `internal/public configured ${sample.name} fields differ`);
    assert(JSON.stringify(calls[1].body).includes("ASR text")); assert(JSON.stringify(calls[1].body.tool_choice).includes("client"));
    const logs = c.logs.query({}); assert.equal(logs.total - beforeLogs, 1); assert.equal(logs.rows[0].serviceId, root.id);
    assert.equal(logs.rows[0].attempts, 3); assert.equal(logs.rows[0].totalTokens, 2);
    const meter = c.tokens.get(scoped.token.id)!; assert.equal(meter.usedRequests, 1); assert.equal(meter.usedTokens, 2);
    record(`public STT/internal ASR configured fields ${sample.name}`, 200, Date.now() - hit.start,
      { publicFields, internalFields, publicProviderCalls: 1, childToolCount: 0, topLevelLogRows: 1, requestCharges: 1, tokenCharges: 2, totalAttempts: 3 });
  }

  const result = { ticket: "HYD-TOOL-MISMATCH-FASTFAIL", base: "8c12ff24b72767bcc7b0438a4091c36e7ecddccc", node: process.version,
    environment: `${process.platform}/${process.arch}`, providers: "synthetic loopback only", scenarios: evidence, passed: evidence.length, failed: 0,
    limitations: ["Retained pending adapter mismatches still keep their terminal prepass rejection; this remains a separate unmet core case, not an approved exclusion.", "ASR audio is supported through Chat Completions; public Responses background cannot express Completion input_audio.", "Internal ASR forwards only the authorized configured language/prompt fields; wider public STT parameter parity is unchanged and existing zero-token STT accounting is preserved."] };
  if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ passed: evidence.length, failed: 0 }));
} finally {
  await app?.close();
  await container?.egressPool.closeAll();
  container?.sqlite.close();
  await new Promise<void>(resolve => synthetic.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
