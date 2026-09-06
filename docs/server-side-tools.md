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

**Status as of 2026-09-07:** stages A, B and C are shipped; D is parked. Items 1,
4 and 5 depend on Path A emission and are blocked on two unmeasured client
shapes; item 6 has become a decision to revisit rather than a task. Item-by-item
status is at the end of this document, under
[Stage D — Path A native emission. PARKED](#stage-d--path-a-native-emission-parked-2026-09-07-not-built).

## Repositioning

The release carrying this feature is **v2.0.0-b**, under the name
**Hydro AI station**.

The version is written `2.0.0-b`, not `2.0.0b`, because the latter is not valid
semver and `parseVersion` in `updateService` reads it as plain `2.0.0`: the
trailing `b` is dropped, `isPrerelease` returns false, and it compares EQUAL to a
real 2.0.0 tag. A deployment stamped that way would sit on the stable channel and
never be offered anything from the 2.0.0 line. `2.0.0-b` parses as
`{core:[2,0,0], pre:["b"]}` and sorts correctly below 2.0.0.

The rename is a separate work item from the feature, and it touches more than a
string:

- repo name and every URL that embeds it
- the GHCR image path (`ghcr.io/arrosam/hydrogen-llm-proxy`)
- `README.md`, `README.zh.md`, `docs/`, the hero SVG
- web UI branding, page titles, favicon
- `docker-compose.yml`, `deploy/`, `.env.example`
- the Rainyun app-store listing
- the live deployment at `llm.areel.org`

**Decided 2026-09-07: the rename is IN-TREE ONLY** (`046de47`). The product name,
the dashboard, both READMEs and the user-facing docs carry the new name; the
GitHub repo, the GHCR image path and the live deployment do not move, so no
existing pull breaks and nothing outward-facing changes. Session cookie, database
filename, language storage key and every `HYDROGEN_*` environment variable are
deliberately untouched — renaming any of them would log users out, orphan the
database, reset preferences, or break the live box's `.env`.

Two consequences accepted: the product is called Hydro AI station while its
artifacts still say `hydrogen-llm-proxy`, and the Rainyun store listing still
reads **Hydrogen**, which the READMEs now say explicitly so a reader is not sent
after a name that is not there.

Still open: whether the image path and repo ever move, and what happens to pulls
of the old path.

## Open

*Revised 2026-09-07, after stages A-C shipped. The entries below are what is
still open; what closed is recorded where it was decided.*

- **The measurement gate for building the loop is cleared.** M1 came back
  negative — the Anthropic-wire harness declares no server-side tools — but M2
  cleared positively (Codex declares one) and M3 reproduced the defect live, so
  the dispatch code was written and shipped in Stage A. The tool *type strings*
  Hydrogen declares must still match what a harness's system prompt promises, or
  the model cannot reach them; S9 settles that as one config entry per exact
  string.
- **The gate for CLIENT-FACING emission is not cleared.** Two shapes remain
  unmeasured and block Stage D: M5, what Codex accepts as a hosted-tool result,
  and M6, what Claude Code sends and accepts on the Anthropic wire — which
  subsumes the older open question about whether it validates a synthesized
  `encrypted_content`. Both are written out under
  [Stage D — PARKED](#stage-d--path-a-native-emission-parked-2026-09-07-not-built).
- Search backend (D4) — needs a key that does not exist yet.
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

### M2 — Responses-wire harness: NOT MEASURED — SUPERSEDED 2026-09-06

**This section is the state before the capture. It was cleared: see
[M2 — Codex DOES declare a server-side tool](#m2--codex-does-declare-a-server-side-tool-measured-2026-09-06)
below.** Kept because it records what the gate actually was, and what evidence
was accepted as clearing it.

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
- *which tools a **Micro Agent** grants* — that stays in the Micro Agent editor.
  A Micro Agent is not merely a consumer of a service's grants: it declares its
  own, the same way a Model Service does (confirmed 2026-09-06, superseding the
  weaker D8 wording that agents only *inherit*)

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

### Where each tool fact is edited (confirmed 2026-09-06)

| Fact | Screen | Storage |
|---|---|---|
| Tool config: backend, key, MCP servers, sandbox, round cap | **Tools** tab | new tables |
| Which providers serve which tool natively | **Providers** tab | migration `0008` |
| Which tools a Model Service grants | **Model Services** editor | zod schema, no migration |
| Which tools a Micro Agent grants (agent-wide) | **Micro Agent** editor | zod schema, no migration |
| Which tools one Micro Agent *stage* adds | that stage's row in the Micro Agent editor | zod schema, no migration |

`ServiceDef = AgentDef | ServiceSteps` (`execution/definition.ts:327`), so both
service kinds are JSON-blob definitions validated by zod. Adding a grant to each
is the same symmetric schema change, and neither needs a migration.

Grants **union**, never subtract, at every level — client-declared ∪ agent ∪
service — consistent with D2. Nothing anywhere can remove a tool the caller
asked for.

**Micro Agent grants attach at both levels (decided 2026-09-06).** An agent
declares a baseline tool set, and any stage may add to it. The tools visible to
one stage are:

```
client-declared  ∪  agent-wide grant  ∪  that stage's grant  ∪  grants of the
                                          Model Service the stage invokes
```

Union at every level, subtraction nowhere — so a tool can be scoped to a single
stage (`web_search` on `critique` but not `draft`) without any mechanism that
could take a tool away from a caller who asked for it. The cost, accepted: the
Micro Agent editor needs a tool picker on every stage row, not one on the agent.

## The Responses API tool surface (investigated 2026-09-06)

### Built-in tool types

**Corrected 2026-09-06.** An earlier draft of this section listed nine types,
taken from the tools *guide*. The API *reference* union has **eighteen**. The
difference matters: Hydrogen's `parseTools` keeps anything that is not
`type: "function"` as an opaque `Tool.raw`, so **seventeen of the eighteen** are
same-family-replay-only and vanish the moment a step resolves to an Anthropic or
Chat Completions provider.

| `type` | What it is |
|---|---|
| `function` | the ordinary client-executed tool — the only one Hydrogen models natively |
| `custom` | freeform text/grammar-constrained tool, supports async |
| `namespace` | groups function/custom tools under one name; members may set `defer_loading` |
| `tool_search` | deferred tool discovery, `execution: "server" \| "client"` |
| `programmatic_tool_calling` | model writes JavaScript that orchestrates other tools |
| `apply_patch` | create/delete/update files via unified diffs |
| `shell` | shell commands in a container or local environment, with skills |
| `local_shell` | shell commands in the local environment |
| `code_interpreter` | hosted Python, with container memory and network policy |
| `web_search` | hosted web search, domain filtering and location context |
| `web_search_2025_08_26` | dated variant |
| `web_search_preview` | preview variant, content type and context size |
| `web_search_preview_2025_03_11` | dated preview variant |
| `file_search` | vector-store retrieval with ranking and filters |
| `image_generation` | GPT image models, quality/size controls |
| `computer` | virtual computer control |
| `computer_use_preview` | preview variant across Win/Mac/Linux/browser |
| `mcp` | remote MCP server, OAuth and service connectors |

Config fields observed in the Codex binary's field tables, useful for knowing
what must survive a round trip: `allowed_domains`, `blocked_domains`,
`search_context_size`, `user_location`, `filters`, `image_settings`,
`allowed_callers`, `external_web_access`, `max_output_tokens`, `commands`,
`settings`, `ref_id`.

### Output item types Hydrogen models nowhere

From the same binary tables, the item union a Responses reply can contain:

`message`, `reasoning`, `function_call`, `function_call_output`,
`custom_tool_call`, `custom_tool_call_output`, `local_shell_call`,
`web_search_call`, `image_generation_call`, `tool_search_call`,
`tool_search_output`, `additional_tools`, `compaction`, `compaction_trigger`,
`context_compaction` — plus `program` and `program_output` for programmatic tool
calling.

Hydrogen's Responses parse handles `message`, `function_call`,
`function_call_output` and `reasoning`. Everything else is unhandled.

### Correlation fields are the sharp edge

Programmatic tool calling puts a `caller` field on a `function_call` (matching a
`program`'s `call_id`), exactly as tool search puts `namespace` on one. Hydrogen
rebuilds a `function_call` from three fields — `call_id`, `name`, `arguments` —
so **every** such correlation field is dropped on replay, not just the one
measured below. Whatever fix carries `namespace` should be shaped to carry the
others rather than special-casing a single field.

### `namespace` is a documented Responses feature, not a Codex extension

This **corrects M2 finding 4**, which called it undocumented. `namespace` +
`tool_search` + `defer_loading` is the Responses *tool search* feature
(gpt-5.4+): declare a namespace, mark members `defer_loading: true`, add
`{"type":"tool_search"}`, and the model loads member definitions only when it
needs them — appended at the end of context so the prompt cache survives.

Three item types come with it that Hydrogen models nowhere:

- `tool_search_call` — `{execution, call_id, status, arguments:{paths:[...]}}`
- `tool_search_output` — `{execution, call_id, status, tools:[...]}`
- `additional_tools` — a `role: "developer"` input item carrying `tools[]`

**Codex 0.144.5 does not use any of them.** Its three namespaces declare
`defer_loading` on zero members and it sends no `tool_search` tool, so it uses
`namespace` purely as grouping and every member is immediately callable. That is
what makes Behavior 9's flatten complete for the measured case — there is no
deferred-loading round trip to preserve.

### Measured defect: Hydrogen drops `namespace` off a replayed `function_call`

Parsing a Responses body and rendering it straight back to a Responses upstream:

```
in:  {"type":"function_call","name":"js","namespace":"mcp__node_repl","call_id":"call_stub_1",...}
out: {"type":"function_call","call_id":"call_stub_1","name":"js","arguments":"{\"code\":\"1+1\"}"}
```

The tool *declarations* survive verbatim (they ride `Tool.raw`), but
`responses.ts:313` parses a `function_call` into a `tool_use` part that has
nowhere to keep `namespace`, and `responses.ts:395` renders it back without one.
`responses.ts:507`/`568` lose it the same way on the response leg.

Per the API docs a namespaced call **requires** the field; omitting it on replay
yields `Missing namespace for function_call`. So a Codex conversation proxied to
a genuine Responses upstream breaks on the second turn the moment a namespaced
tool is used.

**This is a bug in Hydrogen today, not a gap in this feature.** It needs
`ToolUsePart` to carry `namespace`, and the parse/render pairs on both legs to
keep it. Cross-family rendering confirms the other half — every non-function
tool becomes `null`, taking the namespace's ten member tools with it:

```
Responses -> anthropic          tools: null
Responses -> openai_completion  tools: null
```

Fixing the same-family replay is smaller than Behavior 9 and independent of it;
it should land first, because it is a live break rather than a missing feature.

## Behavior 11 — the Tools tab is a library of tool definitions (2026-09-06)

Revises Behavior 10. The Tools tab does not hold config for the four tools
Hydrogen executes; it holds **definitions for any of the eighteen Responses tool
types**, `custom` included, with that type's own configuration fields —
`allowed_domains`, `search_context_size`, `user_location`, `vector_store_ids`,
`container`, `image_settings`, a `custom` tool's grammar, an `mcp` server's
label and URL, a `namespace`'s members, and so on.

A definition is a named, reusable row. Providers reference them (which ones they
serve natively) and Model Services and Micro Agents reference them (which ones
they grant). The ownership rule from Behavior 10 is unchanged: the definition
lives here, the *references* live where their owner lives.

This splits the tools into two classes, and the tab must show which is which:

- **Hydrogen-executed** — `web_search`, `image_generation`, `mcp`,
  `code_interpreter`. Hydrogen runs these and needs a credential or a sandbox.
- **Declaration-only** — the other fourteen. Hydrogen cannot execute them; it
  declares them upstream and relays what comes back. A definition still has to
  exist so a service can grant one and so the round trip is lossless.

## Behavior 12 — lossless Responses conversion (2026-09-06)

Promoted ahead of the tool-execution slices, because it fixes a live break
rather than adding a capability, and needs no credential of any kind.

1. **Responses → Responses is a passthrough and must be lossless.** Every one of
   the eighteen tool types survives; every output/input item type survives,
   including the ones Hydrogen models nowhere today (`custom_tool_call`,
   `local_shell_call`, `web_search_call`, `image_generation_call`,
   `tool_search_call`, `tool_search_output`, `additional_tools`, `program`,
   `program_output`, the `compaction` family); and every correlation field on a
   `function_call` survives — `namespace`, `caller`, and any future sibling.
   Carrying them generically, not field by field, is the requirement.

2. **Other → Responses conversion is in scope too.** An Anthropic or Chat
   Completions client served by a Responses provider must produce a valid
   Responses request, and the reply must come back in the client's own format
   without losing what that format can express.

The reverse (Responses → a narrower family) stays lossy by nature: nothing in
the Anthropic or Chat Completions wire can carry a `tool_search_call`. Behavior 9
covers the one case worth translating rather than dropping.

---

# Second pass — decided 2026-09-06 (supersedes Behaviors 1, 3 and 8)

## S1. Hydrogen implements no tools. A tool is a user-defined API call.

**This reverses Behavior 1.** Hydrogen does not run web search, does not generate
images, does not host a sandbox, does not speak MCP. A server-side tool is an
HTTP endpoint the operator configures; Hydrogen declares it upstream, receives
the model's call, dispatches to that endpoint, and feeds the result back.

Consequences, all deliberate:

- **D3 and D4 are void.** No image Model Service routing, no Tavily/SearXNG
  choice, no search credential in Hydrogen. There is nothing to pick.
- **The sandbox decision is void.** No container per call, no egress filter, no
  Docker socket — and therefore no Rainyun portability caveat.
- **Slices 4–7 collapse.** "web_search", "image_generation", "mcp" and
  "code_interpreter" stop being four build items and become four things an
  operator may point at their own endpoints.
- This revives the **user-configurable HTTP tool surface that the Oxygen plan
  listed as an explicit non-goal** ("built once, reverted"). Re-decided
  knowingly: with Oxygen gone there is no other home for an implementation, and
  the alternative is Hydrogen growing dependencies it does not want.

## S2. A tool with no configured API call is never advertised

If no endpoint is configured for a tool, Hydrogen does not declare it upstream
and does not tell the model it exists. The model is never offered a capability
that cannot be served.

This folds two questions into one gate. A tool is offered only when **both** an
endpoint exists **and** policy (S3) says Hydrogen should serve it.

## S3. Native-vs-Hydrogen is an operator preference, per tool

Not inferred. For each tool the operator chooses:

- **prefer provider** — if the resolved provider serves the tool natively, pass
  it through untouched; use the configured endpoint only where it does not.
- **override** — always strip the native tool and dispatch to the configured
  endpoint, even when the provider could have served it.

This replaces Behavior 3's automatic native-first rule with an explicit switch,
while keeping "surface the upstream error" (Behavior 4) unchanged.

## S4. Capability is declared on the provider, mapped per model

Resolves the per-provider/per-model gap. A provider declares which tools it can
serve natively; **Model Mapping selects and maps them per model, exactly as it
already does for the API format.** A provider endpoint fronting both a
tool-capable and a tool-incapable model is expressible, and the capability lives
next to the credential it belongs to.

## S5. Rename

Repo name, GHCR image path and the `areel.org` deployment all move to the new
name. **Old images are retained, not deleted**, and the old name keeps working —
the new name is added alongside rather than swapped in.

## S6. The dispatch contract is a fixed envelope Hydrogen owns

Hydrogen POSTs a shape it defines — the tool name, the model's arguments, the
call id — and expects `{ output }` or `{ error }` back. It does no templating,
no placeholder interpolation, and no response extraction.

The operator supplies an adapter that turns that envelope into whatever the real
service wants. That keeps Hydrogen free of a template language, secret
interpolation and response-path extraction — the three things that made the
reverted HTTP tool builder large — and leaves exactly one contract to document
and test. The cost, accepted: an operator who wants Tavily needs somewhere to run
a small adapter rather than pointing Hydrogen straight at `api.tavily.com`.

An `{ error }` reply is fed to the model as an errored tool result, per
Behavior 6, not surfaced to the client.

## S7. Tools are free-form. There is no hosted-tool vocabulary.

An operator names a tool whatever they like — `check_inventory`,
`query_warehouse`, `web_search` — gives it a description and a parameter schema,
and points it at an endpoint. Hydrogen declares it upstream as an ordinary
**function** tool and executes it when the model calls it.

Consequences:

- **No per-tool translation code.** Nothing in Hydrogen knows what a web search
  *is*. A new tool is configuration, never a release.
- **Works on every wire format immediately**, because a function tool is the one
  thing all three families model natively.
- **Behavior 5 loses its subject.** There is no `server_tool_use` /
  `web_search_tool_result` / `web_search_call` to synthesize, because Hydrogen no
  longer serves the hosted-tool types those blocks describe. What the client sees
  instead is settled in S8.
- A client-declared hosted `web_search` (Codex sends one unconditionally) is a
  *different thing* from an operator's tool named `web_search`. Whether they are
  allowed to collide, and which wins, is still open.

## S8. Two paths, because there are two goals (amends S7)

The stated purpose is two things at once, and they need different mechanisms:

> "the agent requires server side tools but local inference or 3rd party
> inference doesn't provide that, caused agent error" — **compatibility**
>
> "provide agent developer more space to define server side tools, so they don't
> need to rely on any specific model provider" — **freedom**

**Path A — compatibility, for the known hosted vocabulary.** The client declares
a hosted tool. If the resolved provider cannot serve it natively (S4) and an
endpoint is configured (S2), Hydrogen executes it through that endpoint and
replies **in the client's own hosted shape** — `server_tool_use` +
`web_search_tool_result` for Anthropic, `web_search_call` for Responses. An
unmodified Codex or Claude Code works with no idea anything was substituted.

This is why S7 alone was not enough: handing back a plain `function_call` named
`web_search` to a client that declared a *hosted* `web_search` reproduces the
very agent error the feature exists to remove. **Behavior 5 is restored, scoped
to Path A.**

**Path B — freedom, for everything else.** Any name outside the vocabulary is a
free-form function tool exactly as S7 describes: declared as a `function`,
executed by Hydrogen, no per-tool code, no release needed to add one.

Hydrogen still **implements** none of it (S1). The vocabulary buys recognition
and correct re-emission, not implementation.

### The vocabulary, as documented

| Family | Server-executed tool types |
|---|---|
| Anthropic | `web_search_20250305`, `web_search_20260209`, `web_fetch_20250910`, `web_fetch_20260209`, `code_execution_*`, `tool_search` |
| Responses | `web_search` (+ dated and preview variants), `file_search`, `code_interpreter`, `image_generation`, `computer` / `computer_use_preview`, `mcp`, `tool_search`, `programmatic_tool_calling`, `shell` / `local_shell`, `apply_patch` |

Anthropic's `bash_*`, `text_editor_*` and `computer_*` are **client** tools — the
client executes them, so they are out of scope entirely.

### Still open, following from S8

- One logical tool has several type strings across families and versions
  (`web_search_20250305` / `web_search_20260209` / `web_search`). How an operator
  configures that once is undecided.
- What a client sees for a **Path B** tool. Path A is settled (native shape);
  Path B is not.
- What happens when an operator names a free-form tool `web_search`.

## S9. One config entry per exact tool type string

No alias table, no canonical identity. An operator configures
`web_search_20250305` and `web_search_20260209` and `web_search` as separate
entries, each with its own endpoint. Explicit, inspectable, and version-specific
behaviour is expressible — the `_20260209` Anthropic variants carry built-in
dynamic filtering the older ones do not, so treating them as one tool would be a
lie.

Two costs, accepted:

- The same endpoint is pasted once per type string an operator wants to serve.
- **A client declaring a type string nobody configured is served by nobody.**
  Hydrogen has no entry, so it cannot execute the tool; if the provider cannot
  serve it either, the tool is lost and the agent hits the exact error this
  feature exists to prevent. A new provider tool version therefore needs an
  operator to add an entry, not just a Hydrogen release.

What Hydrogen should *do* in that case — drop it silently as today, or refuse
the request loudly — is decided in S10.

## S10. An unservable tool is dropped and logged, never fatal

When neither the resolved provider nor any configured entry can serve a declared
tool, Hydrogen strips it and proceeds. The request log records which tools were
dropped and why.

This is a deliberate exception to "surface the error" (Behavior 4), and the
reason is measured: **Codex declares `web_search` on every single request**
(M2), whether or not the turn needs it. Refusing an unservable tool would take
the entire service down for a capability most turns never use. Dropping keeps
the turn working when the model can answer without it.

The log is what stops this being the silent-degradation failure the feature
exists to fix — the loss becomes visible to the operator, just not fatal to the
caller.

## S11. A Path B tool is shown as a server-side tool where the format allows

Anthropic clients see real `server_tool_use` + `tool_result` blocks for a
free-form tool. That block type exists so a client knows the server already ran
it and must not execute it itself, and it carries a `name`, so an arbitrary name
fits without inventing anything.

Responses and Chat Completions clients see nothing but the final answer: neither
format can express "the server executed this function tool" for a name outside
its hosted vocabulary (S8), and fabricating an item type the real API would never
emit is how a strict client gets broken.

Two documented fidelity tiers, same rule as Behavior 5 — represent it natively
where the format has a place for it, stay quiet where it does not.

## S12. Hydrogen presents itself as a provider that natively has these tools

The governing principle for the loop, and it settles the fallback question
without a special rule: **from the model's side, the tools are the provider's
own.** A step change is therefore an ordinary model switch mid-conversation, not
a restart.

What follows:

- **Tool calls and their results carry forward across steps.** Step 2 continues
  the conversation that step 1 was having, tool history included. It does not
  replay the client's original request.
- **Hydrogen never re-dispatches a tool it has already run.** This matters
  beyond cost: an operator's endpoint may be a write, and a fallback must not
  fire `check_inventory` twice from one client request.
- The conversation handed to step 2 contains work authored by a different model
  on possibly a different family. That is exactly what a mid-run model switch
  is, and it is accepted as such.
- Cross-family is safe by construction: an executed tool lives in the IR as
  canonical `tool_use` / `tool_result` parts, which every family renders.

**This does not change how partial text behaves.** A mid-stream failure still
discards the partial answer and re-attempts, as today — the client never sees a
half answer. The asymmetry is deliberate: partial text is cheap to regenerate
and meaningless on its own, whereas a completed tool result was paid for and may
have already changed something in the world.

## S13. Tool events stream live; text stays buffered (amends D9)

A `server_tool_use` block is emitted the moment the call is made, and its result
the moment the endpoint returns, so a streaming client shows activity for the
whole dispatch instead of sitting in silence. Ordinary text keeps its current
buffered behaviour.

The split follows S12's own asymmetry: a dispatched tool is **committed** — it
has been paid for and may have changed something — so announcing it early costs
nothing that was not already spent. Text is **not** committed, and keeping it
buffered preserves the retry safety Hydrogen has today, where a mid-stream
failure re-attempts cleanly and no half answer ever reaches the client.

It also removes the idle-timeout risk a fully buffered loop would create on a
long tool chain.

## Behavior 10 restated for the new design

Behavior 10's contents were written when Hydrogen implemented the tools. Under
S1 they are void. The **Tools** tab now owns one thing: the list of tool entries.

Each entry: the exact tool type string or free-form name (S9), a description and
parameter schema, the endpoint URL, its credential, and the
prefer-provider-or-override switch (S3).

Unchanged from Behavior 10: writes are admin-only, reads are not (the Model
Services and Micro Agent editors must list tools to render their grant pickers),
provider capability still lives on **Providers** and is mapped per model in
**Model Mapping** (S4), and grants still live in the service and agent editors.

## S14. Usage accounting follows what a real provider does

Researched rather than invented, from Anthropic's web search tool docs:

- The whole loop is **one request** — "this process can repeat multiple times
  throughout a single request".
- `usage.input_tokens` / `output_tokens` are **aggregate over every internal
  iteration**, not just the final turn.
- Tool invocations are counted **separately** from tokens:
  `usage.server_tool_use.web_search_requests`, billed at $10/1,000 on top of
  token cost. Failed searches are not billed.
- The cap is **per tool** (`max_uses`), not global, and exceeding it yields an
  errored result block (`max_uses_exceeded`) rather than a failed request.

Hydrogen therefore:

- counts **every round** against the client key's token quota, reported as one
  request's aggregate usage (confirms D7, and answers the quota question);
- adds a **dispatch counter** alongside tokens, so an operator can see and bill
  tool invocations separately from tokens;
- replaces D5's global 16-round cap with a **per-tool `max_uses`**, and on
  exhaustion feeds the model an errored tool result instead of failing the turn.

Quota stays checked once per request, as today. A single loop can therefore
overshoot a nearly-exhausted key, bounded by `max_uses`; the key is correctly
exhausted afterwards.

### Three earlier decisions independently confirmed

- **Behavior 6** (a failing tool is reported to the model, not the client):
  Anthropic returns HTTP 200 with a `web_search_tool_result_error` inside the
  result block. Same shape, same reasoning.
- **S13** (stream tool events live): Anthropic's own streaming example emits the
  `server_tool_use` block, then shows an explicit "pause while search executes",
  then the result block.
- **S10** (drop and log rather than fail): Anthropic likewise degrades inside the
  turn rather than failing the request.

### New problem this surfaced: `encrypted_content`

A `web_search_tool_result` carries `encrypted_content` per result, and the caller
**must send it back unchanged** on later turns — "if `encrypted_content` is
missing or modified, the request fails with a 400 validation error". Citations
carry an `encrypted_index` with the same rule.

Hydrogen synthesizing this block (Path A) must therefore put *something* there.
That is fine while Hydrogen keeps serving the tool, since it is also the one
reading the value back. It breaks when a later turn falls back to a **real**
Anthropic provider with native web search: that provider is handed a value it
never issued and rejects the request. See S15.

## S15. Hydrogen does not launder its own tool results. The 400 surfaces.

When a conversation carrying Hydrogen-issued `encrypted_content` reaches a
provider that validates it, that provider returns a 400 and **the 400 goes to
the client**. Hydrogen does not rewrite its blocks into plain text, does not skip
the offending fallback step, and does not pre-emptively force override.

This is the same rule already settled twice for Anthropic `thinking` (`62ab091`)
and `reasoning_effort` clamping: the proxy does not quietly reshape a request so
it succeeds differently from what was asked. A validation error naming the
problem is more useful than a 200 that silently degraded the conversation.

The remedy is configuration, where it belongs. An operator who does not want this
either keeps native-capable providers out of a service whose tools Hydrogen
serves, or sets that tool to override (S3) so every value in the conversation is
Hydrogen's own and consistently accepted.

Consequence, accepted: a Model Service that mixes a Hydrogen-served tool with a
native-capable fallback will break on that fallback path, visibly.

## S16. Both entries may exist. The declaration decides which one applies.

A free-form entry named `web_search` and a vocabulary entry `web_search` can be
configured at the same time. They do not collide, because the **wire shape**
distinguishes them:

| Declared as | Resolves to |
|---|---|
| `{"type": "web_search"}` | the Path A vocabulary entry — hosted semantics, native result blocks |
| `{"type": "function", "name": "web_search"}` | the Path B free-form entry — an ordinary function tool |

The kind is a property of the config entry the operator created, and the client's
declaration selects between them. No reserved-word list, no name rejected at
config time, and neither path silently acquires the other's semantics.

### The intervention rule, stated once

This is the whole of Hydrogen's tool policy, and everything above is a special
case of it. **Hydrogen touches a tool in exactly two situations:**

1. **Gap-fill** — the resolved provider does not serve a declared tool, and a
   config entry exists for it. Hydrogen executes it.
2. **Override** — the operator explicitly set that tool to override (S3), so
   Hydrogen executes it even where the provider could have.

In every other case the tool passes through untouched and the provider owns it.
A tool that is neither servable by the provider nor configured is dropped and
logged (S10).

## S17. A client key scopes tools as well as services

A key carries a tool allow/deny list alongside `scope_services_json`. An
expensive tool can be withheld from one key that otherwise shares a Model Service
with trusted callers, without duplicating the service.

Cost, accepted: a tool can now be blocked in two places — the service grant and
the key scope — so "why isn't this tool offered?" has two answers to check. The
request log records which of the two dropped it (S10).

## Remaining defaults — override any in one line

| # | Default |
|---|---|
| E1 | **Endpoint credential**: an optional set of static headers per tool entry, encrypted under the master key like provider keys, and included in the sealed export. No OAuth, no refresh. |
| E2 | **Endpoint timeout**: per entry, default 30s. On expiry the model gets an errored tool result (Behavior 6), not a failed turn. |
| E3 | **Egress proxy**: a tool entry may be attached to a configured proxy, the same way a provider can. Default is a direct connection. |
| E4 | **SSRF**: tool endpoint URLs go through the existing `ssrf.ts` guard, since the URL is operator-supplied but the request is caller-triggered. |
| E5 | **Micro Agents**: each stage runs its own tool loop, with the tools visible to that stage (client ∪ agent ∪ stage ∪ invoked service). |
| E6 | **Retries**: a failing endpoint is not retried. One dispatch, then the model is told. Retrying a possibly-non-idempotent operator endpoint is not Hydrogen's call to make. |

---

# Slice 0 — done 2026-09-06 (`d0d6782`)

Same-family Responses passthrough is lossless. What changed:

- **`ToolUsePart.extra`** — family-tagged, holding every field of a
  `function_call` the canonical part does not model. Collected by *subtracting*
  the modelled keys rather than allowlisting, so `namespace` and `caller` are
  carried today and a field invented next year is carried without an edit.
- **Unmodelled items round-trip whole** on both legs, as opaque parts. The
  render half already existed with no producer; this added the producer,
  mirroring `completion.ts`'s handling of `input_audio`.
- **The stream carries both**, so a streaming client is not the one path that
  still loses the field.

Verified: 9 new tests in `test/responsesPassthrough.test.ts` covering the
measured Codex turn-2 shape, an invented field, both legs, all 18 tool types,
the streaming path, and — the other half of the contract — that none of it leaks
onto the Anthropic or Chat Completions wire. Full suite 892/892.

**Done-when 3 remains unverified**: proving a real Codex conversation survives
turn 2 needs a genuine gpt-5.4+ Responses endpoint, which no configured provider
is. Done-when 1 and 2 are covered by the tests above.

# Slice 1 — done 2026-09-06 (`823e744`)

Namespaced tools now reach providers that have no namespaces.

- **Members are parsed as tools too**, carrying `Tool.namespace`, alongside the
  namespace's own `raw` entry. The raw one replays verbatim to a Responses
  upstream; members are skipped there so nothing is declared twice.
- **Declared to a foreign provider as `namespace__member`.** Qualification is
  required rather than tidy: Codex ships `mcp__cua_repl/js` *and*
  `mcp__node_repl/js`, plus two `js_reset`, so a bare-name flatten silently
  merges two different tools.
- **Calls re-flatten on every request** (a client replays them each turn) and
  **split back before the client sees them** — buffered via
  `Response.withNamespaces`, streaming via the `withNamespaces` transform,
  mirroring the two shapes `withThinkingFormat` already has.
- **The split matches the declared namespace list**, not the last separator: a
  plain function tool may contain `__` in its own name and guessing would rename
  it. Being derived from the client's own tools array each turn, it needs no
  server-side state and survives retries and fallback steps.

Verified: 13 new tests in `test/namespaceFlatten.test.ts` — declarations across
both foreign families, the real collision staying distinct, descriptions and
schemas carried, same-family replay not duplicating members, prior-turn calls
re-flattened, both split paths, and `splitToolName`'s refusal to split on an
undeclared prefix. Full suite 905/905.

Worth recording: the slice 0 suite **caught this change** — it asserted the
string `mcp__node_repl` never reaches the Anthropic wire, which slice 1
deliberately makes false. Tightened to the invariant that actually matters: the
`namespace` *field* never leaves the Responses wire, while the namespace inside
a flattened *name* is the mechanism.

---

# Stage A — the dispatch loop, done 2026-09-07 (`13d55f1`, fixes `1658762`)

Ask, dispatch what the model called, ask again. The loop wraps the step chain
rather than living inside it, which is what makes S12 true: each round runs the
whole chain against the conversation so far, so a step that dies mid-loop hands
the accumulated history to the fallback instead of restarting, and a result
already in the conversation is never re-derived.

Resolution is per step, against that provider's capabilities. Usage aggregates
over rounds and reports `toolDispatches` beside the tokens. A Micro Agent shares
one budget across its stages (E5), and each stage's grants are the agent's plus
its own.

Reviewed at max effort; seven findings fixed, two deliberately not. Eight of the
new tests fail against the pre-fix code.

## Open, from the Stage A review

### A-1. A mixed turn can hand back a granted tool the client cannot answer

`shouldContinue` returns the turn untouched when the model calls one of ours
alongside one of the client's. That is right for a tool the CLIENT declared —
Anthropic does the same, and the client can answer both. It is wrong for a
**granted** tool, which the client has never seen: it receives a `tool_use` with
no handler and no schema, and the turn dies with the tool unrun.

Every alternative depends on something unmeasured: whether a real client, handed
an assistant turn containing a `tool_result` it did not produce, replays it
intact on the next request. Dispatching ours and returning the client's call
requires exactly that. **Not guessed — this needs a decision, and the capture
that would inform it is the same class as the Stage D ones.**

### A-2. `toolDispatches` is counted but goes nowhere

S14 says the dispatch counter sits beside the token counts so an operator can
bill on it. The loop computes it correctly, but nothing persists it: no renderer
emits it, `requestLogger` copies only the three token subsets, and `request_logs`
has no column. Half of S14 is therefore unimplemented.

Deliberately deferred rather than half-built: persisting it needs a migration and
a Logs column, which belong with the admin API and console work, not wedged into
the execution layer.

### A-3. S13's live tool events are still buffered

The loop buffers and replays. Streaming the call and its result live needs a
client-visible shape for a server-executed tool, which is Path A emission and is
unmeasured. Noted in `modelService.stream` rather than guessed.

---

# Stage B — the admin API, done 2026-09-07 (`9777212`, fixes `2ba003e`)

`toolRoutes` under the session guard: admin-only writes, because a tool row
carries a credential and decides where this server's traffic goes; reads open to
a manager, because the grant pickers need the list. Provider `toolCapabilities`
on create *and* update, per-model narrowing on the mapping, `grantTools`
validated against the configured free-form tools at save time, and a tool scope
on every API key.

Reviewed at max effort. Six findings fixed: tools were missing from the backup
package entirely (a restore brought back services granting tools that no longer
existed), `ProviderUpdate` silently dropped `toolCapabilities`, a rename walked
around the delete guard, that guard ignored `kind` and so refused to delete an
unused hosted tool, deleting a tool left keys scoped to a dangling id, and the
endpoint URL — which can itself be the credential — was visible to a manager.
One reported finding was refuted: `[]` is truthy in JavaScript, so a mapping's
empty capability list never collapsed into "inherit".

# Stage C — the web console, done 2026-09-07 (`752d207`, fixes `21dadb6`)

Every knob the feature has now has a control: the Tools tab, a provider
capability declaration, per-model narrowing, grant pickers agent-wide and per
stage, and the key tool scope. Every string in en and zh.

Two of the controls shipped inverted and were caught in review. A key whose
"Any tool" box was unticked with nothing selected stored `scopeTools: []`, which
`scopeAllows` reads as **every** tool — so the save now refuses that state and
says Hydrogen cannot record "may dispatch nothing", rather than rewriting the
request into one of the two states that do exist. And the provider editor
collapsed `[]` into `null`, so the console could not declare "serves no hosted
tool types" — the one declaration a `prefer_provider` tool needs to fire — and
destroyed an API-set `[]` on any unrelated edit.

A third finding was a real privilege gap rather than a UI bug: `POST` and
`PATCH /services` carry no admin check, so a manager could attach a
credential-bearing tool to a service — the same capability `toolRoutes`
refuses to even show them. A grant *change* is now admin-only; everything else
about the service stays a manager's to edit.

Twelve findings fixed in all, one refuted, two deferred as refactors of code the
stage never touched. 997 tests / 61 files.

---

# Stage D — Path A native emission. PARKED 2026-09-07, not built.

Hydrogen dispatches a hosted tool and feeds the result back **upstream**
correctly today. What is not built is the client-facing half: emitting that
result to the caller in each wire format's own native shape, so a client that
declared `{"type":"web_search"}` sees the blocks it expects rather than a
function-call round trip it never asked for.

This is parked, not deferred by preference. Two shapes decide the whole design
and neither has been measured, and S8's rule — measure rather than guess what an
external client sends — makes guessing them out of bounds.

## The gap, precisely

### M5 — what Codex accepts as a hosted-tool RESULT. NOT MEASURED.

M4 measured the return leg for a **function** tool: `function_call` out,
`function_call_output` back, correlated by `call_id` alone. That is Path B, and
it is settled.

Path A is a different item type. A client that declared `{"type":"web_search"}`
expects the Responses API's own hosted-search items, and nothing in this repo
has observed Codex consume one. Unknown, and each one changes the emitter:

- which item `type` string carries the result, and whether the call and the
  result are separate items or one item that gains fields as it completes;
- whether the sources/citations are structured items or text annotations on the
  message, and what identifies each one;
- whether Codex requires anything opaque round-tripped on later turns, as the
  Anthropic wire requires for `encrypted_content`;
- what a **failed** hosted call looks like, which Behavior 5 needs in order to
  report "the search failed" without ending the turn.

### M6 — what Claude Code sends and accepts on the Anthropic wire. NOT MEASURED.

M1 measured a different harness and came back negative: it declared no
server-side tools at all. It therefore says nothing about Claude Code, which is
the client "Done when" item 1 is written against.

`web_search_tool_result` carries `encrypted_content` per result and the caller
**must** send it back unchanged or the request 400s (S15). Synthesizing that
field is the single riskiest thing in this stage: get it wrong and the failure
is not a wrong answer but a hard 400 on the *next* turn, after the user has
already seen a good one.

## Why guessing is worse than parking

A wrong result shape does not fail loudly. Codex ignores an item type it does
not recognise, so the model answers without the search it asked for and nobody
sees an error — the exact silent degradation S15 exists to prevent. On the
Anthropic side a wrong `encrypted_content` fails on a later turn, far from the
change that caused it. Both are the failure mode this document has refused
everywhere else.

## What is blocked behind this

- **A-3** — S13's live tool events. The loop still buffers and replays, because
  streaming a call and its result needs the client-visible shape defined here.
- **A-1** — a granted tool called alongside a client tool in one parallel block.
  Every candidate answer depends on whether a real client replays an assistant
  turn containing a `tool_result` it did not produce. Same class of capture.
- **"Done when" items 1, 2 and 4**, which are all written from the client's side
  of the wire.

## The capture that clears it

The harness the earlier measurements used, `scratchpad/stub-responses.cjs`, was
never tracked in git and no longer exists on disk. Rebuilding it is the first
step, not a prerequisite the operator supplies.

1. Rebuild the stub Responses upstream: it asserts a hosted `web_search` call,
   then serves a candidate result shape.
2. Point Codex at it with `-c model_providers` overrides and run one turn whose
   prompt forces a search.
3. Record what Codex renders, and what it replays in the next turn's `input`.
4. Repeat for Claude Code against a stub Anthropic upstream for M6.

Steps 2 and 4 need a signed-in client on the operator's machine and a real model
choosing to search; they cannot be run from here.

## Done when — status at the park

1. Claude Code → Hydrogen → DeepSeek-only, citations render — **blocked on M6.**
2. Anthropic ticked capable, native path taken — **reachable now**: capability
   declaration, narrowing and the "pass through untouched" path are all built
   and configurable. Untested end to end against a live Anthropic key.
3. A Responses client gets an image through an image Model Service — **unaffected
   by this stage**, unchanged since slice 0.
4. `chat/completions` client, links in the answer text — **blocked on M5**, since
   what the client sees is Path A emission.
5. Search backend 500 → the answer completes saying the search failed —
   **partly built.** `dispatchTool` never throws and the failure reaches the
   model, so the turn completes; how the failure is *shown* to the client is
   Path A emission.
6. Client-supplied MCP `server_url` → 400 naming the reason — **not built, and
   worth re-deciding.** Today an `{"type":"mcp","server_url":...}` declaration is
   passed through to the upstream untouched, which slice 0 pins with a test
   (`responsesPassthrough.test.ts`, "replays all 18 types unchanged"). That is
   arguably the better behaviour under the never-rewrite rule: if the upstream
   can serve it, refusing on the client's behalf is Hydrogen inventing a limit.
   A 400 would be right only if Hydrogen is claiming to *be* the provider. The
   item is left unbuilt rather than quietly dropped, because it now reads as a
   decision to revisit rather than a task to finish.
