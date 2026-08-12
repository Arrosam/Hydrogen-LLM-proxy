# Memory: what a request actually costs

Written 2026-08-13, against v1.5.1. Prompted by a production report: the
container peaks over 1 GB of RAM under load, on traffic that cost a few MB back
in the 0.x era, and it has climbed gradually since Micro Agents arrived (v0.3.0,
commit `c096e09`).

Everything below is measured with `bench/memory/harness.cjs` against a local mock
upstream. Nothing in this investigation touched production.

## Conclusions first

1. **There is no leak.** After a forced GC, heap returns to 23–28 MB across
   hundreds of requests. What climbs and stays up is RSS that V8 does not hand
   back to the OS — which is why the graph looks like a sawtooth rather than a
   ramp.
2. **Cost is a multiple of the request body, per in-flight request.** Each MB of
   client body costs roughly 3.6 MB of heap through a plain Model Service and
   7.5 MB through a five-stage Micro Agent — about one extra full pass per stage.
3. **That is why it grew with Micro Agents.** A plain service serializes the
   conversation for the log a fixed number of times. An agent additionally
   serializes each stage's entire upstream request into its attempt record
   (`microAgent.ts`, `callService` → `call.request`), so the cost scales with
   stage count.
4. **1 GB is consistent with these numbers**, not evidence of a defect: ~55
   concurrent in-flight 1.5 MB agent requests reaches it. In-flight count is
   arrival rate × upstream latency, so a few requests per second against a
   30-second model is enough.

## Measurements

Idle after boot: **112 MB RSS / 19.6 MB heap**. Peak values are sampled at 200 ms
from inside the process; treat them as ±20%.

| Conversation | Concurrency | Service | Peak RSS | Peak heap | Heap per in-flight request |
|---|---|---|---|---|---|
| 85 KB | 10 | plain | 131 MB | 30 MB | ~1.1 MB |
| 85 KB | 10 | 5-stage agent | 164 MB | 55 MB | ~3.5 MB |
| 85 KB | 30 | 5-stage agent | 219 MB | 89 MB | ~2.3 MB |
| 500 KB | 10 | plain | 161 MB | 68 MB | ~4.8 MB |
| 500 KB | 10 | 5-stage agent | 226 MB | 108 MB | ~8.8 MB |
| 1.5 MB | 10 | plain | 205 MB | 104 MB | ~8.4 MB |
| 1.5 MB | 10 | 5-stage agent | 343 MB | 183 MB | ~16.3 MB |

An instant upstream makes the peak **churn**-dominated (garbage not yet
collected). A realistic 2-second upstream makes it **retention**-dominated (data
genuinely live). Both regimes matter and they respond to different fixes, so
measure the one you are trying to improve.

## Ruled out, with evidence

| Suspect | Verdict |
|---|---|
| A leak | Post-GC heap flat at 23–28 MB over 300+ requests |
| `attempt_path_json` growing unbounded | `AttemptRecord` carries no payloads — step, model, status, latency, retry only |
| Base64 re-rendered per stage (`wire.ts`, `completion.ts`) | Real, but irrelevant to text-dominated traffic |
| Log serialization multiplying per stage | Transport logging is once per client request; the per-stage cost is the agent's own attempt records |
| `MAX_BODY_BYTES` raised at some point | 25 MB since the MVP commit, never changed |
| The truncate-and-retry loop in `serializeForLog` | Unlimited (`LOG_PAYLOAD_MAX_CHARS=0`) measured *worse*: 119 MB vs 89 MB peak heap |

## What was fixed

**Measure before building** (`util/logPayload.ts`). `serializeForLog` used to
pretty-print the entire payload and only then compare it against the budget, so a
1.5 MB body produced a >1.5 MB string that was immediately discarded — and an
agent repeated that once per stage. It now walks the value to get a deliberate
*lower bound* and only builds the string when it will plausibly fit. A payload
that fits is still stored byte for byte; the estimate can only cause a false
"fits", which the existing length check catches.

**Capture early, release early** (`transport/proxyController.ts`,
`observability/requestLogger.ts`). `HttpRequestInfo` now carries `bodyPayload`, a
bounded string captured when the request arrives, instead of the parsed body; the
streaming relay captures the upstream body once and drops its reference. Both
existed only to be serialized at the end, which on a streaming call meant holding
the whole conversation for the length of the stream.

Measured effect, five-stage agent with a 1.5 MB conversation:

| Regime | Peak heap | Peak RSS | Wall time |
|---|---|---|---|
| Fast upstream (churn) | 180.8 → 157.6 MB (−12.8%) | 336 → 320 MB (−4.8%) | −23% |
| Slow upstream, non-streaming | no measurable change | no measurable change | — |
| 9-second token stream | 81.9 → 75.0 MB (−8.4%) | 172 → 163 MB (−5.4%) | — |

**This does not get production from 1 GB to a few MB, and it was never going to.**
It removes waste worth roughly 5–13% of peak depending on regime, and makes agent
requests ~23% faster. The remaining cost is largely inherent: per in-flight
request the proxy holds the canonical conversation, the wire body in flight, and
bounded log payloads.

## What was considered and rejected

- **Caching the rendered wire body across stages.** Five stages make five
  upstream calls, so five serializations are inherent; sharing them risks silent
  divergence when stages differ in overrides.
- **Moving active requests to disk.** The registry is single-digit MB and
  `request_logs` already persists every completed request. It would have cost
  8–20 extra hot-path writes per request to reclaim almost nothing.
- **A commit bisect.** Wrong instrument for a gradual accumulation; stage-count
  scaling on the current build demonstrates the correlation directly.

## If the target is an order of magnitude

The levers left all change externally visible behaviour, so they are decisions
rather than fixes:

- **Bound the body size.** Peak cannot exceed limit × concurrency × ~4. A limit
  below today's 25 MB means 413s for large pastes.
- **Bound concurrent large requests.** A real ceiling with no rejections, paid for
  in added latency under burst.
- **Cap the heap** (`--max-old-space-size`). Does not reduce cost; forces V8 to
  collect harder instead of growing, and turns exhaustion into a crash.
- **Stop capturing full payloads for the log.** The bounded log strings are ~1.1 MB
  live per in-flight agent request at the default 100,000 chars. Lowering
  `LOG_PAYLOAD_MAX_CHARS` trades log fidelity for footprint directly, with no code
  change.

## Reproducing

```bash
node bench/memory/harness.cjs
```

Environment knobs: `CONV_BYTES`, `CONCURRENCY`, `ROUNDS`, `ONLY` (`plain`,
`agent1`, `agent3`, `agent5`), `LPMC` (`LOG_PAYLOAD_MAX_CHARS`), `MOCK_DELAY_MS`
(upstream think time), `MOCK_FRAME_DELAY_MS` (token trickle), `BUNDLE` (path to a
built `server.cjs`, for before/after comparisons — keep it inside `server/dist` so
its external dependencies resolve).

Build two bundles and point `BUNDLE` at each in turn to compare; run at least
three repetitions, because a single pair cannot resolve anything under ~20%.
