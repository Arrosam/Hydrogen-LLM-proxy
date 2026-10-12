import type {
  AgentAsr,
  AgentDef,
  AgentOcr,
  AgentStage,
  HostedToolOptions,
  ModelService,
  Overrides,
  ServiceCategory,
  ServiceDef,
  ServiceStep,
  ServiceSteps,
  ThinkingFormat,
} from "../types";
import { isAgentDef, isChatPipelineCategory } from "../types";
import { MIB } from "./constants";
import {
  AGENT_KIND,
  DEFAULT_CATEGORY,
  DEFAULT_HOSTED_TOOL_OPTIONS,
  DEFAULT_RETRY,
  DEFAULT_RETRY_ON,
  DEFAULT_SERVICE_TIMEOUT_MS,
  DEFAULT_THINKING_FORMAT,
  SERVICE_KIND,
  type ServiceKind,
} from "./serviceDef";

/**
 * The service editor's form, and the pure mapping between it and a stored
 * definition. The mapping is deliberately NOT an identity round trip:
 *
 * - a chat definition stored without `hostedTools` is saved with the defaults;
 * - the legacy kind "agent" is saved as "micro_agent";
 * - legacy flat fields (`thinking`, `system`, `temperature`, `maxTokens`) are
 *   folded into `overrides`, where an existing override wins;
 * - what the server treats as absent is dropped: an explicit thinking format
 *   "original", half a delimiter pair, a zero attachment budget, the default
 *   category, a false `reliableStreaming`, an empty `output`.
 *
 * The attachment budget IS an identity round trip: the form shows it in whole
 * MiB but writes back the stored bytes until the field is edited.
 */
export interface ServiceForm {
  // The record around the definition.
  name: string;
  description: string;
  enabled: boolean;
  /** Hosted tools bound to the service (admins only). */
  toolIds: number[];
  // The definition.
  kind: ServiceKind;
  timeoutMs: number;
  category: ServiceCategory;
  steps: ServiceStep[];
  stages: AgentStage[];
  /** Name of the stage whose output the agent returns; "" = the last one. */
  output: string;
  ocr: AgentOcr | undefined;
  asr: AgentAsr | undefined;
  reliableStreaming: boolean;
  thinkingFormat: ThinkingFormat;
  thinkingOpen: string;
  thinkingClose: string;
  /** Attachment inlining budget in whole MiB; 0 = unlimited (not written). */
  maxAttachmentMiB: number;
  /**
   * The stored budget in bytes when it is not a whole number of MiB, which the
   * field above can only show rounded. It is what gets written back for as
   * long as the field is not edited; an edit clears it (`attachmentMiBEdit`).
   */
  storedAttachmentBytes: number | undefined;
  toolConfig: HostedToolOptions;
}

export const EMPTY_SERVICE_FORM: ServiceForm = {
  name: "",
  description: "",
  enabled: true,
  toolIds: [],
  kind: SERVICE_KIND.resilience,
  timeoutMs: DEFAULT_SERVICE_TIMEOUT_MS,
  category: DEFAULT_CATEGORY,
  steps: [],
  stages: [],
  output: "",
  ocr: undefined,
  asr: undefined,
  reliableStreaming: false,
  thinkingFormat: DEFAULT_THINKING_FORMAT,
  thinkingOpen: "",
  thinkingClose: "",
  maxAttachmentMiB: 0,
  storedAttachmentBytes: undefined,
  toolConfig: { ...DEFAULT_HOSTED_TOOL_OPTIONS },
};

/** A step with no retry policy: the server then applies its defaults (retry on
 * [429, 499, 502, 503, timeout, network], 3 attempts). An explicit
 * `retry: { on: [], maxAttempts: 1 }` would silently disable retries. */
export const blankStep = (model: string, provider: string): ServiceStep => ({ model, provider });

/**
 * The editor only renders `overrides` (parameter/content pairs), so legacy flat
 * fields are folded into it whenever a definition enters the editor (load AND
 * raw-JSON sync) -- otherwise they would keep applying while being invisible.
 * Existing `overrides` keys win, matching the server's merge precedence in
 * stepOverrides/stageOverrides.
 */
