/**
 * Characterization of the ServiceEditor as a Micro Agent editor, which is where
 * StageEditor, OcrEditor and AsrEditor live: the agent definition it loads and
 * the exact payload it saves, stages (add / duplicate / remove / reorder),
 * context blocks, transitions, the per-stage advanced overrides, the OCR and
 * ASR pre-pass editors, the OCR tester, and their markup classes.
 */
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { ServiceEditor } from "../src/components/ServiceEditor";
import defaultOcrTestImage from "../src/assets/ocr-test-default.png";
import { formatNumber } from "../src/lib/format";
import type { AgentDef, AgentStage, HostedTool, ModelService, ServiceDef, User } from "../src/types";
import {
  ADMIN, MANAGER, button, classes, cls, deferred, fail, field, hasButton, iconButton, isOn, labelEl, mockApi, openModal,
  renderPage, toastShown, toggle, type, type MockApi, type Routes,
} from "./helpers";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

type Props = ComponentProps<typeof ServiceEditor>;
interface Body { name: string; description: string | null; steps: Record<string, unknown>; enabled: boolean; toolIds?: number[] }

const JSON_HEADERS = { "content-type": "application/json" };
const sentJson = (method: string, path: string, body: unknown) => ({ method, path, body, headers: JSON_HEADERS, credentials: "same-origin" });
const MIB = 1024 * 1024;
const TOOL_DEFAULTS = { streamMode: "progress", maxRounds: 8, maxCalls: 16 };
const TOOLS: HostedTool[] = [{
  id: 1, name: "search", description: "", parameters: {}, url: "https://t", bodyTemplate: null, resultPath: "", timeoutMs: 1000, maxResultBytes: 1000, enabled: true, headerNames: [], hasHeaders: false,
}];

const service = (id: number, name: string, steps: ServiceDef, extra: Partial<ModelService> = {}): ModelService => ({
  id, name, description: null, steps, enabled: true, summary: "", createdAt: id, ...extra,
});
const STEP = { model: "sonnet", provider: "openai" };
const CHAT = service(20, "chat-a", { timeoutMs: 60000, steps: [STEP] });
const OCR = service(21, "ocr-b", { timeoutMs: 60000, steps: [STEP], category: "ocr" });
const IMAGE = service(22, "painter", { timeoutMs: 60000, steps: [STEP], category: "image" });
const STT = service(23, "whisper", { timeoutMs: 60000, steps: [STEP], category: "stt" });
const STT2 = service(24, "whisper-2", { timeoutMs: 60000, steps: [STEP], category: "stt" });
const SUB_AGENT = service(25, "sub-agent", { kind: "micro_agent", timeoutMs: 60000, stages: [] });
const LEGACY_AGENT = service(26, "old-agent", { kind: "agent", timeoutMs: 60000, stages: [] });
const SERVICES = [CHAT, OCR, IMAGE, STT, STT2, SUB_AGENT, LEGACY_AGENT];

/** Every field the agent form knows, none at its default, in the order the editor writes them. */
const FULL: AgentDef = {
  kind: "micro_agent",
  timeoutMs: 30000,
  stages: [
    { name: "draft", service: "chat-a", input: [{ kind: "last_user" }] },
    {
      name: "check",
      service: "sub-agent",
      input: [
        { kind: "stage_output", stage: "draft", role: "assistant" },
        { kind: "tool_turn", name: "lookup", input: '{"q":1}', result: "none", isError: true },
        { kind: "message", role: "assistant", text: "verdict?" },
      ],
      tools: "none",
      overrides: { temperature: 0 },
      timeoutMs: 5000,
      transitions: [
        { when: { type: "output_contains", value: "bad", stage: "draft" }, goto: "end", output: "draft" },
        { when: { type: "always" }, goto: "final" },
      ],
    },
    { name: "final", service: "ocr-b", input: [{ kind: "text_conversation" }] },
  ],
  output: "final",
  ocr: { service: "ocr-b", prompt: "read it", overrides: { maxTokens: 100 }, timeoutMs: 7000 },
  asr: { service: "whisper", timeoutMs: 20000 },
  maxAttachmentBytes: 4 * MIB,
  thinkingFormat: "none",
  thinkingDelimiters: { open: "<a>", close: "</a>" },
  hostedTools: { streamMode: "all", maxRounds: 4, maxCalls: 9 },
};
const FULL_SVC = service(5, "agent", FULL, { description: "desc", enabled: false, toolIds: [1] });
const FULL_BODY: Body = { name: "agent", description: "desc", steps: FULL as unknown as Record<string, unknown>, enabled: false, toolIds: [1] };
const NEW_AGENT = { kind: "micro_agent", timeoutMs: 60000, stages: [], hostedTools: TOOL_DEFAULTS };
const agent = (stages: AgentStage[], extra: Partial<AgentDef> = {}): AgentDef => ({ kind: "micro_agent", timeoutMs: 60000, stages, ...extra });
const THREE = agent([{ name: "a", service: "chat-a", input: [] }, { name: "b", service: "ocr-b", input: [] }, { name: "c", service: "chat-a", input: [] }]);

const setup = async (props: Partial<Props> = {}, routes: Routes = {}, me: User = ADMIN) => {
  const api = mockApi({ "GET /tools": { tools: TOOLS }, "POST /services": {}, "PATCH /services/5": {}, ...routes }, me);
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const view = await renderPage(
    <ServiceEditor open service={null} services={SERVICES} models={[]} providers={[]} mappings={[]} defaultKind="chain" onClose={onClose} onSaved={onSaved} {...props} />,
  );
  if (me.role === "admin") await screen.findByText("Hosted server tools");
  return { api, onClose, onSaved, ...view };
};
const edit = (def: ServiceDef, props: Partial<Props> = {}, routes: Routes = {}) => setup({ service: service(5, "agent", def), ...props }, routes);

const save = async (api: MockApi) => {
  const before = api.mutations().filter((c) => c.path.startsWith("/services") && !c.path.includes("test")).length;
  fireEvent.click(button("Save"));
  await waitFor(() => expect(api.mutations().filter((c) => c.path.startsWith("/services") && !c.path.includes("test"))).toHaveLength(before + 1));
  return api.mutations().filter((c) => !c.path.includes("test"))[before];
};
const savedSteps = async (api: MockApi) => ((await save(api)).body as Body).steps;
const savedStages = async (api: MockApi) => (await savedSteps(api)).stages as Record<string, unknown>[];
const savedStage = async (api: MockApi, i: number) => (await savedStages(api))[i];

const EDITOR_CARD = "rounded-xl border border-ink-700 bg-ink-850/70 p-3";
const PANEL = "rounded-lg border border-ink-800 bg-ink-950/40 p-3";
const ROW = "rounded-lg border border-ink-800 bg-ink-900/60 p-2 text-xs";
const DISCLOSURE = "text-xs text-ink-500 hover:text-ink-300";
const STAGE_ADVANCED = "Advanced (tools, parameter overrides, timeout)";
const OCR_ADVANCED = "Advanced (prompt, parameter overrides, timeout)";
const ASR_TOGGLE = "Audio transcription (ASR) pre-pass";
const OCR_TOGGLE = "Translate images to text (OCR pre-pass)";
/** In an agent the editor cards are, in order: OCR, ASR, then one per stage. */
const cards = () => [...document.querySelectorAll<HTMLElement>(".rounded-xl.bg-ink-850\\/70")];
const ocrCard = () => cards()[0];
const asrCard = () => cards()[1];
const stages = () => cards().slice(2);
const stage = (i: number) => stages()[i];
const stageName = (c: HTMLElement) => c.querySelector<HTMLInputElement>('input[placeholder="stage name"]')!;
const stageNames = () => stages().map((c) => stageName(c).value);
const runs = (c: HTMLElement) => field<HTMLSelectElement>("Runs", c);
const section = (c: HTMLElement, label: string) => labelEl(label, c).closest(".mt-3") as HTMLElement;
const rows = (c: HTMLElement, label: string) => [...section(c, label).children[1].children] as HTMLElement[];
const blocks = (c: HTMLElement) => rows(c, "Input");
const transitions = (c: HTMLElement) => rows(c, "Transitions");
const blockKinds = (c: HTMLElement) => blocks(c).map((b) => b.querySelector(".badge-gray")!.textContent);
const addBlock = (c: HTMLElement, kind: string) => type(labelEl("Input", c).parentElement!.querySelector("select")!, kind);
const selects = (el: HTMLElement) => [...el.querySelectorAll<HTMLSelectElement>("select")];
const options = (select: HTMLSelectElement) => [...select.options].map((o) => [o.value, o.textContent]);
const openAdvanced = (c: HTMLElement) => {
  fireEvent.click(button(STAGE_ADVANCED, c));
  return button(STAGE_ADVANCED, c).nextElementSibling as HTMLElement;
};
const ocrPrompt = () => ocrCard().querySelector<HTMLTextAreaElement>("textarea.min-h-\\[120px\\]")!;
const overrideContent = (within: HTMLElement) => within.querySelector<HTMLInputElement>('input[placeholder="content — JSON or text"]')!;
const drag = (from: number, to: number) => {
  fireEvent.dragStart(stage(from).querySelector("[draggable]")!);
  fireEvent.drop(stage(to));
};

// ---------------------------------------------------------------------------

