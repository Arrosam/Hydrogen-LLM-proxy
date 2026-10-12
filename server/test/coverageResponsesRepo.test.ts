import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type OpenedDatabase } from "../src/db";
import { ResponseRepo, type WireItem } from "../src/persistence/responseRepo";
import { TokenRepo } from "../src/persistence/tokenRepo";

/**
 * Coverage for the durable response state that responseRepo.test.ts does not
 * reach: the restore lock, the conversation revision check, retention
 * boundaries and exemptions, item cursors, the event log and revision counting.
 * Every test gets its own database, so clock and retention changes stay local.
 */

let opened: OpenedDatabase, dir: string, repo: ResponseRepo;
let owner: number, stranger: number;
let now: number, ttl: number;
const T = 10_000;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydro-response-cov-"));
  opened = openDatabase(dir);
  const tokens = new TokenRepo(opened.db, Buffer.alloc(32, 9));
  owner = tokens.create({ name: "owner" }).token.id;
  stranger = tokens.create({ name: "stranger" }).token.id;
  now = T; ttl = 1_000;
  repo = new ResponseRepo(opened.db, () => ttl, () => now);
});
afterEach(() => { opened.sqlite.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const newResponse = (id: string, conversationId?: string, revision?: number, response: WireItem = {}) =>
  repo.createResponse({ id, tokenId: owner, status: "queued", background: true, response: { id, status: "queued", object: "response", ...response }, inputItems: [], history: [], conversationId }, revision);
const message = (text: string, id?: string): WireItem => ({ ...(id ? { id } : {}), type: "message", role: "user", content: text });
const rowExists = (table: "stored_responses" | "response_conversations", id: string) =>
  opened.sqlite.prepare(`select id from ${table} where id = ?`).get(id) !== undefined;
const revision = (id: string) => repo.conversation(id, owner)!.revision;
const status = (fn: () => unknown): number | undefined => {
  try { fn(); } catch (error) { return (error as { statusCode?: number }).statusCode; }
  return undefined;
};

describe("restore lock", () => {
  it("refuses to begin a restore while a response is running", () => {
    newResponse("resp-running");
    expect(() => repo.beginRestore()).toThrow("Wait for active responses before restoring");
    expect(status(() => repo.beginRestore())).toBe(409);
    // The refused restore did not take the lock.
    expect(() => newResponse("resp-second")).not.toThrow();
    repo.transition("resp-running", owner, "in_progress", {});
    expect(status(() => repo.beginRestore())).toBe(409);
  });

  it("blocks new responses for the length of a restore and is not re-entrant", () => {
    newResponse("resp-done"); repo.transition("resp-done", owner, "completed", {});
    expect(() => repo.beginRestore()).not.toThrow();
    expect(() => newResponse("resp-during")).toThrow("Response state is being restored");
    expect(status(() => newResponse("resp-during"))).toBe(503);
    expect(() => repo.beginRestore()).toThrow("Wait for active responses before restoring");
    expect(status(() => repo.beginRestore())).toBe(409);
    repo.endRestore();
    expect(() => newResponse("resp-after")).not.toThrow();
    expect(repo.response("resp-during", owner)).toBeUndefined();
  });
});

describe("conversation revision check", () => {
  it("rejects a response prepared against a stale revision", () => {
    const conversation = repo.createConversation(owner, {});
    expect(conversation.revision).toBe(0);
    repo.appendItems(conversation.id, owner, [message("a")]);
    expect(() => newResponse("resp-stale", conversation.id, 0)).toThrow("Conversation changed while preparing this response");
    expect(status(() => newResponse("resp-stale", conversation.id, 0))).toBe(409);
    expect(repo.response("resp-stale", owner)).toBeUndefined();
    expect(() => newResponse("resp-current", conversation.id, 1)).not.toThrow();
  });

  it("skips the check when no revision is supplied", () => {
    const conversation = repo.createConversation(owner, {});
    repo.appendItems(conversation.id, owner, [message("a")]);
    expect(() => newResponse("resp-unchecked", conversation.id)).not.toThrow();
  });
});

describe("retention", () => {
  it("never expires or prunes a running response or its conversation", () => {
    const conversation = repo.createConversation(owner, {});
    newResponse("resp-long", conversation.id);
    now += 5_000;
    expect(repo.response("resp-long", owner)).toBeDefined();
    expect(repo.state("resp-long", owner)).toMatchObject({ id: "resp-long", status: "queued" });
    expect(repo.conversation(conversation.id, owner)).toBeDefined();
    repo.prune();
    expect(rowExists("stored_responses", "resp-long")).toBe(true);
    expect(rowExists("response_conversations", conversation.id)).toBe(true);

    repo.transition("resp-long", owner, "in_progress", {});
    now += 5_000;
    expect(repo.state("resp-long", owner)).toMatchObject({ status: "in_progress" });
    repo.prune();
    expect(rowExists("stored_responses", "resp-long")).toBe(true);

    expect(repo.transition("resp-long", owner, "completed", {})).toBeDefined();
    expect(repo.response("resp-long", owner)).toBeDefined();
    now += 5_000;
    expect(repo.response("resp-long", owner)).toBeUndefined();
    expect(repo.state("resp-long", owner)).toBeUndefined();
    expect(repo.conversation(conversation.id, owner)).toBeUndefined();
    repo.prune();
    expect(rowExists("stored_responses", "resp-long")).toBe(false);
    expect(rowExists("response_conversations", conversation.id)).toBe(false);
  });

  it("expires an idle conversation that has no response", () => {
    const conversation = repo.createConversation(owner, {}, [message("a")]);
    now += 5_000;
    expect(repo.conversation(conversation.id, owner)).toBeUndefined();
    expect(() => repo.items(conversation.id, owner)).toThrow("Conversation not found");
    expect(status(() => repo.items(conversation.id, owner))).toBe(404);
  });

  it("hides a finished row at exactly the ttl and prunes it one millisecond later", () => {
    newResponse("resp-edge"); repo.transition("resp-edge", owner, "completed", {});
    const conversation = repo.createConversation(owner, {});
    now = T + 999;
    expect(repo.response("resp-edge", owner)).toBeDefined();
    expect(repo.state("resp-edge", owner)).toBeDefined();
    expect(repo.conversation(conversation.id, owner)).toBeDefined();
    now = T + 1_000;
    expect(repo.response("resp-edge", owner)).toBeUndefined();
    expect(repo.state("resp-edge", owner)).toBeUndefined();
    expect(repo.conversation(conversation.id, owner)).toBeUndefined();
    repo.prune();
    expect(rowExists("stored_responses", "resp-edge")).toBe(true);
    expect(rowExists("response_conversations", conversation.id)).toBe(true);
    now = T + 1_001;
    repo.prune();
    expect(rowExists("stored_responses", "resp-edge")).toBe(false);
    expect(rowExists("response_conversations", conversation.id)).toBe(false);
  });

  it.each([0, -1])("keeps everything forever with a ttl of %i", value => {
    newResponse("resp-kept"); repo.transition("resp-kept", owner, "completed", {});
    const conversation = repo.createConversation(owner, {});
    ttl = value; now += 1_000_000;
    expect(repo.response("resp-kept", owner)).toBeDefined();
    expect(repo.conversation(conversation.id, owner)).toBeDefined();
    repo.prune();
    expect(rowExists("stored_responses", "resp-kept")).toBe(true);
    expect(rowExists("response_conversations", conversation.id)).toBe(true);
  });
});

describe("conversation item paging", () => {
  it("rejects an unknown cursor and a cursor from another conversation", () => {
    const first = repo.createConversation(owner, {}, [message("a", "item-a")]);
    const second = repo.createConversation(owner, {}, [message("b", "item-b")]);
    expect(() => repo.items(first.id, owner, { after: "nope" })).toThrow("Item cursor not found");
    expect(status(() => repo.items(first.id, owner, { after: "nope" }))).toBe(400);
    expect(() => repo.items(first.id, owner, { after: "item-b" })).toThrow("Item cursor not found");
    expect(repo.items(second.id, owner, { after: "item-b" })).toEqual({ data: [], has_more: false });
  });

  it("defaults to 20 items, newest first", () => {
    const conversation = repo.createConversation(owner, {}, Array.from({ length: 20 }, (_, i) => message(`m${i}`, `item-${i}`)));
    const exact = repo.items(conversation.id, owner);
    expect(exact.data).toHaveLength(20); expect(exact.has_more).toBe(false);
    expect(exact.data[0]!.id).toBe("item-19"); expect(exact.data[19]!.id).toBe("item-0");
    repo.appendItems(conversation.id, owner, [message("m20", "item-20")]);
    const over = repo.items(conversation.id, owner);
    expect(over.data).toHaveLength(20); expect(over.has_more).toBe(true);
    expect(over.data[0]!.id).toBe("item-20"); expect(over.data[19]!.id).toBe("item-1");
  });
});

describe("event log", () => {
  it("numbers events in order and reads exclusively after a cursor", () => {
    newResponse("resp-events");
    const first = repo.addEvent("resp-events", owner, { type: "a", payload: 1 });
    const second = repo.addEvent("resp-events", owner, { type: "b" });
    const third = repo.addEvent("resp-events", owner, { type: "c" });
    expect(first).toMatchObject({ type: "a", payload: 1 });
    const [s1, s2, s3] = [first, second, third].map(event => event.sequence_number as number);
    expect(s2).toBeGreaterThan(s1!); expect(s3).toBeGreaterThan(s2!);
    expect(repo.events("resp-events", owner)).toEqual([first, second, third]);
    expect(repo.events("resp-events", owner, s1)).toEqual([second, third]);
    expect(repo.events("resp-events", owner, s3)).toEqual([]);
  });

  it("keeps each response's events apart", () => {
    newResponse("resp-one"); newResponse("resp-two");
    repo.addEvent("resp-one", owner, { type: "one" });
    repo.addEvent("resp-two", owner, { type: "two" });
    expect(repo.events("resp-one", owner).map(event => event.type)).toEqual(["one"]);
    expect(repo.events("resp-two", owner).map(event => event.type)).toEqual(["two"]);
  });

  it("returns at most 200 events per read", () => {
    newResponse("resp-many");
    for (let i = 0; i < 201; i++) repo.addEvent("resp-many", owner, { type: "tick", i });
    const page = repo.events("resp-many", owner);
    expect(page).toHaveLength(200); expect(page[0]!.i).toBe(0); expect(page[199]!.i).toBe(199);
    const rest = repo.events("resp-many", owner, page[199]!.sequence_number as number);
    expect(rest).toHaveLength(1); expect(rest[0]!.i).toBe(200);
  });

  it("answers not found for an unknown response or another key", () => {
    newResponse("resp-owned");
    for (const call of [
      () => repo.addEvent("resp-unknown", owner, { type: "a" }), () => repo.events("resp-unknown", owner),
      () => repo.addEvent("resp-owned", stranger, { type: "a" }), () => repo.events("resp-owned", stranger),
    ]) {
      expect(call).toThrow("Response not found"); expect(status(call)).toBe(404);
    }
    expect(repo.events("resp-owned", owner)).toEqual([]);
  });
});

describe("conversation revision counting", () => {
  it("leaves the revision alone when deleting an unknown item", () => {
    const conversation = repo.createConversation(owner, {}, [message("a", "item-a")]);
    expect(() => repo.deleteItem(conversation.id, owner, "nope")).toThrow("Conversation item not found");
    expect(status(() => repo.deleteItem(conversation.id, owner, "nope"))).toBe(404);
    expect(revision(conversation.id)).toBe(0);
    expect(repo.item(conversation.id, owner, "item-a")).toBeDefined();
  });

  it("advances by one for each append and delete", () => {
    const conversation = repo.createConversation(owner, {}, [message("a", "item-a")]);
    expect(revision(conversation.id)).toBe(0);
    repo.appendItems(conversation.id, owner, [message("b", "item-b"), message("c", "item-c")]);
    expect(revision(conversation.id)).toBe(1);
    repo.deleteItem(conversation.id, owner, "item-b");
    expect(revision(conversation.id)).toBe(2);
    expect(repo.allItems(conversation.id, owner).map(item => item.id)).toEqual(["item-a", "item-c"]);
  });

  it("advances on a completed turn only when it appends output", () => {
    const conversation = repo.createConversation(owner, {});
    newResponse("resp-append", conversation.id);
    repo.transition("resp-append", owner, "completed", {}, [], [message("out", "item-out")]);
    expect(revision(conversation.id)).toBe(1);
    newResponse("resp-empty", conversation.id);
    repo.transition("resp-empty", owner, "completed", {}, [], []);
    expect(revision(conversation.id)).toBe(1);
    newResponse("resp-absent", conversation.id);
    repo.transition("resp-absent", owner, "completed", {});
    expect(revision(conversation.id)).toBe(1);
    expect(repo.allItems(conversation.id, owner).map(item => item.id)).toEqual(["item-out"]);
  });

  it("replaces conversation metadata for its owner only", () => {
    const conversation = repo.createConversation(owner, { old: "1" });
    expect(repo.updateConversation(conversation.id, owner, { a: "b" }).metadata).toEqual({ a: "b" });
    expect(repo.conversation(conversation.id, owner)!.metadata).toEqual({ a: "b" });
    expect(() => repo.updateConversation(conversation.id, stranger, { x: "y" })).toThrow("Conversation not found");
    expect(status(() => repo.updateConversation(conversation.id, stranger, { x: "y" }))).toBe(404);
    expect(repo.conversation(conversation.id, owner)!.metadata).toEqual({ a: "b" });
  });
});

describe("interrupted and running rows", () => {
  it("deletes an interrupted store:false response instead of leaving it failed", () => {
    newResponse("resp-ephemeral", undefined, undefined, { store: false });
    expect(repo.failInterrupted()).toBe(1);
    expect(rowExists("stored_responses", "resp-ephemeral")).toBe(false);
  });

  it("logs a response.failed event for an interrupted stored response", () => {
    newResponse("resp-stored");
    repo.addEvent("resp-stored", owner, { type: "response.created" });
    expect(repo.failInterrupted()).toBe(1);
    const events = repo.events("resp-stored", owner);
    expect(events.map(event => event.type)).toEqual(["response.created", "response.failed"]);
    expect(events[1]!.response).toMatchObject({ status: "failed", error: { code: "server_restarted" } });
  });

  it("refuses to delete a running response", () => {
    newResponse("resp-active");
    expect(() => repo.deleteResponse("resp-active", owner)).toThrow("Cancel the active response before deleting it");
    expect(status(() => repo.deleteResponse("resp-active", owner))).toBe(409);
    repo.transition("resp-active", owner, "in_progress", {});
    expect(status(() => repo.deleteResponse("resp-active", owner))).toBe(409);
    repo.transition("resp-active", owner, "completed", {});
    expect(() => repo.deleteResponse("resp-active", owner)).not.toThrow();
    expect(repo.response("resp-active", owner)).toBeUndefined();
  });
});
