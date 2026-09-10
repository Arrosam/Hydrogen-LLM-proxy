import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { DB } from "../db/index.js";
import { conversationItems, responseConversations, storedResponses, responseEvents } from "../db/schema.js";
import type { Message } from "@areelai/wire-format";
import { genId } from "@areelai/common";

export type StoredResponse = typeof storedResponses.$inferSelect;
export type Conversation = typeof responseConversations.$inferSelect;
type ResponseInsert = typeof storedResponses.$inferInsert;
export type WireItem = Record<string, unknown>;
const RUNNING = ["queued", "in_progress"] as const;

export class ResponseStateError extends Error {
  constructor(message: string, readonly statusCode: number = 404) { super(message); }
}

/** Durable state owned by a single client API Key. All public operations take that owner. */
export class ResponseRepo {
  private maintenance = false;
  constructor(private readonly db: DB, private readonly retentionMs: () => number, private readonly now: () => number = Date.now) {}

  private expired(touchedAt: number): boolean {
    const ttl = this.retentionMs();
    return ttl > 0 && touchedAt <= this.now() - ttl;
  }

  response(id: string, tokenId: number): StoredResponse | undefined {
    const row = this.db.select().from(storedResponses).where(and(eq(storedResponses.id, id), eq(storedResponses.tokenId, tokenId))).get();
    return row && (!this.expired(row.touchedAt) || RUNNING.includes(row.status as "queued")) ? row : undefined;
  }

  /** Hot path for streaming: never deserialize the conversation snapshot just to check ownership. */
  state(id: string, tokenId: number): Pick<StoredResponse, "id" | "status" | "touchedAt"> | undefined {
    const row = this.db.select({ id: storedResponses.id, status: storedResponses.status, touchedAt: storedResponses.touchedAt }).from(storedResponses).where(and(eq(storedResponses.id, id), eq(storedResponses.tokenId, tokenId))).get();
    return row && (!this.expired(row.touchedAt) || RUNNING.includes(row.status as "queued")) ? row : undefined;
  }

  conversation(id: string, tokenId: number): Conversation | undefined {
    const row = this.db.select().from(responseConversations).where(and(eq(responseConversations.id, id), eq(responseConversations.tokenId, tokenId))).get();
    if (!row || !this.expired(row.touchedAt)) return row;
    const active = this.db.select({ id: storedResponses.id }).from(storedResponses).where(and(eq(storedResponses.conversationId, id), eq(storedResponses.tokenId, tokenId), inArray(storedResponses.status, [...RUNNING]))).get();
    return active ? row : undefined;
  }

  private requireConversation(id: string, tokenId: number): Conversation {
    const row = this.conversation(id, tokenId);
    if (!row) throw new ResponseStateError("Conversation not found");
    return row;
  }

  private assertIdle(id: string, tokenId: number): void {
    const active = this.db.select({ id: storedResponses.id }).from(storedResponses).where(and(
      eq(storedResponses.conversationId, id), eq(storedResponses.tokenId, tokenId), inArray(storedResponses.status, [...RUNNING]),
    )).get();
    if (active) throw new ResponseStateError("Conversation already has an active response", 409);
  }

  createConversation(tokenId: number, metadata: Record<string, string>, items: WireItem[] = []): Conversation {
    return this.db.transaction(() => {
      const row = this.db.insert(responseConversations).values({ id: genId("conv"), tokenId, metadata, touchedAt: this.now() }).returning().get();
      this.insertItems(row.id, items);
      return row;
    });
  }

  updateConversation(id: string, tokenId: number, metadata: Record<string, string>): Conversation {
    this.requireConversation(id, tokenId);
    return this.db.update(responseConversations).set({ metadata, touchedAt: this.now() }).where(and(eq(responseConversations.id, id), eq(responseConversations.tokenId, tokenId))).returning().get();
  }

  deleteConversation(id: string, tokenId: number): void {
    this.requireConversation(id, tokenId);
    this.assertIdle(id, tokenId);
    this.db.delete(responseConversations).where(and(eq(responseConversations.id, id), eq(responseConversations.tokenId, tokenId))).run();
  }

  private insertItems(conversationId: string, items: WireItem[]): WireItem[] {
    return items.map(value => {
      const id = typeof value.id === "string" && value.id ? value.id : genId("item");
      const item = { ...value, id };
      this.db.insert(conversationItems).values({ id, conversationId, item }).run();
      return item;
    });
  }

