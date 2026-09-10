# @areelai/wire-format

Pure translation between the OpenAI Chat Completions, OpenAI Responses and Anthropic Messages wire formats through one canonical request, response and stream model. A client body of any family is parsed into a `Request` and rendered for any other family; an upstream body or SSE stream of any family is parsed into a `Response` or a sequence of canonical `StreamEvent`s and serialized back out in the client's family. It does not open sockets, read files, store anything, or know about providers, API keys or retries: the upstream round-trip lives in `@areelai/model-services`.

## Install

```
npm install @areelai/wire-format
```

Zero runtime dependencies (`"dependencies": {}`); only Node built-ins are used. No sibling `@areelai` packages. Node 20 or newer, ESM only.

## Ten-line adoption example

```ts
import { buildRequest, parseRequest, parseStream, serializeStream } from "@areelai/wire-format";

const req = parseRequest("anthropic", { model: "my-service", max_tokens: 64, messages: [{ role: "user", content: "Say hello" }] });
const body = buildRequest("openai_completion", req.data()).render({ upstreamModel: "gpt-4o" });
console.log(body.model, body.messages); // "gpt-4o" and OpenAI-shaped messages, max_tokens carried over

async function* openaiSse() { // stand-in for an upstream response body: any AsyncIterable<Buffer | string>
  yield 'data: {"id":"c1","model":"gpt-4o","choices":[{"delta":{"content":"Hello"}}]}\n\n';
  yield 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
  yield "data: [DONE]\n\n";
}
const events = parseStream("openai_completion", openaiSse());
for await (const frame of serializeStream("anthropic", events, { model: "my-service" })) process.stdout.write(frame);
```

The loop prints Anthropic `message_start`, `content_block_start`, `content_block_delta`, ..., `message_stop` frames. `parseStream` accepts whatever your HTTP client hands you (an undici body, `Readable.fromWeb(res.body)`, or a generator as above).

## Entry points

- `@areelai/wire-format`: everything.
- `@areelai/wire-format/request`: `parseRequest`, `buildRequest`, the `Request` base class with `RequestData` and `RenderTarget`, `GenerationParams` and `RequestOverrides`, the content-part types (`Message`, `TextPart`, `ImagePart`, `Tool`, `ToolChoice`, ...), `Family`, `FormatConversionError`, and the three request classes `OpenAICompletionRequest`, `AnthropicRequest`, `OpenAIResponsesRequest`.
- `@areelai/wire-format/response`: `parseResponse`, `buildResponse`, `parseStream`, `serializeStream`, the `Response` base class, `StreamEvent` and `StreamContext`, `collectStream`, `fabricateStream`, `tapStream`, `withoutReasoning`, `Usage`, the thinking-format helpers, the error-body helpers, and the three response classes `OpenAICompletionResponse`, `AnthropicResponse`, `OpenAIResponsesResponse`.

Importing any of the three registers all three families with the format registry (`registerFormat`), so a bare `import "@areelai/wire-format"` is enough for `parseRequest("anthropic", ...)` to work. `Family` is exactly `"openai_completion" | "openai_responses" | "anthropic"`; a provider's type is the same value (`ProviderType`, `familyForProviderType`).

## The canonical model

- `Request.data()` is the family-independent shape (`requestedService`, `system`, `messages`, `tools`, `toolChoice`, `params`, `stream`). `withOverrides(patch)` layers a step or caller override on top (the patch wins) and returns a new request of the same family; `withStream(bool)` forces the transport mode; `render(target)` produces the wire body and fits `maxTokens` under `target.providerMaxOutputTokens`.
- Body keys a family does not model are kept in `params.passthrough` and replayed only onto the same family (`collectPassthrough`, `applyNonCanonical`); `params.extra` is merged verbatim onto any egress body.
- `Response.render(family, model)` renders a parsed upstream answer for any client family. `text()`, `reasoning()`, `toolCalls()`, `withoutReasoning()` and `withThinkingFormat(format)` operate on the canonical content; `fabricate(family, ctx)` turns a buffered answer into a paced client stream.
- `collectStream(events)` drains canonical events into `ResponseData` and reports `incomplete` when the upstream ended without a terminal event, which is how a truncated stream becomes a retryable failure in `@areelai/model-services`.
- `buildErrorBody(family, status, message)`, `buildErrorFrame(...)` and `pingFrame(family)` produce the client-family error and keep-alive shapes. `FormatConversionError` is thrown when a canonical request carries something the egress family cannot express, for example a URL file reference on a family that only accepts inline bytes.

## License

MIT
