import { z } from "zod";

/**
 * A trigger is an HTTP status code, or one of the symbolic classes:
 *   "timeout" - the upstream call timed out
 *   "error"   - any failure (network error or any non-2xx status)
 *   "exhausted" (advanceOn only) - advance once this step's retries are used up,
 *                regardless of the failure class
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

/**
 * Thinking/reasoning level for a step or stage.
 *   "disabled"       - turn extended thinking off
 *   "auto"           - let the model decide (default when the client requested it)
 *   "enabled"        - turn extended thinking on
 *   "low".."max"     - turn it on at a named effort level (OpenAI reasoning_effort;
 *                      mapped to a token budget on Anthropic upstreams)
 *   { budget }       - turn it on and enforce an explicit token budget
 */
export const ThinkingLevelSchema = z.union([
  z.literal("disabled"),
  z.literal("auto"),
  z.literal("enabled"),
  z.literal("low"),
  z.literal("medium"),
  z.literal("high"),
  z.literal("xhigh"),
  z.literal("max"),
  z.object({ budget: z.number().int().min(1024).max(128_000) }),
]);

export const StepSchema = z.object({
  /** Internal catalog model name. */
  model: z.string().min(1),
  /** Provider name; (model, provider) must be a mapped pair in the catalog. */
  provider: z.string().min(1),
  retry: RetrySchema.optional(),
  /** When to advance to the next step. Omit = advance on any failure. */
  advanceOn: z.array(AdvanceTriggerSchema).optional(),
  /** Thinking/reasoning level override for this step. */
  thinking: ThinkingLevelSchema.optional(),
});

export const ServiceStepsSchema = z.object({
  timeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
  steps: z.array(StepSchema).min(1, "a Model Service needs at least one step"),
  /**
   * Reliable streaming: for a streaming client request, stream the upstream
   * response and buffer it (a truncated stream retries under the step's rules)
   * before replaying the complete result. The client only ever gets a complete
   * response -- or, once retries are exhausted, a clean 502 -- never a
   * partial/truncated stream. Streaming the upstream (not a plain non-streaming
   * request) is what lets reasoning from stream-only providers be captured.
   * Costs first-token latency (the client waits for the full response). Omitted
   * = off: stream straight through (real token-by-token, but a mid-stream
   * truncation can't be retried once headers commit).
   */
  reliableStreaming: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Agent (compositional): an ordered set of stages, each an independent
// model call whose prompt is assembled from the original request and any
// earlier stage's output. One stage's result is returned to the client. This
// is a general pipeline primitive (map/transform/critique/route/ensemble/...),
// not tied to any specific workflow.
// ---------------------------------------------------------------------------

/**
 * A whole "context block" in a stage's input. Blocks are assembled, in order,
 * into the message list sent to the stage's model -- letting you build a fresh
 * minimal request or the original conversation plus appended turns.
 */
export const AgentContextBlockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("original_conversation") }), // all original messages, images included
  z.object({ kind: z.literal("text_conversation") }), // all original messages, images stripped
  z.object({ kind: z.literal("last_user") }), // the last original user message
  z.object({ kind: z.literal("last_user_text") }), // the last user message, text parts only
  z.object({ kind: z.literal("last_user_images") }), // the last user message, image parts only
  z.object({
    kind: z.literal("stage_output"),
    stage: z.string().min(1),
    role: z.enum(["user", "assistant"]).default("assistant"),
  }),
  z.object({
    kind: z.literal("message"), // an authored turn ("plain text" = this with role user)
    role: z.enum(["user", "assistant"]).default("user"),
    text: z.string().default(""),
  }),
  z.object({
    kind: z.literal("tool_turn"), // one call+result exchange
    name: z.string().min(1),
    input: z.string().default(""), // JSON arguments
    result: z.string().default(""),
    isError: z.boolean().optional(),
    id: z.string().optional(),
  }),
]);

/** A routing condition, tested against the original input or a stage's output. */
export const AgentConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("always") }),
  z.object({ type: z.literal("input_has_image") }),
  z.object({ type: z.literal("input_contains"), value: z.string().min(1) }),
  z.object({ type: z.literal("input_matches"), value: z.string().min(1) }), // regex
  z.object({ type: z.literal("output_contains"), value: z.string().min(1), stage: z.string().optional() }),
  z.object({ type: z.literal("output_matches"), value: z.string().min(1), stage: z.string().optional() }), // regex
]);

/** A forward-only edge: when the condition holds, go to `goto` (a later stage or "end"). */
export const AgentTransitionSchema = z.object({
  when: AgentConditionSchema,
  goto: z.string().min(1),
  /** When goto="end": which stage's output to return (this or an earlier stage).
   * Omitted = the stage that ends the agent. */
  output: z.string().optional(),
});

