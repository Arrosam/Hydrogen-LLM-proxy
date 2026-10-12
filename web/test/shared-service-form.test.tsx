/**
 * Unit tests for the pure halves of the service editors: the definition <-> form
 * mapping (lib/serviceForm), the stage tables and operations (lib/agentStage),
 * the service filters (lib/services) and `replaceAt`.
 */
import { describe, expect, it } from "vitest";
import {
  CONDITIONS, CONTEXT_BLOCKS, CONTEXT_BLOCK_MENU, GOTO_END, ROUTER, condHasValue, condIsOutput, condIsRegex, duplicateStage,
  hasLegacyInlineSteps, isModelStage, newCondition, newContextBlock, newStage, stageNameFromInput, uniqueName,
} from "../src/lib/agentStage";
import { replaceAt } from "../src/lib/collections";
import {
  EMPTY_SERVICE_FORM, blankStep, defToForm, duplicateStep, foldLegacy, formToDef, isChatPipelineForm, newServiceForm, serviceToForm,
  withRetry, type ServiceForm,
} from "../src/lib/serviceForm";
import { agentServices, chatServices, otherServices, sttServices } from "../src/lib/services";
import type { AgentDef, AgentStage, ModelService, ServiceDef, ServiceStep, ServiceSteps, Trigger } from "../src/types";

const MIB = 1024 * 1024;
const TOOL_DEFAULTS = { streamMode: "progress", maxRounds: 8, maxCalls: 16 };
const form = (over: Partial<ServiceForm> = {}): ServiceForm => ({ ...EMPTY_SERVICE_FORM, ...over });
/** def -> form -> def, starting from the blank form. */
const roundTrip = (def: ServiceDef): ServiceDef => formToDef(form(defToForm(def)));
const keys = (o: object) => Object.keys(o);
const svc = (id: number, name: string, steps: ServiceDef, extra: Partial<ModelService> = {}): ModelService => ({
  id, name, description: null, steps, enabled: true, summary: "", createdAt: id, ...extra,
});

const FULL_STEPS: ServiceSteps = {
  timeoutMs: 45000,
  steps: [
    { model: "sonnet", provider: "openai", retry: { on: [429, "timeout"], maxAttempts: 5, intervalMs: 250 }, advanceOn: [503, "exhausted"], overrides: { temperature: 0.2 } },
    { model: "haiku", provider: "anthropic" },
  ],
  category: "ocr",
  reliableStreaming: true,
  maxAttachmentBytes: 8 * MIB,
  thinkingFormat: "think_tags",
  thinkingDelimiters: { open: "<a>", close: "</a>" },
  hostedTools: { streamMode: "all", maxRounds: 4, maxCalls: 9 },
};
const STAGE: AgentStage = { name: "draft", service: "chat-a", input: [{ kind: "original_conversation" }], overrides: { topP: 0.5 } };
const FULL_AGENT: AgentDef = {
  kind: "micro_agent",
  timeoutMs: 30000,
  stages: [STAGE, { name: "route", input: [] }],
  output: "draft",
  ocr: { service: "vision", prompt: "read" },
  asr: { service: "whisper", timeoutMs: 20000 },
  maxAttachmentBytes: 2 * MIB,
  thinkingFormat: "reasoning",
  thinkingDelimiters: { open: "[", close: "]" },
  hostedTools: { streamMode: "all", maxRounds: 2, maxCalls: 3 },
};

describe("EMPTY_SERVICE_FORM", () => {
  it("is the blank Model Service: every field at its default", () => {
    expect(EMPTY_SERVICE_FORM).toEqual({
      name: "", description: "", enabled: true, toolIds: [],
      kind: "resilience", timeoutMs: 60000, category: "chat", steps: [], stages: [], output: "", ocr: undefined, asr: undefined,
      reliableStreaming: false, thinkingFormat: "original", thinkingOpen: "", thinkingClose: "", maxAttachmentMiB: 0, toolConfig: TOOL_DEFAULTS,
    });
  });

  it("saves as the shortest chat definition", () => {
    expect(formToDef(EMPTY_SERVICE_FORM)).toEqual({ timeoutMs: 60000, steps: [], hostedTools: TOOL_DEFAULTS });
  });
});

