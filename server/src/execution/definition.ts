import { THINKING_FORMATS } from "../core/ir/thinkingFormat";
import { z } from "zod";
import { mergeOverrides, type GenerationParams, type OverridableParam, type RequestOverrides } from "../core/ir/params";
import type { ThinkingDelimiters, ThinkingFormat } from "../core/ir/thinkingFormat";
import { BYTES_PER_GIB } from "../config/limits";
import { HTTP_STATUS, STATUS_CLIENT_CLOSED, STATUS_UPSTREAM_FAILURE } from "../util/httpStatus";

/**
 * Persisted shape of a Model Service / Micro Agent. This is the config a
 * ModelService step or MicroAgent stage carries. The key change from the old
 * design: every step/stage may override a RICH set of request parameters
 * (`overrides`), not just thinking/temperature -- anything a GenerationParams
 * carries, plus the system prompt.
 */

// --- triggers / retry ------------------------------------------------------

/** The range of HTTP status codes a trigger may name. */
const MIN_TRIGGER_STATUS = 100;
const MAX_TRIGGER_STATUS = 599;

/**
 * A trigger is an HTTP status code, or a symbolic class:
 *   "timeout" - the upstream call timed out
 *   "network" - the connection failed or died before a complete response
 *               arrived, so there is no HTTP status to match on. Distinct from
 *               "error": a bad model/provider mapping or a rejected upstream URL
 *               is a configuration fault that retrying can only repeat.
 *   "error"   - any failure (network error or any non-2xx status)
 *   "exhausted" (advanceOn only) - advance once this step's retries are used up
 */
export const TriggerSchema = z.union([
  z.number().int().min(MIN_TRIGGER_STATUS).max(MAX_TRIGGER_STATUS),
  z.literal("timeout"),
  z.literal("network"),
  z.literal("error"),
]);

export const AdvanceTriggerSchema = z.union([TriggerSchema, z.literal("exhausted")]);

/**
 * Retry defaults, in one place. A step may omit `retry` entirely, in which case
 * zod never runs RetrySchema's defaults and `runSteps` falls back to these — so
 * they must be the same values or the two disagree.
 */
export const DEFAULT_RETRY_ON: z.infer<typeof TriggerSchema>[] = [
  HTTP_STATUS.TOO_MANY_REQUESTS, STATUS_CLIENT_CLOSED, STATUS_UPSTREAM_FAILURE, HTTP_STATUS.SERVICE_UNAVAILABLE, "timeout", "network",
];
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_IDEMPOTENCY = "safe_write" as const;

/** Whole-run timeout of a Model Service or Micro Agent that sets none. */
export const DEFAULT_SERVICE_TIMEOUT_MS = 60_000;

/** The `kind` discriminator of a service definition (also the model_services.kind column). */
export const SERVICE_KIND = { MODEL_SERVICE: "model_service", MICRO_AGENT: "micro_agent" } as const;
/** The dashboard's older spelling of the Micro Agent kind, still accepted on input. */
export const LEGACY_AGENT_KIND = "agent";

/** Ceiling on any configured retry delay: a fixed interval or either backoff bound (10 minutes). */
const MAX_RETRY_DELAY_MS = 600_000;
const DEFAULT_BACKOFF_INITIAL_MS = 100;
const DEFAULT_BACKOFF_MAX_MS = 1_000;
const MAX_RETRY_ATTEMPTS = 100;

/** Bounds of an explicit thinking token budget. */
const MIN_THINKING_BUDGET = 1024;
const MAX_THINKING_BUDGET = 200_000;
const MAX_THINKING_DELIMITER_CHARS = 64;

/** Bounds of the generation params an override may set. */
const MAX_TEMPERATURE = 2;
const MAX_OUTPUT_TOKENS_OVERRIDE = 1_000_000;
const MIN_PENALTY = -2;
const MAX_PENALTY = 2;
const MAX_REPETITION_PENALTY = 2;
const MAX_CHOICES = 128;
const MAX_TOP_LOGPROBS = 20;