  appendItems(id: string, tokenId: number, items: WireItem[]): WireItem[] {
    return this.db.transaction(() => {
      this.requireConversation(id, tokenId);
      this.assertIdle(id, tokenId);
      const inserted = this.insertItems(id, items);
      this.db.update(responseConversations).set({ revision: sql`${responseConversations.revision} + 1`, touchedAt: this.now() }).where(eq(responseConversations.id, id)).run();
      return inserted;
    });
  }

  items(id: string, tokenId: number, options: { after?: string; order?: "asc" | "desc"; limit?: number } = {}): { data: WireItem[]; has_more: boolean } {
    this.requireConversation(id, tokenId);
    const limit = options.limit ?? 20;
    const order = options.order ?? "desc";
    const conditions = [eq(conversationItems.conversationId, id)];
    if (options.after) {
      const cursor = this.db.select().from(conversationItems).where(and(eq(conversationItems.conversationId, id), eq(conversationItems.id, options.after))).get();
      if (!cursor) throw new ResponseStateError("Item cursor not found", 400);
      conditions.push(order === "asc" ? gt(conversationItems.sequence, cursor.sequence) : lt(conversationItems.sequence, cursor.sequence));
    }
    const rows = this.db.select().from(conversationItems).where(and(...conditions)).orderBy(order === "asc" ? asc(conversationItems.sequence) : desc(conversationItems.sequence)).limit(limit + 1).all();
    return { data: rows.slice(0, limit).map(row => row.item), has_more: rows.length > limit };
  }

  allItems(id: string, tokenId: number): WireItem[] {
    this.requireConversation(id, tokenId);
    const size = this.db.select({ bytes: sql<number>`coalesce(sum(length(cast(${conversationItems.item} as blob))), 0)` }).from(conversationItems).where(eq(conversationItems.conversationId, id)).get();
    if ((size?.bytes ?? 0) > 25 * 1024 * 1024) throw new ResponseStateError("Conversation exceeds the 25 MiB context limit", 413);
    const rows = this.db.select().from(conversationItems).where(eq(conversationItems.conversationId, id)).orderBy(asc(conversationItems.sequence)).all();
    const result = rows.map(row => row.item);
    if (Buffer.byteLength(JSON.stringify(result)) > 25 * 1024 * 1024) throw new ResponseStateError("Conversation exceeds the 25 MiB context limit", 413);
    return result;
  }

  item(id: string, tokenId: number, itemId: string): WireItem | undefined {
    this.requireConversation(id, tokenId);
    return this.db.select().from(conversationItems).where(and(eq(conversationItems.conversationId, id), eq(conversationItems.id, itemId))).get()?.item;
  }

  deleteItem(id: string, tokenId: number, itemId: string): void {
    this.db.transaction(() => {
      this.requireConversation(id, tokenId);
      this.assertIdle(id, tokenId);
      const result = this.db.delete(conversationItems).where(and(eq(conversationItems.conversationId, id), eq(conversationItems.id, itemId))).run();
      if (!result.changes) throw new ResponseStateError("Conversation item not found");
      this.db.update(responseConversations).set({ revision: sql`${responseConversations.revision} + 1`, touchedAt: this.now() }).where(eq(responseConversations.id, id)).run();
    });
  }

  /** Reserve a conversation BEFORE model/tool execution so competing turns cannot both cause effects. */
  createResponse(input: Omit<ResponseInsert, "touchedAt">, conversationRevision?: number): StoredResponse {
    if (this.maintenance) throw new ResponseStateError("Response state is being restored", 503);
    return this.db.transaction(() => {
      if (input.conversationId) {
        const conversation = this.requireConversation(input.conversationId, input.tokenId);
        if (conversationRevision !== undefined && conversation.revision !== conversationRevision) throw new ResponseStateError("Conversation changed while preparing this response", 409);
        this.assertIdle(input.conversationId, input.tokenId);
        this.db.update(responseConversations).set({ touchedAt: this.now() }).where(eq(responseConversations.id, input.conversationId)).run();
      }
      return this.db.insert(storedResponses).values({ ...input, touchedAt: this.now() }).returning().get();
    });
  }

  beginRestore(): void {
    if (this.maintenance || this.db.select({ id: storedResponses.id }).from(storedResponses).where(inArray(storedResponses.status, [...RUNNING])).get()) throw new ResponseStateError("Wait for active responses before restoring", 409);
    this.maintenance = true;
  }
  endRestore(): void { this.maintenance = false; }

