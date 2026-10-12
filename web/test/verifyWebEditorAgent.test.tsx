/**
 * Independent verification (spec WEB-A, items WA1, WA7-WA9): the ServiceEditor
 * as a Micro Agent editor and its stage editor, driven only through rendered
 * controls. Expected values come from the verification spec.
 */
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { ServiceEditor } from "../src/components/ServiceEditor";
import type { HostedTool, ModelService, ServiceDef } from "../src/types";
import { ADMIN, button, field, hasButton, isOn, labelEl, mockApi, openModal, renderPage, toasts, toggle, type, type MockApi } from "./helpers";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

type Props = ComponentProps<typeof ServiceEditor>;
type Kind = NonNullable<Props["defaultKind"]>;
type Json = Record<string, unknown>;
interface Body { name: string; description: string | null; steps: Json; enabled: boolean; toolIds?: number[] }

const AGENT_KIND: Kind = "chain";
const SERVICE_KIND: Kind = "resilience";
const TOOLS: HostedTool[] = [{
  id: 1, name: "search", description: "", parameters: {}, url: "https://t", bodyTemplate: null, resultPath: "", timeoutMs: 1000, maxResultBytes: 1000, enabled: true, headerNames: [], hasHeaders: false,
}];
const HOSTED = { streamMode: "progress", maxRounds: 8, maxCalls: 16 };
const STEP = { model: "sonnet", provider: "openai" };
const svc = (id: number, name: string, steps: Json, extra: Partial<ModelService> = {}): ModelService => ({
  id, name, description: null, steps: steps as unknown as ServiceDef, enabled: true, summary: "", createdAt: id, ...extra,
});
const CHAT = svc(20, "chat-a", { timeoutMs: 60000, steps: [STEP] });
const IMAGE = svc(22, "painter", { timeoutMs: 60000, steps: [STEP], category: "image" });
const STT = svc(23, "whisper", { timeoutMs: 60000, steps: [STEP], category: "stt" });
const STT2 = svc(24, "whisper-2", { timeoutMs: 60000, steps: [STEP], category: "stt" });
const TTS = svc(27, "speaker", { timeoutMs: 60000, steps: [STEP], category: "tts" });
const VIDEO = svc(28, "filmer", { timeoutMs: 60000, steps: [STEP], category: "video" });
const EMBED = svc(29, "embedder", { timeoutMs: 60000, steps: [STEP], category: "embedding" });
const RERANK = svc(30, "ranker", { timeoutMs: 60000, steps: [STEP], category: "rerank" });
const SERVICES = [CHAT, IMAGE, STT, STT2];
const MEDIA_NAMES = ["painter", "whisper", "whisper-2", "speaker", "filmer", "embedder", "ranker"];

const agentDef = (stages: Json[], extra: Json = {}): Json => ({ kind: "micro_agent", timeoutMs: 60000, stages, hostedTools: HOSTED, ...extra });
const stageOf = (name: string, extra: Json = {}): Json => ({ name, service: "chat-a", input: [], ...extra });

const ROUTES = { "GET /tools": { tools: TOOLS }, "POST /services": {}, "PATCH /services/5": {}, "PATCH /services/6": {}, "PATCH /services/7": {} };
const setup = async (props: Partial<Props> = {}) => {
  const api = mockApi(ROUTES, ADMIN);
  const view = await renderPage(
    <ServiceEditor open service={null} services={SERVICES} models={[]} providers={[]} mappings={[]} defaultKind={AGENT_KIND} onClose={() => {}} onSaved={() => {}} {...props} />,
  );
  await screen.findByText("Hosted server tools");
  return { api, ...view };
};
const edit = (def: Json, props: Partial<Props> = {}) => setup({ service: svc(5, "agent", def), ...props });