describe("defToForm", () => {
  it("maps every field of a resilience definition, and says nothing about the agent-only fields", () => {
    const f = defToForm(FULL_STEPS);
    expect(f).toEqual({
      timeoutMs: 45000, kind: "resilience", steps: FULL_STEPS.steps, category: "ocr", reliableStreaming: true,
      thinkingFormat: "think_tags", thinkingOpen: "<a>", thinkingClose: "</a>", maxAttachmentMiB: 8, toolConfig: FULL_STEPS.hostedTools,
    });
    for (const k of ["stages", "output", "ocr", "asr", "name", "description", "enabled", "toolIds"]) expect(k in f).toBe(false);
  });

  it("maps every field of an agent definition, pins category, and says nothing about steps", () => {
    const f = defToForm({ ...FULL_AGENT, reliableStreaming: true });
    expect(f).toEqual({
      timeoutMs: 30000, kind: "chain", stages: FULL_AGENT.stages, output: "draft", ocr: FULL_AGENT.ocr, asr: FULL_AGENT.asr,
      category: "chat", reliableStreaming: true,
      thinkingFormat: "reasoning", thinkingOpen: "[", thinkingClose: "]", maxAttachmentMiB: 2, toolConfig: FULL_AGENT.hostedTools,
    });
    for (const k of ["steps", "name", "description", "enabled", "toolIds"]) expect(k in f).toBe(false);
  });

  it("an agent without pre-passes sets them to undefined explicitly (the keys are present)", () => {
    const f = defToForm({ kind: "micro_agent", timeoutMs: 1, stages: [] });
    expect(["ocr" in f, "asr" in f, f.ocr, f.asr, f.output]).toEqual([true, true, undefined, undefined, ""]);
  });

  it.each([
    ["an empty object", {}],
    ["a number", 5],
    ["a string", "x"],
    ["an array", []],
  ])("falls back to every default for %s", (_name, value) => {
    expect(defToForm(value as unknown as ServiceDef)).toEqual({
      timeoutMs: 60000, kind: "resilience", steps: [], category: "chat", reliableStreaming: false,
      thinkingFormat: "original", thinkingOpen: "", thinkingClose: "", maxAttachmentMiB: 0, toolConfig: TOOL_DEFAULTS,
    });
  });

  it("throws on null, as a property read on the parsed JSON always did", () => {
    expect(() => defToForm(null as unknown as ServiceDef)).toThrow(TypeError);
  });

  it("recognises both agent kinds", () => {
    expect([defToForm({ kind: "micro_agent" } as AgentDef).kind, defToForm({ kind: "agent" } as AgentDef).kind]).toEqual(["chain", "chain"]);
    expect(defToForm({ kind: "agent" } as AgentDef).stages).toEqual([]);
  });

  it("hands out a fresh copy of the default tool limits", () => {
    const a = defToForm({ timeoutMs: 1, steps: [] }).toolConfig;
    expect(a).toEqual(TOOL_DEFAULTS);
    expect(a).not.toBe(defToForm({ timeoutMs: 1, steps: [] }).toolConfig);
  });

  it.each([
    [0, 0], [1, 0], [MIB / 2 - 1, 0], [MIB / 2, 1], [MIB, 1], [1.5 * MIB, 2], [8 * MIB, 8],
  ])("rounds an attachment budget of %d bytes to %d MiB", (bytes, mib) => {
    expect(defToForm({ timeoutMs: 1, steps: [], maxAttachmentBytes: bytes }).maxAttachmentMiB).toBe(mib);
  });

  it("reads half a delimiter pair into its own half", () => {
    const f = defToForm({ timeoutMs: 1, steps: [], thinkingDelimiters: { open: "<x>" } } as unknown as ServiceDef);
    expect([f.thinkingOpen, f.thinkingClose]).toEqual(["<x>", ""]);
  });

  it("folds legacy flat fields into overrides: a step's thinking; a stage's system, temperature, maxTokens, thinking; the OCR's temperature, maxTokens", () => {
    const step = defToForm({ timeoutMs: 1, steps: [{ model: "m", provider: "p", thinking: "high" }] }).steps![0];
    expect(step).toEqual({ model: "m", provider: "p", overrides: { thinking: "high" } });
    const agent = defToForm({
      kind: "agent", timeoutMs: 1,
      stages: [{ name: "s", input: [], system: "be brief", temperature: 0.1, maxTokens: 9, thinking: "low", overrides: { temperature: 0.9 } }],
      ocr: { service: "v", temperature: 0.3, maxTokens: 7, prompt: "p" },
    });
    expect(agent.stages![0]).toEqual({ name: "s", input: [], overrides: { system: "be brief", temperature: 0.9, maxTokens: 9, thinking: "low" } });
    expect(agent.ocr).toEqual({ service: "v", prompt: "p", overrides: { temperature: 0.3, maxTokens: 7 } });
  });

  it("leaves a definition without legacy fields untouched (same objects)", () => {
    expect(defToForm(FULL_STEPS).steps![0]).toBe(FULL_STEPS.steps[0]);
    expect(defToForm(FULL_AGENT).stages![0]).toBe(STAGE);
    expect(defToForm(FULL_AGENT).ocr).toBe(FULL_AGENT.ocr);
  });
});