/** Bounds of a service, stage or pre-pass timeout. */
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 7_200_000;

const MAX_STAGE_NAME_CHARS = 60;

/** Hosted tool loop: model rounds one request may spend. */
const MAX_TOOL_ROUNDS = 32;
const DEFAULT_TOOL_ROUNDS = 8;
/** Hosted tool loop: the largest configurable `maxCalls`, and the most hosted calls one round may request. */
export const MAX_HOSTED_CALLS = 128;
const DEFAULT_HOSTED_CALLS = 16;
/** Model rounds shared by a hosted tool loop and every loop nested inside it. */
export const MAX_SHARED_TOOL_ROUNDS = 128;

/**
 * Exponential backoff with full jitter. When `backoff` is enabled the effective
 * delay before attempt N (1-based, N>=2) is:
 *   base = min(initialMs * 2^(N-2), maxMs)
 *   delay = random(0, base)          // full jitter
 * When omitted, a fixed `intervalMs` is used (legacy behavior).
 *
 * Defaults satisfy the 499-retry policy: initial 100ms, cap 1s, max 3 attempts.
 */
export const BackoffSchema = z.object({
  /** Initial delay (attempt 2's upper bound before jitter). Default 100ms. */
  initialMs: z.number().int().min(1).max(MAX_RETRY_DELAY_MS).default(DEFAULT_BACKOFF_INITIAL_MS),
  /** Absolute ceiling on the un-jittered delay. Default 1000ms. */
  maxMs: z.number().int().min(1).max(MAX_RETRY_DELAY_MS).default(DEFAULT_BACKOFF_MAX_MS),
});

export const RetrySchema = z.object({
  /**
   * Failure triggers that retry within this step. The defaults cover every way
   * an upstream can fail to deliver a whole answer without it being the
   * caller's fault: 429 (rate limit), 499 (client closed), 502 (the proxy's own
   * code for an upstream stream that ended early or returned an unusable body),
   * 503 (unavailable), a timeout, and a connection that died mid-response.
   */
  on: z.array(TriggerSchema).default(DEFAULT_RETRY_ON),
  maxAttempts: z.number().int().min(1).max(MAX_RETRY_ATTEMPTS).default(DEFAULT_MAX_ATTEMPTS),
  /** Fixed delay between retries (legacy; ignored when `backoff` is set). */
  intervalMs: z.number().int().min(0).max(MAX_RETRY_DELAY_MS).default(0),
  /**
   * Exponential backoff with full jitter. When present, overrides `intervalMs`
   * and the engine computes a jittered delay per attempt.
   */
  backoff: BackoffSchema.optional(),
  /**
   * Idempotency guard. "read" (default for GET-style) always retries 499.
   * "safe_write" retries 499 (the upstream never received/processed the body).
   * "unsafe" NEVER retries 499 — a pre-check must confirm safety first.
   */
  idempotency: z.enum(["read", "safe_write", "unsafe"]).default(DEFAULT_IDEMPOTENCY),
});

// --- rich overridable params ----------------------------------------------

export const ThinkingLevelSchema = z.union([
  z.literal("disabled"),
  z.literal("auto"),
  z.literal("enabled"),
  z.literal("minimal"),
  z.literal("low"),
  z.literal("medium"),
  z.literal("high"),
  z.literal("xhigh"),
  z.literal("max"),
  z.object({ budget: z.number().int().min(MIN_THINKING_BUDGET).max(MAX_THINKING_BUDGET) }),
]);

/**
 * How the service presents the model's thinking to ITS client -- see
 * core/ir/thinkingFormat.ts for what each value means and why `original` (the
 * default) is a strict no-op.
 *
 * This is a service-level setting rather than a per-step override on purpose:
 * it describes the answer the caller receives, and a fallback chain that
 * answered differently depending on which step happened to win would be a
 * worse contract than any of the individual formats.
 */
export const ThinkingFormatSchema = z.enum(THINKING_FORMATS);

