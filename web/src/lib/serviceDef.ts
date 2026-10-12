import type { Family, HostedToolOptions, ServiceCategory, ThinkingFormat, Trigger } from "../types";

/**
 * Names and defaults of the service definition model that more than one
 * editor needs. They mirror the server's schema defaults.
 */

/** The two things the service pages edit: a resilience workflow (a Model
 * Service) or a chain of stages (a Micro Agent). */
export type ServiceKind = "resilience" | "chain";
export const SERVICE_KIND = { resilience: "resilience", chain: "chain" } as const satisfies Record<ServiceKind, ServiceKind>;

/** The canonical `kind` discriminant written into a Micro Agent definition. */
export const AGENT_KIND = "micro_agent";

/** The category a definition has when it names none. */
export const DEFAULT_CATEGORY: ServiceCategory = "chat";

/** Every category, in the order the service form offers them. */
export const SERVICE_CATEGORIES: readonly ServiceCategory[] = ["chat", "ocr", "image", "video", "tts", "stt", "embedding", "rerank"];

/** The thinking format that changes nothing (and is therefore not written). */
export const DEFAULT_THINKING_FORMAT: ThinkingFormat = "original";

/** Timeout of a new service, and of a pre-pass that sets none. */
export const DEFAULT_SERVICE_TIMEOUT_MS = 60_000;

/** The retry policy the server applies to a step that omits `retry`. */
export const DEFAULT_RETRY: { maxAttempts: number; intervalMs: number } = { maxAttempts: 3, intervalMs: 0 };

/** The triggers the server retries on when a step omits `retry`, or its `on`
 * (mirrors DEFAULT_RETRY_ON in server/src/execution/definition.ts). */
export const DEFAULT_RETRY_ON: readonly Trigger[] = [429, 499, 502, 503, "timeout", "network"];

/** Hosted-tool loop settings of a service that has not chosen any. */
export const DEFAULT_HOSTED_TOOL_OPTIONS: Readonly<HostedToolOptions> = { streamMode: "progress", maxRounds: 8, maxCalls: 16 };

/** Bounds of the hosted-tool loop's two limits. */
export const HOSTED_TOOL_LIMITS = {
  rounds: { min: 1, max: 32 },
  calls: { min: 1, max: 128 },
} as const;

/** The categories served by an OpenAI-style passthrough endpoint rather than the chat pipeline. */
export type MediaCategory = Exclude<ServiceCategory, "chat" | "ocr">;

/** The client-facing endpoint each media passthrough category is served on. */
export const MEDIA_ENDPOINTS: Record<MediaCategory, string> = {
  image: "/v1/images/generations",
  video: "/v1/videos",
  tts: "/v1/audio/speech",
  stt: "/v1/audio/transcriptions",
  embedding: "/v1/embeddings",
  rerank: "/v1/rerank",
};

/** The client-facing endpoint of the chat pipeline (chat and ocr), per ingress family. */
export const CHAT_ENDPOINTS: Record<Family, string> = {
  openai_completion: "/v1/chat/completions",
  anthropic: "/v1/messages",
  openai_responses: "/v1/responses",
};
