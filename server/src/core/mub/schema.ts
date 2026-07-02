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

export type Trigger = z.infer<typeof TriggerSchema>;
export type AdvanceTrigger = z.infer<typeof AdvanceTriggerSchema>;
export type RetryPolicy = z.infer<typeof RetrySchema>;
export type MubStep = z.infer<typeof StepSchema>;
export type MubSteps = z.infer<typeof MubStepsSchema>;

/** Parse & validate raw steps_json, filling defaults. Throws ZodError on invalid. */
export function parseMubSteps(raw: unknown): MubSteps {
  return MubStepsSchema.parse(raw);
}

/** Human-readable one-line summary of a MUB workflow (for the dashboard). */
export function summarizeMub(steps: MubSteps): string {
  const parts = steps.steps.map((s) => {
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