describe("foldLegacy", () => {
  it("moves the named keys under overrides, existing overrides winning, and drops them from the top level", () => {
    const out = foldLegacy({ a: 1, b: 2, c: 3, overrides: { temperature: 5 } } as { a?: number; b?: number; c: number; overrides?: Record<string, unknown> }, ["a", "b"]);
    expect(out).toEqual({ c: 3, overrides: { a: 1, b: 2, temperature: 5 } });
  });

  it("returns the same object when none of the keys is set (undefined counts as unset)", () => {
    const obj = { a: undefined, c: 3 } as { a?: number; c: number; overrides?: Record<string, unknown> };
    expect(foldLegacy(obj, ["a"])).toBe(obj);
  });
});

describe("formToDef", () => {
  it("writes a resilience definition's keys in the order the raw view shows", () => {
    const def = formToDef(form(defToForm(FULL_STEPS)));
    expect(keys(def)).toEqual(["timeoutMs", "steps", "category", "reliableStreaming", "maxAttachmentBytes", "thinkingFormat", "thinkingDelimiters", "hostedTools"]);
    expect(def).toEqual(FULL_STEPS);
  });

  it("writes an agent definition's keys in the order the raw view shows", () => {
    const def = formToDef(form(defToForm(FULL_AGENT)));
    expect(keys(def)).toEqual(["kind", "timeoutMs", "stages", "output", "ocr", "asr", "maxAttachmentBytes", "thinkingFormat", "thinkingDelimiters", "hostedTools"]);
    expect(def).toEqual(FULL_AGENT);
  });

  it("omits what is at its default: category chat, reliable streaming off, no budget, format original, no delimiters, no output, no pre-pass", () => {
    expect(keys(formToDef(form()))).toEqual(["timeoutMs", "steps", "hostedTools"]);
    expect(keys(formToDef(form({ kind: "chain" })))).toEqual(["kind", "timeoutMs", "stages", "hostedTools"]);
  });

  it.each(["image", "video", "tts", "stt", "embedding", "rerank"] as const)(
    "category %s drops reliable streaming, thinking and the tool limits, but still sends the attachment budget",
    (category) => {
      const def = formToDef(form({ category, reliableStreaming: true, thinkingFormat: "none", thinkingOpen: "a", thinkingClose: "b", maxAttachmentMiB: 3 }));
      expect(def).toEqual({ timeoutMs: 60000, steps: [], category, maxAttachmentBytes: 3 * MIB });
    },
  );

  it("category ocr keeps everything chat has", () => {
    const def = formToDef(form({ category: "ocr", reliableStreaming: true, thinkingFormat: "none" }));
    expect(def).toEqual({ timeoutMs: 60000, steps: [], category: "ocr", reliableStreaming: true, thinkingFormat: "none", hostedTools: TOOL_DEFAULTS });
  });

  it("an agent ignores the form's category, carries reliable streaming through, and always has thinking and tool limits", () => {
    const def = formToDef(form({ kind: "chain", category: "image", reliableStreaming: true, thinkingFormat: "none" }));
    expect(def).toEqual({ kind: "micro_agent", timeoutMs: 60000, stages: [], reliableStreaming: true, thinkingFormat: "none", hostedTools: TOOL_DEFAULTS });
  });

  it.each([
    ["both halves", "<a>", "</a>", { thinkingDelimiters: { open: "<a>", close: "</a>" } }],
    ["only the opening", "<a>", "", {}],
    ["only the closing", "", "</a>", {}],
    ["neither", "", "", {}],
  ])("delimiters are written as a pair or not at all: %s", (_name, thinkingOpen, thinkingClose, expected) => {
    expect(formToDef(form({ thinkingOpen, thinkingClose }))).toEqual({ timeoutMs: 60000, steps: [], ...expected, hostedTools: TOOL_DEFAULTS });
  });

  it("writes the delimiters after a non-default format", () => {
    const def = formToDef(form({ thinkingFormat: "reasoning", thinkingOpen: "a", thinkingClose: "b" }));
    expect(keys(def)).toEqual(["timeoutMs", "steps", "thinkingFormat", "thinkingDelimiters", "hostedTools"]);
  });

  it.each([[0, false], [1, true], [-1, false]])("an attachment budget of %d MiB is written: %s", (maxAttachmentMiB, written) => {
    const def = formToDef(form({ maxAttachmentMiB }));
    expect("maxAttachmentBytes" in def).toBe(written);
    if (written) expect(def.maxAttachmentBytes).toBe(maxAttachmentMiB * MIB);
  });

  it("passes the form's lists through by reference, and a zero timeout as 0", () => {
    const steps: ServiceStep[] = [{ model: "m", provider: "p" }];
    const def = formToDef(form({ steps, timeoutMs: 0 })) as ServiceSteps;
    expect([def.steps === steps, def.timeoutMs]).toEqual([true, 0]);
  });
});

