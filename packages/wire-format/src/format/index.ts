/**
 * Format barrel. Importing this module registers all three wire formats with the
 * registry (each format module self-registers on load), so the base
 * Request/Response classes can dispatch across families. Import this once at the
 * composition root before any translation happens.
 */
import "./completion.js";
import "./anthropic.js";
import "./responses.js";

export * from "./family.js";
export {
  parseRequest,
  buildRequest,
  parseResponse,
  buildResponse,
  parseStream,
  serializeStream,
} from "./registry.js";

export { OpenAICompletionRequest, OpenAICompletionResponse } from "./completion.js";
export { AnthropicRequest, AnthropicResponse } from "./anthropic.js";
export { OpenAIResponsesRequest, OpenAIResponsesResponse } from "./responses.js";
