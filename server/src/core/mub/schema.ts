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

export const StepSchema = z.object({
  /** Internal catalog model name. */
  model: z.string().min(1),
  /** Provider name; (model, provider) must be a mapped pair in the catalog. */
  provider: z.string().min(1),
  retry: RetrySchema.optional(),
  /** When to advance to the next step. Omit = advance on any failure. */
  advanceOn: z.array(AdvanceTriggerSchema).optional(),
});

export const MubStepsSchema = z.object({
  timeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
  steps: z.array(StepSchema).min(1, "a MUB needs at least one step"),
});

// ---------------------------------------------------------------------------
// Chain (compositional) MUB: an ordered set of stages, each an independent
// model call whose prompt is assembled from the original request and any
// earlier stage's output. One stage's result is returned to the client. This
// is a general pipeline primitive (map/transform/critique/route/ensemble/…),
// not tied to any specific workflow.
// ---------------------------------------------------------------------------

/** A single piece of content fed into a stage's message. */
export const ChainPartSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("literal"), text: z.string() }),
  z.object({ source: z.literal("original_text") }),
  z.object({ source: z.literal("original_images") }),
  z.object({ source: z.literal("original_system") }),
  z.object({ source: z.literal("original_messages") }),
  z.object({ source: z.literal("stage"), name: z.string().min(1) }),
]);

export const ChainBlockSchema = z.object({
  role: z.enum(["user", "assistant"]).default("user"),
  parts: z.array(ChainPartSchema).default([]),
});

export const ChainStageSchema = z.object({
  /** Unique id within the chain; later stages reference it by name. */
  name: z.string().min(1).max(60),
  /** How to call this stage's model — reuses the resilience step engine. */
  steps: z.array(StepSchema).min(1, "a stage needs at least one (model, provider) step"),
  /** Messages to send. [] = pass the original request's messages through. */
  input: z.array(ChainBlockSchema).default([]),
  /** Optional system-prompt override (text parts); omitted = inherit original. */
  system: z.array(ChainPartSchema).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(1_000_000).optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
});

export const ChainSchema = z.object({
  kind: z.literal("chain"),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
  stages: z.array(ChainStageSchema).min(1, "a chain needs at least one stage"),
  /** Name of the stage whose output is returned; omitted = the last stage. */
  output: z.string().optional(),
});

/** The existing resilience workflow, now with an optional explicit discriminant. */
export const ResilienceSchema = MubStepsSchema.extend({
  kind: z.literal("resilience").optional(),
});

export type Trigger = z.infer<typeof TriggerSchema>;
export type AdvanceTrigger = z.infer<typeof AdvanceTriggerSchema>;
export type RetryPolicy = z.infer<typeof RetrySchema>;
export type MubStep = z.infer<typeof StepSchema>;
export type MubSteps = z.infer<typeof MubStepsSchema>;
export type ChainPart = z.infer<typeof ChainPartSchema>;
export type ChainBlock = z.infer<typeof ChainBlockSchema>;
export type ChainStage = z.infer<typeof ChainStageSchema>;
export type ChainDef = z.infer<typeof ChainSchema>;
export type ResilienceDef = z.infer<typeof ResilienceSchema>;
export type MubDef = ChainDef | ResilienceDef;

export function isChain(def: MubDef): def is ChainDef {
  return (def as ChainDef).kind === "chain";
}

/** Parse & validate raw steps_json (resilience or chain). Throws ZodError. */
export function parseMub(raw: unknown): MubDef {
  if (raw && typeof raw === "object" && (raw as { kind?: unknown }).kind === "chain") {
    return ChainSchema.parse(raw);
  }
  return ResilienceSchema.parse(raw);
}

/** Parse & validate raw resilience steps_json. Throws ZodError on invalid. */
export function parseMubSteps(raw: unknown): MubSteps {
  return MubStepsSchema.parse(raw);
}

/** Human-readable one-line summary of a MUB (for the dashboard). */
export function summarizeMub(def: MubDef): string {
  if (isChain(def)) {
    const names = def.stages.map((s) => s.name);
    const returns = def.output && def.output !== names[names.length - 1] ? ` (returns ${def.output})` : "";
    return `chain: ${names.join(" → ")}${returns}`;
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
  return parts.length ? `try ${parts.join("; else ")}; else fail` : "(no steps)";
}
