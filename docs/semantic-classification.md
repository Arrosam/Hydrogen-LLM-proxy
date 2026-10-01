# Semantic classification (Jev / Laya)

Hydrogen's `classification` Model Service category serves **System One typed
semantic decisions**, using the native Jev/Laya JSON protocol. This is not a
chat-completions API and does not generate or parse assistant text.

## API investigation

- **TypeSafe Jev:** [`POST https://api.typesafe.ai/v1/systemone`](https://docs.typesafe.ai/api.md),
  authenticated with `Authorization: Bearer <provider key>`. Requests contain
  `model`, `state` (text, object, or array), and a map of typed `questions`.
  Responses contain `model`, the matching `answers` map, and
  `usage: {input_tokens, output_tokens}`.
- **Laya:** the open-weight [Hugging Face model](https://huggingface.co/convaiinnovations/laya)
  can be served with [`laya-serve`](https://pypi.org/project/laya/), which exposes
  the same `/v1/systemone` interface. Bearer authentication is optional on Laya
  and enabled by `LAYA_API_KEY`. The server may also return routing metadata,
  additional confidence fields, and truncation information; Hydrogen preserves
  them. The model weights alone are not an HTTP inference endpoint.
- The shared question types are **Choice** (select a label, with probabilities),
  **Score** (rate against ordered rubric levels), and **Noul** (yes/no probability).
  Questions are keyed by caller-defined IDs and answers use those same IDs.
  Instructions and criteria can contain structured JSON, not just strings.

The existing non-chat architecture uses a service category to select a dedicated
upstream route, rewrites the client-facing service name to the mapped model ID,
and runs the ordinary step-chain retry/fallback engine. Classification extends
that architecture rather than passing typed decisions through the chat IR.

## Configure a service

1. Add a provider using **OpenAI Chat Completions** as its endpoint type. This
   selects Hydrogen's JSON/Bearer passthrough routing; it does **not** imply that
   Jev or Laya implements chat completions. Use an API **base URL including `/v1`**,
   not the complete `/v1/systemone` endpoint:
   - Jev: `https://api.typesafe.ai/v1`, with a TypeSafe API key.
   - Laya: `http://your-laya-server:8000/v1`, with its key if configured.
     Private/LAN upstream addresses require the existing private-upstream setting.

   Jev supports model discovery at `/v1/models`; `laya-serve` does not promise
   that route, so add Laya mappings manually and use Model Bench to test them.
2. Create an internal Model and map it to that provider's upstream model ID:
   - Jev: `jev-latest` (or an available pinned version).
   - Laya: `english`, `multilingual`, or `typed-decisions` to pin a checkpoint.
     Laya also accepts its documented aliases; an unrecognized Jev-style model
     ID lets its router auto-select. Prefer explicit IDs when pinning matters.
3. Create a Model Service, choose **Semantic classification (Jev / Laya)**,
   and add the mapped model/provider pair. For example, name it `ticket-triage`.
   Add retry and fallback steps as for an embedding or image service.

OpenAI Responses provider endpoints are also eligible passthrough targets. A
provider whose primary endpoint is Anthropic must declare an OpenAI alternate
and enable it on the mapping; an Anthropic-only mapping is rejected. No new
provider enum or database migration is required.

## Call the native endpoint

Use a **Hydrogen client token**, not your provider key, and put the **Model Service
name** in `model`:

```sh
curl http://localhost:8080/v1/systemone \
  -H "Authorization: Bearer $HYDROGEN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "ticket-triage",
    "state": {"body": "I was billed twice. Please refund the duplicate today."},
    "questions": {
      "department": {
        "type": "choice",
        "instructions": "Which team should handle this?",
        "criteria": {"billing": "Payments and refunds", "technical": "Bugs and outages"}
      },
      "urgency": {
        "type": "score",
        "instructions": "How urgent is this?",
        "criteria": ["Not urgent", "Needs attention soon", "Blocking issue"]
      },
      "refund_requested": {
        "type": "noul",
        "instructions": "Does the customer explicitly request a refund?"
      }
    }
  }'
```

An illustrative Jev response (values depend on the upstream):

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "department": {
      "type": "choice",
      "choice": "billing",
      "probabilities": {"billing": 0.9, "technical": 0.1},
      "confidence": 0.8
    },
    "urgency": {
      "type": "score",
      "score": 1.1,
      "legend": {"0": "Not urgent", "1": "Needs attention soon", "2": "Blocking issue"},
      "probabilities": {"0": 0.1, "1": 0.7, "2": 0.2},
      "confidence": 0.55
    },
    "refund_requested": {"type": "noul", "noul": 0.95}
  },
  "usage": {"input_tokens": 318, "output_tokens": 34}
}
```

Hydrogen preserves the response, including its upstream `model`, answer IDs,
probabilities, confidence, usage, and provider-specific metadata. Request fields
are forwarded unchanged except for the mapped `model` and any step
`overrides.extra` parameters. For example, a Laya-only service may pin
`max_len`, `head_max_len`, `lang`, or `min_confidence` through those overrides.
Provider-specific validation remains upstream, as with the other passthrough
categories. Hydrogen wraps errors in its existing JSON error envelope and retains
the upstream failure status (unless a keepalive already committed HTTP 200).

For TypeSafe's documented `429`/`529` overload responses, configure both retry
triggers and exponential backoff if desired; Hydrogen applies the configured
policy, not a separate SDK retry loop. A Jev-to-Laya fallback should use shared
question syntax and account for each provider's limits. Laya's confidence
calculation differs from Jev's, so thresholds are **not interchangeable**.

## Laya batched-state extension

Hydrogen also forwards **`POST /v1/systemone/batch`** to the same mapped
provider's `/systemone/batch` route. This is a Laya extension, not a batch API
promised by TypeSafe Jev:

```json
{
  "model": "ticket-triage",
  "states": [
    {"body": "Please refund my invoice"},
    {"body": "Cannot log in"}
  ],
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "Which team?",
      "criteria": {"billing": "Payments", "technical": "Bugs"}
    }
  }
}
```

Laya accepts up to 64 states and returns `{results: [...], total_usage: {...}}`
in the same order. Hydrogen does not split or emulate a batch for a provider
that lacks this route; that provider's failure follows the configured fallback
rules. Use a Laya-only chain for batching unless every fallback supports it.
The HTTP batch endpoint is distinct from the Python library's batch API; do
not assume single-request tuning fields or library batching controls work on it.

## Accounting, logging, and testing

- Service scope, token enablement/expiry, request quotas, token quotas, and
  upstream endpoint restrictions apply just as for embeddings.
- `usage.input_tokens` maps to logged prompt tokens and `output_tokens` to
  completion tokens. Their sum counts against the client token quota. A batch
  uses `total_usage` once, not both the aggregate and each result. One batch
  request counts as one Hydrogen request.
- Missing/invalid usage counters use zero as Hydrogen's internal accounting
  fallback, **not evidence of zero upstream consumption**; the raw response
  stays unchanged. Hydrogen does not estimate usage from state text. Laya is non-generative and normally reports zero
  output tokens. Provider pricing is separate from Hydrogen's token quotas.
- Typed answers are retained in the request log, subject to the configured
  payload-size limit, rather than reduced to a bare success marker.
- **Model Bench** supports classification on both transports: Proxy exercises
  the service chain with a real client token, while Internal makes one diagnostic
  request at the selected raw mapping or the saved service's first step. Its
  editable starter body includes all three question types. Internal probes are
  not logged or charged to a Hydrogen client token. Internal passthrough probes
  use the editable bench body rather than the step's parameter overrides;
  use Proxy when testing those overrides. The ordinary editor chat dry-run
  is not a classification probe.
- Classification services are **not usable as Micro Agent chat stages or OCR
  pre-passes**, and cannot be called through chat/Responses/Messages endpoints.
  Agent integration would need an explicit typed-decision stage design.

## Primary references

- [TypeSafe HTTP API](https://docs.typesafe.ai/api.md)
- [TypeSafe models and pricing](https://docs.typesafe.ai/models.md)
- [Laya serving documentation](https://pypi.org/project/laya/)
- [Laya HTTP server source](https://github.com/NandhaKishorM/laya/blob/main/laya/serve.py)
- [Laya Hugging Face model](https://huggingface.co/convaiinnovations/laya)