/**
 * Operator-declared thinking boundaries, for a model whose trace is not
 * tag-shaped at all (harmony channels, corner-bracket markers). The scanner
 * matches these literally instead of guessing from shape, which is the only
 * way to cover such a model -- vLLM ships the same escape hatch as
 * `--reasoning-config`, Open WebUI as a configurable reasoning tag pair.
 */
export const ThinkingDelimitersSchema = z.object({
  open: z.string().min(1).max(MAX_THINKING_DELIMITER_CHARS),
  close: z.string().min(1).max(MAX_THINKING_DELIMITER_CHARS),
});

export const ResponseFormatSchema = z.union([
  z.object({ type: z.literal("text") }),
  z.object({ type: z.literal("json_object") }),
  z.object({
    type: z.literal("json_schema"),
    name: z.string().optional(),
    schema: z.record(z.string(), z.unknown()),
    strict: z.boolean().optional(),
  }),
]);

/**
 * The patch a step/stage applies to the outgoing request. Every field is a
 * generation param the request families understand (unsupported ones are
 * dropped per family, or carried through `extra`), plus a `system` override.
 */
export const OverridesSchema = z
  .object({
    temperature: z.number().min(0).max(MAX_TEMPERATURE),
    topP: z.number().min(0).max(1),
    topK: z.number().int().min(0),
    minP: z.number().min(0).max(1),
    maxTokens: z.number().int().min(1).max(MAX_OUTPUT_TOKENS_OVERRIDE),
    stop: z.array(z.string()),
    frequencyPenalty: z.number().min(MIN_PENALTY).max(MAX_PENALTY),
    presencePenalty: z.number().min(MIN_PENALTY).max(MAX_PENALTY),
    repetitionPenalty: z.number().min(0).max(MAX_REPETITION_PENALTY),
    seed: z.number().int(),
    n: z.number().int().min(1).max(MAX_CHOICES),
    logprobs: z.boolean(),
    topLogprobs: z.number().int().min(0).max(MAX_TOP_LOGPROBS),
    logitBias: z.record(z.string(), z.number()),
    responseFormat: ResponseFormatSchema,
    parallelToolCalls: z.boolean(),
    serviceTier: z.string(),
    user: z.string(),
    verbosity: z.enum(["low", "medium", "high"]),
    thinking: ThinkingLevelSchema,
    /** Provider-specific params with no canonical field, merged in verbatim. */
    extra: z.record(z.string(), z.unknown()),
    /** Replace the system prompt for this step/stage. */
    system: z.string(),
  })
  .partial()
  .passthrough();

// --- Model Service (resilience step chain) --------------------------------

export const StepSchema = z.object({
  /** Internal catalog model name. */
  model: z.string().min(1),
  /** Provider name; (model, provider) must be a mapped pair in the catalog. */
  provider: z.string().min(1),
  retry: RetrySchema.optional(),
  /** When to advance to the next step. Omit = advance on any failure. */
  advanceOn: z.array(AdvanceTriggerSchema).optional(),
  /** @deprecated Use `overrides.thinking` instead. Folded automatically for backward compat. */
  thinking: ThinkingLevelSchema.optional(),
  /** Rich per-step parameter overrides. */
  overrides: OverridesSchema.optional(),
});

/**
 * What kind of API a Model Service serves. "chat" (the default) is the full
 * translated chat pipeline. "ocr" is a chat-pipeline category too: OCR models
 * (DeepSeek-OCR, GLM-OCR, ...) are vision chat models, so an ocr service is
 * served on the chat endpoints and may run inside a Micro Agent — it exists to
 * label the service and mark it as an OCR pre-pass candidate. Every other
 * category is an OpenAI-style passthrough to the provider's matching endpoint,
 * still running the step chain's retry/fallback; those are NOT allowed inside
 * a Micro Agent.
 */
export const ServiceCategorySchema = z.enum(["chat", "ocr", "image", "video", "tts", "stt", "embedding", "rerank"]);
export type ServiceCategory = z.infer<typeof ServiceCategorySchema>;

