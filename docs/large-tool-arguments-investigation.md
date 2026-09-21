# Large tool-call arguments: investigation and regression evidence

2026-09-22. Baseline: `origin/main` at `6bd8a228b114f5059e634ce0d644a0da311fad4b`.
Dedicated isolated branch: `codex/fix-large-tool-arguments`.

A Hydrogen defect was reproduced and fixed. The shared SSE parser repeatedly
searched and flattened the entire unfinished frame whenever another network
chunk arrived. This made fragmented large frames quadratic in their size.
Responses repeats the complete function arguments in its done/item/completed
snapshots, so even a call generated in thousands of small deltas could stall
before the client received completion and started execution. A single large
Chat Completions delta reproduced the same delay before its arguments became
visible. The responsible layer was Hydrogen's SSE framing, before IR emission,
not the hosted HTTP adapter or the external file executor.

This confirms a proxy failure mode matching the symptom, not attribution of an
unrecorded production incident. No original provider/client trace was supplied.
Ordinary generation time, intentional reliable-stream buffering, upstream
non-completion, and a client's own scheduling can still delay a file write.

**Event path and execution boundary**

| Layer | Path and behavior |
| --- | --- |
| Ingress | `ProxyController` parses Messages, Chat Completions or Responses and resolves a Model Service. Stateful Responses and bound tools route through `ResponsesController`. |
| Upstream | `ModelService.stream` → request `relay` → `relayStream` → `UpstreamClient.postStream` (undici, with SSRF pinning and cancellation). The request is rendered in the provider's dialect. |
| SSE | `parseSSE` decodes UTF-8 across TCP boundaries, assembles SSE lines/frames, then the provider response parser produces canonical events. This was the quadratic boundary. |
| IR | Chat `delta.tool_calls[].function.arguments`, Messages `input_json_delta.partial_json`, and Responses `response.function_call_arguments.delta` become `tool_args_delta`. Responses done/completed snapshots can fill missing suffixes. `guardToolArguments` forwards each delta, counts bytes and validates completed JSON. |
| Rendering | `requireAnswer` → thinking presentation → `tapStream` → ingress `serializeStream`. Chat and Messages send argument deltas directly; Responses also accumulates the arguments needed for its final snapshots. No incremental JSON reparse is required for each delta. |
| Delivery | `ProxyController.relay` writes frames in order and waits for `drain` under backpressure. Disconnect aborts upstream work. Stateful Responses uses `liveResponseWire`'s single-slot handoff, persisted ordered events, and `follow` with `drain` handling. |
| Buffered modes | Non-streaming uses `postJson`, parses a complete response, then renders it. Reliable Streaming collects and validates an upstream stream before replaying it. Micro Agent stages also buffer for routing. Tool arguments in fabricated streams are emitted without artificial text pacing. |
| Hosted execution | `runHostedTools` collects the completed model turn, resolves bound names, checks the parameter schema and budgets, then `callHttpTool` renders and validates an HTTP request and calls the adapter. Progress/all/final modes change presentation. No partial argument object is dispatched. |
| Client execution | An unbound `write_file` is returned to the external client. Hydrogen has no native filesystem executor for it. That client's argument assembly, validation, UI and executor scheduling are outside this repository. |

