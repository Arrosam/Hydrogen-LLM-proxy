import { z } from "zod";
import { mergeOverrides, type GenerationParams, type OverridableParam, type RequestOverrides } from "@areelai/wire-format";
import type { ThinkingFormat } from "@areelai/wire-format";
import { serviceKind, UnknownServiceKindError } from "./kinds.js";

/**
 * Persisted shape of a Model Service: the config a step carries. Every step
 * may override a RICH set of request parameters (`overrides`), not just
 * thinking/temperature -- anything a GenerationParams carries, plus the system
 * prompt.
 *
 * Other service kinds (a Micro Agent, for one) share the envelope declared
 * here and register a handler in kinds.ts that parses, validates and builds
 * their own definition shape.
 */

// --- triggers / retry ------------------------------------------------------

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
  z.number().int().min(100).max(599),
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
export const DEFAULT_RETRY_ON: z.infer<typeof TriggerSchema>[] = [429, 499, 502, 503, "timeout", "network"];
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_IDEMPOTENCY = "safe_write" as const;

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
  initialMs: z.number().int().min(1).max(600_000).default(100),
  /** Absolute ceiling on the un-jittered delay. Default 1000ms. */
  maxMs: z.number().int().min(1).max(600_000).default(1_000),
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
  maxAttempts: z.number().int().min(1).max(100).default(DEFAULT_MAX_ATTEMPTS),
  /** Fixed delay between retries (legacy; ignored when `backoff` is set). */
  intervalMs: z.number().int().min(0).max(600_000).default(0),
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
  z.object({ budget: z.number().int().min(1024).max(200_000) }),
]);

/**
 * How the service presents the model's thinking to ITS client -- see
 * wire-format's thinkingFormat module for what each value means and why
 * `original` (the default) is a strict no-op.
 *
 * This is a service-level setting rather than a per-step override on purpose:
 * it describes the answer the caller receives, and a fallback chain that
 * answered differently depending on which step happened to win would be a
 * worse contract than any of the individual formats.
 */
export const ThinkingFormatSchema = z.enum(["original", "reasoning_content", "reasoning", "think_tags", "none"]);

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
    temperature: z.number().min(0).max(2),
    topP: z.number().min(0).max(1),
    topK: z.number().int().min(0),
    minP: z.number().min(0).max(1),
    maxTokens: z.number().int().min(1).max(1_000_000),
    stop: z.array(z.string()),
    frequencyPenalty: z.number().min(-2).max(2),
    presencePenalty: z.number().min(-2).max(2),
    repetitionPenalty: z.number().min(0).max(2),
    seed: z.number().int(),
    n: z.number().int().min(1).max(128),
    logprobs: z.boolean(),
    topLogprobs: z.number().int().min(0).max(20),
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
  maxRounds: z.number().int().min(1).max(32).default(8),
  maxCalls: z.number().int().min(1).max(128).default(16),
});
export type HostedToolOptions = z.infer<typeof HostedToolOptionsSchema>;

export const ServiceStepsSchema = z.object({
  hostedTools: HostedToolOptionsSchema.optional(),
  kind: z.literal("model_service").optional(),
  /** Omitted = "chat" (backward compatible with pre-category definitions). */
  category: ServiceCategorySchema.optional(),
  timeoutMs: z.number().int().min(1_000).max(7_200_000).default(60_000),
  steps: z.array(StepSchema).min(1, "a Model Service needs at least one step"),
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
});

// --- the envelope every service kind shares ----------------------------------

/**
 * The fields every persisted definition carries whatever its kind: the
 * gateway reads these without knowing the kind. A registered kind's own schema
 * must accept at least this shape.
 */
export const ServiceEnvelopeSchema = z.object({
  kind: z.string(),
  hostedTools: HostedToolOptionsSchema.optional(),
  timeoutMs: z.number().int().min(1_000).max(7_200_000).default(60_000),
  reliableStreaming: z.boolean().optional(),
  thinkingFormat: ThinkingFormatSchema.optional(),
});
export type ServiceEnvelope = z.infer<typeof ServiceEnvelopeSchema>;

/** A definition of any registered kind other than a step chain. Its full shape
 * is known only to the handler that registered the kind. */
