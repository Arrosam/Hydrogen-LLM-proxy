/**
 * @areelai/wire-format: pure translation between the OpenAI Chat Completions,
 * OpenAI Responses and Anthropic Messages wire formats through one canonical
 * request, response and stream model. No network, no storage, no framework.
 *
 * Importing this module registers all three families with the format
 * registry; `@areelai/wire-format/request` and `@areelai/wire-format/response`
 * are narrower entry points that do the same.
 */
import "./format/index.js";

export * from "./ir/params.js";
export * from "./ir/content.js";
export * from "./ir/request.js";
export * from "./ir/response.js";
export * from "./ir/stream.js";
export * from "./ir/usage.js";
export * from "./ir/answer.js";
export * from "./ir/thinking.js";
export * from "./ir/thinkingFormat.js";
export * from "./ir/ids.js";
export * from "./format/family.js";
export * from "./format/registry.js";
export * from "./format/errors.js";
export * from "./format/wire.js";
export * from "./format/reasoningBridge.js";
export * from "./format/completion.js";
export * from "./format/anthropic.js";
export * from "./format/responses.js";
export * from "./errors.js";
