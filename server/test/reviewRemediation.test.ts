import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import Fastify from "fastify";
import "../src/core/format";
import { buildRequest, parseRequest, parseStream, parseResponse, serializeStream } from "../src/core/format/registry";
import type { Family } from "../src/core/ir/params";
import { collectStream } from "../src/core/ir/stream";
import { sendBuffered } from "../src/core/upstream/roundtrip";
import { readBoundedBody } from "../src/core/upstream/body";
import { ThinkingPolicy } from "../src/core/ir/thinking";
import { historyItems, historyMessages, publicHistoryItem } from "../src/persistence/conversationHistory";
import { openDatabase } from "../src/db";
import { TokenRepo } from "../src/persistence/tokenRepo";
import { UserRepo } from "../src/persistence/userRepo";
import { seedAdminIfEmpty } from "../src/db/bootstrap";
import { exportBackup, restoreBackup } from "../src/backup/archive";
import { RequestGate } from "../src/util/requestGate";
import { inlineUrlFiles, MAX_ATTACHMENT_URLS } from "../src/execution/fileFetch";
import { SsrfGuard } from "../src/core/upstream/ssrf";
import { UpstreamClient } from "../src/core/upstream/client";
import { chatUrl } from "../src/core/upstream/endpoints";
import type { Transport } from "../src/core/upstream/transport";
import { requireClientToken } from "../src/auth/tokenAuth";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function database() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrogen-remediation-"));
  const db = openDatabase(dir);
  cleanup.push(() => { db.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}
async function* source(frames: string[]) { yield* frames; }
const frame = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
const failure = { type: "invalid_request_error", message: "bad tool schema" };

describe("review critical/high regressions", () => {
  it.each(["anthropic", "openai_completion", "openai_responses"] as Family[])("retains in-stream errors in %s and does not fabricate success", async family => {
    const frames = family === "openai_responses"
      ? [frame({ response: { error: failure } }, "response.failed")]
      : [frame({ type: "error", error: failure }, "error"), frame({ type: "message_stop" })];
    const result = await collectStream(parseStream(family, source(frames)));
    expect(result).toMatchObject({ incomplete: true, error: "bad tool schema", failure: { status: 400, retryable: false } });
    const request = buildRequest(family, { requestedService: "m", messages: [], params: {}, stream: true });
    const transport = { postStream: async () => ({ status: 200, headers: {}, body: Readable.from(frames) }) } as Transport;
    expect(await sendBuffered(request, transport, { url: "https://test.invalid", upstreamModel: "m", headers: {}, timeoutMs: 1000 })).toMatchObject({ ok: false, status: 400, message: "bad tool schema", retryable: false });
  });
  it("does not map finish_reason:error to stop", async () => {
    const result = await collectStream(parseStream("openai_completion", source([frame({ choices: [{ finish_reason: "error", delta: {} }] }), "data: [DONE]\n\n"])));
    expect(result.incomplete).toBe(true); expect(result.error).toContain("finish_reason:error");
  });
  it("preserves canonical signed/redacted Anthropic conversation history", () => {
    const messages = parseRequest("anthropic", { model: "m", messages: [{ role: "assistant", content: [
      { type: "thinking", thinking: "thought", signature: "sig" }, { type: "redacted_thinking", data: "opaque" },
      { type: "tool_use", id: "c", name: "lookup", input: { q: 1 } },
    ] }] }).messages;
    const items = historyItems(messages);
    expect(historyMessages(items)).toEqual(messages);
    expect(JSON.stringify(items.map(publicHistoryItem))).not.toContain("__hydrogenCanonicalMessages");
    const wire = buildRequest("anthropic", { requestedService: "m", messages: historyMessages(items), params: {}, stream: false }).render({ upstreamModel: "m" });
    expect(JSON.stringify(wire)).toContain('"signature":"sig"'); expect(JSON.stringify(wire)).toContain('"data":"opaque"');
  });
  it("retains initial Anthropic tool input when no JSON deltas arrive", async () => {
    const frames = [frame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "c", name: "f", input: { q: "hello" } } }), frame({ type: "content_block_stop", index: 0 }), frame({ type: "message_stop" })];
    expect((await collectStream(parseStream("anthropic", source(frames)))).data.content).toContainEqual({ type: "tool_use", id: "c", name: "f", input: { q: "hello" } });
  });
  it("rejects metadata targets even on a proxied request", async () => {
    const dispatcherFor = vi.fn();
    const client = new UpstreamClient(new SsrfGuard({ allowPrivate: true, allowlist: () => [] }), { dispatcherFor } as never);
    await expect(client.getJson("http://169.254.169.254/latest/meta-data", {}, { timeoutMs: 100, proxy: { host: "127.0.0.1", port: 1234 } as never })).rejects.toThrow("disallowed");
    expect(dispatcherFor).not.toHaveBeenCalled();
  });
  it("caps attachment count before doing any fetch", async () => {
    const request = buildRequest("openai_completion", { requestedService: "m", messages: [{ role: "user", content: Array.from({ length: MAX_ATTACHMENT_URLS + 1 }, (_, i) => ({ type: "file" as const, source: { kind: "url" as const, url: `https://test.invalid/${i}` } })) }], params: {}, stream: false });
    const getStream = vi.fn();
    await expect(inlineUrlFiles(request, "openai_completion", { getStream } as never, { timeoutMs: 1000 })).rejects.toThrow("distinct URL attachments");
    expect(getStream).not.toHaveBeenCalled();
  });
  it("bounds aggregate attachment downloads by default while reading", async () => {
    const request = buildRequest("openai_completion", { requestedService: "m", messages: [{ role: "user", content: [1, 2].map(i => ({ type: "file" as const, source: { kind: "url" as const, url: `https://test.invalid/${i}` } })) }], params: {}, stream: false });
    const streams: Readable[] = [];
    const transport = { getStream: async () => { const body = Readable.from(Array.from({ length: 30 }, () => Buffer.alloc(1024 * 1024))); streams.push(body); return { status: 200, headers: {}, body }; } } as Transport;
    await expect(inlineUrlFiles(request, "openai_completion", transport, { timeoutMs: 10000 })).rejects.toThrow("remaining download limit");
    expect(streams[1].destroyed).toBe(true);
  });
  it("generates a non-public bootstrap secret", async () => {
    const { db } = database();
    const seed = await seedAdminIfEmpty(db, { username: "admin", password: "" });
    expect(seed.password).not.toBe("password"); expect(seed.password!.length).toBeGreaterThanOrEqual(32);
    expect(new UserRepo(db).initialCredentialHint()).toBeNull();
  });
});

