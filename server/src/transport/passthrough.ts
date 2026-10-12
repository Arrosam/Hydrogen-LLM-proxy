import type { ConstrainedResolutionError } from "../catalog/catalog";
import { extractUpstreamMessage } from "../core/proxy/errors";
import {
  embeddingsUrl,
  imagesUrl,
  rerankUrl,
  speechUrl,
  transcriptionsUrl,
  videosUrl,
  type UpstreamProvider,
} from "../core/upstream/endpoints";
import type { ServiceCategory } from "../execution/definition";
import { ROUTE } from "./routes";

/**
 * What the surfaces that address one upstream endpoint directly have in
 * common: the client media endpoints and the admin bench.
 */

/** The service categories with an endpoint of their own (chat and ocr share the chat pipeline). */
export type MediaCategory = Exclude<ServiceCategory, "chat" | "ocr">;

/** This proxy's client route for each media category. */
export const ENDPOINT_BY_CATEGORY: Record<MediaCategory, string> = {
  embedding: ROUTE.EMBEDDINGS,
  rerank: ROUTE.RERANK,
  image: ROUTE.IMAGE_GENERATIONS,
  video: ROUTE.VIDEOS,
  tts: ROUTE.AUDIO_SPEECH,
  stt: ROUTE.AUDIO_TRANSCRIPTIONS,
};

const UPSTREAM_URL_BY_CATEGORY: Record<MediaCategory, (p: UpstreamProvider) => string> = {
  embedding: embeddingsUrl,
  rerank: rerankUrl,
  image: imagesUrl,
  video: (p) => videosUrl(p),
  tts: speechUrl,
  stt: transcriptionsUrl,
};

/** The provider URL a category's passthrough posts to; "" for the chat-pipeline
 * categories, which have none. */
export function mediaEndpointUrl(category: ServiceCategory, p: UpstreamProvider): string {
  return UPSTREAM_URL_BY_CATEGORY[category as MediaCategory]?.(p) ?? "";
}

/** The message of a non-2xx passthrough answer: the upstream's own, else its status. */
export function upstreamFailureMessage(status: number, body: unknown): string {
  return extractUpstreamMessage(body) ?? `upstream ${status}`;
}

/** A drained error body: its JSON when it parses, the raw text when it does
 * not, undefined when it was empty. */
export function parseJsonOrText(text: string): unknown {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return text;
  }
}

/** Why a (model, provider) pair did not resolve to an endpoint. Each surface
 * words the missing-endpoint case itself; any other reason reads the same. */
export function resolutionErrorMessage(model: string, provider: string, error: ConstrainedResolutionError, noEndpointHint: string): string {
  return error === "no_endpoint_in_family" ? noEndpointHint : `mapping ${model}@${provider}: ${error}`;
}

/** A value as a multipart text field: scalars go in plain (a quoted "en" would
 * not be a language), structured values as JSON. */
export function formFieldValue(v: unknown): string {
  if (typeof v === "string") return v;
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** What the log records in place of a multipart body. */
export function multipartNote(bytes: number): string {
  return `(multipart ${bytes} bytes)`;
}