export const AgentStageSchema = z.object({
  /** Unique id within the agent; referenced by name in conditions/transitions. */
  name: z.string().min(1).max(60),
  /** Name of a saved Model Service for this stage (its retry/fallback chain). */
  service: z.string().min(1).optional(),
  /** Legacy inline resilience steps (v0.1.3). No service/steps = a router (no model call). */
  steps: z.array(StepSchema).min(1).optional(),
  /** Context blocks assembled into the messages. [] = pass the original messages through. */
  input: z.array(AgentContextBlockSchema).default([]),
  /** Optional system-prompt override; omitted = inherit the original system prompt. */
  system: z.string().optional(),
  /**
   * Whether the stage's model may call the original request's tools. "none"
   * keeps the tool list visible (so an evaluate/compose stage can still judge or
   * reference tool use) by rendering the tool definitions into the system prompt
   * as reference -- but it does NOT register them as callable, so the model
   * returns text/JSON. (This is portable: tool_choice "none" is rejected by many
   * upstreams.) Omitted/"inherit" passes tools + tool_choice through unchanged.
   */
  tools: z.enum(["inherit", "none"]).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(1_000_000).optional(),
  /** Thinking/reasoning level override for this stage. */
  thinking: ThinkingLevelSchema.optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  /** Forward-only conditional edges. Absent/no-match = fall through to the next stage. */
  transitions: z.array(AgentTransitionSchema).optional(),
});

/**
 * Optional image-translation (OCR) pre-pass. When present, every image in the
 * incoming request is sent -- before any stage runs -- to a multimodal/OCR model
 * that transcribes it to text; each image is then replaced in the conversation
 * by that text, so text-only stage models can process the request. Runs a
 * Model Service (by name) or inline steps, never a router.
 */
export const AgentOcrSchema = z.object({
  /** Name of a Model Service running the OCR/multimodal model. */
  service: z.string().min(1).optional(),
  /** Legacy inline resilience steps (alternative to `service`). */
  steps: z.array(StepSchema).min(1).optional(),
  /** System prompt for the OCR model; omitted = the built-in default prompt. */
  prompt: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(1_000_000).optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
});

export const AgentSchema = z.object({
  kind: z.literal("agent"),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
  stages: z.array(AgentStageSchema).min(1, "an agent needs at least one stage"),
  /** Name of the stage whose output is returned; omitted = the last stage. */
  output: z.string().optional(),
  /** Optional image-to-text OCR pre-pass run before the first stage. */
  ocr: AgentOcrSchema.optional(),
  /**
   * Reliable streaming for the agent as a whole (it is exposed to clients as a
   * single Model Service). When on, the terminal stage is not streamed to the
   * client -- every stage streams its upstream and buffers (retrying a
   * truncated stream), and the complete result is replayed. The client never
   * gets a partial/truncated stream. Costs first-token latency. Omitted = off
   * (the terminal stage streams straight through). See
   * ServiceStepsSchema.reliableStreaming.
   */
  reliableStreaming: z.boolean().optional(),
});

/** The existing resilience workflow, now with an optional explicit discriminant. */
export const ResilienceSchema = ServiceStepsSchema.extend({
  kind: z.literal("resilience").optional(),
});

export type Trigger = z.infer<typeof TriggerSchema>;
export type AdvanceTrigger = z.infer<typeof AdvanceTriggerSchema>;
export type RetryPolicy = z.infer<typeof RetrySchema>;
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;
export type ServiceStep = z.infer<typeof StepSchema>;
export type ServiceSteps = z.infer<typeof ServiceStepsSchema>;
export type AgentContextBlock = z.infer<typeof AgentContextBlockSchema>;
export type AgentCondition = z.infer<typeof AgentConditionSchema>;
export type AgentTransition = z.infer<typeof AgentTransitionSchema>;
export type AgentStage = z.infer<typeof AgentStageSchema>;
export type AgentOcr = z.infer<typeof AgentOcrSchema>;
export type AgentDef = z.infer<typeof AgentSchema>;
export type ResilienceDef = z.infer<typeof ResilienceSchema>;
export type ServiceDef = AgentDef | ResilienceDef;

export function isAgent(def: ServiceDef): def is AgentDef {
  return (def as AgentDef).kind === "agent";
}

/** Parse & validate raw steps_json (resilience or agent). Throws ZodError. */
export function parseService(raw: unknown): ServiceDef {
  if (raw && typeof raw === "object" && (raw as { kind?: unknown }).kind === "agent") {
    return AgentSchema.parse(raw);
  }
  return ResilienceSchema.parse(raw);
}

/** Parse & validate raw resilience steps_json. Throws ZodError on invalid. */
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