export type ForeignServiceDef = ServiceEnvelope;

export type Trigger = z.infer<typeof TriggerSchema>;
export type AdvanceTrigger = z.infer<typeof AdvanceTriggerSchema>;
export type BackoffConfig = z.infer<typeof BackoffSchema>;
export type RetryConfig = z.infer<typeof RetrySchema>;
export type ThinkingLevelConfig = z.infer<typeof ThinkingLevelSchema>;
export type Overrides = z.infer<typeof OverridesSchema>;
export type ServiceStep = z.infer<typeof StepSchema>;
export type ServiceSteps = z.infer<typeof ServiceStepsSchema>;
export type ServiceDef = ServiceSteps | ForeignServiceDef;

/** The step-chain kind, as stored in the `kind` column. */
export const STEP_CHAIN_KIND = "model_service";

/** Whether a definition is a plain step chain (as opposed to a registered kind). */
export function isStepChain(def: ServiceDef): def is ServiceSteps {
  const kind = (def as { kind?: unknown }).kind;
  return kind === undefined || kind === STEP_CHAIN_KIND;
}

/** The canonical kind a definition is stored under. */
export function canonicalKind(def: ServiceDef): string {
  if (isStepChain(def)) return STEP_CHAIN_KIND;
  return serviceKind(def.kind)?.kind ?? def.kind;
}

/**
 * How a definition presents thinking to its client. Absent means "original",
 * which is a no-op -- the return type is the canonical union, so the persisted
 * enum cannot drift from it without failing to compile.
 */
export function serviceThinkingFormat(def: ServiceDef): ThinkingFormat {
  return def.thinkingFormat ?? "original";
}

/** The effective category of a definition. A registered kind names its own;
 * an unregistered kind is treated as chat, which is what every kind so far is. */
export function serviceCategory(def: ServiceDef): ServiceCategory {
  if (isStepChain(def)) return def.category ?? "chat";
  return serviceKind(def.kind)?.category(def) ?? "chat";
}

/**
 * Parse & validate a raw definition: a step chain, or any registered kind.
 * Throws ZodError on a bad shape and UnknownServiceKindError on a kind nothing
 * has registered (e.g. a Micro Agent row when @areelai/micro-agent is not
 * installed and registered).
 */
export function parseService(raw: unknown): ServiceDef {
  const kind = raw && typeof raw === "object" ? (raw as { kind?: unknown }).kind : undefined;
  if (kind === undefined || kind === STEP_CHAIN_KIND) return ServiceStepsSchema.parse(raw);
  if (typeof kind !== "string") return ServiceStepsSchema.parse(raw);
  const handler = serviceKind(kind);
  if (!handler) throw new UnknownServiceKindError(kind);
  return handler.parse(raw);
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
export function foldUnknownIntoExtra<T extends RequestOverrides | undefined>(ov: T): T {
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

/** Generation params for a pre-pass model call (temperature defaults to 0),
 * overrides winning over flat legacy fields. Shared with the Micro Agent's OCR
 * pre-pass, which is why it lives here rather than with the agent. */
export function prePassParams(cfg: { overrides?: Record<string, unknown>; temperature?: number; maxTokens?: number }): GenerationParams {
  const ov = (cfg.overrides ?? {}) as GenerationParams;
  const params: GenerationParams = { temperature: ov.temperature ?? cfg.temperature ?? 0 };
  const maxTokens = ov.maxTokens ?? cfg.maxTokens;
  if (maxTokens != null) params.maxTokens = maxTokens;
  return params;
}

/** Parse & validate a raw Model Service step chain. Throws ZodError on invalid. */
export function parseServiceSteps(raw: unknown): ServiceSteps {
  return ServiceStepsSchema.parse(raw);
}

/** Human-readable one-line summary of a step chain (for the dashboard). */
export function summarizeSteps(def: ServiceSteps): string {
  const reliable = def.reliableStreaming ? " [reliable streaming]" : "";
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

/** Human-readable one-line summary of any service (for the dashboard). */
export function summarizeService(def: ServiceDef): string {
  if (isStepChain(def)) return summarizeSteps(def);
  const handler = serviceKind(def.kind);
  return handler ? handler.summarize(def) : `${def.kind} (kind not installed)`;
}
