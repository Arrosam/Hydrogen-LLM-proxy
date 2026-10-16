import { buildRequest, buildResponse, parseRequest } from "../core/format/registry";
import { normalizeMessages, type Message } from "../core/ir/content";

export type HistoryItem = Record<string, unknown>;
const CANONICAL = "__hydrogenCanonicalMessages";

/**
 * Serialized-size ceiling for one conversation's replayed history, in bytes.
 *
 * This names the CONTEXT limit only. It is kept separate from the transport body
 * cap (core/upstream/body.ts), the SSE frame cap and the tool-argument cap. Those
 * are different rules that share the value 25 MiB today, so they keep their own
 * names and a change to one does not silently change another.
 */
export const MAX_HISTORY_CONTEXT_BYTES = 25 * 1024 * 1024;

/** Public wire items are a presentation, never the source of truth for replay.
 * The private snapshot retains opaque reasoning signatures and redacted parts. */
export function historyItems(messages: Message[]): HistoryItem[] {
  return messages.flatMap(message => message.content.flatMap(part => {
    const snapshot: Message = { role: message.role, content: [structuredClone(part)], ...(message.name ? { name: message.name } : {}) };
    let wire: HistoryItem[];
    if (part.type === "reasoning") {
      wire = buildResponse("openai_responses", { id: "history", model: "history", created: 0, content: [part], stopReason: "stop", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }).renderSelf("history").output as HistoryItem[];
    } else {
      try { wire = buildRequest("openai_responses", { requestedService: "history", messages: [snapshot], params: {}, stream: false }).render({ upstreamModel: "history" }).input as HistoryItem[]; }
      catch { wire = []; } // A foreign opaque/file handle is still replayable canonically.
    }
    if (!wire.length) wire = [{ type: "message", role: message.role, content: [] }];
    return wire.map((item, i) => ({ ...item, [CANONICAL]: i === 0 ? [snapshot] : [] }));
  }));
}
export function publicHistoryItem(item: HistoryItem): HistoryItem {
  const result = { ...item };
  delete result[CANONICAL];
  return result;
}
export function historyMessages(items: HistoryItem[]): Message[] {
  const messages: Message[] = [];
  let legacy: HistoryItem[] = [];
  const flush = () => {
    if (legacy.length) messages.push(...parseRequest("openai_responses", { model: "history", input: legacy }).messages);
    legacy = [];
  };
  for (const item of items) {
    if (Array.isArray(item[CANONICAL])) { flush(); messages.push(...structuredClone(item[CANONICAL] as Message[])); }
    else legacy.push(item);
  }
  flush();
  return normalizeMessages(messages);
}
export function hasPrivateHistoryField(item: HistoryItem): boolean {
  return Object.prototype.hasOwnProperty.call(item, CANONICAL);
}

/** Change only an existing trusted canonical snapshot. Public wire data never
 * establishes local tool execution state. */
export function withHistoryMessages(item: HistoryItem, messages: Message[]): HistoryItem {
  if (!hasPrivateHistoryField(item)) throw new Error("Conversation item has no private history");
  return { ...item, [CANONICAL]: structuredClone(messages) };
}

export function privateHistoryMessages(item: HistoryItem): Message[] {
  return Array.isArray(item[CANONICAL]) ? structuredClone(item[CANONICAL] as Message[]) : [];
}
