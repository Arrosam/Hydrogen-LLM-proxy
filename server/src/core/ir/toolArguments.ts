import type { StreamEvent } from "./stream";

/** Match the proxy's 25 MiB request/context budget. These are UTF-8 byte limits,
 * not token limits. SSE snapshots also contain JSON escaping and metadata. */
export const MAX_SSE_FRAME_BYTES = 25 * 1024 * 1024;
export const MAX_TOOL_ARGUMENT_BYTES = 25 * 1024 * 1024;

/** Safe to expose to clients: never include generated arguments or JSON.parse's
 * exception (which can contain a fragment of file content) in this message. */
export class UpstreamStreamError extends Error {
  constructor(message: string) { super(message); this.name = "UpstreamStreamError"; }
}

export function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  if (Buffer.byteLength(value) > MAX_TOOL_ARGUMENT_BYTES) {
    throw new UpstreamStreamError("Upstream tool arguments exceed the 25 MiB limit");
  }
  try { return JSON.parse(value || "{}"); }
  catch { throw new UpstreamStreamError("Upstream tool arguments are not valid JSON"); }
}

/** Relay deltas immediately; only validate JSON at the call/response boundary.
 * No parsing or flattening of the growing argument prefix on each delta. The
 * aggregate byte cap bounds all calls in one response, including closed calls
 * retained by a collector, logger or Responses serializer. */
export async function* guardToolArguments(events: AsyncGenerator<StreamEvent>, maxBytes = MAX_TOOL_ARGUMENT_BYTES): AsyncGenerator<StreamEvent> {
  const pending = new Map<number, { parts: string[]; highSurrogate: boolean }>();
  let bytes = 0;
  const checkSize = (): void => {
    if (bytes > maxBytes) throw new UpstreamStreamError("Upstream tool arguments exceed the 25 MiB limit");
  };
  const validate = (index: number): void => {
    const state = pending.get(index);
    if (!state) return;
    if (state.highSurrogate) bytes += 3;
    checkSize();
    parseToolArguments(state.parts.join(""));
    pending.delete(index);
  };
  for await (const event of events) {
    if (event.type === "tool_start") pending.set(event.index, { parts: [], highSurrogate: false });
    else if (event.type === "tool_args_delta" && event.delta) {
      const state = pending.get(event.index);
      let added = Buffer.byteLength(event.delta);
      if (state) {
        // JSON deltas can split an escaped UTF-16 surrogate pair even though
        // the SSE decoder preserves UTF-8 characters. Count the joined value,
        // deferring a trailing high surrogate until the next delta arrives.
        const first = event.delta.charCodeAt(0), last = event.delta.charCodeAt(event.delta.length - 1);
        if (state.highSurrogate) added += first >= 0xdc00 && first <= 0xdfff ? 1 : 3;
        state.highSurrogate = last >= 0xd800 && last <= 0xdbff;
        if (state.highSurrogate) added -= 3;
        state.parts.push(event.delta);
      }
      bytes += added;
      checkSize();
    } else if (event.type === "tool_stop") validate(event.index);
    else if (event.type === "finish" && !event.incomplete && !event.error) {
      for (const index of pending.keys()) validate(index);
    }
    yield event;
  }
}
