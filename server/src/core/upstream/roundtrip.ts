import { providerFailure } from "./providerError";
import { missingAnswerReason } from "../ir/answer";
import { readBoundedBody, MAX_ERROR_BODY_BYTES } from "./body";
import type { Request } from "../ir/request";
import { buildResponse, parseResponse, parseStream } from "../format/registry";
import { collectStream } from "../ir/stream";
import { decodeThinking, decodeThinkingStream } from "../ir/thinkingFormat";
import { UpstreamStreamError } from "../ir/toolArguments";
import type { SendTarget, Transport } from "./transport";
import type { RelayResult, SendResult } from "./outcome";

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
  try { text = await readBoundedBody(body, MAX_ERROR_BODY_BYTES, true); }
  catch { /* an interrupted error body cannot change its HTTP status */ }
  try {
    return text ? JSON.parse(text) : text;
  } catch {
    return text;
  }
}

/**
 * Buffer an upstream response into one complete Response. When the request's
 * `stream` flag is true, the upstream is streamed and collected via SSE parsing
 * (enables reasoning capture and truncation detection). When false (Reliable
 * Streaming / Micro Agent), a plain JSON request is sent and the response is
 * parsed directly -- no stream to truncate.
 */
export async function sendBuffered(req: Request, transport: Transport, target: SendTarget): Promise<SendResult> {
  if (req.stream) {
    const sentBody = req.render(target);
    const r = await transport.postStream(target.url, target.headers, sentBody, { timeoutMs: target.timeoutMs, signal: target.signal, proxy: target.proxy });
    if (r.status >= 200 && r.status < 300) {
      // A consumption error throws and is mapped to a retryable failure upstream.
      // Decode before collection: collection can merge text and reorder native
      // reasoning/tool parts, erasing evidence of an interrupted inline block.
      const { data, incomplete, failure, error } = await collectStream(decodeThinkingStream(parseStream(req.family, r.body), target.thinkingParser));
      if (failure || error) return { ok: false, status: failure?.status ?? 502, kind: "http", message: failure?.message ?? error!, retryable: failure?.retryable, usage: data.usage, sentBody };
      const missing = missingAnswerReason(data.content, data.stopReason);
      if (!incomplete && missing) return { ok: false, status: 502, kind: "http", message: missing, usage: data.usage, sentBody };
      // A truncated stream (no terminal event) is a failure, not a usage-less
      // "success" -- reported as 502 so a step's numeric 502 trigger matches it.
      if (incomplete) {
        return { ok: false, status: 502, kind: "http", message: "upstream stream ended before completion (truncated)", usage: data.usage, sentBody };
      }
      return { ok: true, response: buildResponse(req.family, data), sentBody };
    }
    return { ok: false, status: r.status, kind: "http", message: `upstream returned ${r.status}`, body: await drainError(r.body), sentBody };
  }
  // Non-streaming path: send stream=false, get a complete JSON response.
  const sentBody = req.render(target);
  const r = await transport.postJson(target.url, target.headers, sentBody, { timeoutMs: target.timeoutMs, signal: target.signal, proxy: target.proxy });
  if (r.status >= 200 && r.status < 300) {
    const body = r.json as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { ok: false, status: 502, kind: "http", message: "upstream returned empty or invalid JSON body", sentBody };
    }
    if (body.error != null || (req.family === "openai_responses" && (body.status === "failed" || body.status === "cancelled" || body.status === "queued" || body.status === "in_progress"))) {
      const failure = providerFailure(body.error ?? { message: "upstream response did not complete" });
      return { ok: false, kind: "http", ...failure, body, sentBody };
    }
    const hasEnvelope = req.family === "openai_completion" ? Array.isArray(body.choices) && body.choices.length > 0
      : req.family === "anthropic" ? Array.isArray(body.content)
      : Array.isArray(body.output);
    if (!hasEnvelope) return { ok: false, status: 502, kind: "http", message: `upstream returned invalid ${req.family} response`, body, sentBody };
    let response = parseResponse(req.family, body);
    try {
      const content = decodeThinking(response.content, target.thinkingParser, response.stopReason);
      const decoding = target.thinkingParser && target.thinkingParser.mode !== "off";
      if (content !== response.content || decoding && response.logprobs) {
        response = buildResponse(req.family, { ...response.data(), content, ...(decoding ? { logprobs: undefined } : {}) });
      }
    } catch (error) {
      if (!(error instanceof UpstreamStreamError)) throw error;
      return { ok: false, status: 502, kind: "http", message: error.message, usage: response.usage, sentBody, retryable: false };
    }
    const missing = missingAnswerReason(response.content, response.stopReason);
    if (missing) return { ok: false, status: 502, kind: "http", message: missing, usage: response.usage, sentBody };
    return { ok: true, response, sentBody };
  }
  const errBody = r.json ?? r.text;
  return { ok: false, status: r.status, kind: "http", message: `upstream returned ${r.status}`, body: errBody, sentBody };
}

/** Return the committed live event stream for a streaming client relay. */
export async function relayStream(req: Request, transport: Transport, target: SendTarget): Promise<RelayResult> {
  const sentBody = req.withStream(true).render(target);
  const r = await transport.postStream(target.url, target.headers, sentBody, { timeoutMs: target.timeoutMs, signal: target.signal, proxy: target.proxy });
  if (r.status >= 200 && r.status < 300) {
    return { ok: true, status: r.status, events: decodeThinkingStream(parseStream(req.family, r.body), target.thinkingParser), sentBody };
  }
  return { ok: false, status: r.status, kind: "http", message: `upstream returned ${r.status}`, body: await drainError(r.body), sentBody };
}
