export type Role = "admin" | "manager";
export type ProviderType = "openai_completion" | "openai_responses" | "anthropic";

export interface User {
  id: number;
  username: string;
  role: Role;
  enabled: boolean;
  mustChangePassword: boolean;
  createdAt: number;
}

export interface Provider {
  id: number;
  name: string;
  type: ProviderType;
  baseUrl: string;
  hasKey: boolean;
  extraHeaders: Record<string, string> | null;
  /** Optional hard cap on output tokens (thinking budgets fit under it). null = none. */
  maxOutputTokens: number | null;
  enabled: boolean;
  createdAt: number;
}

export interface Model {
  id: number;
  name: string;
  description: string | null;
  enabled: boolean;
  createdAt: number;
}

export interface Mapping {
  id: number;
  modelId: number;
  providerId: number;
  upstreamModel: string;
  priority: number;
  enabled: boolean;
}

export type Trigger = number | "timeout" | "network" | "error";
export type AdvanceTrigger = Trigger | "exhausted";

export interface RetryPolicy {
  on: Trigger[];
  maxAttempts: number;
  intervalMs: number;
}

export type ThinkingEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingLevel = "disabled" | "auto" | "enabled" | ThinkingEffort | { budget: number };

/**
 * Rich per-step/stage parameter overrides. Mirrors the server's OverridesSchema.
 * Every field is optional; omitted fields inherit from the client request.
 */
export interface Overrides {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  maxTokens?: number;
  stop?: string[];
  frequencyPenalty?: number;
  presencePenalty?: number;
  repetitionPenalty?: number;
  seed?: number;
  n?: number;
  logprobs?: boolean;
  topLogprobs?: number;
  logitBias?: Record<string, number>;
  responseFormat?:
    | { type: "text" }
    | { type: "json_object" }
    | { type: "json_schema"; name?: string; schema: Record<string, unknown>; strict?: boolean };
  parallelToolCalls?: boolean;
  serviceTier?: string;
  user?: string;
  verbosity?: "low" | "medium" | "high";
  thinking?: ThinkingLevel;
  /** Provider-specific params with no canonical field, merged in verbatim. */
  extra?: Record<string, unknown>;
  /** Replace the system prompt for this step/stage. */
  system?: string;
}

export interface ServiceStep {
  model: string;
  provider: string;
  retry?: RetryPolicy;
  advanceOn?: AdvanceTrigger[];
  thinking?: ThinkingLevel;
  overrides?: Overrides;
}

export interface ServiceSteps {
  timeoutMs: number;
  steps: ServiceStep[];
  reliableStreaming?: boolean;
}

// --- Agent (compositional Micro Agent) ---
export type AgentContextBlock =
  | { kind: "original_conversation" }
  | { kind: "text_conversation" }
  | { kind: "last_user" }
  | { kind: "last_user_text" }
  | { kind: "last_user_images" }
  | { kind: "stage_output"; stage: string; role: "user" | "assistant" }
  | { kind: "message"; role: "user" | "assistant"; text: string }
  | { kind: "tool_turn"; name: string; input: string; result: string; isError?: boolean; id?: string };

export type AgentCondition =
  | { type: "always" }
  | { type: "input_has_image" }
  | { type: "input_contains"; value: string }
  | { type: "input_matches"; value: string }
  | { type: "output_contains"; value: string; stage?: string }
  | { type: "output_matches"; value: string; stage?: string };

export interface AgentTransition {
  when: AgentCondition;
  goto: string; // a later stage's name, or "end"
  output?: string; // when goto="end": which stage's output to return (this/earlier stage)
}

export interface AgentStage {
  name: string;
  service?: string; // referenced Model Service (its fallback chain runs for the stage)
  steps?: ServiceStep[]; // legacy inline steps
  input: AgentContextBlock[];
  system?: string;
  tools?: "inherit" | "none"; // "none" lists tools in the prompt as reference, not registered/callable
  temperature?: number;
  maxTokens?: number;
  thinking?: ThinkingLevel;
  overrides?: Overrides;
  timeoutMs?: number;
  transitions?: AgentTransition[];
}

export interface AgentOcr {
  service?: string; // referenced Model Service running the OCR/multimodal model
  steps?: ServiceStep[]; // legacy inline steps
  prompt?: string; // OCR system prompt; empty = built-in default
  temperature?: number;
  maxTokens?: number;
  overrides?: Overrides;
  timeoutMs?: number;
}

export interface AgentDef {
  kind: "agent";
  timeoutMs: number;
  stages: AgentStage[];
  output?: string;
  ocr?: AgentOcr; // optional image-to-text pre-pass run before the first stage
  reliableStreaming?: boolean;
}

/** A service definition is either the resilience workflow or an agent. */
export type ServiceDef = ServiceSteps | AgentDef;

export function isAgentDef(def: ServiceDef | null | undefined): def is AgentDef {
  return !!def && (def as AgentDef).kind === "agent";
}

export interface ModelService {
  id: number;
  name: string;
  description: string | null;
  steps: ServiceDef;
  enabled: boolean;
  summary: string;
  createdAt: number;
}

export interface Token {
  id: number;
  name: string;
  keyPrefix: string;
  ownerUserId: number | null;
  scopeServices: number[] | null;
  maxRequests: number | null;
  maxTokens: number | null;
  usedRequests: number;
  usedTokens: number;
  expiresAt: number | null;
  enabled: boolean;
  createdAt: number;
}

export interface LogSummary {
  id: number;
  createdAt: number;
  tokenId: number | null;
  serviceId: number | null;
  serviceName: string | null;
  ingressFormat: string;
  egressFormat: string | null;
  streaming: boolean;
  httpStatus: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  attempts: number;
  error: string | null;
}

export interface StatsSummary {
  requests: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
}

export interface TimePoint {
  day: string;
  requests: number;
  totalTokens: number;
}

export interface GroupCount {
  key: string;
  requests: number;
  totalTokens: number;
}