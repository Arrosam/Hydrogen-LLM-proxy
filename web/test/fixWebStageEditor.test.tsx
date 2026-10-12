/**
 * Regression tests for defects fixed in the StageEditor (WA9): what "Add stage"
 * runs, references following a renamed stage, and option keys of stage-name
 * lists. The characterization file components-stage-editor pins the rest.
 */
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { ServiceEditor } from "../src/components/ServiceEditor";
import { renameStage, renameStageRefs } from "../src/lib/agentStage";
import { stageServices } from "../src/lib/services";
import type { AgentDef, AgentStage, ModelService, ServiceDef } from "../src/types";
import { ADMIN, button, field, mockApi, renderPage, type, type MockApi } from "./helpers";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

type Props = ComponentProps<typeof ServiceEditor>;
const TOOL_DEFAULTS = { streamMode: "progress", maxRounds: 8, maxCalls: 16 } as const;
const service = (id: number, name: string, steps: ServiceDef): ModelService => ({ id, name, description: null, steps, enabled: true, summary: "", createdAt: id });
const STEP = { model: "sonnet", provider: "openai" };
const CHAT = service(20, "chat-a", { timeoutMs: 60000, steps: [STEP] });
const OCR = service(21, "ocr-b", { timeoutMs: 60000, steps: [STEP], category: "ocr" });
const IMAGE = service(22, "painter", { timeoutMs: 60000, steps: [STEP], category: "image" });
const STT = service(23, "whisper", { timeoutMs: 60000, steps: [STEP], category: "stt" });
const SUB_AGENT = service(25, "sub-agent", { kind: "micro_agent", timeoutMs: 60000, stages: [] });
const agent = (stages: AgentStage[], extra: Partial<AgentDef> = {}): AgentDef => ({ kind: "micro_agent", timeoutMs: 60000, stages, hostedTools: TOOL_DEFAULTS, ...extra } as AgentDef);

const setup = async (props: Partial<Props> = {}) => {
  const api = mockApi({ "GET /tools": { tools: [] }, "POST /services": {}, "PATCH /services/5": {} }, ADMIN);
  await renderPage(
    <ServiceEditor open service={null} services={[CHAT, OCR, IMAGE, STT, SUB_AGENT]} models={[]} providers={[]} mappings={[]} defaultKind="chain" onClose={() => {}} onSaved={() => {}} {...props} />,
  );
  await waitFor(() => expect(api.sent("GET", "/tools").length).toBeGreaterThan(0));
  await act(async () => {});
  return api;
};
const edit = (def: ServiceDef, props: Partial<Props> = {}) => setup({ service: service(5, "agent", def), ...props });
const savedDef = async (api: MockApi) => {
  const saves = () => api.mutations().filter((c) => c.path === "/services" || c.path === "/services/5");
  const before = saves().length;
  fireEvent.click(button("Save"));
  await waitFor(() => expect(saves()).toHaveLength(before + 1));
  return (saves()[before].body as { steps: AgentDef }).steps;
};
/** In an agent the editor cards are, in order: OCR, ASR, then one per stage. */
const stage = (i: number) => [...document.querySelectorAll<HTMLElement>(".rounded-xl.bg-ink-850\\/70")].slice(2)[i];
const stageName = (i: number) => stage(i).querySelector<HTMLInputElement>('input[placeholder="stage name"]')!;
const runs = (i: number) => field<HTMLSelectElement>("Runs", stage(i));

// ---------------------------------------------------------------------------

describe("WA9: Add stage runs the first service the Runs select offers", () => {
  it("stageServices keeps the chat-pipeline Model Services and the Micro Agents, in their order, and nothing else", () => {
    expect(stageServices([IMAGE, SUB_AGENT, STT, OCR, CHAT]).map((s) => s.name)).toEqual(["sub-agent", "ocr-b", "chat-a"]);
    expect(stageServices([IMAGE, STT])).toEqual([]);
  });

  it.each<[string, ModelService[], string]>([
    ["a media service is listed first", [IMAGE, STT, CHAT], "chat-a"],
    ["an agent is listed first", [SUB_AGENT, IMAGE, OCR], "sub-agent"],
    ["only an agent can run", [IMAGE, SUB_AGENT], "sub-agent"],
  ])("when %s, the new stage runs an offered service", async (_name, services, expected) => {
    const api = await setup({ services });
    fireEvent.click(button("Add stage"));
    expect(runs(0).value).toBe(expected);
    expect([...runs(0).options].map((o) => o.value)).toContain(expected);
    type(field("Name (exposed model name)"), "x");
    expect((await savedDef(api)).stages).toEqual([{ name: "stage", input: [], service: expected }]);
  });

  it("with only services a stage cannot run, the new stage is a router rather than a stage running one of them", async () => {
    const api = await setup({ services: [IMAGE, STT] });
    fireEvent.click(button("Add stage"));
    expect(runs(0).value).toBe("__router__");
    type(field("Name (exposed model name)"), "x");
    expect((await savedDef(api)).stages).toEqual([{ name: "stage", input: [] }]);
  });
});

