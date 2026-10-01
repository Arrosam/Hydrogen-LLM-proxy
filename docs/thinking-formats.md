# Thinking decoding, presentation, and continuation

Thinking has three separate roles in Hydrogen:

1. **Input decoding** belongs to an upstream step. Native reasoning fields are parsed by the wire adapter; an explicit `thinkingParser` can decode one model's inline convention.
2. **Canonical history** preserves the original reasoning parts, signatures, and redacted payloads needed for continuation.
3. **Presentation** belongs to the service or Micro Agent. `thinkingFormat` changes the client's copy, not input classification.

## Configuration

A service can give different fallback models different grammars while presenting one consistent output:

```json
{
  "timeoutMs": 60000,
  "thinkingFormat": "none",
  "steps": [
    {
      "model": "harmony-model",
      "provider": "primary",
      "thinkingParser": {
        "mode": "custom",
        "delimiters": {
          "open": "<|channel|>analysis<|message|>",
          "close": "<|channel|>final<|message|>"
        },
        "unterminated": "error"
      }
    },
    {
      "model": "r1-model",
      "provider": "fallback",
      "thinkingParser": { "mode": "think_tags" }
    }
  ]
}
```

Configure **Upstream thinking decoder** beside each model/provider in the service editor. Micro Agents use the decoders of their referenced Model Services; legacy inline stage steps can also carry `thinkingParser` in JSON. Parser settings are local controls, never sent as generation parameters to a provider.

| Parser | Meaning |
|---|---|
| Absent or `{"mode":"off"}` | Trust native structured fields; do not scan answer text. |
| `{"mode":"think_tags"}` | Recognize only the exact initial `<think>…</think>` convention. |
| `{"mode":"custom","delimiters":{"open":"…","close":"…"}}` | Recognize the specified literal pair for this upstream. |

Custom markers must be distinct, nonempty strings containing non-whitespace text, each at most 64 characters. They are case-sensitive and preserve zero-width characters exactly. Up to 512 whitespace code units may precede an opener; exceeding that bound is an error. A custom opener that itself begins with whitespace matches exactly from position zero.

Only the initial text run is decoded. A native reasoning block encountered first is authoritative. A tag later in an answer is never scanned. There is no broad `think`/`reason`/`thought` stem heuristic, so a legitimate `<reason>…</reason>` answer stays an answer.

**Built-in think tags recognize quoted examples.** A `</think>` inside a paired backtick span, matching code fence, or paired prose quotation is not immediately accepted as the true end. Marker and quotation boundaries may cross any stream chunk. Apostrophes within words do not open a quotation. Fences must have matching marker characters, sufficient run length, no more than three spaces of indentation, and a whitespace-only closing-line suffix; an answer beginning with a language-tagged fence is not mistaken for a closing fence.

Recognition is bounded rather than a full Markdown parser. Inline quotations are line-bounded. A possible close inside an unclosed inline quotation can recover at the next newline; an unresolved candidate can recover at a clean response end. For fenced examples, the decoder retains the earliest candidate until a later unquoted terminator confirms it, so an answer opening a bare fence does not silently consume the main response. If this uncertainty exceeds **4096 UTF-16 code units after the candidate marker**, decoding stops with an explicit ambiguous-boundary error instead of emitting uncertain reasoning as answer text or waiting for an arbitrarily long output. Additional markers do not reset that budget. Failed/truncated responses do not release uncertain tails as answers. Only a normal `stop` permits end-of-response recovery; token-limit, filtering, pause/tool-handoff, unknown stop reasons, and iterator EOF without a terminal event do not resolve an uncertain boundary.

**Custom delimiters remain literal protocol markers**, even inside quotes or code. Choose a custom pair only when that literal contract is appropriate. Arbitrary malformed text is inherently ambiguous; native structured reasoning is the reliable option when exact separation is essential. The quotation lookahead is a memory/character bound, not a wall-clock timeout; the upstream timeout still governs a server that stops sending. This feature is not a confidentiality or data-loss-prevention filter for arbitrary generated text.

## Malformed blocks and streaming

The default `unterminated: "error"` produces a safe error when an opened thinking block does not close. `unterminated: "reasoning"` retains its contents as reasoning instead. Neither policy relabels thinking as answer text. A partial opener, a structural interruption, or excessive opening padding always errors.

