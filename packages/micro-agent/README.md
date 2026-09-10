# @areelai/micro-agent

Micro Agents: forward-only stage pipelines in which each stage runs a saved Model Service (or an inline step chain) with its own context assembly and parameter overrides, routers branch on conditions, and optional OCR and ASR pre-passes turn images and audio into text before the first stage. A Micro Agent extends `ModelService` from `@areelai/model-services`, so it is callable, nestable and storable wherever a Model Service is, and it is stored as a `model_services` row with `kind: "micro_agent"`. The package deliberately owns no transport, catalogue or validator of its own: it registers itself as a service kind and reuses everything model-services already wires, and its only table is the OCR image-description cache.

## Install

```
npm install @areelai/micro-agent @areelai/model-services @areelai/supplier-management
```

Runtime dependencies: `@areelai/common`, `@areelai/wire-format`, `@areelai/supplier-management`, `@areelai/model-services`, `drizzle-orm`, `better-sqlite3`, `zod`. Node 20 or newer, ESM only.

## Ten-line adoption example

`validator`, `stores`, `factory` and `request` are wired exactly as in the `@areelai/model-services` README, and a Model Service named `"chat"` has been saved.

```ts
import { openMicroAgentStores, registerMicroAgentKind } from "@areelai/micro-agent";

const agentStores = openMicroAgentStores({ file: "./data/hydro.db" }); // same file, this package's own table
registerMicroAgentKind({ ocrCache: agentStores.ocrCache(() => 50 * 1024 * 1024) }); // once, at startup

const { def, summary } = validator.validate({
  kind: "micro_agent",
  stages: [
    { name: "draft", service: "chat" }, // no `input` = the original conversation passes through
    { name: "polish", service: "chat", input: [{ kind: "stage_output", stage: "draft", role: "user" }], overrides: { system: "Tighten the draft. Return only the revised text." } },
  ],
});
const row = stores.services.create({ name: "write-and-polish", definition: def });
console.log(summary, row.kind); // "agent: draft -> polish" "micro_agent"

const resolved = factory.resolve("write-and-polish");
if (!resolved.ok) throw new Error(resolved.message);
const inv = await resolved.executor.invoke(request); // the same Invocation shape a Model Service returns
console.log(inv.result.ok ? inv.result.value.response.text() : inv.result.message, inv.attempts);
```

Without the `registerMicroAgentKind()` call the same `validator.validate(...)` throws `UnknownServiceKindError` (`unknown service kind "micro_agent"`), which is the intended behaviour for a deployment that did not install this package.

## Definitions

`AgentSchema` (`parseAgent`, `AgentDef`) is the persisted shape: `kind` (`"micro_agent"`; the legacy alias `"agent"` is accepted on input, see `MICRO_AGENT_ALIASES`), `stages`, optional `output` (which stage's answer is returned; default the last), optional `ocr` and `asr` pre-passes, `timeoutMs`, `reliableStreaming`, `thinkingFormat` and `hostedTools`.

- A stage (`AgentStageSchema`) names a saved `service` or carries inline `steps`; with neither it is a router that makes no model call. `input` is a list of context blocks: `original_conversation`, `text_conversation`, `last_user`, `last_user_text`, `last_user_images`, `stage_output` (an earlier stage's answer as a user or assistant turn), `message` and `tool_turn`. `tools: "none"` describes the client's tools in the prompt instead of registering them. `overrides` accepts every field a Model Service step does, plus `system`; `stageOverrides(stage)` folds the legacy flat `system`, `temperature`, `maxTokens` and `thinking` into it.
- `transitions` are forward-only edges: `{ when: condition, goto: laterStageName | "end", output? }` with conditions `always`, `input_has_image`, `input_contains`, `input_matches`, `output_contains` and `output_matches` (regexes capped at 200 characters). No match falls through to the next stage.
- `validateAgent(def, ctx)` runs at save time through `ServiceValidator`: duplicate or forward stage references, an unknown `output`, a stage that references a media-category service, unmapped inline steps, and pre-pass references of the wrong category are all rejected with a message naming the stage.
- `ocr: { service | steps, prompt?, overrides?, timeoutMs? }` transcribes every image in the request with a chat or OCR-category Model Service before the stages run; `asr: { service | steps, timeoutMs? }` does the same for `input_audio` attachments with an `stt`-category service (`transcribeAudio`). Both replace the attachment with text so text-only stage models can read it.

`MicroAgent` runs every stage buffered (routing needs whole outputs) while inheriting the client's wire mode for each upstream call, then answers a streaming client with a paced fabricated stream. Nested agents are allowed up to eight levels deep, with a cycle guard on the call stack.

## The OCR cache

`registerMicroAgentKind({ ocrCache })` takes an `OcrCacheStore` (`enabled()`, `lookup(hashes)`, `touch(hashes)`, `store(entries)`) or nothing. With it, each image is content-addressed by `imageHash(part)` (SHA-256 of the decoded bytes and media type, or of the URL) and a picture already transcribed is never sent to the OCR model again. `openMicroAgentStores({ file })` opens or migrates the file and returns `imageCache` (an `ImageCacheRepo`: `lookup`, `touch`, `put`, `enforceBudget`, `stats`, `clear`) and `ocrCache(maxBytes)`, which wraps it in an `ImageDescriptionCache` bound to a live byte-budget getter; a budget of `0` switches the cache off and empties it, and eviction is least-recently-used. Every cache operation is fail-safe: a database fault degrades to "transcribe it again", never to a failed request. `createMicroAgentStores(sqlite)` does the same over a shared connection (there is no master key; nothing here is secret).

## What it stores

One table: `image_cache` (`hash`, `description`, `size_bytes`, `last_used_at`; `MICRO_AGENT_TABLES`). The migrations are embedded in `microAgentMigrations` and recorded in this package's own bookkeeping table `__migrations_micro_agent`, so the table can share one SQLite file with the other `@areelai` packages. Agent definitions themselves live in `@areelai/model-services`' `model_services` table; this package adds no columns there.

## Swapping the store

The swap point is the `OcrCacheStore` interface passed to `registerMicroAgentKind`: any object with `enabled`, `lookup`, `touch` and `store` replaces the SQLite cache, and omitting it runs every image through the model. `ImageCacheRepo` and `ImageDescriptionCache` are the default implementation, not a requirement.

## License

MIT