const saves = (api: MockApi) => api.mutations().filter((c) => /^\/services(\/\d+)?$/.test(c.path));
const save = async (api: MockApi) => {
  const before = saves(api).length;
  fireEvent.click(button("Save"));
  await waitFor(() => expect(saves(api)).toHaveLength(before + 1));
  return saves(api)[before];
};
const savedSteps = async (api: MockApi): Promise<Json> => ((await save(api)).body as Body).steps;
const savedStages = async (api: MockApi): Promise<Json[]> => (await savedSteps(api)).stages as Json[];

const ASR_TOGGLE = "Audio transcription (ASR) pre-pass";
const NAME = "Name (exposed model name)";
/** In an agent the editor cards are, in order: OCR, ASR, then one per stage. */
const cards = () => [...document.querySelectorAll<HTMLElement>(".rounded-xl.bg-ink-850\\/70")];
const stages = () => cards().slice(2);
const stage = (i: number) => stages()[i];
const stageName = (c: HTMLElement) => c.querySelector<HTMLInputElement>('input[placeholder="stage name"]')!;
const stageNames = () => stages().map((c) => stageName(c).value);
const runs = (c: HTMLElement) => field<HTMLSelectElement>("Runs", c);
const optionValues = (select: HTMLSelectElement) => [...select.options].map((o) => o.value);
const addBlock = (c: HTMLElement, kind: string) => type(labelEl("Input", c).parentElement!.querySelector("select")!, kind);

// ---------------------------------------------------------------------------