// ---------------------------------------------------------------------------

const DRAFT: AgentStage = { name: "draft", service: "chat-a", input: [{ kind: "last_user" }] };
const CHECK: AgentStage = {
  name: "check",
  service: "sub-agent",
  input: [{ kind: "stage_output", stage: "draft", role: "assistant" }, { kind: "message", role: "user", text: "draft" }],
  transitions: [
    { when: { type: "output_contains", value: "bad", stage: "draft" }, goto: "end", output: "draft" },
    { when: { type: "always" }, goto: "final" },
  ],
};
const FINAL: AgentStage = { name: "final", service: "ocr-b", input: [{ kind: "stage_output", stage: "check", role: "user" }] };
const STAGES = [DRAFT, CHECK, FINAL];

describe("WA9: renameStageRefs", () => {
  it("repoints stage_output blocks, output conditions and returned outputs, and nothing that merely contains the text", () => {
    const next = renameStageRefs(STAGES, "draft", "draft", "first");
    expect(next.output).toBe("first");
    expect(next.stages[1]).toEqual({
      ...CHECK,
      input: [{ kind: "stage_output", stage: "first", role: "assistant" }, { kind: "message", role: "user", text: "draft" }],
      transitions: [
        { when: { type: "output_contains", value: "bad", stage: "first" }, goto: "end", output: "first" },
        { when: { type: "always" }, goto: "final" },
      ],
    });
    // Stages that do not mention it, and the names themselves, are left alone.
    expect([next.stages[0], next.stages[2]]).toEqual([DRAFT, FINAL]);
  });

  it("repoints a transition's goto and the agent's output", () => {
    const next = renameStageRefs(STAGES, "final", "final", "last");
    expect(next.output).toBe("last");
    expect(next.stages[1].transitions![1]).toEqual({ when: { type: "always" }, goto: "last" });
    expect(next.stages[1].transitions![0]).toEqual(CHECK.transitions![0]);
  });

  it("leaves an unrelated output choice and the default alone, adds no keys, and does not mutate", () => {
    const frozen = JSON.stringify(STAGES);
    expect(renameStageRefs(STAGES, "", "draft", "first").output).toBe("");
    expect(renameStageRefs(STAGES, "final", "draft", "first").output).toBe("final");
    expect(Object.keys(renameStageRefs(STAGES, "", "check", "x").stages[0])).toEqual(Object.keys(DRAFT));
    expect(JSON.stringify(STAGES)).toBe(frozen);
  });

  it("never repoints the reserved 'end' target", () => {
    const stages: AgentStage[] = [{ name: "end", input: [], transitions: [{ when: { type: "always" }, goto: "end" }] }];
    expect(renameStageRefs(stages, "", "end", "stop").stages[0].transitions![0].goto).toBe("end");
  });
});

