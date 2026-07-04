export type Role = "admin" | "manager";
export type ProviderType = "openai" | "anthropic" | "openai_compatible";

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

export type Trigger = number | "timeout" | "error";
export type AdvanceTrigger = Trigger | "exhausted";

export interface RetryPolicy {
  on: Trigger[];
  maxAttempts: number;
  intervalMs: number;
}

export interface MubStep {
  model: string;
  provider: string;
  retry?: RetryPolicy;
  advanceOn?: AdvanceTrigger[];
}

export interface MubSteps {
  timeoutMs: number;
  steps: MubStep[];
}

// --- Chain (compositional) MUB ---
export type ChainContextBlock =
  | { kind: "original_conversation" }
  | { kind: "text_conversation" }
  | { kind: "last_user" }
  | { kind: "last_user_text" }
  | { kind: "last_user_images" }
  | { kind: "stage_output"; stage: string; role: "user" | "assistant" }
  | { kind: "message"; role: "user" | "assistant"; text: string }
  | { kind: "tool_turn"; name: string; input: string; result: string; isError?: boolean; id?: string };

export type ChainCondition =
  | { type: "always" }
  | { type: "input_has_image" }
  | { type: "input_contains"; value: string }
  | { type: "input_matches"; value: string }
  | { type: "output_contains"; value: string; stage?: string }
  | { type: "output_matches"; value: string; stage?: string };

export interface ChainTransition {
  when: ChainCondition;
  goto: string; // a later stage's name, or "end"
  output?: string; // when goto="end": which stage's output to return (this/earlier stage)
}

export interface ChainStage {
  name: string;
  mub?: string; // referenced resilience MUB (its fallback chain runs for the stage)
  steps?: MubStep[]; // legacy inline steps
  input: ChainContextBlock[];
  system?: string;
  tools?: "inherit" | "none"; // "none" keeps the tool list but forces tool_choice "none" (not callable)
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  transitions?: ChainTransition[];
}

export interface ChainOcr {
  mub?: string; // referenced resilience MUB running the OCR/multimodal model
  steps?: MubStep[]; // legacy inline steps
  prompt?: string; // OCR system prompt; empty = built-in default
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ChainMub {
  kind: "chain";
  timeoutMs: number;
  stages: ChainStage[];
  output?: string;
  ocr?: ChainOcr; // optional image→text pre-pass run before the first stage
}

/** A MUB definition is either the resilience workflow or a chain. */
export type MubDef = MubSteps | ChainMub;

export function isChainDef(def: MubDef | null | undefined): def is ChainMub {
  return !!def && (def as ChainMub).kind === "chain";
}

export interface Mub {
  id: number;
  name: string;
  description: string | null;
  steps: MubDef;
  enabled: boolean;
  summary: string;
  createdAt: number;
}

export interface Token {
  id: number;
  name: string;
  keyPrefix: string;
  ownerUserId: number | null;
  scopeMubs: number[] | null;
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
  mubId: number | null;
  mubName: string | null;
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