describe("the round trip is deliberately not an identity in four cases", () => {
  it("is an identity for a definition with every field set", () => {
    expect(roundTrip(FULL_STEPS)).toEqual(FULL_STEPS);
    expect(roundTrip(FULL_AGENT)).toEqual(FULL_AGENT);
  });

  it("1. adds the default tool limits to a chat definition stored without them", () => {
    expect(roundTrip({ timeoutMs: 5, steps: [] })).toEqual({ timeoutMs: 5, steps: [], hostedTools: TOOL_DEFAULTS });
  });

  it("2. saves the legacy kind 'agent' as 'micro_agent'", () => {
    expect(roundTrip({ kind: "agent", timeoutMs: 5, stages: [] })).toEqual({ kind: "micro_agent", timeoutMs: 5, stages: [], hostedTools: TOOL_DEFAULTS });
  });

  it("3. folds legacy flat fields into overrides, existing overrides winning", () => {
    const def = roundTrip({ timeoutMs: 5, steps: [{ model: "m", provider: "p", thinking: "high", overrides: { thinking: "low", topP: 1 } }] }) as ServiceSteps;
    expect(def.steps).toEqual([{ model: "m", provider: "p", overrides: { thinking: "low", topP: 1 } }]);
  });

  it("4. drops an explicit 'original' format and half a delimiter pair", () => {
    const def = roundTrip({ timeoutMs: 5, steps: [], thinkingFormat: "original", thinkingDelimiters: { open: "<a>", close: "" } });
    expect(def).toEqual({ timeoutMs: 5, steps: [], hostedTools: TOOL_DEFAULTS });
  });

  it("also normalises: a missing timeout becomes 60000, an explicit default category and false flag disappear", () => {
    const def = roundTrip({ steps: [], category: "chat", reliableStreaming: false, maxAttachmentBytes: 1.4 * MIB } as unknown as ServiceDef);
    expect(def).toEqual({ timeoutMs: 60000, steps: [], maxAttachmentBytes: 1.4 * MIB, hostedTools: TOOL_DEFAULTS });
  });

  it("drops keys the form does not know", () => {
    expect(roundTrip({ timeoutMs: 5, steps: [], mystery: 1 } as unknown as ServiceDef)).toEqual({ timeoutMs: 5, steps: [], hostedTools: TOOL_DEFAULTS });
  });
});