export function foldLegacy<T extends { overrides?: Overrides }>(obj: T, keys: readonly (string & keyof T)[]): T {
  const flat: Record<string, unknown> = {};
  const rest: Record<string, unknown> = { ...obj };
  for (const k of keys) {
    if (rest[k] !== undefined) {
      flat[k] = rest[k];
      delete rest[k];
    }
  }
  if (!Object.keys(flat).length) return obj;
  return { ...rest, overrides: { ...flat, ...(obj.overrides ?? {}) } } as T;
}

const foldStage = (s: AgentStage): AgentStage => foldLegacy(s, ["system", "temperature", "maxTokens", "thinking"]);
const foldOcr = (o: AgentOcr | undefined): AgentOcr | undefined => (o ? foldLegacy(o, ["temperature", "maxTokens"]) : o);
const foldStep = (s: ServiceStep): ServiceStep => foldLegacy(s, ["thinking"]);

/** Whether the form describes something served by the chat pipeline (an agent always is). */
export const isChatPipelineForm = (form: Pick<ServiceForm, "kind" | "category">): boolean =>
  isChatPipelineCategory(form.kind === SERVICE_KIND.chain ? DEFAULT_CATEGORY : form.category);

type AttachmentForm = Pick<ServiceForm, "maxAttachmentMiB" | "storedAttachmentBytes">;

/** A stored attachment budget as the form holds it: rounded for display, exact for saving. */
const attachmentForm = (bytes: number): AttachmentForm => ({
  maxAttachmentMiB: Math.round(bytes / MIB),
  storedAttachmentBytes: bytes > 0 && bytes % MIB !== 0 ? bytes : undefined,
});

/** The user typing `mib` into the budget field: from here on the budget is that many MiB. */
export const attachmentMiBEdit = (mib: number): AttachmentForm => ({ maxAttachmentMiB: mib, storedAttachmentBytes: undefined });

/**
 * The form fields a definition determines -- and only those. An agent
 * definition says nothing about `steps`; a resilience definition says nothing
 * about `stages`, `output`, `ocr` and `asr`: those keys are absent from the
 * result, so a caller that merges it over a form (the raw-JSON view switching
 * back) leaves them as they were. Opening the editor clears them separately,
 * see `serviceToForm`.
 */
export function defToForm(def: ServiceDef): Partial<ServiceForm> {
  const byKind: Partial<ServiceForm> = isAgentDef(def)
    ? {
        kind: SERVICE_KIND.chain,
        stages: (def.stages ?? []).map(foldStage),
        output: def.output ?? "",
        ocr: foldOcr(def.ocr),
        asr: def.asr,
        category: DEFAULT_CATEGORY,
        reliableStreaming: Boolean(def.reliableStreaming),
      }
    : {
        kind: SERVICE_KIND.resilience,
        steps: (def.steps ?? []).map(foldStep),
        category: def.category ?? DEFAULT_CATEGORY,
        reliableStreaming: Boolean(def.reliableStreaming),
      };
  return {
    timeoutMs: def.timeoutMs ?? DEFAULT_SERVICE_TIMEOUT_MS,
    ...byKind,
    thinkingFormat: def.thinkingFormat ?? DEFAULT_THINKING_FORMAT,
    thinkingOpen: def.thinkingDelimiters?.open ?? "",
    thinkingClose: def.thinkingDelimiters?.close ?? "",
    ...attachmentForm(def.maxAttachmentBytes ?? 0),
    toolConfig: def.hostedTools ?? { ...DEFAULT_HOSTED_TOOL_OPTIONS },
  };
}

/**
 * What opening the editor clears on top of what the definition sets: the
 * other kind's lists and both pre-passes, so nothing of the service edited
 * before leaks into the next one.
 */
const CLEARED_ON_OPEN = { steps: [], stages: [], output: "", ocr: undefined, asr: undefined } satisfies Partial<ServiceForm>;

/** The form of a stored service, as the editor opens it. */
export function serviceToForm(service: ModelService): Partial<ServiceForm> {
  return {
    name: service.name,
    description: service.description ?? "",
    enabled: service.enabled,
    toolIds: service.toolIds ?? [],
    ...CLEARED_ON_OPEN,
    ...defToForm(service.steps),
  };
}

/** The form of a new service of `kind`, as the editor opens it. */
export function newServiceForm(kind: ServiceKind, firstStep: ServiceStep | null): Partial<ServiceForm> {
  return { ...EMPTY_SERVICE_FORM, toolConfig: { ...DEFAULT_HOSTED_TOOL_OPTIONS }, kind, steps: firstStep ? [firstStep] : [] };
}