The distinction between argument progress and execution follows the
[OpenAI function-calling guide](https://developers.openai.com/api/docs/guides/function-calling):
streamed deltas can expose generation progress; application code executes the
assembled call. The fake upstream exercises these stages without a paid model.

**Reproduction and measurements**

The harness uses loopback HTTP sockets and the real upstream client, model
service, protocol parsers/renderers and proxy controller. It generates a valid
`write_file` JSON argument at runtime, sends deltas and terminal snapshots, and
uses an independent incremental downstream decoder. A wrapper observes IR
events without consuming them ahead of downstream demand. An HTTP adapter spy
records actual hosted dispatch, separately from the tool-start progress event.

Recorded environment: Node `v22.22.2`, macOS arm64. Runs are sequential, with
`--expose-gc` and GC before each measurement. Figures are representative local
runs, not production latency guarantees. Heap/RSS are sampled high-water growth
over the pre-call value (2 ms sampling in socket runs, each input chunk in the
parser benchmark). Socket figures include the fake upstream, Hydrogen and the
reference client in one process, and are not isolated production server RSS.
Short allocation peaks can escape sampling. Payload construction precedes the
memory baseline. No argument contents or credentials are written to benchmark
output; only timings, sizes, counts and equality results are recorded.

Full numeric evidence: [measurements.jsonl](../bench/tool-arguments/measurements.jsonl).

| One SSE frame, 1 KiB input chunks | Baseline CPU/wall ms | Fixed ms | Baseline / fixed sampled heap growth MiB |
| --- | ---: | ---: | ---: |
| 1 KiB arguments | 0.46 | 0.46 | 0.02 / 0.02 |
| 256 KiB | 20.68 | 1.46 | 16.31 / 0.71 |
| 1 MiB | 310.76 | 3.87 | 36.88 / 2.71 |
| 4 MiB | 3844.09 | 15.32 | 128.56 / 10.62 |

The 4 MiB isolated parser's sampled RSS growth fell from 131.41 to 2.59 MiB.
The code's repeated prefix scan explains the near-quadratic baseline, independent
of model speed. The replacement scans each newly received character once and
joins each line once.

| 4 MiB call over sockets, downstream Messages | Baseline total ms | Fixed total ms | Baseline / fixed sampled heap growth MiB |
| --- | ---: | ---: | ---: |
| Chat upstream, 4096 deltas | 460.11 | 453.22 | 20.01 / 30.01 |
| Messages upstream, 4096 deltas | 416.03 | 444.63 | 25.34 / 28.94 |
| Responses upstream, 4096 deltas plus three full snapshots | 10694.20 | 951.45 | 301.78 / 48.13 |
| Responses upstream, completed snapshot only | 3490.15 | 258.82 | 236.14 / 33.22 |
| Chat upstream, one argument delta fragmented into 1 KiB packets | 3374.64 | 248.48 | 233.93 / 33.80 |

For the baseline Responses many-delta call, the upstream's first/last argument
delta was at 3.22/403.97 ms, the IR first/last delta at 3.49/421.23 ms, and the
client first/last delta at 3.63/421.39 ms. Yet the client call-close event arrived
at **7299.35 ms** and terminal completion at **10694.20 ms**. The same direct
upstream completed in 846.35 ms. After the fix, first/last IR deltas were at
3.95/430.89 ms, client call close at 796.11 ms and completion at 951.45 ms.
Sampled socket-run RSS growth fell from 296.50 to 31.80 MiB.

For the single-large-delta Chat case, upstream generation started at 13.03 ms
but Hydrogen emitted the argument IR event at 3346.86 ms; the direct client
received the arguments at 183.40 ms. After the fix Hydrogen emitted that event
at 216.12 ms, and the downstream received it at 248.21 ms. This isolates the
delay before dispatch to framing rather than JSON generation or the executor.

The matrix covers all nine provider/client dialect pairs, each streaming and
non-streaming, with a direct control for every case (36 rows per revision).
All argument comparisons were exact. Fixed 256 KiB proxy runs completed in
27.68–42.26 ms streaming and 5.70–9.57 ms non-streaming. The size sweep adds
1 KiB, 256 KiB, 1 MiB minus/exact/plus one byte and 4 MiB; 1 KiB deltas,
single large frames, snapshot-only output, and paced 4 KiB deltas. Paced live
relays exposed progress while generation continued; reliable mode waited for
the complete result as designed. Plain Chat/Messages now pay a small linear
validation/storage cost; their baseline deltas already streamed promptly.

Hosted comparisons cover all three upstream dialects, streaming and JSON,
at the six sizes (36 rows per revision). In both revisions 24 calls entered the
HTTP adapter and 12 exceeded its existing 1 MiB request budget, returned a tool
error and never entered it. A fixed streamed Responses 256 KiB call emitted its
last argument delta at 21.56 ms, announced tool start at 31.99 ms, and entered
the adapter at 34.77 ms. At exactly 1 MiB it entered at 107.35 ms. A 4 MiB call
returned the expected size-related tool error in 436.06 ms with no dispatch.
Every native client-tool run recorded zero hosted dispatches.

**Changes and compatibility**

* Replace the growing-buffer SSE regexp with incremental line parsing while
  retaining UTF-8 decoding, LF/CRLF, multiline data, comments and compatible EOF
  handling. Async iteration retains pull-based backpressure and closes the
  source on cancellation or a parsing error.
* Bound an upstream SSE frame to **25 MiB**, including frame syntax. Bound the
  aggregate decoded tool-argument bytes of a streamed response to **25 MiB**.
  Count split surrogate pairs consistently. These new fixed limits match the
  order of the existing request/context budget; they are not new environment
  settings. Escaped snapshots can reach the frame limit before their decoded
  arguments reach the argument limit.
* Validate JSON at tool-close/response-complete boundaries, preserving immediate
  argument deltas. Malformed completed Chat/Responses JSON responses are also
  rejected. Empty no-argument calls retain their existing `{}` behavior. A
  provider emitting malformed or over-limit calls now fails instead of returning
  an apparently successful call. No JSON parser exception containing file
  content is exposed.
* Known protocol/limit failures on a committed stream emit the dialect's
  structured error, close the stream, omit success terminators, and log semantic
  status 502. Existing truncation/transport failures remain visibly aborted.

Other limits and timeout semantics are unchanged:

| Boundary | Existing behavior |
| --- | --- |
| Incoming HTTP body | Fastify 25 MiB. |
| Hosted HTTP request | 1 MiB **rendered** request body; an over-limit body returns structured `invalid_arguments` and never dispatches. The existing public error message is generic. |
| Hosted result / timeout | Default result 64 KiB, maximum configurable 1 MiB; default timeout 30 s, configurable 100 ms–600 s. |
| Hosted context/presentation, stateful event log, conversations | Separate 25 MiB budgets. Responses snapshots count repeatedly. A new stateful regression confirms 4 MiB succeeds and 8 MiB reaches a terminal `response.failed` with a 25 MiB limit message, within 5 s. |
| Model service timeout | Default 60 s; configured range 1 s–2 h. Streaming bounds headers and idle time between transport chunks, not total generation time. Comments count as activity. JSON requests also have a total abort deadline. |
| Cancellation | Client disconnect cancels active upstream I/O. Tests cover silent upstream timeout, comment-only upstream cancellation and a slow downstream cancellation. A comment-only upstream can intentionally outlive the idle timeout; clients needing a total deadline must set one. |
| Logging | Existing configurable payload logging remains unchanged (code default 100,000 characters; zero disables payloads). New error messages and benchmark diagnostics contain no file contents. |

**Validation and reproducibility**

Changed files:

| File | Change |
| --- | --- |
| `server/src/core/ir/stream.ts` | Linear, bounded SSE framing. |
| `server/src/core/ir/toolArguments.ts` | Byte limits, JSON validation, safe protocol errors. |
| `server/src/core/format/registry.ts` | Apply the argument guard to all upstream stream dialects. |
| `server/src/core/format/completion.ts` | Reject malformed completed JSON tool arguments. |
| `server/src/core/format/responses.ts` | Reject malformed completed JSON tool arguments. |
| `server/src/transport/proxyController.ts` | Structured in-stream protocol errors and accurate 502 status. |
| `server/test/fixtures/toolCallHarness.ts` | Generated loopback upstream, reference client, IR/dispatch observations. |
| `server/test/largeToolArguments.test.ts` | 44 regression cases. |
| `server/test/responsesController.test.ts` | Two stateful large-call/limit cases. |
| `bench/tool-arguments/harness.ts` | Parser, matrix, size and hosted benchmarks. |
| `bench/tool-arguments/tsconfig.json` | Reproducible strict typecheck for the new harness/tests. |
| `bench/tool-arguments/measurements.jsonl` | 240 measurements plus eight environment records; no payload contents. |
| `docs/large-tool-arguments-investigation.md` | Investigation, compatibility and validation report. |

Before source changes, `npm test -- --run test/largeToolArguments.test.ts`
reported **32 passed, 4 failed**: the fragmented 4 MiB parser took 3726 ms
against a 1500 ms CPU bound, and malformed arguments in all three dialects were
marked completed. The bound has substantial headroom over the fixed ~15 ms
parser and is intended to detect an algorithmic regression, not enforce a
production SLA.

The added regression coverage includes all nine conversions in both modes,
small and multi-MiB calls, one-byte UTF-8/JSON/CRLF splits, completion while the
upstream remains connected, missing terminals, malformed arguments, byte-limit
boundaries, aggregate multi-call limits, idle timeout, cancellation/backpressure,
hosted dispatch ordering and rejection, and stateful snapshot accounting.

Commands run from the repository root:

| Command | Outcome |
| --- | --- |
| `npm ci --cache /private/tmp/hydrogen-npm-cache --no-audit --no-fund` | Passed; 393 packages. Default-cache attempt failed because the sandbox could not write `~/.npm`; no cache ownership changes were made. |
| `npm run typecheck` | Passed. |
| `npm run typecheck --workspace web` | Passed. |
| `./node_modules/.bin/tsc -p bench/tool-arguments/tsconfig.json` | Passed; supplementary strict check of the new tests and harness. The initial equivalent check used `/private/tmp/hydrogen-tool-typecheck.json`. |
| `npm test -- --run test/largeToolArguments.test.ts test/stream.test.ts test/streamIntegrity.test.ts test/protocolRegression.test.ts` | Passed: 76 tests at the first fix stage. |
| `npm test -- --run test/responsesController.test.ts test/largeToolArguments.test.ts` | Passed: 55 tests, including the final 44 tool regressions and two new stateful cases. |
| `npm test` | Final pass: **65 files / 1152 tests**, 144.96 s. The preceding full run also passed (1150 tests before the two stateful cases were added). |
| `npm run lint --if-present`; `npm run lint --workspace server --if-present`; `npm run lint --workspace web --if-present` | Exit 0, but **no lint script/configuration exists** in these packages; this is not a lint pass. |
| `npm run build` | Passed: Vite web build and esbuild production server. Existing Vite large-chunk warning remains. |
| `git diff --check` | Passed. |
| `node --expose-gc --import tsx bench/tool-arguments/harness.ts parser` | Passed: four parser sizes. |
| `node --expose-gc --import tsx bench/tool-arguments/harness.ts sweep` | Passed: 44 measurements per revision; all native payloads matched. |
| `node --expose-gc --import tsx bench/tool-arguments/harness.ts matrix` | Passed: 36 measurements per revision; all nine pairs in both modes matched. |
| `node --expose-gc --import tsx bench/tool-arguments/harness.ts hosted` | Passed: 36 measurements per revision; 24 dispatches and 12 expected limit rejections. |

For a baseline comparison without switching branches, archive the baseline
commit to a temporary directory, copy only the new fixture and benchmark there,
and link the installed dependencies. Run each mode in that directory and then
against the fixed checkout, sequentially. This is how the recorded measurements
were obtained; neither unrelated branch was checked out, merged, or modified.
The other pending search branch was not needed for comparison.

**Remaining external follow-up**

If a particular client still appears stuck, capture timestamps and byte counts
for the upstream first/last argument delta, terminal event, downstream terminal,
and executor entry, without logging file contents. A missing upstream terminal
or a delay after downstream completion is a different boundary from this fix.
Confirm whether the service uses Reliable Streaming or bound HTTP tools and
whether the client displays generation progress. Use chunked or patch-based
file writes when full-file arguments approach tool, output-token or snapshot
budgets; keep hosted rendered bodies below 1 MiB. No live paid provider was used.