/** Categories served by the translated chat pipeline (vs. media passthrough). */
export function isChatPipeline(category: ServiceCategory): boolean {
  return category === "chat" || category === "ocr";
}

export const HostedToolOptionsSchema = z.object({
  streamMode: z.enum(["all", "progress", "final"]).default("progress"),
  maxRounds: z.number().int().min(1).max(MAX_TOOL_ROUNDS).default(DEFAULT_TOOL_ROUNDS),
  maxCalls: z.number().int().min(1).max(MAX_HOSTED_CALLS).default(DEFAULT_HOSTED_CALLS),
});
export type HostedToolOptions = z.infer<typeof HostedToolOptionsSchema>;

/**
 * Optional aggregate budget (bytes) for the URL attachments a service inlines
 * into a request. The proxy imposes none of its own -- a relay should not
 * decide what a user may attach -- but an operator who knows their provider's
 * (or their box's) appetite can set one per Model Service / Micro Agent.
 * Absent or 0 means unlimited.
 */
export const MAX_ATTACHMENT_LIMIT = 8 * BYTES_PER_GIB;
export const AttachmentBudgetSchema = z.number().int().min(0).max(MAX_ATTACHMENT_LIMIT);

/** A call's time budget in milliseconds: a service's whole step chain, or one
 * stage / pre-pass of an agent. */
const TimeoutMsSchema = z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS);

/**
 * The service-level settings of a definition, whichever kind it is: a
 * Model Service and a Micro Agent declare these identically, and for an agent
 * they describe the agent as a whole.
 */
const ServiceLevelFields = {
  /**
   * Reliable streaming: for a streaming client request, stream the upstream
   * response and buffer it (a truncated stream retries under the step's rules)
   * before replaying the complete result. The client only ever gets a complete
   * response -- or a clean 502 -- never a partial stream. Omitted = off: relay
   * straight through (real token-by-token, but a mid-stream truncation can't be
   * retried once headers commit).
   */
  reliableStreaming: z.boolean().optional(),
  /** How thinking reaches this service's client. Omitted = "original". */
  thinkingFormat: ThinkingFormatSchema.optional(),
  /** Literal thinking boundaries for this service's upstream, when its model
   * does not delimit its trace with a tag shape the scanner can recognise. */
  thinkingDelimiters: ThinkingDelimitersSchema.optional(),
  /**
   * Aggregate budget (bytes) for the URL attachments this service inlines.
   * Absent or 0 = unlimited. See {@link AttachmentBudgetSchema}.
   */
  maxAttachmentBytes: AttachmentBudgetSchema.optional(),
};

export const ServiceStepsSchema = z.object({
  hostedTools: HostedToolOptionsSchema.optional(),
  kind: z.literal(SERVICE_KIND.MODEL_SERVICE).optional(),
  /** Omitted = "chat" (backward compatible with pre-category definitions). */
  category: ServiceCategorySchema.optional(),
  timeoutMs: TimeoutMsSchema.default(DEFAULT_SERVICE_TIMEOUT_MS),
  steps: z.array(StepSchema).min(1, "a Model Service needs at least one step"),
  ...ServiceLevelFields,
});

// --- Micro Agent (stage orchestration) ------------------------------------

/** How a stage or pre-pass names the model it runs: a saved service, or an
 * inline step chain of its own. */
const ModelRefFields = {
  /** Name of a saved Model Service (for a stage, a Micro Agent too). */
  service: z.string().min(1).optional(),
  /** Inline step chain (alternative to `service`). */
  steps: z.array(StepSchema).min(1).optional(),
};

/** The two generation params that predate `overrides` and are still accepted
 * beside it, with the bounds `overrides` itself applies. */
const LegacyFlatOverrides = {
  temperature: OverridesSchema.shape.temperature,
  maxTokens: OverridesSchema.shape.maxTokens,
};

const ConversationRoleSchema = z.enum(["user", "assistant"]);