describe("ServiceEditor: a new Micro Agent", () => {
  it("is titled for the kind, with no service type or reliable-streaming control", async () => {
    await setup();
    const m = openModal("New Micro Agent");
    expect(classes(m)).toEqual(cls("card flex max-h-[92vh] w-full flex-col max-w-4xl"));
    expect(classes(m.querySelector("h2 i"))).toEqual(cls("bi bi-robot text-brand-400"));
    expect(screen.queryByText("Service type")).toBeNull();
    expect(screen.queryByText("Reliable streaming")).toBeNull();
    expect(screen.queryByText("Failure chain (drag to reorder)")).toBeNull();
    expect([field("Name (exposed model name)").value, field("Per-attempt timeout (ms)").value, field("Description (optional)").value]).toEqual(["", "60000", ""]);
    expect(isOn(toggle("Enabled"))).toBe(true);
    expect(field("search").checked).toBe(false);
    expect([field<HTMLSelectElement>("Streaming delivery").value, field("Maximum model rounds").value, field("Maximum tool calls").value]).toEqual(["progress", "8", "16"]);
    expect([field<HTMLSelectElement>("Thinking format").value, field("Thinking starts with").value, field("Thinking ends with").value]).toEqual(["original", "", ""]);
    expect(field("Attachment inlining budget (MiB)").value).toBe("0");
    expect(classes(screen.getByText(/^Micro Agent: a decision tree of stages/))).toEqual(cls("text-xs text-ink-500"));
  });

  it("starts with both pre-passes off and no stage", async () => {
    await setup();
    expect(cards()).toHaveLength(2);
    expect(classes(ocrCard().parentElement)).toEqual(["space-y-4"]);
    expect([classes(ocrCard()), classes(asrCard())]).toEqual([cls(EDITOR_CARD), cls(EDITOR_CARD)]);
    expect([isOn(toggle(OCR_TOGGLE)), isOn(toggle(ASR_TOGGLE))]).toEqual([false, false]);
    expect(classes(screen.getByText(/^Before the chain runs, every image in the request/))).toEqual(cls("mt-1 text-xs text-ink-500"));
    expect(classes(screen.getByText(/^Transcribe input_audio attachments to text/))).toEqual(cls("mt-1 text-xs text-ink-500"));
    expect(ocrCard().querySelector("select")).toBeNull();
    expect(asrCard().querySelector("select")).toBeNull();

    const heading = screen.getByText("Stages (run from the top; transitions branch to later stages)");
    expect([heading.tagName, classes(heading)]).toEqual(["SPAN", cls("label mb-0")]);
    expect(classes(heading.parentElement)).toEqual(cls("mb-2 flex items-center justify-between"));
    const add = button("Add stage");
    expect([classes(add), add.querySelector("i")!.className]).toEqual([cls("btn-ghost btn-xs"), "bi bi-plus-lg"]);
    const hint = screen.getByText("No stages. Add one; each stage runs a Model Service or Micro Agent (or routes on conditions).");
    expect(classes(hint)).toEqual(cls("rounded-lg border border-dashed border-ink-700 px-4 py-6 text-center text-xs text-ink-500"));
    expect(screen.queryByText("Return the output of")).toBeNull();
    expect(screen.queryByText(/^No Model Services exist yet\. Create one first/)).toBeNull();
  });

  it("creates with POST /services as a micro_agent and says so", async () => {
    const { api, onClose, onSaved } = await setup();
    type(field("Name (exposed model name)"), "fresh");
    expect(await save(api)).toEqual(sentJson("POST", "/services", { name: "fresh", description: null, steps: NEW_AGENT, enabled: true, toolIds: [] }));
    await toastShown("Micro Agent created");
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a manager sends no toolIds", async () => {
    const { api } = await setup({}, {}, MANAGER);
    expect(screen.queryByText("Hosted server tools")).toBeNull();
    type(field("Name (exposed model name)"), "fresh");
    expect((await save(api)).body).toEqual({ name: "fresh", description: null, steps: NEW_AGENT, enabled: true });
  });

  it("warns when there is no service at all to run", async () => {
    await setup({ services: [] });
    const warning = screen.getByText("No Model Services exist yet. Create one first — each stage runs a Model Service (or another Micro Agent).");
    expect(classes(warning)).toEqual(cls("mb-2 rounded-lg border border-amber-700/40 bg-amber-700/10 px-3 py-2 text-xs text-amber-300"));
  });

  it("the raw view is labelled Chain JSON and shows the agent definition", async () => {
    await setup();
    fireEvent.click(button("Raw JSON"));
    const area = field<HTMLTextAreaElement>("Chain JSON");
    expect(area.value).toBe(JSON.stringify(NEW_AGENT, null, 2));
    expect(cards()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("ServiceEditor: editing a Micro Agent", () => {
  it("fills the form from the stored definition", async () => {
    await setup({ service: FULL_SVC });
    expect(classes(openModal('Edit "agent"').querySelector("h2 i"))).toEqual(cls("bi bi-robot text-brand-400"));
    expect([field("Name (exposed model name)").value, field("Per-attempt timeout (ms)").value, field("Description (optional)").value]).toEqual(["agent", "30000", "desc"]);
    expect([isOn(toggle("Enabled")), field("search").checked]).toEqual([false, true]);
    expect([field<HTMLSelectElement>("Streaming delivery").value, field("Maximum model rounds").value, field("Maximum tool calls").value]).toEqual(["all", "4", "9"]);
    expect([field<HTMLSelectElement>("Thinking format").value, field("Thinking starts with").value, field("Thinking ends with").value]).toEqual(["none", "<a>", "</a>"]);
    expect(field("Attachment inlining budget (MiB)").value).toBe("4");
    expect([isOn(toggle(OCR_TOGGLE)), field<HTMLSelectElement>("OCR model runs", ocrCard()).value]).toEqual([true, "ocr-b"]);
    expect([isOn(toggle(ASR_TOGGLE)), field<HTMLSelectElement>("STT Model Service", asrCard()).value, field("Timeout (ms)", asrCard()).value]).toEqual([true, "whisper", "20000"]);
    expect(stageNames()).toEqual(["draft", "check", "final"]);
    expect(stages().map((c) => runs(c).value)).toEqual(["chat-a", "sub-agent", "ocr-b"]);
    expect(stages().map(blockKinds)).toEqual([["Last user request"], ["Output from another stage", "Tool use turn", "New conversation turn"], ["Text-only conversation"]]);
    expect(stages().map((c) => transitions(c).length)).toEqual([0, 2, 0]);
    expect(field<HTMLSelectElement>("Return the output of").value).toBe("final");
  });

  it("round-trips: saving an untouched definition PATCHes exactly what was stored", async () => {
    const { api } = await setup({ service: FULL_SVC });
    expect(await save(api)).toEqual(sentJson("PATCH", "/services/5", FULL_BODY));
    await toastShown("Micro Agent updated");
  });

  it("writes the definition's keys in a fixed order in the raw view", async () => {
    await setup({ service: FULL_SVC });
    fireEvent.click(button("Raw JSON"));
    const area = field<HTMLTextAreaElement>("Chain JSON");
    expect(area.value).toBe(JSON.stringify(FULL, null, 2));
    expect(Object.keys(JSON.parse(area.value) as object)).toEqual([
      "kind", "timeoutMs", "stages", "output", "ocr", "asr", "maxAttachmentBytes", "thinkingFormat", "thinkingDelimiters", "hostedTools",
    ]);
  });

  const withDef = (patch: Record<string, unknown>, drop: string[] = []): Body => {
    const steps: Record<string, unknown> = { ...FULL_BODY.steps, ...patch };
    for (const k of drop) delete steps[k];
    return { ...FULL_BODY, steps };
  };
  const withStage = (i: number, patch: Record<string, unknown>, drop: string[] = []): Body => withDef({
    stages: FULL.stages.map((s, idx) => {
      if (idx !== i) return s;
      const next: Record<string, unknown> = { ...s, ...patch };
      for (const k of drop) delete next[k];
      return next;
    }),
  });
  const CHECK = FULL.stages[1];

  it.each<[string, () => void, Body]>([
    ["the timeout", () => type(field("Per-attempt timeout (ms)"), "1000"), withDef({ timeoutMs: 1000 })],
    ["the returned stage", () => type(field("Return the output of"), "draft"), withDef({ output: "draft" })],
    ["the returned stage back to the default (key dropped)", () => type(field("Return the output of"), ""), withDef({}, ["output"])],
    ["the thinking format back to original (key dropped)", () => type(field("Thinking format"), "original"), withDef({}, ["thinkingFormat"])],
    ["half a delimiter pair (both dropped)", () => type(field("Thinking ends with"), ""), withDef({}, ["thinkingDelimiters"])],
    ["the attachment budget at 0 (key dropped)", () => type(field("Attachment inlining budget (MiB)"), "0"), withDef({}, ["maxAttachmentBytes"])],
    ["the tool round limit", () => type(field("Maximum model rounds"), "2"), withDef({ hostedTools: { streamMode: "all", maxRounds: 2, maxCalls: 9 } })],
    ["an unbound tool", () => fireEvent.click(field("search")), { ...FULL_BODY, toolIds: [] }],
    ["the OCR pre-pass switched off (key dropped)", () => fireEvent.click(toggle(OCR_TOGGLE)), withDef({}, ["ocr"])],
    ["the OCR service", () => type(field("OCR model runs", ocrCard()), "chat-a"), withDef({ ocr: { ...FULL.ocr, service: "chat-a" } })],
    ["the ASR pre-pass switched off (key dropped)", () => fireEvent.click(toggle(ASR_TOGGLE)), withDef({}, ["asr"])],
    ["the ASR service", () => type(field("STT Model Service", asrCard()), "whisper-2"), withDef({ asr: { service: "whisper-2", timeoutMs: 20000 } })],
    ["the ASR timeout", () => type(field("Timeout (ms)", asrCard()), "9000"), withDef({ asr: { service: "whisper", timeoutMs: 9000 } })],
    ["a stage's name (and the references to it)", () => type(stageName(stage(2)), "last one"), withDef({
      output: "last_one",
      stages: [FULL.stages[0], { ...CHECK, transitions: [CHECK.transitions![0], { when: { type: "always" }, goto: "last_one" }] }, { ...FULL.stages[2], name: "last_one" }],
    })],
    ["what a stage runs", () => type(runs(stage(0)), "ocr-b"), withStage(0, { service: "ocr-b" })],
    ["a stage turned into a router (its input is kept)", () => type(runs(stage(0)), "__router__"), withStage(0, {}, ["service"])],
    ["an added context block", () => addBlock(stage(0), "text_conversation"), withStage(0, { input: [{ kind: "last_user" }, { kind: "text_conversation" }] })],
    ["a removed context block", () => fireEvent.click(iconButton("bi-x-lg", blocks(stage(1))[1])), withStage(1, { input: [CHECK.input[0], CHECK.input[2]] })],
    ["a context block moved down", () => fireEvent.click(iconButton("bi-arrow-down", blocks(stage(1))[0])), withStage(1, { input: [CHECK.input[1], CHECK.input[0], CHECK.input[2]] })],
    ["a message block's text", () => type(blocks(stage(1))[2].querySelector("textarea")!, "ok?"), withStage(1, { input: [CHECK.input[0], CHECK.input[1], { kind: "message", role: "assistant", text: "ok?" }] })],
    ["an added transition", () => fireEvent.click(button("Add transition", stage(0))), withStage(0, { transitions: [{ when: { type: "always" }, goto: "check" }] })],
    ["a removed transition", () => fireEvent.click(iconButton("bi-x-lg", transitions(stage(1))[0])), withStage(1, { transitions: [CHECK.transitions![1]] })],
    ["a transition's target", () => type(selects(transitions(stage(1))[1])[1], "end"), withStage(1, { transitions: [CHECK.transitions![0], { when: { type: "always" }, goto: "end" }] })],
  ])("changing only %s changes only that in the payload", async (_name, change, expected) => {
    const { api } = await setup({ service: FULL_SVC });
    change();
    expect(await save(api)).toEqual(sentJson("PATCH", "/services/5", expected));
  });

  it.each<[string, (panel: HTMLElement) => void, Body]>([
    ["tool handling back to inherit (key dropped)", (p) => type(field("Tools", p), "inherit"), withStage(1, {}, ["tools"])],
    ["the timeout", (p) => type(field("Timeout (ms)", p), "800"), withStage(1, { timeoutMs: 800 })],
    ["a cleared timeout (key dropped)", (p) => type(field("Timeout (ms)", p), ""), withStage(1, {}, ["timeoutMs"])],
    ["an override", (p) => type(overrideContent(p), "0.7"), withStage(1, { overrides: { temperature: 0.7 } })],
    ["the last override removed (key dropped)", (p) => fireEvent.click(iconButton("bi-x-lg", p)), withStage(1, {}, ["overrides"])],
  ])("changing only a stage's advanced %s changes only that in the payload", async (_name, change, expected) => {
    const { api } = await setup({ service: FULL_SVC });
    change(openAdvanced(stage(1)));
    expect(await save(api)).toEqual(sentJson("PATCH", "/services/5", expected));
  });

  it.each<[string, () => void, Body]>([
    ["prompt", () => type(ocrPrompt(), "transcribe"), withDef({ ocr: { ...FULL.ocr, prompt: "transcribe" } })],
    ["prompt emptied (key dropped)", () => type(ocrPrompt(), ""), withDef({ ocr: { service: "ocr-b", overrides: { maxTokens: 100 }, timeoutMs: 7000 } })],
    ["timeout", () => type(field("Timeout (ms)", ocrCard()), "100"), withDef({ ocr: { ...FULL.ocr, timeoutMs: 100 } })],
    ["override", () => type(overrideContent(ocrCard()), "200"), withDef({ ocr: { ...FULL.ocr, overrides: { maxTokens: 200 } } })],
  ])("changing only the OCR pre-pass's advanced %s changes only that in the payload", async (_name, change, expected) => {
    const { api } = await setup({ service: FULL_SVC });
    fireEvent.click(button(OCR_ADVANCED, ocrCard()));
    change();
    expect(await save(api)).toEqual(sentJson("PATCH", "/services/5", expected));
  });

  it("adds the default tool limits to a definition stored without them, and nothing else", async () => {
    const { api } = await edit(THREE);
    expect(await savedSteps(api)).toEqual({ ...THREE, hostedTools: TOOL_DEFAULTS });
  });

  it("saves the legacy kind 'agent' as 'micro_agent'", async () => {
    const { api } = await edit({ kind: "agent", timeoutMs: 1000, stages: [] });
    expect(openModal('Edit "agent"').querySelector("h2 i")!.className).toBe("bi bi-robot text-brand-400");
    expect(await savedSteps(api)).toEqual({ kind: "micro_agent", timeoutMs: 1000, stages: [], hostedTools: TOOL_DEFAULTS });
  });

  it("folds legacy flat stage and OCR parameters into overrides, where an existing override wins", async () => {
    const { api } = await edit(agent(
      [
        { name: "a", service: "chat-a", input: [], system: "be brief", temperature: 0.3, maxTokens: 50, thinking: "low" },
        { name: "b", service: "chat-a", input: [], temperature: 0.3, overrides: { temperature: 1, topK: 5 } },
      ],
      { ocr: { service: "ocr-b", temperature: 0, maxTokens: 10, overrides: { maxTokens: 99 } } },
    ));
    const steps = await savedSteps(api);
    expect(steps.stages).toEqual([
      { name: "a", service: "chat-a", input: [], overrides: { system: "be brief", temperature: 0.3, maxTokens: 50, thinking: "low" } },
      { name: "b", service: "chat-a", input: [], overrides: { temperature: 1, topK: 5 } },
    ]);
    expect(steps.ocr).toEqual({ service: "ocr-b", overrides: { temperature: 0, maxTokens: 99 } });
  });

  it("switching back from the raw view loads stages, output, OCR and ASR from the JSON and folds legacy fields", async () => {
    const { api } = await setup({ service: FULL_SVC });
    fireEvent.click(button("Raw JSON"));
    const typed = {
      kind: "agent",
      timeoutMs: 2000,
      stages: [{ name: "one", service: "chat-a", input: [], system: "s" }, { name: "two", input: [] }],
      output: "one",
      ocr: { service: "chat-a", temperature: 0.5 },
      asr: { service: "whisper-2" },
    };
    type(field("Chain JSON"), JSON.stringify(typed));
    fireEvent.click(button("Visual editor"));
    expect(stageNames()).toEqual(["one", "two"]);
    expect(stages().map((c) => runs(c).value)).toEqual(["chat-a", "__router__"]);
    expect(field<HTMLSelectElement>("Return the output of").value).toBe("one");
    expect([field<HTMLSelectElement>("OCR model runs", ocrCard()).value, field<HTMLSelectElement>("STT Model Service", asrCard()).value, field("Timeout (ms)", asrCard()).value]).toEqual(["chat-a", "whisper-2", ""]);
    expect(await save(api)).toEqual(sentJson("PATCH", "/services/5", {
      ...FULL_BODY,
      steps: {
        kind: "micro_agent",
        timeoutMs: 2000,
        stages: [{ name: "one", service: "chat-a", input: [], overrides: { system: "s" } }, { name: "two", input: [] }],
        output: "one",
        ocr: { service: "chat-a", overrides: { temperature: 0.5 } },
        asr: { service: "whisper-2" },
        hostedTools: TOOL_DEFAULTS,
      },
    }));
  });

  it("switching back from an agent with nothing but its kind clears stages, output and both pre-passes", async () => {
    const { api } = await setup({ service: FULL_SVC });
    fireEvent.click(button("Raw JSON"));
    type(field("Chain JSON"), '{"kind":"micro_agent"}');
    fireEvent.click(button("Visual editor"));
    expect(cards()).toHaveLength(2);
    expect([isOn(toggle(OCR_TOGGLE)), isOn(toggle(ASR_TOGGLE))]).toEqual([false, false]);
    expect((await save(api)).body).toEqual({ ...FULL_BODY, steps: NEW_AGENT });
  });

  it("offers every other service to its stages, never the agent being edited", async () => {
    await setup({ service: FULL_SVC, services: [...SERVICES, service(5, "agent", FULL), service(30, "chat-z", { timeoutMs: 1, steps: [] })] });
    expect(options(runs(stage(0))).map(([v]) => v)).toEqual(["", "chat-a", "ocr-b", "chat-z", "sub-agent", "old-agent", "__router__"]);
  });
});

// ---------------------------------------------------------------------------

describe("StageEditor: the stage list", () => {
  it("draws a stage card: handle, number, name box, duplicate and remove", async () => {
    await edit(THREE);
    const c = stage(0);
    expect(classes(c)).toEqual(cls(EDITOR_CARD));
    expect(classes(c.parentElement)).toEqual(["space-y-2"]);
    const header = c.firstElementChild!;
    expect(classes(header)).toEqual(cls("mb-2.5 flex items-center gap-2"));
    const [handle, badge, name, spacer, duplicate, remove] = [...header.children] as HTMLElement[];
    expect([handle.tagName, handle.getAttribute("draggable"), handle.title, classes(handle)]).toEqual(["SPAN", "true", "Drag to reorder", cls("cursor-grab text-ink-600 hover:text-ink-300")]);
    expect(handle.querySelector("i")!.className).toBe("bi bi-grip-vertical");
    expect([badge.textContent, classes(badge)]).toEqual(["Stage 1", ["badge-blue"]]);
    expect([(name as HTMLInputElement).value, (name as HTMLInputElement).placeholder, classes(name)]).toEqual(["a", "stage name", cls("input h-7 w-40 py-0 font-mono text-xs")]);
    expect(spacer.className).toBe("flex-1");
    expect([classes(duplicate), duplicate.title, duplicate.querySelector("i")!.className]).toEqual([cls("btn-ghost btn-xs"), "Duplicate stage", "bi bi-files"]);
    expect([classes(remove), remove.title, remove.querySelector("i")!.className]).toEqual([cls("btn-danger btn-xs"), "", "bi bi-trash3"]);
    expect(stages().map((s) => s.querySelector(".badge-blue")!.textContent)).toEqual(["Stage 1", "Stage 2", "Stage 3"]);
  });

  it("Add stage appends 'stage', then 'stage2', running the first listed service with no input", async () => {
    const { api } = await setup();
    fireEvent.click(button("Add stage"));
    fireEvent.click(button("Add stage"));
    fireEvent.click(button("Add stage"));
    expect(stageNames()).toEqual(["stage", "stage2", "stage3"]);
    expect(screen.queryByText(/^No stages\. Add one/)).toBeNull();
    type(field("Name (exposed model name)"), "x");
    expect(await savedStages(api)).toEqual([
      { name: "stage", input: [], service: "chat-a" }, { name: "stage2", input: [], service: "chat-a" }, { name: "stage3", input: [], service: "chat-a" },
    ]);
  });

  it("Add stage with no service available adds a router stage", async () => {
    const { api } = await setup({ services: [] });
    fireEvent.click(button("Add stage"));
    expect(runs(stage(0)).value).toBe("__router__");
    type(field("Name (exposed model name)"), "x");
    expect(await savedStages(api)).toEqual([{ name: "stage", input: [] }]);
  });

  it("a stage name has its whitespace replaced by underscores as it is typed", async () => {
    const { api } = await edit(THREE);
    type(stageName(stage(0)), " my  first\tstage ");
    expect(stageName(stage(0)).value).toBe("_my_first_stage_");
    type(stageName(stage(1)), "");
    expect((await savedStages(api)).map((s) => s.name)).toEqual(["_my_first_stage_", "", "c"]);
  });

  it("Duplicate inserts a deep copy right after, named '<name>_copy', then '_copy2'", async () => {
    const { api } = await setup({ service: FULL_SVC });
    fireEvent.click(iconButton("bi-files", stage(1)));
    fireEvent.click(iconButton("bi-files", stage(1)));
    expect(stageNames()).toEqual(["draft", "check", "check_copy2", "check_copy", "final"]);
    // Editing the copy leaves the original alone.
    fireEvent.click(iconButton("bi-x-lg", blocks(stage(2))[0]));
    const saved = await savedStages(api);
    expect(saved[1]).toEqual(FULL.stages[1]);
    expect(saved[2]).toEqual({ ...FULL.stages[1], name: "check_copy2", input: FULL.stages[1].input.slice(1) });
    expect(saved[3]).toEqual({ ...FULL.stages[1], name: "check_copy" });
  });

  it("Remove deletes the stage; removing the returned stage resets the output choice", async () => {
    const { api } = await edit({ ...THREE, output: "b" });
    fireEvent.click(iconButton("bi-trash3", stage(0)));
    expect(stageNames()).toEqual(["b", "c"]);
    expect((await savedSteps(api)).output).toBe("b");
    fireEvent.click(iconButton("bi-trash3", stage(0)));
    expect(stageNames()).toEqual(["c"]);
    expect(await savedSteps(api)).toEqual({ kind: "micro_agent", timeoutMs: 60000, stages: [THREE.stages[2]], hostedTools: TOOL_DEFAULTS });
    fireEvent.click(iconButton("bi-trash3", stage(0)));
    expect(screen.getByText(/^No stages\. Add one/)).toBeTruthy();
  });

  it.each([
    ["the first onto the last", 0, 2, [1, 2, 0]],
    ["the last onto the first", 2, 0, [2, 0, 1]],
    ["the first onto the second", 0, 1, [1, 0, 2]],
    ["a stage onto itself", 1, 1, [0, 1, 2]],
  ])("dragging %s moves it to that position and keeps the output choice", async (_name, from, to, order) => {
    const { api } = await edit({ ...THREE, output: "a" });
    drag(from, to);
    expect(await savedSteps(api)).toEqual({ ...THREE, stages: order.map((i) => THREE.stages[i]), output: "a", hostedTools: TOOL_DEFAULTS });
  });

  it("a drop after the drag ended, or with no drag at all, moves nothing", async () => {
    const { api } = await edit(THREE);
    fireEvent.drop(stage(2));
    fireEvent.dragStart(stage(0).querySelector("[draggable]")!);
    fireEvent.dragEnd(stage(0).querySelector("[draggable]")!);
    fireEvent.drop(stage(2));
    expect(await savedStages(api)).toEqual(THREE.stages);
  });

  it("an open Advanced section travels with its stage when the list changes", async () => {
    await edit(THREE);
    openAdvanced(stage(1));
    const open = () => stages().map((c) => c.textContent!.includes("Parameter overrides"));
    expect(open()).toEqual([false, true, false]);
    drag(1, 0);
    expect(open()).toEqual([true, false, false]);
    fireEvent.click(iconButton("bi-files", stage(0)));
    expect(open()).toEqual([true, false, false, false]);
    fireEvent.click(iconButton("bi-trash3", stage(0)));
    expect(open()).toEqual([false, false, false]);
  });

  it("offers the output choice only with two or more stages, defaulting to where routing ends", async () => {
    await edit(agent([{ name: "a", service: "chat-a", input: [] }]));
    expect(screen.queryByText("Return the output of")).toBeNull();
    fireEvent.click(button("Add stage"));
    const label = labelEl("Return the output of");
    const select = field<HTMLSelectElement>("Return the output of");
    expect([label.tagName, classes(label), classes(label.parentElement)]).toEqual(["LABEL", cls("label mb-0"), cls("mt-3 flex items-center gap-2")]);
    expect([select.value, classes(select)]).toEqual(["", cls("select w-auto")]);
    expect(options(select)).toEqual([["", "the stage where routing ends (default)"], ["a", "a"], ["stage", "stage"]]);
  });
});

// ---------------------------------------------------------------------------

describe("StageEditor: what a stage runs", () => {
  it("lists chat and OCR services, then agents, then the router; media services are left out", async () => {
    await edit(THREE);
    const select = runs(stage(0));
    expect([select.value, classes(select), classes(labelEl("Runs", stage(0)))]).toEqual(["chat-a", ["select"], ["label"]]);
    expect([...select.children].map((c) => [c.tagName, c.tagName === "OPTGROUP" ? (c as HTMLOptGroupElement).label : c.textContent])).toEqual([
      ["OPTION", "— pick a Model Service or Micro Agent —"], ["OPTGROUP", "Model Services"], ["OPTGROUP", "Micro Agents"],
      ["OPTION", "router (no model call — route by input only)"],
    ]);
    expect(options(select)).toEqual([
      ["", "— pick a Model Service or Micro Agent —"], ["chat-a", "chat-a"], ["ocr-b", "ocr-b"], ["sub-agent", "sub-agent"], ["old-agent", "old-agent"],
      ["__router__", "router (no model call — route by input only)"],
    ]);
  });

  it("omits the Micro Agents group when there is none, but keeps an empty Model Services group", async () => {
    await edit(THREE, { services: [IMAGE] });
    expect([...runs(stage(0)).children].map((c) => c.tagName)).toEqual(["OPTION", "OPTGROUP", "OPTION"]);
    expect(options(runs(stage(0))).map(([v]) => v)).toEqual(["", "__router__"]);
  });

  it("a router stage shows only its hint and transitions", async () => {
    await edit(agent([{ name: "r", input: [] }, { name: "b", service: "chat-a", input: [] }]));
    const c = stage(0);
    expect(runs(c).value).toBe("__router__");
    expect(classes(screen.getByText("Router: evaluates its transitions on the original input; no model runs."))).toEqual(cls("mt-1 text-xs text-ink-500"));
    expect([...c.querySelectorAll(".label")].map((l) => l.firstChild!.textContent)).toEqual(["Runs", "Transitions"]);
    expect(hasButton(STAGE_ADVANCED, c)).toBe(false);
    expect(hasButton(STAGE_ADVANCED, stage(1))).toBe(true);
  });

  it("picking a service for a router stage reveals its input and advanced sections", async () => {
    const { api } = await edit(agent([{ name: "r", input: [] }]));
    type(runs(stage(0)), "sub-agent");
    expect(screen.queryByText(/^Router: evaluates its transitions/)).toBeNull();
    expect(hasButton(STAGE_ADVANCED, stage(0))).toBe(true);
    expect(await savedStage(api, 0)).toEqual({ name: "r", input: [], service: "sub-agent" });
  });

  it("choosing the placeholder leaves the stage without a service, which is a router", async () => {
    const { api } = await edit(THREE);
    type(runs(stage(0)), "");
    expect(runs(stage(0)).value).toBe("__router__");
    expect(await savedStage(api, 0)).toEqual({ name: "a", input: [] });
  });

  it("a stage with legacy inline steps warns, shows the placeholder and keeps its steps until a service is picked", async () => {
    const legacy = { name: "old", steps: [STEP], input: [] };
    const { api } = await edit(agent([legacy]));
    expect(runs(stage(0)).value).toBe("");
    expect(classes(screen.getByText("Uses inline steps (legacy). Pick a Model Service, or edit via Raw JSON."))).toEqual(cls("mt-1 text-xs text-amber-300"));
    expect(hasButton(STAGE_ADVANCED, stage(0))).toBe(true);
    expect(await savedStage(api, 0)).toEqual(legacy);
    type(runs(stage(0)), "chat-a");
    expect(screen.queryByText(/^Uses inline steps/)).toBeNull();
    expect(await savedStage(api, 0)).toEqual({ name: "old", input: [], service: "chat-a" });
  });
});

// ---------------------------------------------------------------------------

describe("StageEditor: context blocks", () => {
  it("draws the input header with an add menu that always shows its placeholder", async () => {
    await edit(THREE);
    const label = labelEl("Input", stage(1));
    expect([label.tagName, classes(label), classes(label.parentElement)]).toEqual(["LABEL", cls("label mb-0"), cls("mb-1.5 flex items-center justify-between")]);
    expect([label.querySelector("span")!.textContent, classes(label.querySelector("span"))]).toEqual(["(empty = pass the original messages through)", cls("normal-case text-ink-500")]);
    const add = label.parentElement!.querySelector("select")!;
    expect(classes(add)).toEqual(cls("select h-7 w-auto py-0 text-xs"));
    expect(options(add)).toEqual([
      ["", "+ add context block…"], ["original_conversation", "Original full conversation"], ["text_conversation", "Text-only conversation"],
      ["last_user", "Last user request"], ["last_user_text", "Last user text only"], ["last_user_images", "Last user images only"],
      ["stage_output", "Output from another stage"], ["message", "New conversation turn"], ["tool_turn", "Tool use turn"], ["plain_text", "Plain text"],
    ]);
    expect(classes(section(stage(1), "Input"))).toEqual(["mt-3"]);
    expect(classes(section(stage(1), "Input").children[1])).toEqual(["space-y-1.5"]);
    addBlock(stage(1), "last_user");
    expect(add.value).toBe("");
    addBlock(stage(1), "");
    expect(blocks(stage(1))).toHaveLength(1);
  });

  it.each<[string, Record<string, unknown>, string, string | null]>([
    ["original_conversation", { kind: "original_conversation" }, "Original full conversation", "The original messages, images included."],
    ["text_conversation", { kind: "text_conversation" }, "Text-only conversation", "The original messages with images stripped."],
    ["last_user", { kind: "last_user" }, "Last user request", "The last user message from the original request."],
    ["last_user_text", { kind: "last_user_text" }, "Last user text only", "Only the text of the last user message."],
    ["last_user_images", { kind: "last_user_images" }, "Last user images only", "Only the image(s) of the last user message."],
    ["stage_output", { kind: "stage_output", stage: "a", role: "assistant" }, "Output from another stage", null],
    ["message", { kind: "message", role: "user", text: "" }, "New conversation turn", null],
    ["plain_text", { kind: "message", role: "user", text: "" }, "New conversation turn", null],
    ["tool_turn", { kind: "tool_turn", name: "", input: "", result: "" }, "Tool use turn", null],
  ])("adding %s appends its default block", async (kind, block, label, hint) => {
    const { api } = await edit(THREE);
    addBlock(stage(1), kind);
    const [row] = blocks(stage(1));
    expect(classes(row)).toEqual(cls(ROW));
    expect([row.querySelector(".badge-gray")!.textContent, classes(row.querySelector(".badge-gray"))]).toEqual([label, ["badge-gray"]]);
    const p = row.querySelector("p");
    expect(p?.textContent ?? null).toBe(hint);
    if (p) expect(classes(p)).toEqual(cls("mt-1 text-[11px] text-ink-600"));
    expect((await savedStage(api, 1)).input).toEqual([block]);
  });

  it("every block row has move-up, move-down and remove buttons", async () => {
    await setup({ service: FULL_SVC });
    const row = blocks(stage(1))[0];
    expect(classes(row.firstElementChild)).toEqual(cls("flex items-center gap-2"));
    const [up, down, remove] = [...row.querySelectorAll("button")];
    expect([classes(up), up.title, up.querySelector("i")!.className]).toEqual([cls("btn-ghost btn-xs"), "Move up", "bi bi-arrow-up"]);
    expect([classes(down), down.title, down.querySelector("i")!.className]).toEqual([cls("btn-ghost btn-xs"), "Move down", "bi bi-arrow-down"]);
    expect([classes(remove), remove.title, remove.querySelector("i")!.className]).toEqual([cls("btn-danger btn-xs"), "", "bi bi-x-lg"]);
  });

  it("moves blocks up and down, and not past either end", async () => {
    const { api } = await setup({ service: FULL_SVC });
    const [first, second, third] = FULL.stages[1].input;
    fireEvent.click(iconButton("bi-arrow-up", blocks(stage(1))[0]));
    fireEvent.click(iconButton("bi-arrow-down", blocks(stage(1))[2]));
    expect((await savedStage(api, 1)).input).toEqual([first, second, third]);
    fireEvent.click(iconButton("bi-arrow-up", blocks(stage(1))[2]));
    expect(blockKinds(stage(1))).toEqual(["Output from another stage", "New conversation turn", "Tool use turn"]);
    fireEvent.click(iconButton("bi-arrow-up", blocks(stage(1))[1]));
    expect((await savedStage(api, 1)).input).toEqual([third, first, second]);
    fireEvent.click(iconButton("bi-arrow-down", blocks(stage(1))[0]));
    fireEvent.click(iconButton("bi-arrow-down", blocks(stage(1))[1]));
    expect((await savedStage(api, 1)).input).toEqual([first, second, third]);
  });

  it("removing every block leaves an empty input", async () => {
    const { api } = await setup({ service: FULL_SVC });
    fireEvent.click(iconButton("bi-x-lg", blocks(stage(1))[0]));
    fireEvent.click(iconButton("bi-x-lg", blocks(stage(1))[0]));
    fireEvent.click(iconButton("bi-x-lg", blocks(stage(1))[0]));
    expect(blocks(stage(1))).toEqual([]);
    expect((await savedStage(api, 1)).input).toEqual([]);
  });

  it("a stage-output block picks an earlier stage and a role", async () => {
    const { api } = await edit(THREE);
    addBlock(stage(2), "stage_output");
    const row = blocks(stage(2))[0];
    const [from, role] = selects(row);
    expect([from.value, classes(from), options(from)]).toEqual(["a", cls("select h-7 w-28 py-0 text-xs"), [["a", "a"], ["b", "b"]]]);
    expect([role.value, classes(role), options(role)]).toEqual(["assistant", cls("select h-7 w-24 py-0 text-xs"), [["assistant", "assistant"], ["user", "user"]]]);
    expect([row.querySelector("span.text-ink-500")!.textContent, classes(row.querySelector("span.text-ink-500"))]).toEqual(["as", ["text-ink-500"]]);
    type(from, "b");
    type(selects(blocks(stage(2))[0])[1], "user");
    expect((await savedStage(api, 2)).input).toEqual([{ kind: "stage_output", stage: "b", role: "user" }]);
  });

  it("a stage-output block on the first stage has no stage to pick", async () => {
    const { api } = await edit(THREE);
    addBlock(stage(0), "stage_output");
    expect(options(selects(blocks(stage(0))[0])[0])).toEqual([["", "(no earlier stage)"]]);
    expect((await savedStage(api, 0)).input).toEqual([{ kind: "stage_output", stage: "", role: "assistant" }]);
  });

  it("a message block edits its role and text", async () => {
    const { api } = await edit(THREE);
    addBlock(stage(0), "message");
    const row = () => blocks(stage(0))[0];
    const [role] = selects(row());
    expect([role.value, classes(role), options(role)]).toEqual(["user", cls("select h-7 w-24 py-0 text-xs"), [["user", "user"], ["assistant", "assistant"]]]);
    const text = row().querySelector("textarea")!;
    expect([text.value, text.placeholder, classes(text)]).toEqual(["", "message text", cls("input mt-1.5 min-h-[36px] font-mono text-xs")]);
    type(role, "assistant");
    type(row().querySelector("textarea")!, "hello\nthere");
    expect((await savedStage(api, 0)).input).toEqual([{ kind: "message", role: "assistant", text: "hello\nthere" }]);
  });

  it("a tool-turn block edits its name, arguments and result, and only carries isError when ticked", async () => {
    const { api } = await edit(THREE);
    addBlock(stage(0), "tool_turn");
    const row = () => blocks(stage(0))[0];
    const name = row().querySelector<HTMLInputElement>("input:not([type=checkbox])")!;
    const [args, result] = [...row().querySelectorAll("textarea")];
    expect([name.placeholder, classes(name)]).toEqual(["tool name", cls("input h-8 py-0 font-mono text-xs")]);
    expect([args.placeholder, classes(args)]).toEqual(['arguments (JSON), e.g. {"city":"SF"}', cls("input min-h-[32px] font-mono text-xs")]);
    expect([result.placeholder, classes(result)]).toEqual(["tool result text", cls("input min-h-[32px] font-mono text-xs")]);
    expect(classes(name.parentElement)).toEqual(cls("mt-1.5 space-y-1.5"));
    const flag = field("mark as error", row());
    expect([flag.type, flag.checked, classes(flag.closest("label"))]).toEqual(["checkbox", false, cls("flex items-center gap-2 text-ink-400")]);
    type(name, "lookup");
    type(row().querySelectorAll("textarea")[0], "{}");
    type(row().querySelectorAll("textarea")[1], "42");
    fireEvent.click(field("mark as error", row()));
    expect((await savedStage(api, 0)).input).toEqual([{ kind: "tool_turn", name: "lookup", input: "{}", result: "42", isError: true }]);
    fireEvent.click(field("mark as error", row()));
    expect((await savedStage(api, 0)).input).toEqual([{ kind: "tool_turn", name: "lookup", input: "{}", result: "42" }]);
  });
});

// ---------------------------------------------------------------------------

describe("StageEditor: transitions", () => {
  const firstRow = () => transitions(stage(1))[0];

  it("draws the transitions header and an added row", async () => {
    await edit(THREE);
    const label = labelEl("Transitions", stage(1));
    expect([label.tagName, classes(label), classes(label.parentElement)]).toEqual(["LABEL", cls("label mb-0"), cls("mb-1.5 flex items-center justify-between")]);
    expect(label.querySelector("span")!.textContent).toBe("(first match wins; no match = end here and return this stage's output)");
    const add = button("Add transition", stage(1));
    expect([classes(add), add.querySelector("i")!.className]).toEqual([cls("btn-ghost btn-xs"), "bi bi-plus-lg"]);
    fireEvent.click(add);
    const row = firstRow();
    expect(classes(row)).toEqual(cls(`space-y-2 ${ROW}`));
    expect([...row.children].map((line) => line.className)).toEqual(["flex flex-wrap items-center gap-1.5", "flex flex-wrap items-center gap-1.5"]);
    expect([...row.querySelectorAll("span")].map((s) => [s.textContent, s.className])).toEqual([["when", "w-12 shrink-0 text-ink-500"], ["go to", "w-12 shrink-0 text-ink-500"]]);
    const [when, goto] = selects(row);
    expect([when.value, classes(when)]).toEqual(["always", cls("select h-8 w-40 py-0 text-xs")]);
    expect(options(when)).toEqual([
      ["always", "always"], ["input_has_image", "input has image"], ["input_contains", "input contains"], ["input_matches", "input matches (regex)"],
      ["output_contains", "output contains"], ["output_matches", "output matches (regex)"],
    ]);
    expect([goto.value, classes(goto), options(goto)]).toEqual(["c", cls("select h-8 w-32 py-0 text-xs"), [["end", "end (return)"], ["c", "c"]]]);
    const remove = iconButton("bi-x-lg", row);
    expect([classes(remove), remove.title]).toEqual([cls("btn-danger btn-xs shrink-0"), "Remove transition"]);
  });

  it("a new transition goes to the next stage, or to the end from the last stage", async () => {
    const { api } = await edit(THREE);
    fireEvent.click(button("Add transition", stage(0)));
    fireEvent.click(button("Add transition", stage(2)));
    const saved = await savedStages(api);
    expect(saved.map((s) => s.transitions)).toEqual([[{ when: { type: "always" }, goto: "b" }], undefined, [{ when: { type: "always" }, goto: "end" }]]);
  });

  it.each<[string, Record<string, unknown>, string | null, boolean]>([
    ["always", { type: "always" }, null, false],
    ["input_has_image", { type: "input_has_image" }, null, false],
    ["input_contains", { type: "input_contains", value: "" }, "text to find", false],
    ["input_matches", { type: "input_matches", value: "" }, "regex", false],
    ["output_contains", { type: "output_contains", value: "" }, "text to find", true],
    ["output_matches", { type: "output_matches", value: "" }, "regex", true],
  ])("condition %s starts blank, with the inputs it needs", async (kind, when, placeholder, hasStage) => {
    const { api } = await setup({ service: FULL_SVC });
    type(selects(firstRow())[0], kind);
    const value = firstRow().querySelector("input");
    expect(value?.placeholder ?? null).toBe(placeholder);
    if (value) expect([value.value, classes(value)]).toEqual(["", cls("input h-8 min-w-[8rem] flex-1 py-0 font-mono text-xs")]);
    // when [, stage], goto, returning
    expect(selects(firstRow())).toHaveLength(hasStage ? 4 : 3);
    expect((await savedStage(api, 1)).transitions).toEqual([{ when, goto: "end", output: "draft" }, FULL.stages[1].transitions![1]]);
  });

  it("an output condition can look at this stage or an earlier one, and carries a typed value", async () => {
    const { api } = await setup({ service: FULL_SVC });
    const [, from] = selects(firstRow());
    expect([from.value, classes(from), options(from)]).toEqual(["draft", cls("select h-8 w-32 py-0 text-xs"), [["", "this stage"], ["draft", "draft"]]]);
    expect(firstRow().querySelector("input")!.value).toBe("bad");
    type(from, "");
    type(firstRow().querySelector("input")!, "worse");
    expect(((await savedStage(api, 1)).transitions as unknown[])[0]).toEqual({ when: { type: "output_contains", value: "worse" }, goto: "end", output: "draft" });
  });

  it("an 'end' transition chooses whose output to return; any other target drops that choice", async () => {
    const { api } = await setup({ service: FULL_SVC });
    const row = firstRow();
    const [, , goto, returning] = selects(row);
    expect(options(goto)).toEqual([["end", "end (return)"], ["final", "final"]]);
    expect([returning.value, classes(returning), options(returning)]).toEqual(["draft", cls("select h-8 w-32 py-0 text-xs"), [["", "this stage's output"], ["draft", "draft"]]]);
    expect([...row.querySelectorAll("span")].map((s) => [s.textContent, s.className])).toContainEqual(["returning", "text-ink-500"]);
    type(returning, "");
    expect(((await savedStage(api, 1)).transitions as unknown[])[0]).toEqual({ when: FULL.stages[1].transitions![0].when, goto: "end" });
    type(selects(firstRow())[3], "draft");
    type(selects(firstRow())[2], "final");
    expect(selects(firstRow())).toHaveLength(3);
    expect(((await savedStage(api, 1)).transitions as unknown[])[0]).toEqual({ when: FULL.stages[1].transitions![0].when, goto: "final" });
    type(selects(firstRow())[2], "end");
    expect(selects(firstRow())[3].value).toBe("");
  });

  it("only earlier stages that run a model can be returned", async () => {
    await edit(agent([{ name: "r", input: [] }, { name: "m", service: "chat-a", input: [] }, { name: "last", service: "chat-a", input: [] }]));
    fireEvent.click(button("Add transition", stage(2)));
    const [, , returning] = selects(transitions(stage(2))[0]);
    expect(options(returning)).toEqual([["", "this stage's output"], ["m", "m"]]);
  });

  it("removing the last transition leaves an empty list", async () => {
    const { api } = await setup({ service: FULL_SVC });
    fireEvent.click(iconButton("bi-x-lg", transitions(stage(1))[0]));
    fireEvent.click(iconButton("bi-x-lg", transitions(stage(1))[0]));
    expect((await savedStage(api, 1)).transitions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("StageEditor: a stage's advanced section", () => {
  it("is closed by default and opens a panel with tools, timeout and overrides", async () => {
    await edit(THREE);
    const toggleButton = button(STAGE_ADVANCED, stage(0));
    expect(classes(toggleButton)).toEqual(cls(`mt-2 ${DISCLOSURE}`));
    expect(toggleButton.querySelector("i")!.className).toBe("bi bi-chevron-right mr-1");
    const panel = openAdvanced(stage(0));
    expect(toggleButton.querySelector("i")!.className).toBe("bi bi-chevron-down mr-1");
    expect(classes(panel)).toEqual(cls(`mt-2 space-y-3 ${PANEL}`));
    const tools = field<HTMLSelectElement>("Tools", panel);
    expect([tools.value, classes(tools)]).toEqual(["inherit", ["select"]]);
    expect(options(tools)).toEqual([["inherit", "Inherit — callable (tool_choice from request)"], ["none", "Listed but not callable (shown in the prompt)"]]);
    expect(classes(screen.getByText(/^Evaluate\/compose stages usually want/))).toEqual(cls("mt-1 text-[11px] text-ink-600"));
    const timeout = field("Timeout (ms)", panel);
    expect([timeout.value, timeout.placeholder, timeout.type, timeout.inputMode, classes(timeout)]).toEqual(["", "inherit", "text", "numeric", ["input"]]);
    expect(classes(timeout.closest(".grid"))).toEqual(cls("grid grid-cols-3 gap-3"));
    expect(classes(panel.lastElementChild)).toEqual(cls(PANEL));
    expect(screen.getByText("No overrides. Add a parameter–content pair; content that parses as JSON is sent typed, anything else as text.")).toBeTruthy();
    fireEvent.click(toggleButton);
    expect(stage(0).textContent).not.toContain("Parameter overrides");
  });

  it("shows the stored values", async () => {
    await setup({ service: FULL_SVC });
    const panel = openAdvanced(stage(1));
    expect([field<HTMLSelectElement>("Tools", panel).value, field("Timeout (ms)", panel).value, overrideContent(panel).value]).toEqual(["none", "5000", "0"]);
  });

  it("saves 'listed but not callable' as tools: none", async () => {
    const { api } = await edit(THREE);
    type(field("Tools", openAdvanced(stage(0))), "none");
    expect(await savedStage(api, 0)).toEqual({ ...THREE.stages[0], tools: "none" });
  });

  it.each<[string, string, string, number | undefined]>([
    ["a plain number", "5000", "5000", 5000],
    ["zero (no minimum)", "0", "0", 0],
    ["a large number (no maximum)", "86400000", "86400000", 86400000],
    ["empty (inherit: key omitted)", "", "", undefined],
    ["a negative number (the sign is stripped)", "-5", "5", 5],
    ["a fraction (the point is stripped)", "1.5", "15", 15],
    ["digits mixed with letters (letters stripped)", "12ab3", "123", 123],
    ["non-numeric (emptied, key omitted)", "soon", "", undefined],
  ])("the stage timeout takes %s", async (_name, typed, shown, sent) => {
    const { api } = await edit(agent([{ name: "a", service: "chat-a", input: [], timeoutMs: 777 }]));
    const panel = openAdvanced(stage(0));
    expect(field("Timeout (ms)", panel).value).toBe("777");
    type(field("Timeout (ms)", panel), typed);
    expect(field("Timeout (ms)", panel).value).toBe(shown);
    expect((await savedStage(api, 0)).timeoutMs).toBe(sent);
  });

  it("adds a parameter override to the stage", async () => {
    const { api } = await edit(THREE);
    const panel = openAdvanced(stage(2));
    fireEvent.click(button("Add parameter", panel));
    type(panel.querySelector('input[placeholder="parameter"]')!, "system");
    type(overrideContent(panel), "be terse");
    expect(await savedStage(api, 2)).toEqual({ ...THREE.stages[2], overrides: { system: "be terse" } });
  });
});

// ---------------------------------------------------------------------------

describe("AsrEditor", () => {
  it("switching it on picks the first speech-to-text service and shows the service and timeout fields", async () => {
    const { api } = await edit(THREE);
    fireEvent.click(toggle(ASR_TOGGLE));
    const select = field<HTMLSelectElement>("STT Model Service", asrCard());
    expect([select.value, classes(select)]).toEqual(["whisper", ["select"]]);
    expect(options(select)).toEqual([["", "pick an stt service…"], ["whisper", "whisper"], ["whisper-2", "whisper-2"]]);
    expect(classes(select.closest(".grid"))).toEqual(cls("mt-3 grid gap-3 sm:grid-cols-2"));
    const timeout = field("Timeout (ms)", asrCard());
    expect([timeout.value, timeout.placeholder, timeout.type, timeout.inputMode, classes(timeout)]).toEqual(["", "60000", "text", "numeric", cls("input font-mono text-xs")]);
    expect([classes(labelEl("STT Model Service", asrCard())), classes(labelEl("Timeout (ms)", asrCard()))]).toEqual([["label"], ["label"]]);
    expect(asrCard().querySelector(".text-amber-400\\/90")).toBeNull();
    expect((await savedSteps(api)).asr).toEqual({ service: "whisper" });
  });

  it("switching it off removes the pre-pass and its fields", async () => {
    const { api } = await setup({ service: FULL_SVC });
    fireEvent.click(toggle(ASR_TOGGLE));
    expect(asrCard().querySelector("select")).toBeNull();
    expect("asr" in (await savedSteps(api))).toBe(false);
  });

  it("without a speech-to-text service it warns and saves a pre-pass with no service", async () => {
    const { api } = await edit(THREE, { services: [CHAT, OCR, SUB_AGENT] });
    fireEvent.click(toggle(ASR_TOGGLE));
    const warning = screen.getByText("No stt-category Model Service exists yet — create one under Model Services first.");
    expect(classes(warning)).toEqual(cls("mt-1 text-xs text-amber-400/90"));
    expect(options(field<HTMLSelectElement>("STT Model Service", asrCard()))).toEqual([["", "pick an stt service…"]]);
    expect((await savedSteps(api)).asr).toEqual({});
  });

  it("choosing the placeholder clears the service but keeps the pre-pass and its timeout", async () => {
    const { api } = await setup({ service: FULL_SVC });
    type(field("STT Model Service", asrCard()), "");
    expect((await savedSteps(api)).asr).toEqual({ timeoutMs: 20000 });
  });

  it.each<[string, string, string, number | undefined]>([
    ["a plain number", "90000", "90000", 90000],
    ["1000, the minimum", "1000", "1000", 1000],
    ["999, just below the minimum (raised to 1000)", "999", "1000", 1000],
    ["zero (raised to 1000)", "0", "1000", 1000],
    ["a negative number (raised to 1000)", "-1", "1000", 1000],
    ["a fraction (truncated)", "2500.9", "2500", 2500],
    ["a large number (no maximum)", "3600000", "3600000", 3600000],
    ["empty (inherit: key omitted)", "", "", undefined],
    ["blank (inherit: key omitted)", "   ", "", undefined],
    ["non-numeric (the 60000 fallback)", "soon", "60000", 60000],
  ])("the timeout takes %s", async (_name, typed, shown, sent) => {
    const { api } = await setup({ service: FULL_SVC });
    type(field("Timeout (ms)", asrCard()), typed);
    expect(field("Timeout (ms)", asrCard()).value).toBe(shown);
    expect(((await savedSteps(api)).asr as { timeoutMs?: number }).timeoutMs).toBe(sent);
  });
});

// ---------------------------------------------------------------------------

describe("OcrEditor", () => {
  it("switching it on picks the first chat-pipeline service and shows the picker, a closed advanced section and the tester", async () => {
    const { api } = await edit(THREE, { services: [IMAGE, SUB_AGENT, OCR, CHAT] });
    fireEvent.click(toggle(OCR_TOGGLE));
    const select = field<HTMLSelectElement>("OCR model runs", ocrCard());
    expect([select.value, classes(select), classes(labelEl("OCR model runs", ocrCard()))]).toEqual(["ocr-b", ["select"], ["label"]]);
    expect(options(select)).toEqual([["", "— pick a multimodal Model Service —"], ["ocr-b", "ocr-b"], ["chat-a", "chat-a"]]);
    expect(classes(select.parentElement!.parentElement)).toEqual(cls("mt-3 space-y-3"));
    const advanced = button(OCR_ADVANCED, ocrCard());
    expect([classes(advanced), advanced.querySelector("i")!.className]).toEqual([cls(DISCLOSURE), "bi bi-chevron-right mr-1"]);
    expect(ocrPrompt()).toBeNull();
    expect(hasButton("Send test image", ocrCard())).toBe(true);
    expect((await savedSteps(api)).ocr).toEqual({ service: "ocr-b" });
  });

  it("switching it off removes the pre-pass and its fields", async () => {
    const { api } = await setup({ service: FULL_SVC });
    fireEvent.click(toggle(OCR_TOGGLE));
    expect(ocrCard().querySelector("select")).toBeNull();
    expect(hasButton("Send test image")).toBe(false);
    expect("ocr" in (await savedSteps(api))).toBe(false);
  });

  it("without a chat-pipeline service it warns, saves a pre-pass with no service and cannot be tested", async () => {
    const { api } = await edit(THREE, { services: [IMAGE, STT, SUB_AGENT] });
    fireEvent.click(toggle(OCR_TOGGLE));
    expect(classes(screen.getByText("No Model Services exist yet — create one that maps to a multimodal model."))).toEqual(cls("mt-1 text-xs text-amber-300"));
    expect(button("Send test image", ocrCard()).disabled).toBe(true);
    expect(classes(screen.getByText("Pick an OCR model above before testing."))).toEqual(cls("mt-1.5 text-[11px] text-amber-300"));
    expect((await savedSteps(api)).ocr).toEqual({});
  });

  it("choosing the placeholder clears the service, keeps the rest and disables the tester", async () => {
    const { api } = await setup({ service: FULL_SVC });
    expect(button("Send test image", ocrCard()).disabled).toBe(false);
    type(field("OCR model runs", ocrCard()), "");
    expect(button("Send test image", ocrCard()).disabled).toBe(true);
    expect((await savedSteps(api)).ocr).toEqual({ prompt: "read it", overrides: { maxTokens: 100 }, timeoutMs: 7000 });
  });

  it("a pre-pass with legacy inline steps warns, can be tested and keeps its steps until a service is picked", async () => {
    const { api } = await edit(agent([], { ocr: { steps: [STEP] } }));
    expect(field<HTMLSelectElement>("OCR model runs", ocrCard()).value).toBe("");
    expect(classes(screen.getByText("Uses inline steps (legacy). Pick a Model Service, or edit via Raw JSON."))).toEqual(cls("mt-1 text-xs text-amber-300"));
    expect(button("Send test image", ocrCard()).disabled).toBe(false);
    expect((await savedSteps(api)).ocr).toEqual({ steps: [STEP] });
    type(field("OCR model runs", ocrCard()), "chat-a");
    expect((await savedSteps(api)).ocr).toEqual({ service: "chat-a" });
  });

  it("the advanced section holds the prompt, a timeout and overrides", async () => {
    await setup({ service: FULL_SVC });
    const advanced = button(OCR_ADVANCED, ocrCard());
    fireEvent.click(advanced);
    expect(advanced.querySelector("i")!.className).toBe("bi bi-chevron-down mr-1");
    const panel = advanced.nextElementSibling as HTMLElement;
    expect(classes(panel)).toEqual(cls(`space-y-3 ${PANEL}`));
    const label = labelEl("OCR prompt (optional)", panel);
    expect([label.tagName, classes(label), classes(label.parentElement)]).toEqual(["LABEL", cls("label mb-0"), cls("mb-1 flex items-center justify-between")]);
    const load = button("Load default", panel);
    expect([classes(load), load.querySelector("i")!.className]).toEqual([cls("text-[11px] text-brand-400 hover:text-brand-300"), "bi bi-arrow-counterclockwise mr-1"]);
    expect([ocrPrompt().value, ocrPrompt().placeholder, classes(ocrPrompt())]).toEqual(["read it", "Leave empty to use the built-in OCR prompt.", cls("input min-h-[120px] font-mono text-xs")]);
    expect(classes(screen.getByText("Must instruct the model to return a JSON array of { index, image } objects (one per image)."))).toEqual(cls("mt-1 text-[11px] text-ink-600"));
    const timeout = field("Timeout (ms)", panel);
    expect([timeout.value, timeout.placeholder, classes(timeout), classes(timeout.closest(".grid"))]).toEqual(["7000", "inherit", ["input"], cls("grid grid-cols-3 gap-3")]);
    expect(overrideContent(panel).value).toBe("100");
    expect(classes(panel.lastElementChild)).toEqual(cls(PANEL));
  });

  it("Load default fills in the built-in prompt", async () => {
    const { api } = await edit(agent([], { ocr: { service: "ocr-b" } }));
    fireEvent.click(button(OCR_ADVANCED, ocrCard()));
    expect(ocrPrompt().value).toBe("");
    fireEvent.click(button("Load default", ocrCard()));
    const prompt = ((await savedSteps(api)).ocr as { prompt: string }).prompt;
    expect(ocrPrompt().value).toBe(prompt);
    expect(prompt.startsWith("You are an OCR and image-analysis engine. You may be given ONE OR MORE images.\nAnalyze every image provided")).toBe(true);
    expect(prompt.endsWith('Example for two images:\n[{"index":1,"image":"..."},{"index":2,"image":"..."}]')).toBe(true);
    // Backslashes in the prompt are literal, not escapes.
    expect(prompt).toContain('newline -> \\n, double-quote -> \\",\n  backslash -> \\\\.');
    expect(prompt.split("\n")).toHaveLength(36);
  });

  it.each<[string, string, string, number | undefined]>([
    ["a plain number", "9000", "9000", 9000],
    ["zero (no minimum)", "0", "0", 0],
    ["empty (inherit: key omitted)", "", "", undefined],
    ["a negative number (the sign is stripped)", "-5", "5", 5],
    ["non-numeric (emptied, key omitted)", "soon", "", undefined],
  ])("the OCR timeout takes %s", async (_name, typed, shown, sent) => {
    const { api } = await setup({ service: FULL_SVC });
    fireEvent.click(button(OCR_ADVANCED, ocrCard()));
    type(field("Timeout (ms)", ocrCard()), typed);
    expect(field("Timeout (ms)", ocrCard()).value).toBe(shown);
    expect(((await savedSteps(api)).ocr as { timeoutMs?: number }).timeoutMs).toBe(sent);
  });
});

// ---------------------------------------------------------------------------

describe("OcrEditor: the tester", () => {
  /** Serve the bundled screenshot, which the tester fetches as an ordinary URL. */
  const serveDefaultImage = (mediaType = "image/png") => {
    const inner = globalThis.fetch;
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== defaultOcrTestImage) return inner(input, init);
      fetched.push(String(input));
      return Promise.resolve({ blob: async () => new Blob(["img"], { type: mediaType }) } as Response);
    }));
    return fetched;
  };
  const tester = () => labelEl("Test OCR", ocrCard()).closest(".rounded-lg") as HTMLElement;
  const run = () => fireEvent.click(button("Send test image", ocrCard()));
  const fileInput = () => ocrCard().querySelector<HTMLInputElement>('input[type="file"]')!;
  const pick = async (file: File) => { await act(async () => { fireEvent.change(fileInput(), { target: { files: [file] } }); }); };
  const testCalls = (api: MockApi) => api.sent("POST", "/services/test-ocr");
  const OK = { ok: true, served: { model: "glm-ocr", provider: "zhipu" }, latencyMs: 1234, usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 }, description: "a cat", raw: '[{"index":1,"image":"a cat"}]' };
  const failure = () => tester().querySelector(".border-red-900\\/50");

  it("shows the default screenshot, an upload control and a run button", async () => {
    await setup({ service: FULL_SVC });
    const box = tester();
    expect(classes(box)).toEqual(cls(PANEL));
    expect(box).toBe(ocrCard().querySelector(".space-y-3")!.lastElementChild);
    const title = labelEl("Test OCR", box);
    expect([title.tagName, classes(title), classes(title.parentElement)]).toEqual(["LABEL", cls("label mb-0"), cls("mb-1 flex items-center justify-between")]);
    expect(classes(screen.getByText(/^Send a test image through the configuration above/))).toEqual(cls("mb-2 text-[11px] text-ink-600"));
    const img = box.querySelector("img")!;
    expect([img.getAttribute("src"), img.alt, classes(img)]).toEqual([defaultOcrTestImage, "", cls("h-12 w-20 shrink-0 rounded border border-ink-700 object-cover object-top")]);
    expect(classes(img.parentElement)).toEqual(cls("flex items-center gap-3"));
    const name = screen.getByText("Default: Hydrogen Overview screenshot");
    expect([classes(name), classes(name.parentElement)]).toEqual([cls("truncate text-xs text-ink-300"), cls("min-w-0 flex-1")]);
    expect(hasButton("Back to the default image", box)).toBe(false);
    const upload = fileInput().closest("label")!;
    expect([upload.textContent, classes(upload), upload.querySelector("i")!.className]).toEqual(["Use my own image", cls("btn-ghost btn-xs cursor-pointer"), "bi bi-upload"]);
    expect([fileInput().accept, fileInput().className]).toEqual(["image/*", "hidden"]);
    const go = button("Send test image", box);
    expect([classes(go), go.disabled, go.querySelector("i")!.className]).toEqual([cls("btn-primary btn-xs"), false, "bi bi-play-fill"]);
    expect(screen.queryByText("Pick an OCR model above before testing.")).toBeNull();
  });

  it("sends the default image with the current, unsaved OCR settings and shows the parsed description", async () => {
    const { api } = await setup({ service: FULL_SVC }, { "POST /services/test-ocr": OK });
    const fetched = serveDefaultImage();
    type(field("OCR model runs", ocrCard()), "chat-a");
    run();
    const badge = await screen.findByText("OK");
    expect(fetched).toEqual([defaultOcrTestImage]);
    expect(testCalls(api)).toEqual([sentJson("POST", "/services/test-ocr", { ocr: { ...FULL.ocr, service: "chat-a" }, image: { mediaType: "image/png", data: "aW1n" } })]);

    expect([classes(badge), badge.querySelector("i")!.className]).toEqual([["badge-green"], "bi bi-check-lg"]);
    const meta = badge.parentElement!;
    expect(classes(meta)).toEqual(cls("mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-400"));
    expect([...meta.children].map((c) => [c.textContent, c.className])).toEqual([
      ["OK", "badge-green"], ["glm-ocr@zhipu", "font-mono"], [`${formatNumber(1234)} ms`, ""], [`${formatNumber(1500)} tokens`, ""],
    ]);
    expect(classes(meta.parentElement)).toEqual(cls("mt-2 rounded-lg border border-ink-800 bg-ink-900/60 p-2.5 text-xs"));
    expect(classes(screen.getByText("Parsed description (what the stages will see)"))).toEqual(cls("mb-1 text-[11px] uppercase tracking-wide text-ink-500"));
    expect(classes(screen.getByText("a cat"))).toEqual(cls("max-h-56 overflow-y-auto whitespace-pre-wrap rounded bg-ink-950 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-200"));
    const showRaw = button("Show raw model reply", tester());
    expect([classes(showRaw), showRaw.querySelector("i")!.className]).toEqual([cls("mt-1.5 text-[11px] text-ink-500 hover:text-ink-300"), "bi bi-chevron-right mr-1"]);
    expect(screen.queryByText(OK.raw)).toBeNull();
    fireEvent.click(showRaw);
    expect(showRaw.querySelector("i")!.className).toBe("bi bi-chevron-down mr-1");
    expect(classes(screen.getByText(OK.raw))).toEqual(cls("mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap rounded bg-ink-950 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-400"));
    fireEvent.click(showRaw);
    expect(screen.queryByText(OK.raw)).toBeNull();
  });

  it("falls back to image/png when the fetched screenshot has no media type", async () => {
    const { api } = await setup({ service: FULL_SVC }, { "POST /services/test-ocr": { ok: true } });
    serveDefaultImage("");
    run();
    await screen.findByText("OK");
    expect((testCalls(api)[0].body as { image: unknown }).image).toEqual({ mediaType: "image/png", data: "aW1n" });
  });

  it("shows only the OK badge and the raw reply when the reply could not be parsed", async () => {
    await setup({ service: FULL_SVC }, { "POST /services/test-ocr": { ok: true, raw: "not json" } });
    serveDefaultImage();
    run();
    const badge = await screen.findByText("OK");
    expect([...badge.parentElement!.children].map((c) => c.textContent)).toEqual(["OK"]);
    const note = screen.getByText(/^The reply did not follow the JSON output contract/);
    expect(classes(note)).toEqual(cls("mb-1 text-[11px] text-amber-300"));
    expect(screen.getByText("not json")).toBeTruthy();
    expect(hasButton("Show raw model reply", tester())).toBe(false);
  });

  it("shows '(empty)' when there is neither a description nor a raw reply", async () => {
    await setup({ service: FULL_SVC }, { "POST /services/test-ocr": { ok: true } });
    serveDefaultImage();
    run();
    expect(await screen.findByText("(empty)")).toBeTruthy();
  });

  it.each([
    ["the model's failure", { ok: false, message: "upstream 500" }, "OCR test failed: upstream 500"],
    ["a refused call", fail(400, { error: "ocr is not configured" }), "OCR test failed: ocr is not configured"],
    ["a non-API failure, stringified", () => { throw new TypeError("offline"); }, "OCR test failed: TypeError: offline"],
  ])("shows %s in a red note", async (_name, handler, text) => {
    await setup({ service: FULL_SVC }, { "POST /services/test-ocr": handler });
    serveDefaultImage();
    run();
    await waitFor(() => expect(failure()).not.toBeNull());
    expect(failure()!.textContent).toBe(text);
    expect(classes(failure())).toEqual(cls("mt-2 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300"));
    expect(failure()!.querySelector("i")!.className).toBe("bi bi-x-circle mr-1.5");
    expect(button("Send test image", ocrCard()).disabled).toBe(false);
  });

  it("is busy while the test runs, and a new run clears the previous result", async () => {
    const gate = deferred<unknown>();
    const { api } = await setup({ service: FULL_SVC }, { "POST /services/test-ocr": OK });
    serveDefaultImage();
    run();
    await screen.findByText("a cat");
    api.on("POST /services/test-ocr", () => gate.promise);
    run();
    const busy = button("Testing…", ocrCard());
    expect([busy.disabled, busy.querySelector("i")!.className]).toEqual([true, "bi bi-arrow-repeat animate-spin"]);
    expect(screen.queryByText("a cat")).toBeNull();
    await waitFor(() => expect(testCalls(api)).toHaveLength(2));
    await act(async () => { gate.resolve({ ok: false, message: "second" }); });
    await waitFor(() => expect(failure()).not.toBeNull());
    expect(button("Send test image", ocrCard()).disabled).toBe(false);
    // The tester never disables the editor's own actions.
    expect(button("Save").disabled).toBe(false);
  });

  it("uses a picked image instead: its name, preview, media type and bytes", async () => {
    const { api } = await setup({ service: FULL_SVC }, { "POST /services/test-ocr": OK });
    const fetched = serveDefaultImage();
    await pick(new File(["hello"], "scan.jpg", { type: "image/jpeg" }));
    await screen.findByText("scan.jpg");
    expect(tester().querySelector("img")!.getAttribute("src")).toBe("data:image/jpeg;base64,aGVsbG8=");
    expect(fileInput().value).toBe("");
    const reset = button("Back to the default image", tester());
    expect([classes(reset), reset.querySelector("i")!.className]).toEqual([cls("text-[11px] text-brand-400 hover:text-brand-300"), "bi bi-arrow-counterclockwise mr-1"]);
    run();
    await screen.findByText("a cat");
    expect(fetched).toEqual([]);
    expect((testCalls(api)[0].body as { image: unknown }).image).toEqual({ mediaType: "image/jpeg", data: "aGVsbG8=" });

    fireEvent.click(reset);
    expect(screen.getByText("Default: Hydrogen Overview screenshot")).toBeTruthy();
    expect(tester().querySelector("img")!.getAttribute("src")).toBe(defaultOcrTestImage);
    expect(screen.queryByText("a cat")).toBeNull();
    expect(hasButton("Back to the default image", tester())).toBe(false);
  });

  it("picking a new image clears the previous result", async () => {
    await setup({ service: FULL_SVC }, { "POST /services/test-ocr": OK });
    serveDefaultImage();
    run();
    await screen.findByText("a cat");
    await pick(new File(["x"], "next.png", { type: "image/png" }));
    await screen.findByText("next.png");
    expect(screen.queryByText("a cat")).toBeNull();
  });

  const sized = (bytes: number) => {
    const file = new File(["x"], "big.png", { type: "image/png" });
    Object.defineProperty(file, "size", { value: bytes });
    return file;
  };

  it("refuses a file that is not an image and keeps the current image", async () => {
    await setup({ service: FULL_SVC });
    await pick(new File(["%PDF"], "doc.pdf", { type: "application/pdf" }));
    await waitFor(() => expect(failure()).not.toBeNull());
    expect(failure()!.textContent).toBe("OCR test failed: That file is not an image.");
    expect(screen.getByText("Default: Hydrogen Overview screenshot")).toBeTruthy();
  });

  it.each([
    ["exactly 15 MiB is accepted", 15 * MIB, true],
    ["one byte more is refused", 15 * MIB + 1, false],
  ])("image size limit: %s", async (_name, bytes, accepted) => {
    await setup({ service: FULL_SVC });
    await pick(sized(bytes));
    if (accepted) {
      await screen.findByText("big.png");
      expect(failure()).toBeNull();
    } else {
      await waitFor(() => expect(failure()).not.toBeNull());
      expect(failure()!.textContent).toBe("OCR test failed: Image is too large (max 15 MB).");
      expect(screen.queryByText("big.png")).toBeNull();
    }
  });

  it("cancelling the file dialog changes nothing", async () => {
    await setup({ service: FULL_SVC });
    await pick(undefined as unknown as File);
    expect(failure()).toBeNull();
    expect(screen.getByText("Default: Hydrogen Overview screenshot")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe("ServiceEditor: reopening after a Micro Agent", () => {
  // The ASR pre-pass is left out of these on purpose: see the report (it is not reset on reopen).
  const { asr: _asr, ...NO_ASR } = FULL;
  const BEFORE = service(5, "agent", NO_ASR);
  const CHAIN = service(6, "chain", { timeoutMs: 1000, steps: [], hostedTools: { streamMode: "final", maxRounds: 1, maxCalls: 1 } });

  /** Keeps one editor mounted, as the page does, and walks it through `sequence`. */
  function Host({ sequence }: { sequence: Array<ModelService | null> }) {
    const [i, setI] = useState(0);
    return (
      <>
        <button onClick={() => setI(i + 1)}>next-target</button>
        <ServiceEditor open service={sequence[i]} services={SERVICES} models={[]} providers={[]} mappings={[]} defaultKind="chain" onClose={() => {}} onSaved={() => {}} />
      </>
    );
  }
  const host = async (sequence: Array<ModelService | null>) => {
    const api = mockApi({ "GET /tools": { tools: TOOLS }, "POST /services": {}, "PATCH /services/5": {}, "PATCH /services/6": {} }, ADMIN);
    await renderPage(<Host sequence={sequence} />);
    await screen.findByText("Hosted server tools");
    return api;
  };

  it("a new agent starts with no stage, no output choice, no OCR pre-pass and the default limits", async () => {
    const api = await host([BEFORE, null]);
    fireEvent.click(button("next-target"));
    expect(openModal("New Micro Agent")).toBeTruthy();
    expect(cards()).toHaveLength(2);
    expect(isOn(toggle(OCR_TOGGLE))).toBe(false);
    type(field("Name (exposed model name)"), "fresh");
    expect(await save(api)).toEqual(sentJson("POST", "/services", { name: "fresh", description: null, steps: NEW_AGENT, enabled: true, toolIds: [] }));
  });

  it("a Model Service opened next shows its failure chain and saves none of the agent's fields", async () => {
    const api = await host([BEFORE, CHAIN]);
    fireEvent.click(button("next-target"));
    expect(classes(openModal('Edit "chain"').querySelector("h2 i"))).toEqual(cls("bi bi-diagram-3 text-brand-400"));
    expect(screen.getByText("Failure chain (drag to reorder)")).toBeTruthy();
    expect(cards()).toEqual([]);
    expect(await save(api)).toEqual(sentJson("PATCH", "/services/6", { name: "chain", description: null, steps: CHAIN.steps, enabled: true, toolIds: [] }));
  });

  it("an agent opened after a Model Service loads its stages over the empty form", async () => {
    const api = await host([CHAIN, BEFORE]);
    fireEvent.click(button("next-target"));
    expect(stageNames()).toEqual(["draft", "check", "final"]);
    expect(await save(api)).toEqual(sentJson("PATCH", "/services/5", { name: "agent", description: null, steps: NO_ASR, enabled: true, toolIds: [] }));
  });
});
