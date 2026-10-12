import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { DB } from "../db";
import { conversationItems, responseConversations, storedResponses, responseEvents } from "../db/schema";
import type { Message } from "../core/ir/content";
import { genId, ID_PREFIX } from "../util/ids";
import { RESPONSE_EVENT, RESPONSE_STATUS, RUNNING_RESPONSE_STATUSES } from "../core/format/responsesWire";
import { MAX_CONTEXT_BYTES } from "../config/limits";
import { HTTP_STATUS } from "../util/httpStatus";

export type StoredResponse = typeof storedResponses.$inferSelect;
export type Conversation = typeof responseConversations.$inferSelect;
type ResponseInsert = typeof storedResponses.$inferInsert;
export type WireItem = Record<string, unknown>;
const RUNNING = RUNNING_RESPONSE_STATUSES;
/** Items returned by one page when the caller names no limit. */
export const DEFAULT_ITEM_PAGE_SIZE = 20;
/** Events returned by one read; a shorter page means the log is drained. */
export const RESPONSE_EVENT_PAGE_SIZE = 200;
const RESPONSE_NOT_FOUND = "Response not found";

/** A response that has not reached a terminal status. */
const STILL_RUNNING = inArray(storedResponses.status, [...RUNNING]);
const isRunning = (status: StoredResponse["status"]): boolean => RUNNING.includes(status as "queued");
/** Every public operation is scoped to the API Key that owns the row. */
const ownedResponse = (id: string, tokenId: number) => and(eq(storedResponses.id, id), eq(storedResponses.tokenId, tokenId));
const ownedConversation = (id: string, tokenId: number) => and(eq(responseConversations.id, id), eq(responseConversations.tokenId, tokenId));
const contextTooLarge = (): ResponseStateError => new ResponseStateError("Conversation exceeds the 25 MiB context limit", HTTP_STATUS.PAYLOAD_TOO_LARGE);

