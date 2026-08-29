import crypto from "node:crypto";
import { buildHeaders, transcriptionsUrl } from "../core/upstream/endpoints";
import { extractUpstreamMessage } from "../core/proxy/errors";
import { runSteps, type RunOutput } from "./steps";
import type { ServiceSteps } from "./definition";
import { MEDIA_FAMILIES, type Catalog } from "../catalog/catalog";
import type { Transport } from "../core/upstream/transport";

/**
 * ASR pre-pass transport: turn one audio attachment into text through an
 * stt-category service's step chain (the provider's /audio/transcriptions
 * endpoint, multipart), with the chain's usual retry/fallback rules.
 *
 * The chat pipeline cannot express audio cross-family (only a same-family
 * opaque replay), so — exactly like the OCR pre-pass does for images — a Micro
 * Agent can transcribe audio up front and hand every downstream model text.
 */

export interface AudioInput {
  /** Base64 audio bytes (the Chat Completions input_audio.data). */
  data: string;
  /** Container format hint: wav | mp3 | ... (input_audio.format). */
  format: string;
}

/** Content hash for the transcript cache; "a:"-prefixed so audio entries can
 * never collide with the OCR image entries sharing the store. */
export function audioHash(a: AudioInput): string {
  return "a:" + crypto.createHash("sha256").update(a.format).update(":").update(a.data).digest("hex");
}

/** Frame a minimal multipart/form-data body: the model field + one audio file. */
export function buildTranscriptionForm(model: string, audio: AudioInput): { body: Buffer; contentType: string } {
  const boundary = "hydrogen-asr-" + crypto.randomBytes(12).toString("hex");
  const nl = "\r\n";
  const head =
    `--${boundary}${nl}Content-Disposition: form-data; name="model"${nl}${nl}${model}${nl}` +
    `--${boundary}${nl}Content-Disposition: form-data; name="file"; filename="audio.${audio.format || "wav"}"${nl}` +
    `Content-Type: audio/${audio.format || "wav"}${nl}${nl}`;
  const tail = `${nl}--${boundary}--${nl}`;
  return {
    body: Buffer.concat([Buffer.from(head, "utf8"), Buffer.from(audio.data, "base64"), Buffer.from(tail, "utf8")]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** Run one audio through the ASR step chain; the success value is the transcript. */
export async function transcribeAudio(
  def: ServiceSteps,
  audio: AudioInput,
  deps: { catalog: Catalog; transport: Transport },
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RunOutput<string>> {
  return runSteps<string>(def, async (step) => {
    // /audio/transcriptions is an OpenAI-shaped route, so the endpoint has to be
    // one -- which a provider whose primary is Anthropic can still offer through
    // a declared alternate.
    const res = deps.catalog.resolveWithin(step.model, step.provider, MEDIA_FAMILIES);
    if (!res.ok) {
      const message =
        res.error === "no_endpoint_in_family"
          ? `audio transcription (ASR) requires an OpenAI-compatible endpoint: ${step.model}@${step.provider} has none enabled (add an OpenAI alternate endpoint to the provider and enable it on the mapping)`
          : `mapping ${step.model}@${step.provider}: ${res.error}`;
      return { ok: false, status: 0, kind: "error", message };
    }
    if (!deps.transport.postRaw) {
      return { ok: false, status: 0, kind: "error", message: "transport does not support multipart uploads (ASR)" };
    }
    const { body, contentType } = buildTranscriptionForm(res.target.upstreamModel, audio);
    const headers = buildHeaders(res.target.upstream);
    headers["content-type"] = contentType;
    const r = await deps.transport.postRaw(transcriptionsUrl(res.target.upstream), headers, body, {
      timeoutMs: opts.timeoutMs ?? def.timeoutMs,
      signal: opts.signal,
    });
    if (r.status >= 200 && r.status < 300) {
      const json = r.json as { text?: unknown } | undefined;
      const text = typeof json?.text === "string" ? json.text : r.text;
      return { ok: true, value: text.trim() };
    }
    return { ok: false, status: r.status, kind: "http", message: extractUpstreamMessage(r.json) ?? `upstream ${r.status}`, errorBody: r.json ?? r.text };
  }, { signal: opts.signal });
}