describe("merging a definition over a live form (the raw view switching back)", () => {
  const live = form({
    name: "keep", description: "me", enabled: false, toolIds: [7],
    kind: "chain", stages: [STAGE], output: "draft", ocr: { service: "v" }, asr: { service: "w" }, steps: [{ model: "old", provider: "p" }],
    timeoutMs: 1, thinkingFormat: "none", thinkingOpen: "a", thinkingClose: "b", maxAttachmentMiB: 4, toolConfig: { streamMode: "all", maxRounds: 1, maxCalls: 1 },
  });

  it("an empty object resets the definition fields and tool limits, never name, description, enabled or bound tools", () => {
    const next = { ...live, ...defToForm({} as ServiceDef) };
    expect([next.name, next.description, next.enabled, next.toolIds]).toEqual(["keep", "me", false, [7]]);
    expect([next.kind, next.timeoutMs, next.category, next.reliableStreaming, next.thinkingFormat, next.thinkingOpen, next.thinkingClose, next.maxAttachmentMiB, next.toolConfig])
      .toEqual(["resilience", 60000, "chat", false, "original", "", "", 0, TOOL_DEFAULTS]);
    expect(next.steps).toEqual([]);
  });

  it("a resilience definition leaves the stages, output and both pre-passes in the form", () => {
    const next = { ...live, ...defToForm({ timeoutMs: 2, steps: [] }) };
    expect([next.stages, next.output, next.ocr, next.asr]).toEqual([[STAGE], "draft", { service: "v" }, { service: "w" }]);
  });

  it("an agent definition leaves the steps in the form, and replaces both pre-passes even with nothing", () => {
    const next = { ...live, ...defToForm({ kind: "micro_agent", timeoutMs: 2, stages: [] }) };
    expect(next.steps).toEqual([{ model: "old", provider: "p" }]);
    expect([next.stages, next.output, next.ocr, next.asr]).toEqual([[], "", undefined, undefined]);
  });
});

describe("serviceToForm / newServiceForm (opening the editor)", () => {
  const dirty = form({ stages: [STAGE], output: "draft", ocr: { service: "v" }, asr: { service: "w" }, steps: [{ model: "old", provider: "p" }], name: "old", toolIds: [9] });

  it("a stored Model Service fills the record fields and clears the agent lists and both pre-passes", () => {
    const next = { ...dirty, ...serviceToForm(svc(1, "svc", FULL_STEPS, { description: "d", enabled: false, toolIds: [1] })) };
    expect([next.name, next.description, next.enabled, next.toolIds]).toEqual(["svc", "d", false, [1]]);
    expect([next.stages, next.output, next.ocr]).toEqual([[], "", undefined]);
    expect(next.asr).toBeUndefined();
    expect(formToDef(next)).toEqual(FULL_STEPS);
  });

  it("a stored Micro Agent clears the steps and takes its own pre-passes", () => {
    const next = { ...dirty, ...serviceToForm(svc(2, "agent", FULL_AGENT)) };
    expect([next.steps, next.asr, next.ocr]).toEqual([[], FULL_AGENT.asr, FULL_AGENT.ocr]);
    expect(formToDef(next)).toEqual(FULL_AGENT);
  });

  it("a null description is the empty string and missing tool ids none", () => {
    const f = serviceToForm(svc(1, "svc", { timeoutMs: 1, steps: [] }));
    expect([f.description, f.toolIds]).toEqual(["", []]);
  });

  it("a new Model Service is the blank form with its first step, a previous ASR pre-pass included", () => {
    const patch = newServiceForm("resilience", blankStep("m", "p"));
    expect("asr" in patch).toBe(true);
    const next = { ...dirty, ...patch };
    expect(next).toEqual({ ...EMPTY_SERVICE_FORM, steps: [{ model: "m", provider: "p" }] });
  });

  it("a new service with nothing to start from has no step; a new Micro Agent has kind chain", () => {
    expect(newServiceForm("resilience", null).steps).toEqual([]);
    expect([newServiceForm("chain", null).kind, newServiceForm("chain", null).steps]).toEqual(["chain", []]);
  });

  it("a new service gets its own copy of the default tool limits", () => {
    expect(newServiceForm("chain", null).toolConfig).not.toBe(EMPTY_SERVICE_FORM.toolConfig);
  });
});