describe("WA9: renameStage", () => {
  it("renames the stage and its references together", () => {
    const r = renameStage(STAGES, "draft", 0, "first", undefined);
    expect([r.stages[0].name, r.output, r.pending]).toEqual(["first", "first", undefined]);
    expect(r.stages[1].input[0]).toEqual({ kind: "stage_output", stage: "first", role: "assistant" });
  });

  it("holds the references while the name is empty and repoints them at the next real name", () => {
    const cleared = renameStage(STAGES, "draft", 0, "", undefined);
    expect([cleared.stages[0].name, cleared.output, cleared.pending]).toEqual(["", "draft", "draft"]);
    expect(cleared.stages[1]).toEqual(CHECK);
    const typed = renameStage(cleared.stages, cleared.output, 0, "n", cleared.pending);
    expect([typed.stages[0].name, typed.output, typed.pending]).toEqual(["n", "n", undefined]);
    expect(typed.stages[1].transitions![0]).toEqual({ when: { type: "output_contains", value: "bad", stage: "n" }, goto: "end", output: "n" });
  });

  it("holds them while the typed name is another stage's, so the two are never merged", () => {
    const clash = renameStage(STAGES, "", 0, "check", undefined);
    expect([clash.stages[0].name, clash.pending]).toEqual(["check", "draft"]);
    expect([clash.stages[1].input[0], clash.stages[2].input[0]]).toEqual([CHECK.input[0], FINAL.input[0]]);
    const done = renameStage(clash.stages, clash.output, 0, "check2", clash.pending);
    expect(done.pending).toBeUndefined();
    expect(done.stages[1].input[0]).toEqual({ kind: "stage_output", stage: "check2", role: "assistant" });
    // References to the real "check" still point at it.
    expect(done.stages[2].input[0]).toEqual(FINAL.input[0]);
  });

  it("leaves references alone when the old name was shared with another stage", () => {
    const twins: AgentStage[] = [{ name: "a", input: [] }, { name: "a", input: [] }, { name: "c", input: [{ kind: "stage_output", stage: "a", role: "assistant" }] }];
    const r = renameStage(twins, "a", 0, "b", undefined);
    expect([r.stages.map((s) => s.name), r.output, r.pending]).toEqual([["b", "a", "c"], "a", undefined]);
    expect(r.stages[2]).toEqual(twins[2]);
  });

  it("a stage that never had a name takes one without touching anything else", () => {
    const stages: AgentStage[] = [{ name: "", input: [] }, { name: "b", input: [{ kind: "stage_output", stage: "", role: "assistant" }] }];
    const r = renameStage(stages, "", 0, "a", undefined);
    expect([r.stages[0].name, r.stages[1], r.output, r.pending]).toEqual(["a", stages[1], "", undefined]);
  });
});

describe("WA9: renaming a stage in the editor", () => {
  it("updates the blocks, conditions and outputs that name it", async () => {
    const api = await edit(agent(STAGES, { output: "draft" }));
    type(stageName(0), "first");
    const def = await savedDef(api);
    expect(def.output).toBe("first");
    expect(def.stages[1]).toEqual({
      ...CHECK,
      input: [{ kind: "stage_output", stage: "first", role: "assistant" }, CHECK.input[1]],
      transitions: [{ when: { type: "output_contains", value: "bad", stage: "first" }, goto: "end", output: "first" }, CHECK.transitions![1]],
    });
  });

  it("updates a transition's target and the returned stage", async () => {
    const api = await edit(agent(STAGES, { output: "final" }));
    type(stageName(2), "last one");
    const def = await savedDef(api);
    expect([def.stages[2].name, def.output, def.stages[1].transitions![1].goto]).toEqual(["last_one", "last_one", "last_one"]);
  });

  it("follows the name keystroke by keystroke, through an empty box and through another stage's name", async () => {
    const api = await edit(agent(STAGES, { output: "draft" }));
    for (const text of ["draf", "", "c", "ch", "check", "check2"]) type(stageName(0), text);
    const def = await savedDef(api);
    expect(def.stages.map((s) => s.name)).toEqual(["check2", "check", "final"]);
    expect(def.output).toBe("check2");
    expect(def.stages[1].input[0]).toEqual({ kind: "stage_output", stage: "check2", role: "assistant" });
    expect(def.stages[2].input[0]).toEqual(FINAL.input[0]);
  });

  it("the pending name travels with its stage when the list is reordered", async () => {
    const api = await edit(agent(STAGES, { output: "draft" }));
    type(stageName(0), "");
    // Remove the last stage: positions shift, the emptied stage is still the first.
    fireEvent.click(stage(2).querySelector("button i.bi-trash3")!.closest("button")!);
    type(stageName(0), "again");
    const def = await savedDef(api);
    expect(def.output).toBe("again");
    expect(def.stages[1].input[0]).toEqual({ kind: "stage_output", stage: "again", role: "assistant" });
  });
});

describe("WA9: stage names are not React keys", () => {
  const keyWarnings = (calls: readonly unknown[][]): string[] =>
    calls.map((c) => String(c[0])).filter((m) => m.includes("same key") || m.includes('unique "key"'));

  it.each<[string, AgentStage[]]>([
    ["two stages share a name", [{ ...DRAFT, name: "a" }, { ...DRAFT, name: "a" }, { ...FINAL, name: "c", input: [{ kind: "stage_output", stage: "a", role: "assistant" }], transitions: [{ when: { type: "output_contains", value: "x" }, goto: "end" }] }]],
    ["two stages have no name yet", [{ ...DRAFT, name: "" }, { ...DRAFT, name: "" }, { ...FINAL, name: "c" }]],
  ])("no duplicate-key warning when %s", async (_name, stages) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await edit(agent(stages));
    // Typing a clashing name into the third stage as well.
    type(stageName(2), stages[0].name || "c");
    fireEvent.click(button("Add transition", stage(0)));
    expect(keyWarnings(spy.mock.calls)).toEqual([]);
  });
});