export const AgentContextBlockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("original_conversation") }),
  z.object({ kind: z.literal("text_conversation") }),
  z.object({ kind: z.literal("last_user") }),
  z.object({ kind: z.literal("last_user_text") }),
  z.object({ kind: z.literal("last_user_images") }),
  z.object({ kind: z.literal("stage_output"), stage: z.string().min(1), role: ConversationRoleSchema.default("assistant") }),
  z.object({ kind: z.literal("message"), role: ConversationRoleSchema.default("user"), text: z.string().default("") }),
  z.object({
    kind: z.literal("tool_turn"),
    name: z.string().min(1),
    input: z.string().default(""),
    result: z.string().default(""),
    isError: z.boolean().optional(),
    id: z.string().optional(),
  }),
]);

export const AgentConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("always") }),
  z.object({ type: z.literal("input_has_image") }),
  z.object({ type: z.literal("input_contains"), value: z.string().min(1) }),
  z.object({ type: z.literal("input_matches"), value: z.string().min(1) }),
  z.object({ type: z.literal("output_contains"), value: z.string().min(1), stage: z.string().optional() }),
  z.object({ type: z.literal("output_matches"), value: z.string().min(1), stage: z.string().optional() }),
]);

export const AgentTransitionSchema = z.object({
  when: AgentConditionSchema,
  goto: z.string().min(1),
  /** When goto="end": which stage's output to return. Omitted = the ending stage. */
  output: z.string().optional(),
});

export const AgentStageSchema = z.object({
  name: z.string().min(1).max(MAX_STAGE_NAME_CHARS),
  /** No service and no steps = a router. */
  ...ModelRefFields,
  /** Context blocks assembled into the messages. [] = pass the original through. */
  input: z.array(AgentContextBlockSchema).default([]),
  /**
   * Whether the stage's model may call the original request's tools. "none"
   * renders the tool definitions into the system prompt as reference but does
   * NOT register them (portable; tool_choice "none" is widely rejected).
   * Omitted/"inherit" passes tools + tool_choice through unchanged.
   */
  tools: z.enum(["inherit", "none"]).optional(),
  /** Legacy flat overrides (folded into `overrides` at consumption). */
  system: z.string().optional(),
  ...LegacyFlatOverrides,
  /** @deprecated Use `overrides.thinking` instead. Folded automatically for backward compat. */
  thinking: ThinkingLevelSchema.optional(),
  /** Rich per-stage parameter overrides (includes the system prompt). */
  overrides: OverridesSchema.optional(),
  timeoutMs: TimeoutMsSchema.optional(),
  /** Forward-only conditional edges. Absent/no-match = fall through to the next stage. */
  transitions: z.array(AgentTransitionSchema).optional(),
});

export const AgentOcrSchema = z.object({
  ...ModelRefFields,
  /** System prompt for the OCR model; omitted = the built-in default. */
  prompt: z.string().optional(),
  /** Legacy flat overrides (folded at consumption). */
  ...LegacyFlatOverrides,
  overrides: OverridesSchema.optional(),
  timeoutMs: TimeoutMsSchema.optional(),
});

/** Audio-to-text (ASR) pre-pass config: an stt-category Model Service (or
 * inline steps) that transcribes input_audio attachments before the stages
 * run, mirroring the OCR pre-pass for images. */
export const AgentAsrSchema = z.object({
  ...ModelRefFields,
  timeoutMs: TimeoutMsSchema.optional(),
});

export const AgentSchema = z.object({
  hostedTools: HostedToolOptionsSchema.optional(),
  // Accept the frontend's legacy "agent" discriminant as well as "micro_agent".
  kind: z.union([z.literal(SERVICE_KIND.MICRO_AGENT), z.literal(LEGACY_AGENT_KIND)]),
  timeoutMs: TimeoutMsSchema.default(DEFAULT_SERVICE_TIMEOUT_MS),
  stages: z.array(AgentStageSchema).min(1, "a Micro Agent needs at least one stage"),
  /** Name of the stage whose output is returned; omitted = the last stage. */
  output: z.string().optional(),
  /** Optional image-to-text OCR pre-pass run before the first stage. */
  ocr: AgentOcrSchema.optional(),
  /** Optional audio-to-text ASR pre-pass run before the first stage. */
  asr: AgentAsrSchema.optional(),
  /** For the agent as a whole; inherited by stages that set no budget of their own. */
  ...ServiceLevelFields,
});