describe("isChatPipelineForm", () => {
  it.each([
    ["resilience", "chat", true], ["resilience", "ocr", true], ["resilience", "image", false], ["resilience", "stt", false],
    ["chain", "chat", true], ["chain", "image", true],
  ] as const)("%s / %s -> %s", (kind, category, expected) => {
    expect(isChatPipelineForm({ kind, category })).toBe(expected);
  });
});

describe("withRetry", () => {
  const bare: ServiceStep = { model: "m", provider: "p" };
  const DEFAULT_ON = [429, 499, 502, 503, "timeout", "network"];

  it("starts an explicit policy from the server defaults", () => {
    expect(withRetry(bare, { maxAttempts: 5 })).toEqual({ ...bare, retry: { on: DEFAULT_ON, maxAttempts: 5, intervalMs: 0 } });
    expect(withRetry(bare, { intervalMs: 10 })).toEqual({ ...bare, retry: { on: DEFAULT_ON, maxAttempts: 3, intervalMs: 10 } });
    expect(withRetry(bare, { on: [429] })).toEqual({ ...bare, retry: { on: [429], maxAttempts: 3, intervalMs: 0 } });
  });

  it("patches an existing policy", () => {
    const step = { ...bare, retry: { on: [429 as const], maxAttempts: 5, intervalMs: 9 } };
    expect(withRetry(step, { intervalMs: 1 }).retry).toEqual({ on: [429], maxAttempts: 5, intervalMs: 1 });
  });

  it("drops the policy once it is 3 attempts, no interval and the default triggers; a patch that changes nothing on a bare step keeps it bare", () => {
    const step = { ...bare, advanceOn: [503 as const], retry: { on: [429, 499, 502, 503, "timeout", "network"] as Trigger[], maxAttempts: 5, intervalMs: 0 } };
    const out = withRetry(step, { maxAttempts: 3 });
    expect(out).toEqual({ ...bare, advanceOn: [503] });
    expect("retry" in out).toBe(false);
    expect("retry" in withRetry(bare, { maxAttempts: 3 })).toBe(false);
  });

  it("keeps a policy that differs in any one part", () => {
    expect("retry" in withRetry({ ...bare, retry: { on: [429], maxAttempts: 3, intervalMs: 0 } }, { maxAttempts: 3 })).toBe(true);
    expect("retry" in withRetry({ ...bare, retry: { on: [], maxAttempts: 3, intervalMs: 1 } }, { maxAttempts: 3 })).toBe(true);
  });

  it("does not mutate the step", () => {
    const step = { ...bare, retry: { on: [], maxAttempts: 5, intervalMs: 0 } };
    withRetry(step, { maxAttempts: 3 });
    expect(step.retry).toEqual({ on: [], maxAttempts: 5, intervalMs: 0 });
  });
});

describe("duplicateStep / blankStep", () => {
  const step: ServiceStep = { model: "m", provider: "a", overrides: { stop: ["x"] } };

  it("copies deeply and switches to the first other provider", () => {
    const copy = duplicateStep(step, ["a", "b", "c"]);
    expect(copy).toEqual({ ...step, provider: "b" });
    expect(copy.overrides).not.toBe(step.overrides);
    expect(duplicateStep({ ...step, provider: "b" }, ["a", "b"]).provider).toBe("a");
  });

  it.each([[["a"]], [[]]])("keeps the provider when there is no other (%j)", (providers) => {
    expect(duplicateStep(step, providers)).toEqual(step);
  });

  it("a blank step has no retry policy", () => {
    expect(blankStep("m", "p")).toEqual({ model: "m", provider: "p" });
  });
});