  touchResponse(id: string, tokenId: number): void {
    if (!this.response(id, tokenId)) throw new ResponseStateError("Response not found");
    this.db.update(storedResponses).set({ touchedAt: this.now() }).where(and(eq(storedResponses.id, id), eq(storedResponses.tokenId, tokenId))).run();
  }

  /** Terminal transitions are conditional: a late completion can never overwrite cancellation. */
  transition(id: string, tokenId: number, status: StoredResponse["status"], response: WireItem, history?: Message[], append?: WireItem[]): StoredResponse | undefined {
    return this.db.transaction(() => {
      const current = this.response(id, tokenId);
      if (!current || !RUNNING.includes(current.status as "queued")) return undefined;
      const row = this.db.update(storedResponses).set({ status, response: { ...response, id, status }, ...(history ? { history } : {}), touchedAt: this.now() }).where(and(
        eq(storedResponses.id, id), eq(storedResponses.tokenId, tokenId), inArray(storedResponses.status, [...RUNNING]),
      )).returning().get();
      if (row && row.conversationId && append?.length) {
        this.insertItems(row.conversationId, append);
        this.db.update(responseConversations).set({ revision: sql`${responseConversations.revision} + 1`, touchedAt: this.now() }).where(eq(responseConversations.id, row.conversationId)).run();
      }
      return row;
    });
  }

  deleteResponse(id: string, tokenId: number): void {
    const row = this.response(id, tokenId);
    if (!row) throw new ResponseStateError("Response not found");
    if (RUNNING.includes(row.status as "queued")) throw new ResponseStateError("Cancel the active response before deleting it", 409);
    this.db.delete(storedResponses).where(and(eq(storedResponses.id, id), eq(storedResponses.tokenId, tokenId))).run();
  }

  addEvent(id: string, tokenId: number, event: WireItem): WireItem {
    if (!this.state(id, tokenId)) throw new ResponseStateError("Response not found");
    const row = this.db.insert(responseEvents).values({ responseId: id, event }).returning().get();
    return { ...event, sequence_number: row.sequence };
  }

  events(id: string, tokenId: number, after = -1): WireItem[] {
    if (!this.state(id, tokenId)) throw new ResponseStateError("Response not found");
    return this.db.select().from(responseEvents).where(and(eq(responseEvents.responseId, id), gt(responseEvents.sequence, after))).orderBy(asc(responseEvents.sequence)).limit(200).all().map(row => ({ ...row.event, sequence_number: row.sequence }));
  }

  /** Startup recovery never repeats a tool operation whose external outcome may be unknown. */
  failInterrupted(): number {
    const rows = this.db.select().from(storedResponses).where(inArray(storedResponses.status, [...RUNNING])).all();
    for (const row of rows) {
      const failed = this.transition(row.id, row.tokenId, "failed", { ...row.response, error: { code: "server_restarted", message: "The server restarted before this response completed; external tool operations were not replayed." } });
      if (row.response.store === false) this.deleteResponse(row.id, row.tokenId);
      else if (failed) this.addEvent(row.id, row.tokenId, { type: "response.failed", response: failed.response });
    }
    return rows.length;
  }

  prune(): void {
    const ttl = this.retentionMs();
    if (ttl <= 0) return;
    const cutoff = this.now() - ttl;
    this.db.delete(storedResponses).where(and(lt(storedResponses.touchedAt, cutoff), inArray(storedResponses.status, ["completed", "failed", "cancelled", "incomplete"]))).run();
    // Active response reservations keep their conversation alive even during a long tool call.
    this.db.delete(responseConversations).where(and(lt(responseConversations.touchedAt, cutoff), sql`not exists (select 1 from stored_responses r where r.conversation_id = ${responseConversations.id} and r.status in ('queued', 'in_progress'))`)).run();
  }

  /**
   * Everything a client key ever stored: its responses, conversations and
   * their items and events. Called when the key is deleted -- the tables
   * reference the key by plain id, so the cascade is explicit here rather
   * than a foreign key into another package's table.
   */
  deleteForToken(tokenId: number): void {
    this.db.delete(storedResponses).where(eq(storedResponses.tokenId, tokenId)).run();
    this.db.delete(responseConversations).where(eq(responseConversations.tokenId, tokenId)).run();
  }
}