export type Trigger = z.infer<typeof TriggerSchema>;
export type AdvanceTrigger = z.infer<typeof AdvanceTriggerSchema>;
export type BackoffConfig = z.infer<typeof BackoffSchema>;
export type RetryConfig = z.infer<typeof RetrySchema>;
export type Overrides = z.infer<typeof OverridesSchema>;
export type ServiceStep = z.infer<typeof StepSchema>;
export type ServiceSteps = z.infer<typeof ServiceStepsSchema>;
export type AgentCondition = z.infer<typeof AgentConditionSchema>;
export type AgentStage = z.infer<typeof AgentStageSchema>;
export type AgentOcr = z.infer<typeof AgentOcrSchema>;
export type AgentDef = z.infer<typeof AgentSchema>;
export type ServiceDef = AgentDef | ServiceSteps;

export function isAgent(def: ServiceDef): def is AgentDef {
  const kind = (def as AgentDef).kind;
  return kind === SERVICE_KIND.MICRO_AGENT || kind === LEGACY_AGENT_KIND;
}

/** A stage that names no model makes no call: it only routes. */
export function isRouterStage(stage: Pick<AgentStage, "service" | "steps">): boolean {
  return !stage.service && (!stage.steps || stage.steps.length === 0);
}

/**
 * How a definition presents thinking to its client. Absent means "original",
 * which is a no-op -- the return type is the canonical union, so the persisted
 * enum cannot drift from it without failing to compile.
 */
export function serviceThinkingFormat(def: ServiceDef): ThinkingFormat {
  return def.thinkingFormat ?? "original";
}

/**
 * The literal thinking boundaries a definition declares, if any.
 *
 * Scanning by tag SHAPE cannot cover a model that does not delimit its trace
 * that way (harmony's channel markers being the standard example), so the
 * operator can state the pair outright and the scanner matches it literally.
 * Read together with {@link serviceThinkingFormat}, which decides how that
 * thinking is presented once it has been found.
 */
export function serviceThinkingDelimiters(def: ServiceDef): ThinkingDelimiters | undefined {
  return def.thinkingDelimiters;
}

/** The effective category of a definition. Agents are always "chat". */
export function serviceCategory(def: ServiceDef): ServiceCategory {
  return isAgent(def) ? "chat" : (def.category ?? "chat");
}

/** Parse & validate a raw definition (Model Service steps or a Micro Agent). Throws ZodError. */
export function parseService(raw: unknown): ServiceDef {
  const kind = raw && typeof raw === "object" ? (raw as { kind?: unknown }).kind : undefined;
  if (kind === SERVICE_KIND.MICRO_AGENT || kind === LEGACY_AGENT_KIND) {
    return AgentSchema.parse(raw);
  }
  return ServiceStepsSchema.parse(raw);
}

// --- override folding (legacy flat fields -> rich overrides) ----------------

/** Canonical override keys that map 1:1 to a GenerationParams/stream/system
 * field. Anything else on an overrides object is treated as a provider-specific
 * param and folded into `extra` so it reaches the upstream wire body. */
const CANONICAL_OVERRIDE_KEYS: ReadonlySet<string> = new Set<OverridableParam>([
  "temperature", "topP", "topK", "minP", "maxTokens", "stop", "frequencyPenalty",
  "presencePenalty", "repetitionPenalty", "seed", "n", "logprobs", "topLogprobs",
  "logitBias", "responseFormat", "parallelToolCalls", "serviceTier", "user",
  "verbosity", "thinking", "extra",
]);

/** Move any non-canonical keys on an overrides object into its `extra` record,
 * so vendor-specific / nested JSON keys are preserved and sent upstream instead
 * of being silently dropped by the wire-family renderers. */