describe("WA1: the ASR pre-pass of a previously opened Micro Agent does not leak", () => {
  interface Target { service: ModelService | null; open?: boolean; kind?: Kind }
  const WITH_ASR = svc(5, "listener", agentDef([stageOf("a")], { asr: { service: "whisper", timeoutMs: 20000 } }));
  const OTHER_ASR = svc(7, "listener-2", agentDef([stageOf("z")], { asr: { service: "whisper-2", timeoutMs: 5000 } }));
  const PLAIN_AGENT = svc(5, "plain", agentDef([stageOf("a")]));
  const CHAIN = svc(6, "chain", { timeoutMs: 1000, steps: [], hostedTools: HOSTED });
  const CLOSED: Target = { service: null, open: false };

  /** Keeps one editor mounted, as the page does, and walks it through `sequence`. */
  function Host({ sequence }: { sequence: Target[] }) {
    const [i, setI] = useState(0);
    const cur = sequence[i];
    return (
      <>
        <button onClick={() => setI(i + 1)}>next-target</button>
        <ServiceEditor open={cur.open ?? true} service={cur.service} services={SERVICES} models={[]} providers={[]} mappings={[]}
          defaultKind={cur.kind ?? AGENT_KIND} onClose={() => {}} onSaved={() => {}} />
      </>
    );
  }
  const host = async (sequence: Target[]) => {
    const api = mockApi(ROUTES, ADMIN);
    await renderPage(<Host sequence={sequence} />);
    await screen.findByText("Hosted server tools");
    return api;
  };
  const next = () => fireEvent.click(button("next-target"));

  it("the stored agent really opens with its ASR pre-pass on (precondition)", async () => {
    const api = await host([{ service: WITH_ASR }]);
    expect(isOn(toggle(ASR_TOGGLE))).toBe(true);
    expect((await savedSteps(api)).asr).toEqual({ service: "whisper", timeoutMs: 20000 });
  });

  it("open, close, then a NEW Micro Agent: the saved payload has no asr", async () => {
    const api = await host([{ service: WITH_ASR }, CLOSED, { service: null }]);
    next();
    expect(document.querySelector(".card")).toBeNull();
    next();
    expect(openModal("New Micro Agent")).toBeTruthy();
    expect(isOn(toggle(ASR_TOGGLE))).toBe(false);
    type(field(NAME), "fresh");
    const sent = await save(api);
    expect([sent.method, sent.path]).toEqual(["POST", "/services"]);
    expect((sent.body as Body).steps).not.toHaveProperty("asr");
    expect((sent.body as Body).steps.kind).toBe("micro_agent");
  });

  it("a NEW Micro Agent opened straight after (no close in between) has no asr either", async () => {
    const api = await host([{ service: WITH_ASR }, { service: null }]);
    next();
    expect(isOn(toggle(ASR_TOGGLE))).toBe(false);
    type(field(NAME), "fresh");
    expect(await savedSteps(api)).not.toHaveProperty("asr");
  });

  it("open, close, then an existing Model Service: the saved payload has no asr", async () => {
    const api = await host([{ service: WITH_ASR }, CLOSED, { service: CHAIN }]);
    next();
    next();
    expect(openModal('Edit "chain"')).toBeTruthy();
    const sent = await save(api);
    expect([sent.method, sent.path]).toEqual(["PATCH", "/services/6"]);
    expect((sent.body as Body).steps).not.toHaveProperty("asr");
  });

  it("open, close, then a NEW Model Service: the saved payload has no asr", async () => {
    const api = await host([{ service: WITH_ASR }, CLOSED, { service: null, kind: SERVICE_KIND }]);
    next();
    next();
    expect(openModal("New Model Service")).toBeTruthy();
    type(field(NAME), "fresh");
    expect(await savedSteps(api)).not.toHaveProperty("asr");
  });

  it("an ASR pre-pass switched on but never saved does not reach the next new Micro Agent", async () => {
    const api = await host([{ service: PLAIN_AGENT }, CLOSED, { service: null }]);
    fireEvent.click(toggle(ASR_TOGGLE));
    expect(isOn(toggle(ASR_TOGGLE))).toBe(true);
    next();
    next();
    expect(isOn(toggle(ASR_TOGGLE))).toBe(false);
    type(field(NAME), "fresh");
    expect(await savedSteps(api)).not.toHaveProperty("asr");
  });

  it("a Micro Agent without ASR opened after one with ASR is saved without asr", async () => {
    const api = await host([{ service: WITH_ASR }, CLOSED, { service: svc(6, "plain", agentDef([stageOf("a")])) }]);
    next();
    next();
    expect(isOn(toggle(ASR_TOGGLE))).toBe(false);
    expect(await savedSteps(api)).not.toHaveProperty("asr");
  });

  it("reopening the same agent keeps its own ASR pre-pass (unchanged neighbour)", async () => {
    const api = await host([{ service: WITH_ASR }, CLOSED, { service: WITH_ASR }]);
    next();
    next();
    expect(isOn(toggle(ASR_TOGGLE))).toBe(true);
    expect((await savedSteps(api)).asr).toEqual({ service: "whisper", timeoutMs: 20000 });
  });

  it("another agent with its own ASR pre-pass shows and saves its own, not the previous one", async () => {
    const api = await host([{ service: WITH_ASR }, CLOSED, { service: OTHER_ASR }]);
    next();
    next();
    const sent = await save(api);
    expect(sent.path).toBe("/services/7");
    expect((sent.body as Body).steps.asr).toEqual({ service: "whisper-2", timeoutMs: 5000 });
  });
});

// ---------------------------------------------------------------------------

