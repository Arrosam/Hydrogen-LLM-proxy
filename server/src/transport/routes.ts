/**
 * Client-facing route paths and the path prefixes other modules test against.
 * Registration, the fuzzy URL rewriter, the auth middleware and the SPA
 * fallback must agree on these, so each is spelled once.
 */
export const API_PREFIX = "/v1";
export const ADMIN_PREFIX = "/admin";
export const ADMIN_API_PREFIX = "/admin/api";
export const HEALTH_PATH = "/healthz";

export const ROUTE = {
  CHAT_COMPLETIONS: "/v1/chat/completions",
  MESSAGES: "/v1/messages",
  RESPONSES: "/v1/responses",
  CONVERSATIONS: "/v1/conversations",
  MODELS: "/v1/models",
  EMBEDDINGS: "/v1/embeddings",
  RERANK: "/v1/rerank",
  IMAGE_GENERATIONS: "/v1/images/generations",
  VIDEOS: "/v1/videos",
  AUDIO_SPEECH: "/v1/audio/speech",
  AUDIO_TRANSCRIPTIONS: "/v1/audio/transcriptions",
} as const;
