import { serializeStream } from "../core/format/registry";
import type { StreamEvent } from "../core/ir/stream";
import type { ThinkingDelimiters, ThinkingFormat } from "../core/ir/thinkingFormat";
import { withThinkingFormat } from "../core/ir/thinkingFormat";
import type { WireItem } from "../persistence/responseRepo";
import { frameEvent, isPreambleEvent, isTerminalEvent } from "./responseWire";

/** A single-slot rendezvous keeps live serialization bounded and applies backpressure. */
export function liveResponseWire(model: string, envelope: WireItem, emit: (event: WireItem) => Promise<void>, thinkingFormat: ThinkingFormat, thinkingDelimiters?: ThinkingDelimiters) {
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
      for await (const frame of serializeStream("openai_responses", withThinkingFormat(input(), thinkingFormat, thinkingDelimiters), { model, thinkingFormat })) {
        const event = frameEvent(frame);
        if (!event) continue;
        if (event.response) event.response = { ...(event.response as WireItem), ...envelope };
        if (isPreambleEvent(event)) continue;
        if (isTerminalEvent(event)) {
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
