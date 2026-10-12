import type { Request } from "../ir/request";
import { buildResponse, parseResponse, parseStream, responseBodyFault } from "../format/registry";
import { collectStream, decodeUtf8 } from "../ir/stream";
import type { SendTarget, Transport, TransportStreamResult } from "./transport";
import type { RelayResult, SendFailure, SendResult } from "./outcome";
import { STATUS_UPSTREAM_FAILURE, isSuccessStatus } from "../../util/httpStatus";

/**
 * The shared wire round-trip behind every Request subclass's `send`/`relay`. The
 * subclass methods are thin one-liners over these so the emit logic lives in one
 * place while the method surface stays on the concrete class (a Request must be
 * constructed into a subclass before it can be sent).
 *
 * `send` (buffered) honors the request's own `stream` flag: when `stream` is
 * true the upstream is streamed (so reasoning from stream-only providers is
 * captured and a truncated response can be detected); when `stream` is false
 * (Reliable Streaming / Micro Agent internal calls) the upstream gets a
 * non-streaming JSON request and returns a single complete response body.
 * `relay` always streams the upstream (render with stream=true) and hands the
 * live event stream to the caller to pipe to the client.
 */

async function drainError(body: AsyncIterable<Buffer | string>): Promise<unknown> {
  let text = "";
  try {
    for await (const chunk of decodeUtf8(body)) text += chunk;
  } catch {
    /* ignore */
  }
  try {
    return text ? JSON.parse(text) : text;
  } catch {
    return text;
  }
}

/** A 2xx the proxy itself judged not to be an answer -- reported as 502 so a step's numeric 502 trigger matches it. */
function upstreamFault(message: string, sentBody: Record<string, unknown>, body?: unknown): SendFailure {
  return { ok: false, status: STATUS_UPSTREAM_FAILURE, kind: "http", message, ...(body !== undefined ? { body } : {}), sentBody };
}

/** The upstream answered with a non-2xx status; `body` is whatever it said. */
function upstreamRejection(status: number, body: unknown, sentBody: Record<string, unknown>): SendFailure {
  return { ok: false, status, kind: "http", message: `upstream returned ${status}`, body, sentBody };
}

/**
 * POST the rendered request as a stream; a non-2xx reply is drained into the
 * failure it becomes. (The transport options are spelled out at each call on
 * purpose: that every provider-addressed call names its `proxy` is checked
 * structurally, by test/egressProxy.test.ts.)
 */
async function openStream(
  transport: Transport,
  target: SendTarget,
  sentBody: Record<string, unknown>,
): Promise<{ ok: true; reply: TransportStreamResult } | SendFailure> {
  const reply = await transport.postStream(target.url, target.headers, sentBody, { timeoutMs: target.timeoutMs, signal: target.signal, proxy: target.proxy });
  if (isSuccessStatus(reply.status)) return { ok: true, reply };
  return upstreamRejection(reply.status, await drainError(reply.body), sentBody);
}

/**
 * Buffer an upstream response into one complete Response. When the request's
 * `stream` flag is true, the upstream is streamed and collected via SSE parsing
 * (enables reasoning capture and truncation detection). When false (Reliable
 * Streaming / Micro Agent), a plain JSON request is sent and the response is
 * parsed directly -- no stream to truncate.
 */
export async function sendBuffered(req: Request, transport: Transport, target: SendTarget): Promise<SendResult> {
  const sentBody = req.render(target);
  if (req.stream) {
    const opened = await openStream(transport, target, sentBody);
    if (!opened.ok) return opened;
    // A consumption error throws and is mapped to a retryable failure upstream.
    const { data, incomplete } = await collectStream(parseStream(req.family, opened.reply.body));
    // A truncated stream (no terminal event) is a failure, not a usage-less "success".
    if (incomplete) return upstreamFault("upstream stream ended before completion (truncated)", sentBody);
    return { ok: true, response: buildResponse(req.family, data), sentBody };
  }
  // Non-streaming path: send stream=false, get a complete JSON response.
  const r = await transport.postJson(target.url, target.headers, sentBody, { timeoutMs: target.timeoutMs, signal: target.signal, proxy: target.proxy });
  if (!isSuccessStatus(r.status)) return upstreamRejection(r.status, r.json ?? r.text, sentBody);
  const body = r.json as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return upstreamFault("upstream returned empty or invalid JSON body", sentBody);
  }
  // What makes a body this family's answer is the family's own knowledge (see the format registry).
  const fault = responseBodyFault(req.family, body);
  if (fault === "unfinished") {
    const error = body.error as Record<string, unknown> | undefined;
    return upstreamFault(typeof error?.message === "string" ? error.message : "upstream response did not complete", sentBody, body);
  }
  if (fault === "invalid") return upstreamFault(`upstream returned invalid ${req.family} response`, sentBody, body);
  return { ok: true, response: parseResponse(req.family, body), sentBody };
}

/** Return the committed live event stream for a streaming client relay. */
export async function relayStream(req: Request, transport: Transport, target: SendTarget): Promise<RelayResult> {
  const sentBody = req.withStream(true).render(target);
  const opened = await openStream(transport, target, sentBody);
  if (!opened.ok) return opened;
  return { ok: true, status: opened.reply.status, events: parseStream(req.family, opened.reply.body), sentBody };
}
