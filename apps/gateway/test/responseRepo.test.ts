import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type OpenedDatabase } from "../src/db/index.js";
import { ResponseRepo } from "../src/persistence/responseRepo.js";
import { TokenRepo } from "@areelai/user-management";
import { HostedToolRepo } from "@areelai/model-services";
import { HttpToolSchema } from "@areelai/model-services";
import { ServiceRepo } from "@areelai/model-services";
import { hostedTools } from "@areelai/model-services";

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
