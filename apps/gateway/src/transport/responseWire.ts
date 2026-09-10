import type { Family } from "@areelai/wire-format";
import { buildRequest, serializeStream } from "@areelai/wire-format";
import type { Message } from "@areelai/wire-format";
import type { Response } from "@areelai/wire-format";
import { fabricateStream } from "@areelai/wire-format";
import type { ThinkingFormat } from "@areelai/wire-format";
import type { WireItem } from "../persistence/responseRepo.js";

export function messagesToItems(messages: Message[]): WireItem[] {
  return buildRequest("openai_responses", { requestedService: "history", messages, params: {}, stream: false }).render({ upstreamModel: "history" }).input as WireItem[];
}

/** Render once for both persistence and SSE so response/item identities agree. */
export async function responseWire(response: Response, family: Family, model: string, id: string, extra: WireItem, thinkingFormat?: ThinkingFormat): Promise<{ body: WireItem; events: WireItem[] }> {
  const events: WireItem[] = [];
  let body: WireItem = { ...response.render(family, model, { thinkingFormat }), ...extra, id };
  for await (const frame of serializeStream(family, fabricateStream(response.data(), Infinity), { model, thinkingFormat })) {
    const data = frame.split("\n").filter(s => s.startsWith("data:")).map(s => s.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") continue;
    const event = JSON.parse(data) as WireItem;
    if (family === "openai_responses") {
      if (event.response) {
        event.response = { ...(event.response as WireItem), ...extra, id };
        if (event.type === "response.completed" || event.type === "response.incomplete") body = event.response as WireItem;
      }
      if (event.type === "response.created" || event.type === "response.in_progress") continue;
    } else if (family === "anthropic" && event.type === "message_start") {
      event.message = { ...(event.message as WireItem), id, hydrogen: extra.hydrogen };
    }
    events.push(event);
  }
  return { body, events };
}
