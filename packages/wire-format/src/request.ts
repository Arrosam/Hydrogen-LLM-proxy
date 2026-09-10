/**
 * The request half of the adapter: parse a client's wire request into the
 * canonical {@link Request}, layer overrides onto it, and render it for any
 * family. Registers all three families on import.
 */
import "./format/index.js";

export { parseRequest, buildRequest } from "./format/registry.js";
export * from "./ir/request.js";
export * from "./ir/params.js";
export * from "./ir/content.js";
export * from "./ir/thinking.js";
export * from "./format/family.js";
export { FormatConversionError } from "./format/errors.js";
export { OpenAICompletionRequest } from "./format/completion.js";
export { AnthropicRequest } from "./format/anthropic.js";
export { OpenAIResponsesRequest } from "./format/responses.js";
