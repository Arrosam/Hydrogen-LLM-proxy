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