export class ResponseStateError extends Error {
  constructor(message: string, readonly statusCode: number = HTTP_STATUS.NOT_FOUND) { super(message); }
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
    const row = this.db.select().from(storedResponses).where(ownedResponse(id, tokenId)).get();
    return this.visible(row);
  }

  /** Hot path for streaming: never deserialize the conversation snapshot just to check ownership. */
  state(id: string, tokenId: number): Pick<StoredResponse, "id" | "status" | "touchedAt"> | undefined {
    const row = this.db.select({ id: storedResponses.id, status: storedResponses.status, touchedAt: storedResponses.touchedAt }).from(storedResponses).where(ownedResponse(id, tokenId)).get();
    return this.visible(row);
  }

  conversation(id: string, tokenId: number): Conversation | undefined {
    const row = this.db.select().from(responseConversations).where(ownedConversation(id, tokenId)).get();
    if (!row || !this.expired(row.touchedAt)) return row;
    return this.hasActiveResponse(id, tokenId) ? row : undefined;
  }

  /** A row is visible until it expires -- and past that while it is still running. */
  private visible<T extends Pick<StoredResponse, "status" | "touchedAt">>(row: T | undefined): T | undefined {
    return row && (!this.expired(row.touchedAt) || isRunning(row.status)) ? row : undefined;
  }

  /** Whether the conversation has a response that has not reached a terminal status. */
  private hasActiveResponse(conversationId: string, tokenId: number): boolean {
    return Boolean(this.db.select({ id: storedResponses.id }).from(storedResponses).where(and(
      eq(storedResponses.conversationId, conversationId), eq(storedResponses.tokenId, tokenId), STILL_RUNNING,
    )).get());
  }

  /** The conversation's items changed: a turn prepared against the old revision must not commit. */
  private bumpRevision(conversationId: string): void {
    this.db.update(responseConversations).set({ revision: sql`${responseConversations.revision} + 1`, touchedAt: this.now() }).where(eq(responseConversations.id, conversationId)).run();
  }

  private requireConversation(id: string, tokenId: number): Conversation {
    const row = this.conversation(id, tokenId);
    if (!row) throw new ResponseStateError("Conversation not found");
    return row;
  }

  private assertIdle(id: string, tokenId: number): void {
    if (this.hasActiveResponse(id, tokenId)) throw new ResponseStateError("Conversation already has an active response", HTTP_STATUS.CONFLICT);
  }

  createConversation(tokenId: number, metadata: Record<string, string>, items: WireItem[] = []): Conversation {
    return this.db.transaction(() => {
      const row = this.db.insert(responseConversations).values({ id: genId(ID_PREFIX.CONVERSATION), tokenId, metadata, touchedAt: this.now() }).returning().get();
      this.insertItems(row.id, items);
      return row;
    });
  }

  updateConversation(id: string, tokenId: number, metadata: Record<string, string>): Conversation {
    this.requireConversation(id, tokenId);
    return this.db.update(responseConversations).set({ metadata, touchedAt: this.now() }).where(ownedConversation(id, tokenId)).returning().get();
  }

  deleteConversation(id: string, tokenId: number): void {
    this.requireConversation(id, tokenId);
    this.assertIdle(id, tokenId);
    this.db.delete(responseConversations).where(ownedConversation(id, tokenId)).run();
  }

  private insertItems(conversationId: string, items: WireItem[]): WireItem[] {
    return items.map(value => {
      const id = typeof value.id === "string" && value.id ? value.id : genId(ID_PREFIX.ITEM);
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
      this.bumpRevision(id);
      return inserted;
    });
  }

  items(id: string, tokenId: number, options: { after?: string; order?: "asc" | "desc"; limit?: number } = {}): { data: WireItem[]; has_more: boolean } {
    this.requireConversation(id, tokenId);
    const limit = options.limit ?? DEFAULT_ITEM_PAGE_SIZE;
    const order = options.order ?? "desc";
    const conditions = [eq(conversationItems.conversationId, id)];
    if (options.after) {
      const cursor = this.db.select().from(conversationItems).where(and(eq(conversationItems.conversationId, id), eq(conversationItems.id, options.after))).get();
      if (!cursor) throw new ResponseStateError("Item cursor not found", HTTP_STATUS.BAD_REQUEST);
      conditions.push(order === "asc" ? gt(conversationItems.sequence, cursor.sequence) : lt(conversationItems.sequence, cursor.sequence));
    }
    const rows = this.db.select().from(conversationItems).where(and(...conditions)).orderBy(order === "asc" ? asc(conversationItems.sequence) : desc(conversationItems.sequence)).limit(limit + 1).all();
    return { data: rows.slice(0, limit).map(row => row.item), has_more: rows.length > limit };
  }

  allItems(id: string, tokenId: number): WireItem[] {
    this.requireConversation(id, tokenId);
    const size = this.db.select({ bytes: sql<number>`coalesce(sum(length(cast(${conversationItems.item} as blob))), 0)` }).from(conversationItems).where(eq(conversationItems.conversationId, id)).get();
    if ((size?.bytes ?? 0) > MAX_CONTEXT_BYTES) throw contextTooLarge();
    const rows = this.db.select().from(conversationItems).where(eq(conversationItems.conversationId, id)).orderBy(asc(conversationItems.sequence)).all();
    const result = rows.map(row => row.item);
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_CONTEXT_BYTES) throw contextTooLarge();
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
      this.bumpRevision(id);
    });
  }

  /** Reserve a conversation BEFORE model/tool execution so competing turns cannot both cause effects. */
  createResponse(input: Omit<ResponseInsert, "touchedAt">, conversationRevision?: number): StoredResponse {
    if (this.maintenance) throw new ResponseStateError("Response state is being restored", HTTP_STATUS.SERVICE_UNAVAILABLE);
    return this.db.transaction(() => {
      if (input.conversationId) {
        const conversation = this.requireConversation(input.conversationId, input.tokenId);
        if (conversationRevision !== undefined && conversation.revision !== conversationRevision) throw new ResponseStateError("Conversation changed while preparing this response", HTTP_STATUS.CONFLICT);
        this.assertIdle(input.conversationId, input.tokenId);
        this.db.update(responseConversations).set({ touchedAt: this.now() }).where(eq(responseConversations.id, input.conversationId)).run();
      }
      return this.db.insert(storedResponses).values({ ...input, touchedAt: this.now() }).returning().get();
    });
  }

  beginRestore(): void {
    if (this.maintenance || this.db.select({ id: storedResponses.id }).from(storedResponses).where(STILL_RUNNING).get()) throw new ResponseStateError("Wait for active responses before restoring", HTTP_STATUS.CONFLICT);
    this.maintenance = true;
  }
  endRestore(): void { this.maintenance = false; }

  touchResponse(id: string, tokenId: number): void {
    if (!this.response(id, tokenId)) throw new ResponseStateError(RESPONSE_NOT_FOUND);
    this.db.update(storedResponses).set({ touchedAt: this.now() }).where(ownedResponse(id, tokenId)).run();
  }

  /** Terminal transitions are conditional: a late completion can never overwrite cancellation. */
  transition(id: string, tokenId: number, status: StoredResponse["status"], response: WireItem, history?: Message[], append?: WireItem[]): StoredResponse | undefined {
    return this.db.transaction(() => {
      const current = this.response(id, tokenId);
      if (!current || !isRunning(current.status)) return undefined;
      const row = this.db.update(storedResponses).set({ status, response: { ...response, id, status }, ...(history ? { history } : {}), touchedAt: this.now() }).where(and(
        eq(storedResponses.id, id), eq(storedResponses.tokenId, tokenId), STILL_RUNNING,
      )).returning().get();
      if (row && row.conversationId && append?.length) {
        this.insertItems(row.conversationId, append);
        this.bumpRevision(row.conversationId);
      }
      return row;
    });
  }

  deleteResponse(id: string, tokenId: number): void {
    const row = this.response(id, tokenId);
    if (!row) throw new ResponseStateError(RESPONSE_NOT_FOUND);
    if (isRunning(row.status)) throw new ResponseStateError("Cancel the active response before deleting it", HTTP_STATUS.CONFLICT);
    this.db.delete(storedResponses).where(ownedResponse(id, tokenId)).run();
  }

  addEvent(id: string, tokenId: number, event: WireItem): WireItem {
    if (!this.state(id, tokenId)) throw new ResponseStateError(RESPONSE_NOT_FOUND);
    const row = this.db.insert(responseEvents).values({ responseId: id, event }).returning().get();
    return { ...event, sequence_number: row.sequence };
  }

  events(id: string, tokenId: number, after = -1): WireItem[] {
    if (!this.state(id, tokenId)) throw new ResponseStateError(RESPONSE_NOT_FOUND);
    return this.db.select().from(responseEvents).where(and(eq(responseEvents.responseId, id), gt(responseEvents.sequence, after))).orderBy(asc(responseEvents.sequence)).limit(RESPONSE_EVENT_PAGE_SIZE).all().map(row => ({ ...row.event, sequence_number: row.sequence }));
  }

  /** Startup recovery never repeats a tool operation whose external outcome may be unknown. */
  failInterrupted(): number {
    const rows = this.db.select().from(storedResponses).where(STILL_RUNNING).all();
    for (const row of rows) {
      const failed = this.transition(row.id, row.tokenId, RESPONSE_STATUS.FAILED, { ...row.response, error: { code: "server_restarted", message: "The server restarted before this response completed; external tool operations were not replayed." } });
      if (row.response.store === false) this.deleteResponse(row.id, row.tokenId);
      else if (failed) this.addEvent(row.id, row.tokenId, { type: RESPONSE_EVENT.FAILED, response: failed.response });
    }
    return rows.length;
  }

  prune(): void {
    const ttl = this.retentionMs();
    if (ttl <= 0) return;
    const cutoff = this.now() - ttl;
    this.db.delete(storedResponses).where(and(lt(storedResponses.touchedAt, cutoff), inArray(storedResponses.status, [RESPONSE_STATUS.COMPLETED, RESPONSE_STATUS.FAILED, RESPONSE_STATUS.CANCELLED, RESPONSE_STATUS.INCOMPLETE]))).run();
    // Active response reservations keep their conversation alive even during a long tool call.
    this.db.delete(responseConversations).where(and(lt(responseConversations.touchedAt, cutoff), sql`not exists (select 1 from stored_responses r where r.conversation_id = ${responseConversations.id} and r.status in ('queued', 'in_progress'))`)).run();
  }
}