describe("review control-integrity regressions", () => {
  it("atomically reserves the last request and token budget", () => {
    const { db } = database(), tokens = new TokenRepo(db, Buffer.alloc(32, 1));
    const token = tokens.create({ name: "one", maxRequests: 1 }).token;
    const lease = tokens.reserveQuota(token.id); expect(typeof lease).toBe("object");
    expect(tokens.reserveQuota(token.id)).toBe("requests");
    if (typeof lease !== "string") { const release = lease.retain(); lease.release(); expect(tokens.reserveQuota(token.id)).toBe("requests"); release(); }
    const budget = tokens.create({ name: "budget", maxTokens: 10 }).token;
    const tokenLease = tokens.reserveQuota(budget.id); expect(tokens.reserveQuota(budget.id)).toBe("tokens");
    tokens.incrementUsage(budget.id, 1, 10); if (typeof tokenLease !== "string") tokenLease.release();
    expect(tokens.reserveQuota(budget.id)).toBe("tokens");
  });
  it("rejects a concurrent authenticated request when maxRequests is one", async () => {
    const { db } = database(), tokens = new TokenRepo(db, Buffer.alloc(32, 1));
    const token = tokens.create({ name: "one", maxRequests: 1 });
    const app = Fastify(); cleanup.unshift(() => app.close());
    let release!: () => void; const wait = new Promise<void>(r => { release = r; });
    let markEntered!: () => void; const entered = new Promise<void>(r => { markEntered = r; });
    app.post("/run", { preHandler: requireClientToken(tokens, "openai_completion") }, async () => { markEntered(); await wait; tokens.incrementUsage(token.token.id, 1, 0); return {}; });
    const first = app.inject({ method: "POST", url: "/run", headers: { authorization: `Bearer ${token.secret}` } });
    await entered;
    try { expect((await app.inject({ method: "POST", url: "/run", headers: { authorization: `Bearer ${token.secret}` } })).statusCode).toBe(429); }
    finally { release(); expect((await first).statusCode).toBe(200); }
  });
  it("authenticates tables and metadata and refuses an empty-admin restore", async () => {
    const { db, sqlite } = database(), key = Buffer.alloc(32, 1);
    await seedAdminIfEmpty(db, { username: "admin", password: "a-test-password" });
    const pkg = await exportBackup(sqlite, key, { passphrase: "a-test-passphrase", includeLogs: false, includeImageCache: false, appVersion: "test" });
    const tampered = structuredClone(pkg); tampered.tables.users[0].username = "attacker";
    await expect(restoreBackup(sqlite, key, tampered, "a-test-passphrase")).rejects.toThrow("modified");
    const empty = structuredClone(pkg); empty.tables.users = [];
    await expect(restoreBackup(sqlite, key, empty, "a-test-passphrase")).rejects.toThrow("enabled admin");
    await restoreBackup(sqlite, key, pkg, "a-test-passphrase");
    expect(new UserRepo(db).getByUsername("admin")).toBeTruthy();
  });
  it("preflights oversized backup tables without materializing rows", async () => {
    const iterate = vi.fn();
    const sqlite = { prepare: (sql: string) => sql.startsWith("PRAGMA") ? { all: () => [{ name: "id" }] } : { get: () => ({ bytes: 128 * 1024 * 1024 }), iterate } };
    await expect(exportBackup(sqlite as never, Buffer.alloc(32), { passphrase: "test-passphrase", includeLogs: true, includeImageCache: false, appVersion: "test" })).rejects.toThrow("safe export budget");
    expect(iterate).not.toHaveBeenCalled();
  });
  it("locks restore admission throughout asynchronous preparation", () => {
    const gate = new RequestGate(); const release = gate.acquire();
    expect(() => gate.beginMaintenance()).toThrow("active requests"); release();
    const end = gate.beginMaintenance(); expect(() => gate.acquire()).toThrow("being restored"); end();
    const done = gate.acquire(); done(); expect(gate.activeCount).toBe(0);
  });
  it("password change and logout revoke copied sessions immediately", async () => {
    const { db } = database(), users = new UserRepo(db);
    const user = await users.create({ username: "u", password: "first-password", role: "admin", mustChangePassword: true });
    const initial = users.sessionVersion(user);
    expect(await users.changeOwnPassword(user.id, "new-password")).toBe("wrong_current");
    expect(await users.changeOwnPassword(user.id, "new-password", "first-password")).toBe("ok");
    const changed = users.sessionVersion(users.get(user.id)!); expect(changed).not.toBe(initial);
    users.revokeSessions(user.id); expect(users.sessionVersion(users.get(user.id)!)).not.toBe(changed);
  });
  it("fits legacy Claude thinking under the client's max_tokens", () => {
    expect(ThinkingPolicy.anthropic("high", 4096, undefined, "claude-sonnet-4-5")).toMatchObject({ max_tokens: 4096, thinking: { budget_tokens: 4095 } });
    expect(ThinkingPolicy.anthropic("high", 1024, undefined, "claude-sonnet-4-5").thinking).toEqual({ type: "disabled" });
  });
  it("preserves nonempty replay reasoning when an earlier alias is empty", () => {
    expect(parseRequest("openai_completion", { messages: [{ role: "assistant", reasoning: "", reasoning_content: "thought", tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }] }] }).messages[0].content).toContainEqual({ type: "reasoning", text: "thought" });
  });
  it("preserves image detail and requested logprobs on replay", async () => {
    const request = parseRequest("openai_completion", { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/image.png", detail: "high" } }] }] });
    expect(JSON.stringify(buildRequest("openai_responses", request.data()).render({ upstreamModel: "m" }))).toContain('"detail":"high"');
    const value = { content: [{ token: "a", logprob: -0.1 }] };
    const response = parseResponse("openai_completion", { choices: [{ message: { content: "a" }, finish_reason: "stop", logprobs: value }] });
    expect((response.renderSelf("m").choices as { logprobs: unknown }[])[0].logprobs).toEqual(value);
    const frames = [frame({ choices: [{ delta: { content: "a" }, finish_reason: "stop", logprobs: value }] }), "data: [DONE]\n\n"];
    const parsed = await collectStream(parseStream("openai_completion", source(frames)));
    expect(parsed.data.logprobs).toEqual(value);
    let wire = ""; for await (const part of serializeStream("openai_completion", parseStream("openai_completion", source(frames)), { model: "m" })) wire += part;
    expect(wire).toContain('"logprob":-0.1');
  });
  it.each(["64:ff9b::a9fe:a9fe", "64:ff9b:1::7f00:1", "2002:7f00:1::"]) ("blocks unsafe IPv6 transition address %s", async address => {
    const guard = new SsrfGuard({ allowPrivate: false, allowlist: () => [] });
    await expect(guard.assertAllowed(`http://[${address}]/`)).rejects.toThrow("disallowed");
  });
  it("appends endpoint paths before the base query string", () => {
    expect(chatUrl({ type: "openai_completion", baseUrl: "https://example.com/v1?version=1", apiKey: null })).toBe("https://example.com/v1/chat/completions?version=1");
  });
  it("bounds upstream error buffering and preserves split UTF-8", async () => {
    const bytes = Buffer.from("你好");
    expect(await readBoundedBody(Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]), 64)).toBe("你好");
    const body = Readable.from([Buffer.alloc(128)]); expect((await readBoundedBody(body, 16, true)).length).toBe(16); expect(body.destroyed).toBe(true);
  });
  it.each([0, -3, "abc", 1.5])("rejects invalid n=%s", n => {
    expect(() => parseRequest("openai_completion", { messages: [], n })).toThrow("positive integer");
  });
});
