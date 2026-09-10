import { z } from "zod";
import {
  HostedToolOptionsSchema,
  OverridesSchema,
  StepSchema,
  ThinkingFormatSchema,
  ThinkingLevelSchema,
  foldUnknownIntoExtra,
  prePassParams,
  type ServiceDef,
} from "@areelai/model-services";
import { mergeOverrides, type GenerationParams, type RequestOverrides } from "@areelai/wire-format";

/**
 * Persisted shape of a Micro Agent: a forward-only stage pipeline. Every
 * stage may override the same rich set of request parameters a Model Service
 * step can. The `kind` discriminant is what routes a stored definition to this
 * package's handler (see kind.ts).
 */

export const MICRO_AGENT_KIND = "micro_agent";
/** The frontend's legacy discriminant, still accepted on input. */
export const MICRO_AGENT_ALIASES = ["agent"] as const;

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
  /** Legacy flat overrides (folded into `overrides` at consumption). */
  system: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(1_000_000).optional(),
  /** @deprecated Use `overrides.thinking` instead. Folded automatically for backward compat. */
  thinking: ThinkingLevelSchema.optional(),
  /** Rich per-stage parameter overrides (includes the system prompt). */
  overrides: OverridesSchema.optional(),
  timeoutMs: z.number().int().min(1_000).max(7_200_000).optional(),
  /** Forward-only conditional edges. Absent/no-match = fall through to the next stage. */
  transitions: z.array(AgentTransitionSchema).optional(),
});

export const AgentOcrSchema = z.object({
  service: z.string().min(1).optional(),
  steps: z.array(StepSchema).min(1).optional(),
  /** System prompt for the OCR model; omitted = the built-in default. */
  prompt: z.string().optional(),
  /** Legacy flat overrides (folded at consumption). */
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(1_000_000).optional(),
  overrides: OverridesSchema.optional(),
  timeoutMs: z.number().int().min(1_000).max(7_200_000).optional(),
});

/** Audio-to-text (ASR) pre-pass config: an stt-category Model Service (or
 * inline steps) that transcribes input_audio attachments before the stages
 * run, mirroring the OCR pre-pass for images. */
export const AgentAsrSchema = z.object({
  service: z.string().min(1).optional(),
  steps: z.array(StepSchema).min(1).optional(),
  timeoutMs: z.number().int().min(1_000).max(7_200_000).optional(),
});

export const AgentSchema = z.object({
  hostedTools: HostedToolOptionsSchema.optional(),
  // Accept the frontend's legacy "agent" discriminant as well as "micro_agent".
  kind: z.union([z.literal("micro_agent"), z.literal("agent")]),
  timeoutMs: z.number().int().min(1_000).max(7_200_000).default(60_000),
  stages: z.array(AgentStageSchema).min(1, "a Micro Agent needs at least one stage"),
  /** Name of the stage whose output is returned; omitted = the last stage. */
  output: z.string().optional(),
  /** Optional image-to-text OCR pre-pass run before the first stage. */
  ocr: AgentOcrSchema.optional(),
  /** Optional audio-to-text ASR pre-pass run before the first stage. */
  asr: AgentAsrSchema.optional(),
  /** Reliable streaming for the agent as a whole (see ServiceStepsSchema). */
  reliableStreaming: z.boolean().optional(),
  /** How thinking reaches this agent's client (see ServiceStepsSchema). */
  thinkingFormat: ThinkingFormatSchema.optional(),
});

export type AgentContextBlock = z.infer<typeof AgentContextBlockSchema>;
export type AgentCondition = z.infer<typeof AgentConditionSchema>;
export type AgentTransition = z.infer<typeof AgentTransitionSchema>;
export type AgentStage = z.infer<typeof AgentStageSchema>;
export type AgentOcr = z.infer<typeof AgentOcrSchema>;
export type AgentAsr = z.infer<typeof AgentAsrSchema>;
export type AgentDef = z.infer<typeof AgentSchema>;

/** Whether a definition is a Micro Agent. */
export function isAgent(def: ServiceDef): def is AgentDef {
  const kind = (def as { kind?: unknown }).kind;
  return kind === MICRO_AGENT_KIND || kind === "agent";
}

/** Parse & validate a raw Micro Agent definition. Throws ZodError. */
export function parseAgent(raw: unknown): AgentDef {
  return AgentSchema.parse(raw);
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
  return prePassParams(ocr);
}

/** The saved services this agent references: stage services and pre-pass services. */
export function agentReferences(def: AgentDef): string[] {
  const names: (string | undefined)[] = [...def.stages.map((s) => s.service), def.ocr?.service, def.asr?.service];
  return names.filter((n): n is string => typeof n === "string" && n.length > 0);
}

/** Human-readable one-line summary of an agent (for the dashboard). */
export function summarizeAgent(def: AgentDef): string {
  const reliable = def.reliableStreaming ? " [reliable streaming]" : "";
  const names = def.stages.map((s) => s.name);
  const branching = def.stages.some((s) => s.transitions && s.transitions.length > 0);
  const returns = def.output && def.output !== names[names.length - 1] ? ` (returns ${def.output})` : "";
  const ocr = def.ocr ? "OCR -> " : "";
  return `agent: ${ocr}${names.join(" -> ")}${branching ? " (branching)" : ""}${returns}${reliable}`;
}