describe("agentStage: context blocks", () => {
  it("lists the eight kinds once, in menu order, plus the 'Plain text' alias of message", () => {
    expect(keys(CONTEXT_BLOCKS)).toEqual(["original_conversation", "text_conversation", "last_user", "last_user_text", "last_user_images", "stage_output", "message", "tool_turn"]);
    expect(CONTEXT_BLOCK_MENU.map((m) => [m.value, m.kind, m.labelKey])).toEqual([
      ["original_conversation", "original_conversation", "contextBlock.originalConversation"],
      ["text_conversation", "text_conversation", "contextBlock.textConversation"],
      ["last_user", "last_user", "contextBlock.lastUser"],
      ["last_user_text", "last_user_text", "contextBlock.lastUserText"],
      ["last_user_images", "last_user_images", "contextBlock.lastUserImages"],
      ["stage_output", "stage_output", "contextBlock.stageOutput"],
      ["message", "message", "contextBlock.message"],
      ["tool_turn", "tool_turn", "contextBlock.toolTurn"],
      ["plain_text", "message", "contextBlock.plainText"],
    ]);
  });

  it("only the five conversation kinds carry a hint", () => {
    expect(Object.entries(CONTEXT_BLOCKS).map(([k, s]) => [k, s.hintKey])).toEqual([
      ["original_conversation", "blockHint.originalConversation"], ["text_conversation", "blockHint.textConversation"], ["last_user", "blockHint.lastUser"],
      ["last_user_text", "blockHint.lastUserText"], ["last_user_images", "blockHint.lastUserImages"],
      ["stage_output", undefined], ["message", undefined], ["tool_turn", undefined],
    ]);
  });

  it.each([
    ["original_conversation", { kind: "original_conversation" }],
    ["text_conversation", { kind: "text_conversation" }],
    ["last_user", { kind: "last_user" }],
    ["last_user_text", { kind: "last_user_text" }],
    ["last_user_images", { kind: "last_user_images" }],
    ["stage_output", { kind: "stage_output", stage: "one", role: "assistant" }],
    ["message", { kind: "message", role: "user", text: "" }],
    ["plain_text", { kind: "message", role: "user", text: "" }],
    ["tool_turn", { kind: "tool_turn", name: "", input: "", result: "" }],
    ["anything else", { kind: "original_conversation" }],
  ])("menu entry %s adds %j", (value, block) => {
    expect(newContextBlock(value, ["one", "two"])).toEqual(block);
  });

  it("a stage_output block with no earlier stage names none", () => {
    expect(newContextBlock("stage_output", [])).toEqual({ kind: "stage_output", stage: "", role: "assistant" });
  });
});

describe("agentStage: conditions", () => {
  it("lists the six conditions in menu order", () => {
    expect(CONDITIONS.map((c) => [c.type, c.labelKey])).toEqual([
      ["always", "condition.always"], ["input_has_image", "condition.inputHasImage"], ["input_contains", "condition.inputContains"],
      ["input_matches", "condition.inputMatches"], ["output_contains", "condition.outputContains"], ["output_matches", "condition.outputMatches"],
    ]);
  });

  it.each([
    ["always", false, false, false, { type: "always" }],
    ["input_has_image", false, false, false, { type: "input_has_image" }],
    ["input_contains", true, false, false, { type: "input_contains", value: "" }],
    ["input_matches", true, false, true, { type: "input_matches", value: "" }],
    ["output_contains", true, true, false, { type: "output_contains", value: "" }],
    ["output_matches", true, true, true, { type: "output_matches", value: "" }],
  ] as const)("%s: has a value %s, reads an output %s, is a regex %s", (type, hasValue, isOutput, isRegex, fresh) => {
    expect([condHasValue({ type }), condIsOutput({ type }), condIsRegex({ type })]).toEqual([hasValue, isOutput, isRegex]);
    expect(newCondition(type)).toEqual(fresh);
  });

  it("names its two sentinels", () => {
    expect([ROUTER, GOTO_END]).toEqual(["__router__", "end"]);
  });
});

