# Stateful Responses and hosted HTTP tools

Available in v2.0.0, building on v1.8.0-rc.5. See the [Chinese integration guide](server-tools.zh.md) for examples.

## Decisions

- Operators register tools and bind them to Model Services or Micro Agents. Definitions are supplied automatically.
- Hydrogen owns orchestration and HTTP forwarding; the external adapter implements tool business logic.
- Arbitrary tool names use Hydrogen trace extensions, not vendor-specific built-in tool types.
- Fixed POST JSON, encrypted static headers, a JSON body template and a JSON Pointer selecting the model-facing result.
- Responses, Conversations, background jobs and cancellation use local SQLite state isolated by API Key.
- Mixed batches finish hosted tools first, then return client calls. Continue via Responses `previous_response_id` or Anthropic `hydrogen.previous_response_id`, supplying only new input.
- Retention is configurable in Settings: default 30 idle days; 0 disables expiry. Continuation refreshes expiry.
- Per-service streaming modes: `all`, `progress` (default), `final`.
- HTTP errors become structured tool results. No automatic adapter retry or redirect following.

## Execution

`serviceCall.ts` is the shared Micro Agent and tool-loop call recorder. `runHostedTools` invokes existing executors, retaining provider selection, retries, cancellation, usage and nested attempt logs. It appends the original assistant turn and tool results before invoking the next model round.

The Responses/Anthropic controller wraps the selected executor. Named stages with bindings use `HostedToolService` and finish their own loop before returning to the next stage. A Micro Agent's own bindings apply to its output turns.

Defaults: 8 rounds and 16 tool calls. Nested stages share the top-level call budget and a hard 128-loop-round ceiling; each child also honors its own limits. HTTP calls run sequentially. Repeated model call IDs within a loop are rejected. Each adapter operation gets a Hydrogen-generated `call.id`; traces separately retain `model_call_id`. Client and hosted tool names must be distinct.

Arguments are checked against local JSON Schema draft 7 before HTTP execution. No external schema fetches occur. Templates execute no code; whole placeholders preserve JSON types and interpolation accepts scalars. The existing SSRF guard applies. Tools use direct connections independently of model-provider egress proxies.

## Streaming

`all` emits `hydrogen.model.delta` for each round plus tool events. These are process traces; clients render standard protocol output as the final answer rather than concatenating the traces into it. `progress` emits tool progress then the final answer; `final` emits only the final answer. Ordinary Responses without hosted tools retain native live streaming.

Micro Agent stages and Reliable Streaming retain their buffering semantics. Full-process mode cannot expose deltas or reasoning absent from the underlying executor. Thinking presentation settings also apply to process events; original signed reasoning remains in canonical model history.

Events are stored with increasing `sequence_number` values. Reconnect with `GET /v1/responses/:id?stream=true&starting_after=...`. Final SSE and retrieval results share response and output-item IDs.

## Persistence

Migrations 0008/0009 add tools, bindings, conversations/items, response snapshots and events. Tool headers are encrypted with the master key and re-sealed for portable backups. The backup history option includes response/conversation data; tool configuration is always included.

A transaction reserves a Conversation before execution. Concurrent response creation or item mutation returns 409. Completion conditionally appends history and transitions state; late completion cannot overwrite cancellation. Child response snapshots remain usable after deleting an ancestor.

`hydrogen.session_id` is stable across previous-response chains; explicit Conversations use their conversation ID. Provider egress reconstructs history locally with provider storage disabled. Previous per-request instructions are not inherited.

Background jobs survive client disconnect. Explicit cancellation is limited to background jobs and does not undo completed external effects. Restarted/restored in-flight jobs fail visibly and are never automatically replayed. `store:false` uses transient execution records, removed after delivery or startup recovery. Conversations persist independently.

Limits: 32 active jobs per process, 25 MiB context/event growth. Retention runs at startup and every minute, preserving active reservations. Use one process per SQLite directory; this is not a distributed job scheduler.

Supported stateful input items are messages, function calls/results and reasoning. Unsupported Conversation item types and provider-stored prompt templates are rejected. This feature does not implement every provider's built-in tool or every Responses extension. Tool adapters return one JSON body; adapter-side streaming is outside this contract.

## Client-protocol round trips

A tool may declare an optional `serverTool` contract: the name a client declares, the result block type that client protocol expects, and the JSON Pointer to the entry array in the adapter's response. A client that declares that name as a provider-executed tool (Anthropic `web_search_20250305`, or Responses `{"type":"web_search"}`) then receives the full round trip — the call and its result — instead of only the model's final prose. Every round of a multi-round run is returned, rebuilt from the run's history so the sequence keeps each round's own text ahead of its call.

The proxy stays ignorant of any particular tool or adapter format: the adapter decides what an entry contains, and the selected array is passed through verbatim into the block type the contract names. Exposure remains governed by the existing per-service and per-agent bindings.

Each wire gets its own shape rather than one shape bent to fit both. Anthropic pairs `server_tool_use` with a following result block in the same assistant turn, both carrying the required `caller`, and models failure as the result's own content object (`web_search_tool_result_error` with an `error_code`) so it can never be read as an empty result set. Responses has no separate result block: a provider-executed call is one `web_search_call` item carrying the action and its source URLs. The error code is the adapter's choice, expressed through the same result pointer; `unavailable` is only substituted when the adapter names nothing usable, and a call to the declared name that never reached an adapter is dropped rather than returned as a client tool.

A loop that reaches its round ceiling pauses rather than failing: it returns `pause_turn` with the turn so far, and the client continues by sending that turn back. The pause happens before any call is sent, so a resume replays the whole pending batch and nothing is half-executed. The resume signal is structural — a declared call with no result anywhere in the request — so no extra state has to survive between requests. The call budget is deliberately different: it is judged per call, so a refused call reaches the model as `tool_call_limit` and the turn continues. Responses has no such status and maps the pause to `status: "incomplete"` with `incomplete_details.reason = "pause_turn"`.

Limits worth stating: `encrypted_content` is Anthropic's own opaque replay token and cannot be produced by a proxy that runs its own search, and citations are not fabricated because the adapter cannot supply the quoted original text.

## References

- [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state)
- [OpenAI background execution](https://developers.openai.com/api/docs/guides/background)
- [Responses reference](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create)
- [Anthropic server tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools)