Reasoning streams as soon as an opener is recognized. The decoder keeps a possible closing-marker suffix plus, only when a quotation makes a boundary uncertain, the bounded lookahead described above—not the whole trace. Matching is incremental and linear, including overlapping custom markers. Buffered and streamed decoding use the same state machine. The separator whitespace after a close is removed; reasoning text is otherwise preserved verbatim.

A response with reasoning but no answer or tool call is still rejected by answer validation, including with the `reasoning` malformed-block policy. Streaming may already have delivered reasoning before a later error, but `none` does not expose those reasoning events. Usage and upstream errors are retained when available. Opting into reliable streaming separately still buffers the response by design.

Raw token logprobs are omitted when an inline decoder is active: their token alignment no longer matches the transformed output, and they may contain hidden reasoning tokens.

## Output formats

| Format | Presentation |
|---|---|
| `original` (default) | No presentation rewrite. Explicit upstream decoding still runs independently. |
| `reasoning_content` | Chat Completions uses that field; other wires keep native reasoning blocks. |
| `reasoning` | Chat Completions uses that field; other wires keep native reasoning blocks. |
| `think_tags` | Render readable reasoning in `<think>` blocks, preserving its position relative to tools/text. |
| `none` | Remove decoded reasoning from client presentation. |

Choosing any output format **does not enable text scanning**. `none` hides native or explicitly decoded reasoning, not unknown inline formats. To preserve raw inline text, leave the decoder off. To stop generating reasoning, use the separate thinking-level control; presentation does not reduce upstream billing.

## Replay safety

Anthropic thinking, redacted payloads, Responses reasoning items, and signed reasoning can be required on the next turn. Converting them to ordinary text or deleting them can make a returned tool call impossible to continue.

- **Stateless proxy delivery:** `none` and `think_tags` are rejected with a clear HTTP 400 configuration error when the response contains replay-required reasoning. If streaming headers were already sent, an error frame carries the failure; no successful terminal event is emitted. The guard applies to ordinary subsequent turns as well as tool calls.
- **Stored Responses/Conversations and hosted tool loops:** retain canonical originals separately, so client presentation can be lossy without destroying retained continuation state. Continue using the returned response/conversation identifier rather than manually replaying the shaped output.
- **Responses with `store: false` and no durable conversation:** lossy replay-required output is rejected because no continuation history remains. When a conversation ID is supplied, that conversation retains canonical history independently of response storage, so lossy presentation is still supported.
- **Plain textual Chat reasoning without replay metadata:** remains eligible for lossy presentation.

Use `original`, `reasoning`, or `reasoning_content` for stateless signed-thinking conversations. Hydrogen never silently switches `none` to a revealing format to make continuation work.

**Existing disabled-thinking behavior:** the generation-level `thinking: "disabled"` control still removes returned reasoning in buffered execution if an upstream ignores the request. That removal precedes canonical replay checks and can discard replay-required metadata. Do not rely on an ignored generation-disable control to preserve signed continuation; use a compliant upstream, or leave generation enabled and choose an appropriate presentation/stateful policy instead.

## Migration from the old replacement design

This is a deliberate behavior change:

1. Output formats no longer guess whether text is thinking. If a model returns inline `<think>` blocks, add `thinkingParser: {"mode":"think_tags"}` to **that step**.
2. Move each old service/agent-level `thinkingDelimiters` pair to the appropriate upstream step's `thinkingParser: {"mode":"custom","delimiters":…}`. Do not blindly copy one grammar across heterogeneous fallbacks. The old shared setting is rejected with migration guidance, not silently ignored; the UI keeps it visible until you explicitly remove it.
3. For spaced, mixed-name, or other model-specific markers, configure the exact custom pair. Automatic spelling/stem guessing was removed; built-in `<think>` recognition protects quoted examples using bounded lookahead.
4. Unclosed thinking is now an error or retained reasoning, never an answer. Whole-trace buffering and delayed 24-character replay were removed.
5. Stateless signed-thinking clients must use a native output format or move to stored continuation.

No database migration is required. Review affected saved definitions before deploying; deployments that relied on implicit inline scanning need explicit per-step configuration.