describe("agentStage: stages", () => {
  const stages: AgentStage[] = [{ name: "stage", input: [] }, { name: "stage2", input: [] }, { name: "draft", input: [], service: "s" }];

  it("uniqueName returns the base when free, else the first free number from 2", () => {
    expect([uniqueName(stages, "new"), uniqueName(stages, "draft"), uniqueName(stages, "stage"), uniqueName([], "stage")]).toEqual(["new", "draft2", "stage3", "stage"]);
  });

  it("newStage is named 'stage' (made unique), has no input, and runs the given service if any", () => {
    expect(newStage([], "svc")).toEqual({ name: "stage", input: [], service: "svc" });
    expect(newStage(stages, undefined)).toEqual({ name: "stage3", input: [] });
    expect("service" in newStage(stages, undefined)).toBe(false);
  });

  it("duplicateStage copies deeply under name_copy, then name_copy2", () => {
    const src: AgentStage = { name: "draft", input: [{ kind: "last_user" }], service: "s" };
    const copy = duplicateStage(stages, src);
    expect(copy).toEqual({ ...src, name: "draft_copy" });
    expect(copy.input).not.toBe(src.input);
    expect(duplicateStage([...stages, copy], src).name).toBe("draft_copy2");
  });

  it("isModelStage / hasLegacyInlineSteps", () => {
    const step = { model: "m", provider: "p" };
    const cases = [{}, { service: "s" }, { steps: [] }, { steps: [step] }, { service: "s", steps: [step] }];
    expect(cases.map((c) => [isModelStage(c), hasLegacyInlineSteps(c)])).toEqual([[false, false], [true, false], [false, false], [true, true], [true, false]]);
  });

  it("stageNameFromInput turns each run of whitespace into one underscore", () => {
    expect([stageNameFromInput("a b"), stageNameFromInput(" a \t b "), stageNameFromInput("ab")]).toEqual(["a_b", "_a_b_", "ab"]);
  });
});

describe("services filters", () => {
  const list = [
    svc(1, "chat", { timeoutMs: 1, steps: [] }),
    svc(2, "ocr", { timeoutMs: 1, steps: [], category: "ocr" }),
    svc(3, "image", { timeoutMs: 1, steps: [], category: "image" }),
    svc(4, "stt", { timeoutMs: 1, steps: [], category: "stt" }),
    svc(5, "agent", { kind: "micro_agent", timeoutMs: 1, stages: [] }),
    svc(6, "legacy-agent", { kind: "agent", timeoutMs: 1, stages: [] }),
  ];
  const names = (l: ModelService[]) => l.map((s) => s.name);

  it("chatServices: chat and ocr Model Services, never agents or media categories", () => {
    expect(names(chatServices(list))).toEqual(["chat", "ocr"]);
  });
  it("agentServices: both agent kinds", () => {
    expect(names(agentServices(list))).toEqual(["agent", "legacy-agent"]);
  });
  it("sttServices: only the stt category", () => {
    expect(names(sttServices(list))).toEqual(["stt"]);
  });
  it("otherServices: all but the one being edited; all of them for a new service", () => {
    expect(names(otherServices(list, list[1]))).toEqual(["chat", "image", "stt", "agent", "legacy-agent"]);
    expect(otherServices(list, null)).toHaveLength(6);
  });
});

describe("replaceAt", () => {
  it("replaces the item whole (no merge) and leaves the list alone", () => {
    const list = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
    const next = replaceAt<{ a: number; b?: number }>(list, 0, { a: 9 });
    expect(next).toEqual([{ a: 9 }, { a: 3, b: 4 }]);
    expect([next[1] === list[1], list[0]]).toEqual([true, { a: 1, b: 2 }]);
  });
  it("an index out of range changes nothing", () => {
    expect(replaceAt([1, 2], 5, 9)).toEqual([1, 2]);
  });
});
