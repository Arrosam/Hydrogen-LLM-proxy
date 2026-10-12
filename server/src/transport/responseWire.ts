import type { Family } from "../core/format/family";
import { RESPONSE_EVENT } from "../core/format/responsesWire";
import { buildRequest, serializeStream } from "../core/format/registry";
import type { Message } from "../core/ir/content";
import type { Response } from "../core/ir/response";
import { fabricateStream } from "../core/ir/stream";
import type { ThinkingFormat } from "../core/ir/thinkingFormat";
import type { WireItem } from "../persistence/responseRepo";

/** Field name that opens an SSE data line in a serialized frame. */
const SSE_DATA_FIELD = "data:";

/** The JSON event a serialized SSE frame carries, or null for a frame with no
 * data (or the chat-completions `[DONE]` sentinel). */
export function frameEvent(frame: string): WireItem | null {
  const data = frame.split("\n").filter(s => s.startsWith(SSE_DATA_FIELD)).map(s => s.slice(SSE_DATA_FIELD.length).trimStart()).join("\n");
  return !data || data === "[DONE]" ? null : JSON.parse(data) as WireItem;
}

/** `response.created` / `response.in_progress`: the stored response announces
 * these itself, so a rendered stream's own copies are dropped. */
export function isPreambleEvent(event: WireItem): boolean {
  return event.type === RESPONSE_EVENT.CREATED || event.type === RESPONSE_EVENT.IN_PROGRESS;
}

/** `response.completed` / `response.incomplete`: the event whose `response` is the final body. */
export function isTerminalEvent(event: WireItem): boolean {
  return event.type === RESPONSE_EVENT.COMPLETED || event.type === RESPONSE_EVENT.INCOMPLETE;
}

export function messagesToItems(messages: Message[]): WireItem[] {
  return buildRequest("openai_responses", { requestedService: "history", messages, params: {}, stream: false }).render({ upstreamModel: "history" }).input as WireItem[];
}

/** Render once for both persistence and SSE so response/item identities agree. */
export async function responseWire(response: Response, family: Family, model: string, id: string, extra: WireItem, thinkingFormat?: ThinkingFormat): Promise<{ body: WireItem; events: WireItem[] }> {
  const events: WireItem[] = [];
  let body: WireItem = { ...response.render(family, model, { thinkingFormat }), ...extra, id };
  for await (const frame of serializeStream(family, fabricateStream(response.data(), Infinity), { model, thinkingFormat })) {
    const event = frameEvent(frame);
    if (!event) continue;
    if (family === "openai_responses") {
      if (event.response) {
        event.response = { ...(event.response as WireItem), ...extra, id };
        if (isTerminalEvent(event)) body = event.response as WireItem;
      }
      if (isPreambleEvent(event)) continue;
    } else if (family === "anthropic" && event.type === "message_start") {
      event.message = { ...(event.message as WireItem), id, hydrogen: extra.hydrogen };
    }
    events.push(event);
  }
  return { body, events };
}
