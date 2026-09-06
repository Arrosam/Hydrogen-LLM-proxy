# Server-side tools — requirements

> Status: **signed off 2026-09-06**. Product decision: the release carrying this
> feature is **v2.0.0b**, and the product is renamed **Hydro AI station** — a
> deliberate repositioning from "LLM proxy" to "AI agent backend". See
> [Repositioning](#repositioning) for what the rename actually touches.
>
> Supersedes the 2026-07-27 *Oxygen-tools* three-repo plan (Hydrogen dispatches /
> Oxygen implements / O-H packages). There is no Oxygen and no O-H: Hydrogen
> implements the tools itself.

## Problem

A client that speaks the Responses or Anthropic wire declares built-in tools
(`web_search`, `image_generation`, `mcp`, `code_interpreter`). Hydrogen parses
them into `Tool.raw` and replays them **only to the same family** —
`server/src/core/format/responses.ts:438`, `server/src/core/format/anthropic.ts:205`.

Point Codex or Claude Code at a DeepSeek/GLM catalogue and those tools vanish
silently: the harness system prompt still promises them, so the model either
hallucinates the calls or announces it cannot use them. Today Hydrogen can stand
in for a provider's *chat*. It cannot stand in for a provider.

## Behavior

1. **Hydrogen executes the tools itself.** Four in scope: `web_search` +
   `web_fetch`, `image_generation`, `mcp`, `code_interpreter`.

2. **A tool is on the table if the client declared it OR the Model Service
   grants it.** Union of the two. A plain `curl` client with no `tools` field,
   hitting a service that grants `web_search`, gets web search.

3. **Native first.** Every provider carries an operator-declared capability list.
   If the resolved provider is ticked for that tool, the tool is passed upstream
   untouched and the provider executes it. Otherwise Hydrogen strips it,
   re-declares it as a plain function tool, and runs the loop itself.
   Consequence, accepted: fallback steps within one Model Service can change the
   executor mid-service, and with it the search index and citation shape.

4. **A wrongly-ticked capability produces a real upstream 400, surfaced as-is.**
   No probe-and-retry, no silent substitution. This is the same rule already
   enforced for Anthropic `thinking` (`62ab091`) and `reasoning_effort`.

5. **The client sees native protocol wherever its format has one.**
   - Anthropic → `server_tool_use` + `web_search_tool_result` blocks + `citations`.
   - Responses → `web_search_call` / `image_generation_call` items + annotations.
   - Chat Completions → no built-in-tool vocabulary exists, so results are folded
     into the answer text. Two documented fidelity tiers; nothing is faked into a
     format that cannot hold it.

6. **A failing tool is reported to the model, not to the client.** The search
   backend 500s mid-turn, after partial output already reached the client → an
   errored tool result goes back to the model, the model writes around it, and
   the turn completes. Not silent: the failure is visible in the transcript.

7. **MCP servers are operator-configured rows only.** A client-supplied
   `server_url` is rejected with an error naming the reason. Clients may select a
   configured server by name. This closes the SSRF/exfiltration path that
   accepting a caller-supplied URL would open.

8. **`code_interpreter` runs in a throwaway container per call**, with network
   access filtered through the existing SSRF guard and, if the provider has one,
   the configured egress proxy. Not `--network none`; not a plain bridge.

## Assumed defaults

Each of these is a decision made in the absence of a stated preference. Override
any of them in one line.

| # | Default |
|---|---|
| D1 | Ships incrementally in the order `web_search`+`web_fetch` → `image_generation` → `mcp` → `code_interpreter`. The first three do not wait on the sandbox. |
| D2 | Union only — a service may add tools, never subtract one the client asked for. No deny-list in this version. |
| D3 | `image_generation` routes through the existing image Model Services, inheriting their retry/fallback. No new image credential. |
| D4 | Pluggable search backend; **Tavily** first (returns LLM-ready content rather than a raw SERP), SearXNG for pure self-hosters. `web_fetch` reuses `ssrf.ts` plus an HTML→markdown pass. |
| D5 | 16 tool rounds per turn, overridable per Model Service. On exhaustion the model is told it is out of tool calls and answers with what it has. |
| D6 | Tool credentials and MCP servers become a new admin-only config surface — encrypted with the master key like provider keys, included in the sealed export, readable non-admin so the service editor can list them. Same rule as Proxies. |
| D7 | Each tool round is logged as a nested `ServiceCall` (the Micro Agent shape); usage sums into the parent row. |
| D8 | Micro Agent stages inherit service-granted tools. |
| D9 | Streaming works by buffering the intermediate rounds and streaming the final one — the Micro Agent precedent. |

## Non-goals

- `file_search` and vector stores
- `computer_use`, `local_shell`
- Client-supplied MCP servers
- Deny-lists / any subtractive tool policy
- The `Oxygen-tools` and `O-H` repos (superseded by this document)
- **Portability of `code_interpreter` to the Rainyun one-click deploy.** It needs
  a Docker socket or a rootless runtime; the one-click app-store deployment does
  not provide one. Documented, not solved. The other three tools are unaffected.

## Done when

1. Claude Code → Hydrogen → a DeepSeek-only catalogue: a real search runs,
   citations render in Claude Code's own UI, and the request log shows DeepSeek
   answered.
2. The same request with the Anthropic provider ticked capable: Anthropic
   searches, Hydrogen adds nothing, and the log shows the native path was taken.
3. A Responses client gets an image back through an existing image Model Service.
4. A `chat/completions` client on a `web_search`-granted service gets links in
   the answer text and no protocol error.
5. The search backend forced to 500 → the answer still completes and says the
   search failed.
6. A client-supplied MCP `server_url` → 400 naming the reason.

## Repositioning

The release carrying this feature is **v2.0.0b**, under the name
**Hydro AI station**. The rename is a separate work item from the feature, and it
touches more than a string:

- repo name and every URL that embeds it
- the GHCR image path (`ghcr.io/arrosam/hydrogen-llm-proxy`)
- `README.md`, `README.zh.md`, `docs/`, the hero SVG
- web UI branding, page titles, favicon
- `docker-compose.yml`, `deploy/`, `.env.example`
- the Rainyun app-store listing
- the live deployment at `llm.areel.org`

Nothing here is decided yet beyond the name and the version. Whether the image
path and repo actually move — and what happens to pulls of the old path — is an
open question below.

## Open

- **The measurement gate is half cleared** — see [Measurements](#measurements).
  M1 measured the Anthropic-wire coding harness and it came back **negative**: it
  declares no server-side tools at all. M2, the Responses-wire case this feature
  was actually premised on, is still unmeasured, and no dispatch code is written
  until it is. The tool *type strings* Hydrogen declares must match what the
  harness's system prompt promises, or the model still cannot reach them.
- Search backend (D4) — needs a key that does not exist yet.
- Whether Claude Code validates Anthropic's `encrypted_content` on a
  `web_search_tool_result`, or accepts a synthesized value. Resolve by testing
  against the real client.
- Service-granted tools: chat category only, or also embeddings/tts? Assumed
  chat only.
- Whether the rename moves the repo and GHCR image path, and what happens to
  existing pulls and the Rainyun listing if it does.

## Measurements

### M1 — Anthropic-wire coding harness declares NO server-side tools

Source: `server/data/hydrogen.db`, `request_logs` rows 3–7, captured 2026-07-07;
user-agent `hertz`, ingress `anthropic`, path `/v1/messages`, bodies 72–88 KB
stored intact.

Every request declares 18–21 tools. **All of them are plain function tools with an
`input_schema`. Zero bare-`type` (server-side) tools.** The harness ships its own
`WebSearch`, `WebFetch` and `run_mcp` and executes them client-side. Its system
prompt never names `web_search`, `code_interpreter`, or any hosted tool.

**What this changes.** For coding-agent harnesses on the Anthropic wire, the
client-declared half of Behavior 2 is dead weight — they never ask for a hosted
tool, so there is nothing for Hydrogen to intercept. All of this feature's value
for that client class sits in the **service-granted** half. That reorders the
build: the service-grant config surface (D6) is not a secondary convenience, it
is the primary path.

### M2 — Responses-wire harness: NOT MEASURED

There is no `/v1/responses` request in any log, ever — `select distinct
ingress_format from request_logs` returns only `anthropic`. The premise this
feature was originally built on, that Codex/ChatGPT harnesses promise hosted
tools their model cannot reach, remains unverified.

**How to capture it.** No configuration change is needed: `LOG_PAYLOAD_MAX_CHARS`
defaults to 2,000,000 and no `log_payload_max_chars` settings row overrides it,
so bodies are already stored whole.

1. Point Codex (or any Responses-wire client) at Hydrogen with a client key.
2. One short, fresh conversation — a single turn is enough.
3. Read the row back:

```sql
select id, request_path, ingress_format, length(request_body)
from request_logs where request_path = '/v1/responses' order by id desc limit 5;
```

What the capture has to answer, and nothing gets written until it does:

- Does the request carry bare-`type` tools (`web_search`, `image_generation`,
  `code_interpreter`, `mcp`) at all, or only `type: "function"` entries?
- If it does, what are the **exact type strings and versions**? Declaring
  `web_search` where the harness expects `web_search_preview` means the model
  still cannot reach it.
- Does the system prompt name tools that are absent from the `tools` array? That
  gap is the actual bug this feature exists to close.

### M2 — Codex DOES declare a server-side tool. Measured 2026-09-06.

Source: Codex CLI **0.144.5**, default config, driven at `http://localhost:8080/v1`
with `wire_api = "responses"` against a bogus model so the 404 fires after the
body is logged. `request_logs` rows 9–20, ingress `openai_responses`, 68 KB.

14 tools per request:

| Shape | Count | Names |
|---|---|---|
| `type: "function"` | 10 | `shell_command`, `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`, `update_plan`, `request_user_input`, `view_image`, `get_goal`, `create_goal`, `update_goal` |
| `type: "web_search"` | 1 | sent verbatim as `{"type":"web_search","external_web_access":false}` |
| `type: "namespace"` | 3 | `multi_agent_v1`, `mcp__cua_repl`, `mcp__node_repl` — each with a nested `tools: [names]` array |

**Findings that change the spec:**

1. **The name is `web_search`.** Not `web_search_preview`, not a dated variant.
   The binary contains `web_search`, `web_search_call`, `image_generation`,
   `local_shell`, `computer_use` and `file_search`; `web_search_preview` appears
   once and is not what 0.144.5 emits.

2. **It is sent unconditionally.** Adding `-c tools.web_search=true` produced a
   byte-identical tool. `external_web_access: false` is governed by something
   other than that switch. Hydrogen cannot assume the tool is absent by default.

3. **The system prompt never mentions it.** All 21,026 characters of
   `instructions` never say `web_search`, `browse`, or `image_generation`. This
   **falsifies the July premise** that the harness prompt promises hosted tools
   the model cannot reach. The model learns the tool exists only from the `tools`
   array — so when Hydrogen drops it, the model does not hallucinate a promised
   tool, it simply never knows the tool existed. The bug is real; the mechanism
   is not the one assumed.

4. **`type: "namespace"` is not a documented Responses shape.** It is a Codex
   extension carrying sub-agent and MCP tool groups. Hydrogen's `parseTools`
   already funnels it into `Tool.raw` unchanged, so same-family replay is intact.

5. **Cross-family, Codex loses 4 of its 14 tools.** `responses.ts:130` stores all
   four non-function tools as `raw`; `anthropic.ts:400` and `completion.ts:485`
   filter on `t.raw.family === <their own>`, so all four are dropped. Ten plain
   function tools survive. That is the concrete, measured defect.

6. **Fields Hydrogen must carry unharmed:** `store: false`, `include: []`,
   `prompt_cache_key`, `client_metadata` (Codex telemetry),
   `parallel_tool_calls: false`, `tool_choice: "auto"`, `reasoning: null`.

**Open, following from M2:** the three `namespace` tools are dropped cross-family
alongside `web_search`, and they matter more (they carry MCP and sub-agent
tooling). Whether Hydrogen translates, passes through, or keeps dropping them is
not decided by anything above.

## Behavior 9 — namespace flattening (decided 2026-09-06, after M2)

Codex's `type: "namespace"` tools are **flattened into ordinary function tools**
when the resolved provider is not Responses-family, and folded back on the way
home. Same-family egress replays them verbatim as today.

Measured facts this rests on:

- Namespace members are complete function tools — `type`, `name`, `description`,
  `strict`, `parameters`. Nothing has to be invented to flatten them.
- Flattening 3 namespaces expands 14 declared tools into **20**.
- **Bare member names collide**: `mcp__cua_repl/js` and `mcp__node_repl/js`, and
  likewise `js_reset`. A naive flatten silently merges two different tools, so
  the flattened name must be qualified — `mcp__node_repl__js` — and the mapping
  kept for the return trip.

**Open:** the return trip is unverified. We have Codex's request but never a
successful reply, so what Codex accepts back for a namespaced call — a
`function_call` named `js` in namespace context, or the qualified name — is
unknown. Resolve by pointing Codex at a working Model Service and capturing a
completed turn. Getting this wrong breaks every namespaced tool call, so it is a
gate on shipping the flattening, not on designing it.

### M3 — the defect reproduced live on the production instance

Two requests to `https://llm.areel.org/v1/responses`, service `Auto-free`, same
model, same prompt, differing only in tool shape:

| Tool sent | Model's reply |
|---|---|
| `{"type":"function","name":"js",...}` | a real `function_call` item: `{"name":"js","arguments":"{\"code\":\"1+1\"}"}` |
| Codex's actual `{"type":"namespace","name":"mcp__node_repl",...}` | **no tool call at all** — plain text reading `<{"tool_call": {"tool_name": "node_repl/js", ...}}>` |

The namespace tool is dropped before the model sees it, and the model then
invents a tool-call-shaped string in prose. This is the defect, reproducible on
demand, on the live deployment. It also means **no reachable provider can serve a
namespaced tool today**, which is why M4 needed a stub rather than a real turn.

### M4 — the return shape, measured 2026-09-06

Method: a stub Responses upstream (`scratchpad/stub-responses.cjs`) asserted one
namespaced call; Codex executed it through its real `node_repl` MCP server and
sent the result back. Captured on the first probe — the hypothesis read out of
the binary's serde field table was correct.

**What Codex accepts** (assistant side):

```json
{"type":"function_call","call_id":"call_stub_1","name":"js",
 "namespace":"mcp__node_repl","arguments":"{\"code\":\"1+1\"}"}
```

Codex logged `mcp: node_repl/js started` / `(completed)` and ran it.

**What Codex sends back** (next turn's `input`):

```json
{"type":"function_call","name":"js","namespace":"mcp__node_repl",
 "arguments":"{\"code\":\"1+1\"}","call_id":"call_stub_1"}
{"type":"function_call_output","call_id":"call_stub_1",
 "output":"Wall time: 6.6820 seconds\nOutput:\n[{\"type\":\"text\",\"text\":\"\"}]"}
```

**Three facts that pin the design:**

1. `namespace` is a first-class sibling of `name` on a `function_call` item —
   **not** a qualified name like `mcp__node_repl__js`.
2. `function_call_output` carries **only** `call_id` and `output`. There is no
   namespace on the return leg; correlation is by `call_id` alone.
3. Codex replays the assistant's `function_call` verbatim next turn, `namespace`
   included — so Hydrogen must re-flatten prior-turn items on every subsequent
   outbound request, not just the first.

**Behavior 9, now fully specified.** Outbound to a non-Responses provider,
`{name, namespace}` flattens to a qualified `namespace + "__" + name` (required:
bare `js` and `js_reset` each collide across two namespaces). Inbound, a call
named `mcp__node_repl__js` splits back into `{"name":"js","namespace":"mcp__node_repl"}`.
The mapping is derivable from the item itself, so **it needs no server-side
state** and survives retries, fallback steps and restarts.

## Behavior 10 — the Tools tab (decided 2026-09-06)

A **Tools** tab in the web console, owning tool configuration and nothing else.

**It owns:**
- the web-search backend choice and its API key
- operator-configured MCP servers (name, URL, auth)
- `code_interpreter` sandbox settings (image, timeout, memory, egress policy)
- per-tool enable/disable and the round cap (D5)

**It deliberately does NOT own:**
- *which providers natively serve which tool* — that stays on **Providers**,
  beside the base URL and key it belongs to
- *which Model Services grant which tool* — that stays in the **Model Services**
  editor, beside the steps it applies to

Each fact is editable from exactly one screen. The cost, accepted: there is no
single place to see where a tool is in use.

**Permissions**, matching Proxies: writes are admin-only (a tool row carries a
credential and decides where this server's traffic goes); **reads are not
admin-gated**, because the Model Services editor must list the configured tools
to render its grant picker.

**Wiring**, following the existing convention exactly:
- `NAV` entry in `web/src/components/Layout.tsx` — `{to: "/tools", labelKey:
  "nav.tools", icon: "bi-...", adminOnly: false}`
- route in `web/src/App.tsx`
- `nav.tools` plus every field label in `web/src/lib/i18n.tsx`, **en and zh both**
- Bootstrap Icons only, never emoji
- `web/src/pages/Tools.tsx`, modelled on `Proxies.tsx`
- server side: a `toolRoutes` group registered like `proxyRoutes`, with secrets
  encrypted under the master key and included in the sealed export

**Storage:** new tables. Provider capabilities need migration `0008` (the
`providers` table has no such column today); service tool grants need **no**
migration — a service definition is a JSON blob validated by zod in
`execution/definition.ts`, so the grant is a schema extension.
