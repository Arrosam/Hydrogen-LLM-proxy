/**
 * The response half of the adapter: parse an upstream body or SSE stream into
 * canonical form, and render or serialize it for the client's family.
 * Registers all three families on import.
 */
import "./format/index.js";

export { parseResponse, buildResponse, parseStream, serializeStream } from "./format/registry.js";
export * from "./ir/response.js";
export * from "./ir/stream.js";
export * from "./ir/usage.js";
export * from "./ir/answer.js";
export * from "./ir/thinkingFormat.js";
export * from "./ir/content.js";
export * from "./format/family.js";
export * from "./errors.js";
export { OpenAICompletionResponse } from "./format/completion.js";
export { AnthropicResponse } from "./format/anthropic.js";
export { OpenAIResponsesResponse } from "./format/responses.js";
