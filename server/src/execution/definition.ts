import { z } from "zod";

/**
 * Persisted shape of a Model Service / Micro Agent. This is the config a
 * ModelService step or MicroAgent stage carries. The key change from the old
 * design: every step/stage may override a RICH set of request parameters
 * (`overrides`), not just thinking/temperature -- anything a GenerationParams
 * carries, plus the system prompt.
 */

// --- triggers / retry ------------------------------------------------------

/**
 * A trigger is an HTTP status code, or a symbolic class:
 *   "timeout" - the upstream call timed out
 *   "error"   - any failure (network error or any non-2xx status)
 *   "exhausted" (advanceOn only) - advance once this step's retries are used up
 */
export const TriggerSchema = z.union([
  z.number().int().min(100).max(599),
  z.literal("timeout"),
  z.literal("error"),
]);

export const AdvanceTriggerSchema = z.union([TriggerSchema, z.literal("exhausted")]);

export const RetrySchema = z.object({
  on: z.array(TriggerSchema).default([]),
  maxAttempts: z.number().int().min(1).max(20).default(1),
  intervalMs: z.number().int().min(0).max(600_000).default(0),
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
  .partial();

// --- Model Service (resilience step chain) --------------------------------

export const StepSchema = z.object({
  /** Internal catalog model name. */
  model: z.string().min(1),
  /** Provider name; (model, provider) must be a mapped pair in the catalog. */
  provider: z.string().min(1),
  retry: RetrySchema.optional(),
  /** When to advance to the next step. Omit = advance on any failure. */
  advanceOn: z.array(AdvanceTriggerSchema).optional(),
  /** Rich per-step parameter overrides. */
  overrides: OverridesSchema.optional(),
});

export const ServiceStepsSchema = z.object({
  kind: z.literal("model_service").optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
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
});

// --- Micro Agent (stage orchestration) ------------------------------------

export const AgentContextBlockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("original_conversation") }),
  z.object({ kind: z.literal("text_conversation") }),
  z.object({ kind: z.literal("last_user") }),
  z.object({ kind: z.literal("last_user_text") }),
  z.object({ kind: z.literal("last_user_images") }),
  z.object({ kind: z.literal("stage_output"), stage: z.string().min(1), role: z.enum(["user", "assistant"]).default("assistant") }),
  z.object({ kind: z.literal("message"), role: z.enum(["user", "assistant"]).default("user"), text: z.string().default("") }),
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
  name: z.string().min(1).max(60),
  /** Name of a saved Model Service / Micro Agent for this stage. */
  service: z.string().min(1).optional(),
  /** Inline step chain (alternative to `service`). No service/steps = a router. */
  steps: z.array(StepSchema).min(1).optional(),
  /** Context blocks assembled into the messages. [] = pass the original through. */
  input: z.array(AgentContextBlockSchema).default([]),
  /**
   * Whether the stage's model may call the original request's tools. "none"
   * renders the tool definitions into the system prompt as reference but does
   * NOT register them (portable; tool_choice "none" is widely rejected).
   * Omitted/"inherit" passes tools + tool_choice through unchanged.
   */
  tools: z.enum(["inherit", "none"]).optional(),
  /** Rich per-stage parameter overrides (includes the system prompt). */
  overrides: OverridesSchema.optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  /** Forward-only conditional edges. Absent/no-match = fall through to the next stage. */
  transitions: z.array(AgentTransitionSchema).optional(),
});

export const AgentOcrSchema = z.object({
  service: z.string().min(1).optional(),
  steps: z.array(StepSchema).min(1).optional(),
  /** System prompt for the OCR model; omitted = the built-in default. */
  prompt: z.string().optional(),
  overrides: OverridesSchema.optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
});

export const AgentSchema = z.object({
  kind: z.literal("micro_agent"),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
  stages: z.array(AgentStageSchema).min(1, "a Micro Agent needs at least one stage"),
  /** Name of the stage whose output is returned; omitted = the last stage. */
  output: z.string().optional(),
  /** Optional image-to-text OCR pre-pass run before the first stage. */
  ocr: AgentOcrSchema.optional(),
  /** Reliable streaming for the agent as a whole (see ServiceStepsSchema). */
  reliableStreaming: z.boolean().optional(),
});

export type Trigger = z.infer<typeof TriggerSchema>;
export type AdvanceTrigger = z.infer<typeof AdvanceTriggerSchema>;
export type RetryConfig = z.infer<typeof RetrySchema>;
export type ThinkingLevelConfig = z.infer<typeof ThinkingLevelSchema>;
export type Overrides = z.infer<typeof OverridesSchema>;
export type ServiceStep = z.infer<typeof StepSchema>;
export type ServiceSteps = z.infer<typeof ServiceStepsSchema>;
export type AgentContextBlock = z.infer<typeof AgentContextBlockSchema>;
export type AgentCondition = z.infer<typeof AgentConditionSchema>;
export type AgentTransition = z.infer<typeof AgentTransitionSchema>;
export type AgentStage = z.infer<typeof AgentStageSchema>;
export type AgentOcr = z.infer<typeof AgentOcrSchema>;
export type AgentDef = z.infer<typeof AgentSchema>;
export type ServiceDef = AgentDef | ServiceSteps;

export function isAgent(def: ServiceDef): def is AgentDef {
  return (def as AgentDef).kind === "micro_agent";
}

/** Parse & validate a raw definition (Model Service steps or a Micro Agent). Throws ZodError. */
export function parseService(raw: unknown): ServiceDef {
  if (raw && typeof raw === "object" && (raw as { kind?: unknown }).kind === "micro_agent") {
    return AgentSchema.parse(raw);
  }
  return ServiceStepsSchema.parse(raw);
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
  const parts = def.steps.map((s) => {
    let label = `${s.model}@${s.provider}`;
    const attempts = s.retry?.maxAttempts ?? 1;
    if (attempts > 1) {
      const interval = s.retry?.intervalMs ?? 0;
      label += ` (retry ${attempts}x${interval ? ` ${interval}ms` : ""})`;
    }
    return label;
  });
  return `${parts.length ? `try ${parts.join("; else ")}; else fail` : "(no steps)"}${reliable}`;
}