/** "original" is the server's default, so it is left out entirely rather than
 * persisted -- a definition nobody configured stays as short as it was. */
function thinkingFields(form: ServiceForm): Pick<ServiceDef, "thinkingFormat" | "thinkingDelimiters"> {
  if (!isChatPipelineForm(form)) return {};
  // Both halves or neither: half a pair is a declaration the scanner cannot
  // use, and persisting it would read as configured when it is not.
  const delimiters = form.thinkingOpen && form.thinkingClose ? { thinkingDelimiters: { open: form.thinkingOpen, close: form.thinkingClose } } : {};
  if (form.thinkingFormat === DEFAULT_THINKING_FORMAT) return delimiters;
  return { thinkingFormat: form.thinkingFormat, ...delimiters };
}

const attachmentField = (form: ServiceForm): Pick<ServiceDef, "maxAttachmentBytes"> => {
  const bytes = form.storedAttachmentBytes ?? form.maxAttachmentMiB * MIB;
  return bytes > 0 ? { maxAttachmentBytes: bytes } : {};
};

/** The definition the form describes. Key order is the order the raw-JSON view shows. */
export function formToDef(form: ServiceForm): ServiceDef {
  if (form.kind === SERVICE_KIND.chain) {
    return {
      kind: AGENT_KIND,
      timeoutMs: form.timeoutMs,
      stages: form.stages,
      ...(form.output ? { output: form.output } : {}),
      ...(form.ocr ? { ocr: form.ocr } : {}),
      ...(form.asr ? { asr: form.asr } : {}),
      // The agent form has no switch for it; a stored flag is carried through.
      ...(form.reliableStreaming ? { reliableStreaming: true } : {}),
      ...attachmentField(form),
      ...thinkingFields(form),
      hostedTools: form.toolConfig,
    } as AgentDef;
  }
  const chat = isChatPipelineCategory(form.category);
  return {
    timeoutMs: form.timeoutMs,
    steps: form.steps,
    ...(form.category !== DEFAULT_CATEGORY ? { category: form.category } : {}),
    ...(chat && form.reliableStreaming ? { reliableStreaming: true } : {}),
    ...attachmentField(form),
    ...thinkingFields(form),
    ...(chat ? { hostedTools: form.toolConfig } : {}),
  } as ServiceSteps;
}

type Retry = NonNullable<ServiceStep["retry"]>;

/** Whether `on` is the server's default trigger set, in any order. */
const isDefaultRetryOn = (on: Retry["on"]): boolean =>
  on.length === DEFAULT_RETRY_ON.length && DEFAULT_RETRY_ON.every((trigger) => on.includes(trigger));

/**
 * `step` with `patch` applied to its retry policy. A policy starts from what
 * the server does when `retry` is omitted (3 attempts, on
 * [429, 499, 502, 503, timeout, network]) -- the set the editor shows as
 * selected -- so changing only the attempts keeps those triggers. It is kept
 * explicit only once something differs from that; otherwise the field is
 * dropped and the server's defaults keep applying. An empty `on` is not a
 * default: it means "retry on nothing" and is kept.
 */
export function withRetry(step: ServiceStep, patch: Partial<Retry>): ServiceStep {
  const merged: Retry = { on: [...DEFAULT_RETRY_ON], ...DEFAULT_RETRY, ...step.retry, ...patch };
  const isDefault = isDefaultRetryOn(merged.on) && merged.maxAttempts === DEFAULT_RETRY.maxAttempts && merged.intervalMs === DEFAULT_RETRY.intervalMs;
  if (!isDefault) return { ...step, retry: merged };
  const { retry: _retry, ...rest } = step;
  return rest as ServiceStep;
}

/** A deep copy of `step`, switched to the first of `providers` that is not its
 * own -- duplicating a step is the shortcut for a provider fallback. */
export function duplicateStep(step: ServiceStep, providers: readonly string[]): ServiceStep {
  const copy = JSON.parse(JSON.stringify(step)) as ServiceStep;
  const alternative = providers.find((p) => p !== copy.provider);
  if (alternative) copy.provider = alternative;
  return copy;
}