function foldUnknownIntoExtra<T extends RequestOverrides | undefined>(ov: T): T {
  if (!ov) return ov;
  const extra: Record<string, unknown> = { ...(ov.extra as Record<string, unknown> | undefined ?? {}) };
  const out: Record<string, unknown> = {};
  let mutated = false;
  for (const [k, v] of Object.entries(ov)) {
    if (k === "stream" || k === "system") { out[k] = v; continue; }
    if (CANONICAL_OVERRIDE_KEYS.has(k)) { out[k] = v; continue; }
    extra[k] = v;
    mutated = true;
  }
  if (mutated || Object.keys(extra).length) out.extra = extra;
  else if (ov.extra !== undefined) out.extra = ov.extra;
  // `out` already carries every key, so return it as-is: re-spreading `ov` over
  // it would leave the non-canonical keys at the top level too, copied rather
  // than moved, and `extra` is the only place a renderer looks for them.
  return out as T;
}

/** Effective per-step overrides: the flat `thinking` folded under `overrides`,
 * and any unknown keys folded into `extra`. */
export function stepOverrides(step: ServiceStep): RequestOverrides | undefined {
  const flat = step.thinking !== undefined ? { thinking: step.thinking } : undefined;
  const merged = mergeOverrides(flat, step.overrides as RequestOverrides | undefined);
  return foldUnknownIntoExtra(merged);
}

/** Effective per-stage overrides: flat system/temperature/maxTokens/thinking folded under `overrides`,
 * and any unknown keys folded into `extra`. */
export function stageOverrides(stage: AgentStage): RequestOverrides | undefined {
  const flat: RequestOverrides = {};
  if (stage.system !== undefined) flat.system = stage.system;
  if (stage.temperature !== undefined) flat.temperature = stage.temperature;
  if (stage.maxTokens !== undefined) flat.maxTokens = stage.maxTokens;
  if (stage.thinking !== undefined) flat.thinking = stage.thinking;
  const merged = mergeOverrides(Object.keys(flat).length ? flat : undefined, stage.overrides as RequestOverrides | undefined);
  return foldUnknownIntoExtra(merged);
}

/** Effective OCR generation params (temperature defaults to 0), overrides winning over flat. */
export function ocrParams(ocr: AgentOcr): GenerationParams {
  const ov = (ocr.overrides ?? {}) as GenerationParams;
  const params: GenerationParams = { temperature: ov.temperature ?? ocr.temperature ?? 0 };
  const maxTokens = ov.maxTokens ?? ocr.maxTokens;
  if (maxTokens != null) params.maxTokens = maxTokens;
  return params;
}

/** Parse & validate a raw Model Service step chain. Throws ZodError on invalid. */
export function parseServiceSteps(raw: unknown): ServiceSteps {
  return ServiceStepsSchema.parse(raw);
}

/** Human-readable one-line summary of a service (for the dashboard). */
export function summarizeService(def: ServiceDef): string {
  const reliable = def.reliableStreaming ? " [reliable streaming]" : "";
  if (isAgent(def)) {
    const names = def.stages.map((s) => s.name);
    const branching = def.stages.some((s) => s.transitions && s.transitions.length > 0);
    const returns = def.output && def.output !== names[names.length - 1] ? ` (returns ${def.output})` : "";
    const ocr = def.ocr ? "OCR -> " : "";
    return `agent: ${ocr}${names.join(" -> ")}${branching ? " (branching)" : ""}${returns}${reliable}`;
  }
  const category = def.category && def.category !== "chat" ? `[${def.category}] ` : "";
  const parts = def.steps.map((s) => {
    let label = `${s.model}@${s.provider}`;
    // A step with no `retry` block is not a step without retries: runSteps
    // applies the same defaults, so the summary must say so.
    const attempts = s.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (attempts > 1) {
      const interval = s.retry?.intervalMs ?? 0;
      label += ` (retry ${attempts}x${interval ? ` ${interval}ms` : ""})`;
    }
    return label;
  });
  return `${category}${parts.length ? `try ${parts.join("; else ")}; else fail` : "(no steps)"}${reliable}`;
}
