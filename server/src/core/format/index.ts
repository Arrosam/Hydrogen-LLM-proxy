/**
 * Format barrel. Importing this module registers all three wire formats with the
 * registry (each format module self-registers on load), so the base
 * Request/Response classes can dispatch across families. Import this once at the
 * composition root before any translation happens.
 */
import "./completion";
import "./anthropic";
import "./responses";

export * from "./family";
export {
  parseRequest,
  buildRequest,
  parseResponse,
  buildResponse,
  parseStream,
  serializeStream,
} from "./registry";

export { OpenAICompletionRequest, OpenAICompletionResponse } from "./completion";
export { AnthropicRequest, AnthropicResponse } from "./anthropic";
export { OpenAIResponsesRequest, OpenAIResponsesResponse } from "./responses";
