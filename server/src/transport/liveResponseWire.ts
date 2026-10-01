import { serializeStream } from "../core/format/registry";
import type { StreamEvent } from "../core/ir/stream";
import type { ThinkingFormat } from "../core/ir/thinkingFormat";
import { withThinkingFormat } from "../core/ir/thinkingFormat";
import type { WireItem } from "../persistence/responseRepo";

/** A single-slot rendezvous keeps live serialization bounded and applies backpressure. */
export function liveResponseWire(model: string, envelope: WireItem, emit: (event: WireItem) => Promise<void>, thinkingFormat: ThinkingFormat) {
  let slot: { event: StreamEvent; consumed: () => void } | undefined;
  let wake: (() => void) | undefined;
  let ended = false;
  let failure: unknown;
  let body: WireItem | undefined;
  const terminal: WireItem[] = [];
  async function* input(): AsyncGenerator<StreamEvent> {
    while (true) {
      if (!slot && !ended) await new Promise<void>(resolve => { wake = resolve; });
      if (!slot) return;
      const next = slot; slot = undefined; next.consumed();
      yield next.event;
    }
  }
  const done = (async () => {
    try {
      for await (const frame of serializeStream("openai_responses", withThinkingFormat(input(), thinkingFormat), { model, thinkingFormat })) {
        const data = frame.split("\n").find(line => line.startsWith("data: "));
        if (!data) continue;
        const event = JSON.parse(data.slice(6)) as WireItem;
        if (event.response) event.response = { ...(event.response as WireItem), ...envelope };
        if (event.type === "response.created" || event.type === "response.in_progress") continue;
        if (event.type === "response.completed" || event.type === "response.incomplete") {
          body = event.response as WireItem;
          terminal.push(event);
        } else await emit(event);
      }
    } catch (error) { failure = error; slot?.consumed(); slot = undefined; }
  })();
  return {
    async send(event: StreamEvent): Promise<void> {
      if (failure) throw failure;
      if (ended || slot) throw new Error("Invalid live response stream state");
      await new Promise<void>(resolve => { slot = { event, consumed: resolve }; wake?.(); wake = undefined; });
      if (failure) throw failure;
    },
    async close(): Promise<{ body: WireItem | undefined; terminal: WireItem[] }> {
      ended = true; wake?.(); await done;
      if (failure) throw failure;
      return { body, terminal };
    },
  };
}
