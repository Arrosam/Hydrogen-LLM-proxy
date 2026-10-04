import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type OpenedDatabase } from "../src/db";
import { ResponseRepo } from "../src/persistence/responseRepo";
import { TokenRepo } from "../src/persistence/tokenRepo";
import { HostedToolRepo } from "../src/persistence/hostedToolRepo";
import { HttpToolSchema } from "../src/execution/toolHttp";
import { ServiceRepo } from "../src/persistence/serviceRepo";
import { hostedTools } from "../src/db/schema";
import "../src/core/format";
import type { Message, ToolResultPart, ToolUsePart } from "../src/core/ir/content";
import { historyItems, historyMessages } from "../src/persistence/conversationHistory";

let opened: OpenedDatabase;
let dir: string;
let repo: ResponseRepo;
let owner: number;
let stranger: number;
let now = 10_000;
let ttl = 1_000;
const KEY = Buffer.alloc(32, 9);

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydro-response-state-"));
  opened = openDatabase(dir);
  const tokens = new TokenRepo(opened.db, KEY);
  owner = tokens.create({ name: "owner" }).token.id;
  stranger = tokens.create({ name: "stranger" }).token.id;
  repo = new ResponseRepo(opened.db, () => ttl, () => now);
});
afterAll(() => {
  opened.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const newResponse = (id: string, conversationId?: string) => repo.createResponse({ id, tokenId: owner, status: "queued", background: true, response: { id, status: "queued", object: "response" }, inputItems: [], history: [], conversationId });

describe("owned response state", () => {
  const pending = (instanceId: string): ToolUsePart => ({ type: "tool_use", id: "operation", name: "provider_server_side_lookup", serverTool: true, input: { query: "synthetic" },
    hydrogenTool: { id: 42, emittedName: "provider_server_side_lookup", declaredName: "web_search", declarationType: "web_search", instanceId } });
  const ownedResponse = (id: string, call: ToolUsePart, status: "queued" | "incomplete" = "queued", tokenId = owner, conversationId?: string) => repo.createResponse({
    id, tokenId, conversationId, status, response: { store: true }, inputItems: [], history: [{ role: "assistant", content: [structuredClone(call)] }],
  });
  const result = (call: ToolUsePart): ToolResultPart => ({ type: "tool_result", toolUseId: call.id, content: [{ type: "text", text: "synthetic completed result" }],
    hydrogenTool: { ...call.hydrogenTool!, execution: "completed" } });

  it("late stale copies cannot claim or prevent the winning receipt from being published", () => {
    const saved = pending("late-copy-instance"), call = structuredClone(saved);
    ownedResponse("late-source", saved, "incomplete"); ownedResponse("late-winner", saved);
    call.hydrogenTool!.execution = "started"; repo.recordPendingTool("late-winner", owner, call);
    ownedResponse("late-loser", saved);
    expect(() => repo.recordPendingTool("late-loser", owner, structuredClone(saved))).toThrow("already been claimed");
    call.hydrogenTool!.execution = "completed"; repo.recordPendingTool("late-winner", owner, call, result(call));
    for (const id of ["late-source", "late-winner", "late-loser"]) {
      const parts = repo.response(id, owner)!.history.flatMap(message => message.content);
      expect(parts.find(part => part.type === "tool_use")).toMatchObject({ hydrogenTool: { execution: "completed", claimedBy: "late-winner" } });
      expect(parts.filter(part => part.type === "tool_result")).toHaveLength(1);
    }
  });

  it("claim updates are scoped by conversation sequence even when public item IDs collide across keys", () => {
    const call = pending("item-isolation-instance");
    const first = repo.createConversation(owner, {}, historyItems([{ role: "assistant", content: [call] }]).map(item => ({ ...item, id: "same-item" })));
    const other = repo.createConversation(stranger, {}, [{ id: "same-item", type: "message", role: "user", content: "other owner's text" }]);
    const before = repo.allItems(other.id, stranger);
    ownedResponse("item-isolation-runner", call, "queued", owner, first.id);
    call.hydrogenTool!.execution = "started"; repo.recordPendingTool("item-isolation-runner", owner, call);
    expect(repo.allItems(other.id, stranger)).toEqual(before);
    call.hydrogenTool!.execution = "completed"; repo.recordPendingTool("item-isolation-runner", owner, call, result(call));
    expect(repo.allItems(other.id, stranger)).toEqual(before);
    expect(repo.items(first.id, owner, { order: "asc", limit: 100 }).data.filter(item => item.type === "function_call_output")).toHaveLength(1);
    expect(historyMessages(repo.allItems(first.id, owner)).flatMap(message => message.content).filter(part => part.type === "tool_result")).toHaveLength(1);
    expect(JSON.stringify(repo.items(first.id, owner).data)).not.toContain("claimedBy");
  });

  it("claims survive original response deletion through an authoritative conversation item", () => {
    const call = pending("deleted-source-instance"), conversation = repo.createConversation(owner, {}, historyItems([{ role: "assistant", content: [call] }]));
    ownedResponse("deleted-claim-source", call, "incomplete"); repo.deleteResponse("deleted-claim-source", owner);
    ownedResponse("deleted-claim-winner", call, "queued", owner, conversation.id);
    call.hydrogenTool!.execution = "started"; repo.recordPendingTool("deleted-claim-winner", owner, call);
    repo.transition("deleted-claim-winner", owner, "cancelled", {});
    // A known completed receipt can still be retained without reversing cancellation.
    call.hydrogenTool!.execution = "completed"; repo.recordPendingTool("deleted-claim-winner", owner, call, result(call));
    expect(repo.response("deleted-claim-winner", owner)!.status).toBe("cancelled");
    repo.deleteResponse("deleted-claim-winner", owner);
    const restored = historyMessages(repo.allItems(conversation.id, owner));
    expect(restored.flatMap(message => message.content).filter(part => part.type === "tool_result")).toHaveLength(1);
    expect(repo.items(conversation.id, owner).data.filter(item => item.type === "function_call_output")).toHaveLength(1);
  });

  it.each(["owner", "arguments", "call-id", "instance"])("claim rejects mismatched %s before any private state mutation", invalid => {
    const saved = pending(`invalid-${invalid}`), call = structuredClone(saved);
    ownedResponse(`invalid-${invalid}-source`, saved, "incomplete"); ownedResponse(`invalid-${invalid}-runner`, saved);
    if (invalid === "arguments") call.input = { query: "changed" };
    if (invalid === "call-id") call.id = "other";
    if (invalid === "instance") call.hydrogenTool!.instanceId = "unknown-instance";
    expect(() => repo.recordPendingTool(`invalid-${invalid}-runner`, invalid === "owner" ? stranger : owner, call)).toThrow();
    expect(repo.response(`invalid-${invalid}-source`, owner)!.history[0].content).toEqual([saved]);
  });

  it("restart keeps the authoritative source claim even after the interrupted runner is failed", () => {
    const call = pending("restart-claim-instance");
    ownedResponse("restart-claim-source", call, "incomplete"); ownedResponse("restart-claim-runner", call);
    call.hydrogenTool!.execution = "started"; repo.recordPendingTool("restart-claim-runner", owner, call);
    repo.failInterrupted(); expect(repo.response("restart-claim-runner", owner)!.status).toBe("failed");
    const history: Message[] = repo.response("restart-claim-source", owner)!.history;
    expect(history[0].content[0]).toMatchObject({ hydrogenTool: { execution: "started", claimedBy: "restart-claim-runner" } });
  });

  it("isolates read, continuation touch, delete and conversation mutations by API Key", () => {
    const conversation = repo.createConversation(owner, {}, [{ type: "message", role: "user", content: "hi" }]);
    newResponse("resp-private", conversation.id);
    expect(repo.response("resp-private", stranger)).toBeUndefined();
    expect(repo.conversation(conversation.id, stranger)).toBeUndefined();
    expect(() => repo.touchResponse("resp-private", stranger)).toThrow("not found");
    expect(() => repo.deleteResponse("resp-private", stranger)).toThrow("not found");
    expect(() => repo.appendItems(conversation.id, stranger, [])).toThrow("not found");
    expect(repo.transition("resp-private", stranger, "cancelled", {})).toBeUndefined();
  });
  it("reserves conversations before execution and prevents edits while running", () => {
    const conversation = repo.createConversation(owner, {});
    newResponse("resp-reservation", conversation.id);
    expect(() => newResponse("resp-competing", conversation.id)).toThrow("active response");
    expect(() => repo.appendItems(conversation.id, owner, [])).toThrow("active response");
    expect(() => repo.deleteConversation(conversation.id, owner)).toThrow("active response");
    repo.transition("resp-reservation", owner, "cancelled", {});
    expect(() => newResponse("resp-next", conversation.id)).not.toThrow();
  });
  it("never lets late completion overwrite cancellation or append cancelled output", () => {
    const conversation = repo.createConversation(owner, {});
    newResponse("resp-cancel", conversation.id);
    repo.transition("resp-cancel", owner, "cancelled", { output: [] });
    expect(repo.transition("resp-cancel", owner, "completed", { output: ["late"] }, [], [{ type: "message", content: "late" }])).toBeUndefined();
    expect(repo.response("resp-cancel", owner)?.status).toBe("cancelled");
    expect(repo.allItems(conversation.id, owner)).toEqual([]);
  });
  it("atomically commits output with a completed response and preserves ordered item cursors", () => {
    const conversation = repo.createConversation(owner, {}, [{ id: "item-a", type: "message", content: "first" }]);
    newResponse("resp-done", conversation.id);
    repo.transition("resp-done", owner, "completed", { output: [] }, [], [{ id: "item-b", type: "message", content: "second" }, { id: "item-c", type: "message", content: "third" }]);
    expect(repo.items(conversation.id, owner, { order: "asc", limit: 1 })).toMatchObject({ data: [{ id: "item-a" }], has_more: true });
    expect(repo.items(conversation.id, owner, { order: "asc", after: "item-a", limit: 2 }).data.map(item => item.id)).toEqual(["item-b", "item-c"]);
    expect(repo.items(conversation.id, owner, { after: "item-c", limit: 2 }).data.map(item => item.id)).toEqual(["item-b", "item-a"]);
    repo.deleteItem(conversation.id, owner, "item-b");
    expect(repo.item(conversation.id, owner, "item-b")).toBeUndefined();
  });
  it("keeps child snapshots available after deleting their ancestor", () => {
    newResponse("resp-parent");
    repo.transition("resp-parent", owner, "completed", {});
    repo.createResponse({ id: "resp-child", tokenId: owner, previousResponseId: "resp-parent", status: "completed", response: {}, inputItems: [], history: [{ role: "user", content: [{ type: "text", text: "retained" }] }] });
    repo.deleteResponse("resp-parent", owner);
    expect(repo.response("resp-child", owner)?.history[0].content).toEqual([{ type: "text", text: "retained" }]);
  });
  it("applies live retention settings and expires idle completed state", () => {
    newResponse("resp-expiry");
    repo.transition("resp-expiry", owner, "completed", {});
    now += 800;
    repo.touchResponse("resp-expiry", owner);
    now += 800;
    expect(repo.response("resp-expiry", owner)).toBeDefined();
    ttl = 0;
    now += 2_000;
    expect(repo.response("resp-expiry", owner)).toBeDefined();
    ttl = 1_000;
    expect(repo.response("resp-expiry", owner)).toBeUndefined();
    repo.prune();
    expect(opened.sqlite.prepare("select id from stored_responses where id = ?").get("resp-expiry")).toBeUndefined();
  });
  it("marks interrupted jobs failed on restart without replaying tools", () => {
    newResponse("resp-interrupted");
    expect(repo.failInterrupted()).toBeGreaterThan(0);
    expect(repo.response("resp-interrupted", owner)).toMatchObject({ status: "failed", response: { error: { code: "server_restarted" } } });
    expect(repo.failInterrupted()).toBe(0);
  });
});

describe("hosted tool persistence", () => {
  it("encrypts all configured headers and retains them when editing with headers omitted", () => {
    const tools = new HostedToolRepo(opened.db, KEY);
    const input = HttpToolSchema.parse({ name: "lookup", parameters: { type: "object" }, url: "https://adapter.example/lookup", headers: { Authorization: "Bearer tool-secret" }, bodyTemplate: { args: "{{arguments}}" } });
    const created = tools.create(input);
    expect(JSON.stringify(created)).not.toContain("tool-secret");
    expect(created.headerNames).toEqual(["Authorization"]);
    expect(JSON.stringify(opened.db.select().from(hostedTools).all())).not.toContain("tool-secret");
    const { headers, ...changed } = input;
    tools.update(created.id, { ...changed, url: "https://adapter.example/new" });
    expect(tools.materialize(tools.get(created.id)!).headers).toEqual(headers);
    const services = new ServiceRepo(opened.db);
    const service = services.create({ name: "with-tool", definition: { steps: [{ model: "m", provider: "p" }], timeoutMs: 1_000 } });
    tools.bind(service.id, [created.id, created.id]);
    expect(tools.forService(service.id).map(tool => tool.name)).toEqual(["lookup"]);
    expect(() => tools.bind(service.id, [999_999])).toThrow();
    expect(tools.boundIds(service.id)).toEqual([created.id]);
    tools.delete(created.id);
    expect(tools.boundIds(service.id)).toEqual([]);
  });
});
