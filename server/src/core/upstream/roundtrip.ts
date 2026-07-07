import type { Request } from "../ir/request";
import { buildResponse, parseStream } from "../format/registry";
import { collectStream } from "../ir/stream";
import type { SendTarget, Transport } from "./transport";
import type { RelayResult, SendResult } from "./outcome";

/**
 * The shared wire round-trip behind every Request subclass's `send`/`relay`. The
 * subclass methods are thin one-liners over these so the emit logic lives in one
 * place while the method surface stays on the concrete class (a Request must be
 * constructed into a subclass before it can be sent).
 *
 * Both stream the upstream (render with stream=true): a streamed upstream is what
 * lets reasoning from stream-only providers be captured and lets a truncated
 * response be detected. `send` buffers the stream into a complete Response;
 * `relay` hands the live event stream to the caller to pipe to the client.
 */

async function drainError(body: AsyncIterable<Buffer | string>): Promise<unknown> {
  let text = "";
  try {
    for await (const chunk of body) text += chunk.toString();
  } catch {
    /* ignore */
  }
  try {
    return text ? JSON.parse(text) : text;
  } catch {
    return text;
  }
}

/** Buffer an upstream stream into one complete Response (reliable path). */
export async function sendBuffered(req: Request, transport: Transport, target: SendTarget): Promise<SendResult> {
  const sentBody = req.withStream(true).render(target);
  const r = await transport.postStream(target.url, target.headers, sentBody, { timeoutMs: target.timeoutMs, signal: target.signal });
  if (r.status >= 200 && r.status < 300) {
    // A consumption error throws and is mapped to a retryable failure upstream.
    const { data, incomplete } = await collectStream(parseStream(req.family, r.body));
    // A truncated stream (no terminal event) is a failure, not a usage-less
    // "success" -- reported as 502 so a step's numeric 502 trigger matches it.
    if (incomplete) {
      return { ok: false, status: 502, kind: "http", message: "upstream stream ended before completion (truncated)", sentBody };
    }
    return { ok: true, response: buildResponse(req.family, data), sentBody };
  }
  return { ok: false, status: r.status, kind: "http", message: `upstream returned ${r.status}`, body: await drainError(r.body), sentBody };
}

/** Return the committed live event stream for a streaming client relay. */
export async function relayStream(req: Request, transport: Transport, target: SendTarget): Promise<RelayResult> {
  const sentBody = req.withStream(true).render(target);
  const r = await transport.postStream(target.url, target.headers, sentBody, { timeoutMs: target.timeoutMs, signal: target.signal });
  if (r.status >= 200 && r.status < 300) {
    return { ok: true, status: r.status, events: parseStream(req.family, r.body), sentBody };
  }
  return { ok: false, status: r.status, kind: "http", message: `upstream returned ${r.status}`, body: await drainError(r.body), sentBody };
}
