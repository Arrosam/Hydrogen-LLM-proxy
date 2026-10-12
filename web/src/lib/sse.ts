/** Server-sent events as the chat wires speak them: framing, and what the frames add up to. */

/** Prefix of an SSE data line. */
export const SSE_DATA = "data:";
/** The sentinel some wires end a stream with; it carries no data. */
const SSE_DONE = "[DONE]";

/** The text after `data:` on a line, or null when the line is not a data line. */
export function sseDataOf(line: string): string | null {
  return line.startsWith(SSE_DATA) ? line.slice(SSE_DATA.length).trim() : null;
}

/** Every JSON object the frames carry on a data line, in order. Anything else is skipped. */
function* sseObjects(frames: readonly string[]): Generator<Record<string, unknown>> {
  for (const frame of frames) {
    for (const line of frame.split("\n")) {
      const payload = sseDataOf(line);
      if (!payload || payload === SSE_DONE) continue;
      try {
        yield JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
    }
  }
}

/**
 * Assemble the text a streamed run produced, from the raw frames, in whichever
 * dialect they arrived in. A bench that only showed frames would make you read
 * SSE to find out whether the model answered.
 */
export function textFromFrames(frames: string[]): string {
  let out = "";
  for (const data of sseObjects(frames)) {
    // Anthropic
    const delta = data.delta as Record<string, unknown> | undefined;
    if (data.type === "content_block_delta" && delta && typeof delta.text === "string") out += delta.text;
    // Responses
    else if (data.type === "response.output_text.delta" && typeof data.delta === "string") out += data.delta;
    // Chat Completions
    else if (Array.isArray(data.choices)) {
      for (const ch of data.choices as Array<Record<string, unknown>>) {
        const d = ch.delta as Record<string, unknown> | undefined;
        if (d && typeof d.content === "string") out += d.content;
      }
    }
  }
  return out;
}

/**
 * The usage a streamed run reported, dug out of the frames.
 *
 * Every wire puts it somewhere different and all of them put it at the END,
 * which is precisely where a reader watching the text stop has stopped looking.
 * Without this the bench showed a streamed run with no token counts at all --
 * no cached share, no thinking tokens -- beside a buffered run that showed all
 * three, which reads as the proxy having lost them.
 */
export function usageFromFrames(frames: string[]): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  // Anthropic splits it in two: the input side and both cache counters arrive
  // on message_start, the output side on message_delta. Merge, do not replace.
  let anthropic: Record<string, unknown> | undefined;
  for (const data of sseObjects(frames)) {
    const type = String(data.type ?? "");
    if (type === "message_start") {
      const u = (data.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined;
      if (u) anthropic = { ...anthropic, ...u };
    } else if (type === "message_delta" && data.usage) {
      anthropic = { ...anthropic, ...(data.usage as Record<string, unknown>) };
    } else if (type.startsWith("response.") && data.response) {
      const u = (data.response as Record<string, unknown>).usage as Record<string, unknown> | undefined;
      if (u) found = u;
    } else if (data.usage) {
      found = data.usage as Record<string, unknown>;
    }
  }
  return found ?? anthropic;
}

/** Split an SSE body into frames, keeping each one whole. */
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let rest = buffer;
  for (;;) {
    const m = /\r?\n\r?\n/.exec(rest);
    if (!m) break;
    const raw = rest.slice(0, m.index);
    rest = rest.slice(m.index + m[0].length);
    if (raw.trim()) frames.push(raw);
  }
  return { frames, rest };
}

/** Read an SSE body to completion, reporting frames as they arrive. */
export async function drainSse(body: ReadableStream<Uint8Array>, onFrames: (frames: string[]) => void): Promise<string[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const all: string[] = [];
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { frames, rest } = splitFrames(buffer);
    buffer = rest;
    if (frames.length) {
      all.push(...frames);
      onFrames(frames);
    }
  }
  buffer += decoder.decode();
  const { frames } = splitFrames(`${buffer}\n\n`);
  if (frames.length) {
    all.push(...frames);
    onFrames(frames);
  }
  return all;
}
