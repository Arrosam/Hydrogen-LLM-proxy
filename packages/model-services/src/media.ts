import type { Usage } from "@areelai/wire-format";
import {
  MEDIA_FAMILIES,
  embeddingsUrl,
  imagesUrl,
  rerankUrl,
  speechUrl,
  transcriptionsUrl,
  videosUrl,
  type Catalog,
  type ResolvedTarget,
  type UpstreamProvider,
} from "@areelai/supplier-management";
import { classifyError, runSteps, type AttemptResult, type RunOutput } from "./steps.js";
import { stepOverrides, type ServiceCategory, type ServiceStep, type ServiceSteps } from "./definition.js";

/**
 * The non-chat service categories are OpenAI-style passthroughs: the request
 * body goes to the provider's matching endpoint with `model` swapped to the
 * mapped upstream name (plus any step override parameters), and the step
 * chain's retry/fallback rules apply. This module is the execution half; the
 * HTTP handlers that read a client request and write the reply live with
 * whoever serves the endpoints.
 *
 * These services are deliberately NOT reachable from an orchestrating kind
 * (a Micro Agent) -- the validator and the runtime resolver both reject the
 * reference.
 */

export type MediaCategory = Exclude<ServiceCategory, "chat" | "ocr">;

/** The client-facing route each category is served on. */
export const MEDIA_ENDPOINT_BY_CATEGORY: Record<MediaCategory, string> = {
  embedding: "/v1/embeddings",
  rerank: "/v1/rerank",
  image: "/v1/images/generations",
  video: "/v1/videos",
  tts: "/v1/audio/speech",
  stt: "/v1/audio/transcriptions",
};

/** The provider endpoint a category is forwarded to. */
export function mediaUrl(category: MediaCategory, p: UpstreamProvider): string {
  switch (category) {
    case "embedding": return embeddingsUrl(p);
    case "rerank": return rerankUrl(p);
    case "image": return imagesUrl(p);
    case "video": return videosUrl(p);
    case "tts": return speechUrl(p);
    case "stt": return transcriptionsUrl(p);
  }
}

/** Step override params for a passthrough body: the pairs editor's arbitrary
 * keys land in `extra` (chat-only canonical params are ignored here). */
export function mediaStepParams(step: ServiceStep): Record<string, unknown> {
  const ov = stepOverrides(step);
  return (ov?.extra as Record<string, unknown> | undefined) ?? {};
}

/** Field names safe to frame into a Content-Disposition header verbatim. */
export const SAFE_FORM_FIELD = /^[A-Za-z0-9_.-]+$/;

/** A step-override value as a multipart text field: scalars go in plain (a
 * quoted "en" would not be a language), structured values as JSON. */
export function formFieldValue(v: unknown): string {
  if (typeof v === "string") return v;
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/**
 * Video job ids are returned to the client with a routing suffix so polling
 * endpoints (which carry no model name) can find the provider statelessly.
 *
 * The suffix names the ENDPOINT too, not just the provider. A provider whose
 * primary is Anthropic can still serve video through a declared OpenAI
 * alternate; encoding only the provider would send the poll and the download to
 * the primary base URL -- a different host from the one holding the job.
 */
export function suffixVideoId(id: string, serviceId: number, providerId: number, endpointIndex: number): string {
  return `${id}-h${serviceId}x${providerId}e${endpointIndex}`;
}

export function parseVideoId(
  id: string,
): { upstreamId: string; serviceId: number; providerId: number; endpointIndex: number } | null {
  // The endpoint group is optional: ids handed out before it existed always
  // came from the primary endpoint, which is index 0.
  const m = /^(.+)-h(\d+)x(\d+)(?:e(\d+))?$/.exec(id);
  if (!m) return null;
  return {
    upstreamId: m[1],
    serviceId: Number(m[2]),
    providerId: Number(m[3]),
    endpointIndex: m[4] != null ? Number(m[4]) : 0,
  };
}

/** One successful passthrough attempt. */
export interface MediaHit {
  status: number;
  json: unknown;
  text: string;
  target: ResolvedTarget;
  sentBody: unknown;
}

/**
 * Run the step chain for a media category, one passthrough send per attempt.
 * Each step is resolved to an OpenAI-shaped endpoint: a provider that also
 * declares one reaches it here even when its primary is Anthropic.
 */
export function runMediaSteps<T = MediaHit>(
  catalog: Catalog,
  def: ServiceSteps,
  category: MediaCategory,
  signal: AbortSignal | undefined,
  send: (step: ServiceStep, target: ResolvedTarget) => Promise<AttemptResult<T>>,
): Promise<RunOutput<T>> {
  return runSteps<T>(def, async (step) => {
    const res = catalog.resolveWithin(step.model, step.provider, MEDIA_FAMILIES);
    if (!res.ok) {
      const message =
        res.error === "no_endpoint_in_family"
          ? `${category} passthrough requires an OpenAI-compatible endpoint: ${step.model}@${step.provider} has none enabled (add an OpenAI alternate endpoint to the provider and enable it on the mapping)`
          : `mapping ${step.model}@${step.provider}: ${res.error}`;
      return { ok: false, status: 0, kind: "error", message };
    }
    try {
      return await send(step, res.target);
    } catch (e) {
      const c = classifyError(e);
      return { ok: false, status: 0, kind: c.kind, message: c.message };
    }
  }, { signal });
}

export function zeroUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

/** Embeddings report prompt-token usage; the other categories have none. */
export function mediaUsage(category: MediaCategory, json: Record<string, unknown> | undefined): Usage {
  if (category !== "embedding") return zeroUsage();
  const u = (json?.usage ?? {}) as { prompt_tokens?: number; total_tokens?: number };
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: 0,
    totalTokens: u.total_tokens ?? u.prompt_tokens ?? 0,
  };
}