describe("WA7 (agent editor): switching from Raw JSON back to the visual editor", () => {
  it.each([["invalid JSON", "{ nope"], ["null", "null"], ["an array", "[]"], ["a number", "5"], ["a string", '"x"'], ["empty text", ""]])(
    "with %s it toasts, stays in the raw view and keeps the text", async (_name, text) => {
      await edit(agentDef([stageOf("a")]));
      fireEvent.click(button("Raw JSON"));
      type(field("Chain JSON"), text);
      fireEvent.click(button("Visual editor"));
      await waitFor(() => expect(toasts().length).toBeGreaterThan(0));
      expect(hasButton("Visual editor")).toBe(true);
      expect(field<HTMLTextAreaElement>("Chain JSON").value).toBe(text);
    });

  it("with a valid agent object it returns to the form", async () => {
    await edit(agentDef([stageOf("a")]));
    fireEvent.click(button("Raw JSON"));
    type(field("Chain JSON"), JSON.stringify(agentDef([stageOf("one"), stageOf("two")])));
    fireEvent.click(button("Visual editor"));
    expect(hasButton("Raw JSON")).toBe(true);
    expect(stageNames()).toEqual(["one", "two"]);
    expect(toasts()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("WA8: reliableStreaming on a stored Micro Agent survives a visual save", () => {
  const RELIABLE = agentDef([stageOf("a")], { reliableStreaming: true });

  it("an untouched save keeps reliableStreaming: true", async () => {
    const { api } = await edit(RELIABLE);
    expect((await savedSteps(api)).reliableStreaming).toBe(true);
  });

  it("a save after editing other fields keeps reliableStreaming: true", async () => {
    const { api } = await edit(RELIABLE);
    type(field(NAME), "renamed");
    type(field("Per-attempt timeout (ms)"), "1000");
    fireEvent.click(button("Add stage"));
    const sent = (await save(api)).body as Body;
    expect(sent.name).toBe("renamed");
    expect(sent.steps.timeoutMs).toBe(1000);
    expect(sent.steps.reliableStreaming).toBe(true);
  });

  it("a second save keeps reliableStreaming: true", async () => {
    const { api } = await edit(RELIABLE);
    await save(api);
    expect((await savedSteps(api)).reliableStreaming).toBe(true);
  });

  it("a visit to the raw view and back keeps reliableStreaming: true", async () => {
    const { api } = await edit(RELIABLE);
    fireEvent.click(button("Raw JSON"));
    fireEvent.click(button("Visual editor"));
    expect((await savedSteps(api)).reliableStreaming).toBe(true);
  });

  it("the legacy kind 'agent' with reliableStreaming: true keeps it too", async () => {
    const { api } = await edit({ ...RELIABLE, kind: "agent" });
    expect((await savedSteps(api)).reliableStreaming).toBe(true);
  });

  it("an agent stored without the flag is not saved with reliableStreaming: true", async () => {
    const { api } = await edit(agentDef([stageOf("a")]));
    expect((await savedSteps(api)).reliableStreaming).not.toBe(true);
  });

  it("a new Micro Agent is not saved with reliableStreaming: true", async () => {
    const { api } = await setup();
    type(field(NAME), "fresh");
    expect((await savedSteps(api)).reliableStreaming).not.toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("WA9a: renaming a stage updates every reference to it", () => {
  const ALWAYS = { type: "always" };
  const out = (stageRef: string, role = "assistant"): Json => ({ kind: "stage_output", stage: stageRef, role });
  /** "a" is referenced as the agent's output and by stage_output blocks; "c" by two gotos; "ab" only shares a prefix with "a". */
  const build = (a: string, ab: string, c: string): Json[] => [
    stageOf(a, { transitions: [{ when: ALWAYS, goto: c }] }),
    stageOf(ab, { input: [out(a)], transitions: [{ when: ALWAYS, goto: c }] }),
    stageOf(c, { input: [out(a), out(ab, "user")] }),
  ];
  const DEF = (output: string) => agentDef(build("a", "ab", "c"), { output });

  it("round-trips untouched (precondition)", async () => {
    const { api } = await edit(DEF("a"));
    const steps = await savedSteps(api);
    expect(steps.stages).toEqual(build("a", "ab", "c"));
    expect(steps.output).toBe("a");
  });

  it("the agent's output and the stage_output blocks follow a renamed stage", async () => {
    const { api } = await edit(DEF("a"));
    type(stageName(stage(0)), "alpha");
    const steps = await savedSteps(api);
    expect(steps.output).toBe("alpha");
    expect(steps.stages).toEqual(build("alpha", "ab", "c"));
  });

  it("transitions' goto follow a renamed stage", async () => {
    const { api } = await edit(DEF("a"));
    type(stageName(stage(2)), "omega");
    const steps = await savedSteps(api);
    expect(steps.stages).toEqual(build("a", "ab", "omega"));
    expect(steps.output).toBe("a");
  });

  it("the agent's output follows when the last stage is the returned one", async () => {
    const { api } = await edit(DEF("c"));
    type(stageName(stage(2)), "omega");
    const steps = await savedSteps(api);
    expect(steps.output).toBe("omega");
    expect(steps.stages).toEqual(build("a", "ab", "omega"));
  });

  it("references follow a name typed in several edits", async () => {
    const { api } = await edit(DEF("a"));
    type(stageName(stage(0)), "al");
    type(stageName(stage(0)), "alp");
    type(stageName(stage(0)), "alpha");
    const steps = await savedSteps(api);
    expect(steps.output).toBe("alpha");
    expect(steps.stages).toEqual(build("alpha", "ab", "c"));
  });

  it("renaming one stage leaves references to the others alone, including a name that only shares a prefix", async () => {
    const { api } = await edit(DEF("a"));
    type(stageName(stage(1)), "beta");
    const steps = await savedSteps(api);
    expect(steps.output).toBe("a");
    expect(steps.stages).toEqual(build("a", "beta", "c"));
  });

  it("a rename and a rename back restores every reference", async () => {
    const { api } = await edit(DEF("a"));
    type(stageName(stage(0)), "alpha");
    type(stageName(stage(0)), "a");
    const steps = await savedSteps(api);
    expect(steps.output).toBe("a");
    expect(steps.stages).toEqual(build("a", "ab", "c"));
  });

  it("an end transition's returned stage and an output condition's stage follow the rename too", async () => {
    const withRefs = (a: string): Json[] => [
      stageOf(a),
      stageOf("b", { transitions: [{ when: { type: "output_contains", value: "bad", stage: a }, goto: "end", output: a }] }),
    ];
    const { api } = await edit(agentDef(withRefs("a")));
    expect(await savedStages(api)).toEqual(withRefs("a"));
    type(stageName(stage(0)), "alpha");
    expect(await savedStages(api)).toEqual(withRefs("alpha"));
  });
});

// ---------------------------------------------------------------------------

describe("WA9b: Add stage picks a service the Runs select offers", () => {
  const newStage = async (services: ModelService[]) => {
    const { api } = await setup({ services });
    fireEvent.click(button("Add stage"));
    expect(stages()).toHaveLength(1);
    const select = runs(stage(0));
    const shown = select.value;
    const offered = optionValues(select);
    type(field(NAME), "x");
    const [saved] = await savedStages(api);
    return { shown, offered, service: saved.service as string | undefined };
  };

  it.each<[string, ModelService[]]>([
    ["an image service", [IMAGE, CHAT]],
    ["a speech-to-text service", [STT, CHAT]],
    ["a text-to-speech service", [TTS, CHAT]],
    ["a video service", [VIDEO, CHAT]],
    ["an embedding service", [EMBED, CHAT]],
    ["a reranker", [RERANK, CHAT]],
    ["several media services", [IMAGE, STT, STT2, TTS, CHAT]],
  ])("with %s listed first, the new stage runs the chat service, not the media one", async (_name, services) => {
    const { shown, offered, service } = await newStage(services);
    expect(MEDIA_NAMES).not.toContain(service);
    expect(offered).toContain("chat-a");
    expect(service).toBe("chat-a");
    expect(shown).toBe("chat-a");
  });

  it.each<[string, ModelService[]]>([
    ["only a speech-to-text service", [STT]],
    ["only media services", [IMAGE, STT, TTS, VIDEO, EMBED, RERANK]],
  ])("with %s, the new stage runs no media service and the select shows one of its own options", async (_name, services) => {
    const { shown, offered, service } = await newStage(services);
    expect(MEDIA_NAMES).not.toContain(service);
    expect(service).toBeUndefined();
    expect(offered).toContain(shown);
    for (const name of MEDIA_NAMES) expect(offered).not.toContain(name);
  });

  it("with a chat service listed first it still runs that one (unchanged neighbour)", async () => {
    const { shown, service } = await newStage([CHAT, IMAGE, STT]);
    expect([shown, service]).toEqual(["chat-a", "chat-a"]);
  });

  it("a second added stage also avoids the media service", async () => {
    const { api } = await setup({ services: [STT, IMAGE, CHAT] });
    fireEvent.click(button("Add stage"));
    fireEvent.click(button("Add stage"));
    type(field(NAME), "x");
    expect((await savedStages(api)).map((s) => s.service)).toEqual(["chat-a", "chat-a"]);
  });
});

// ---------------------------------------------------------------------------

describe("WA9c: stages with the same or an empty name render without duplicate-key warnings", () => {
  const keyWarnings = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((args) => args.map(String).join(" ")).filter((line) => /same key|unique "key"/i.test(line));
  const watch = () => vi.spyOn(console, "error").mockImplementation(() => {});
  const ALWAYS = { type: "always" };

  it("two stages named alike, stored that way", async () => {
    const spy = watch();
    await edit(agentDef([
      stageOf("x", { transitions: [{ when: ALWAYS, goto: "x" }] }),
      stageOf("x", { input: [{ kind: "stage_output", stage: "x", role: "assistant" }], transitions: [{ when: { type: "output_contains", value: "v", stage: "x" }, goto: "end", output: "x" }] }),
      stageOf("y", { input: [{ kind: "stage_output", stage: "x", role: "assistant" }] }),
    ], { output: "x" }));
    expect(stageNames()).toEqual(["x", "x", "y"]);
    expect(keyWarnings(spy)).toEqual([]);
  });

  it("two stages with an empty name, stored that way", async () => {
    const spy = watch();
    await edit(agentDef([
      stageOf("", { transitions: [{ when: ALWAYS, goto: "" }] }),
      stageOf("", { input: [{ kind: "stage_output", stage: "", role: "assistant" }], transitions: [{ when: ALWAYS, goto: "end", output: "" }] }),
      stageOf("z", { input: [{ kind: "stage_output", stage: "", role: "assistant" }] }),
    ]));
    expect(stageNames()).toEqual(["", "", "z"]);
    expect(keyWarnings(spy)).toEqual([]);
  });

  it("a stage renamed to another stage's name, with transitions and stage-output blocks on screen", async () => {
    const spy = watch();
    await edit(agentDef([stageOf("a"), stageOf("b"), stageOf("c")], { output: "a" }));
    fireEvent.click(button("Add transition", stage(0)));
    addBlock(stage(2), "stage_output");
    type(stageName(stage(1)), "a");
    expect(stageNames()).toEqual(["a", "a", "c"]);
    fireEvent.click(button("Add transition", stage(1)));
    addBlock(stage(2), "stage_output");
    expect(keyWarnings(spy)).toEqual([]);
  });

  it("two stage names cleared to empty", async () => {
    const spy = watch();
    await edit(agentDef([stageOf("a"), stageOf("b"), stageOf("c")]));
    fireEvent.click(button("Add transition", stage(0)));
    addBlock(stage(2), "stage_output");
    type(stageName(stage(0)), "");
    type(stageName(stage(1)), "");
    expect(stageNames()).toEqual(["", "", "c"]);
    expect(keyWarnings(spy)).toEqual([]);
  });

  it("distinct names render without warnings as well (unchanged neighbour)", async () => {
    const spy = watch();
    await edit(agentDef([stageOf("a"), stageOf("b"), stageOf("c")], { output: "b" }));
    fireEvent.click(button("Add transition", stage(0)));
    addBlock(stage(2), "stage_output");
    expect(keyWarnings(spy)).toEqual([]);
  });

  it("stages named alike are still saved as they are shown", async () => {
    const { api } = await edit(agentDef([stageOf("x"), stageOf("x")]));
    expect((await savedStages(api)).map((s) => s.name)).toEqual(["x", "x"]);
  });
});
