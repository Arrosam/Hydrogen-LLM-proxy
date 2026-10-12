/**
 * Regression tests for defects fixed in the ServiceEditor (Model Service and
 * Micro Agent sides). One describe per defect; the characterization files
 * components-service-editor / components-stage-editor pin everything else.
 */
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { ServiceEditor } from "../src/components/ServiceEditor";
import type { AgentDef, HostedTool, HostedToolOptions, Mapping, Model, ModelService, Provider, ServiceDef, User } from "../src/types";
import { ADMIN, button, deferred, fail, field, hasButton, labelEl, mockApi, renderPage, toasts, toastShown, type, type MockApi, type Routes } from "./helpers";

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

const model = (id: number, name: string): Model => ({ id, name, description: null, enabled: true, createdAt: id });
const provider = (id: number, name: string): Provider => ({ id, name, type: "openai_completion", baseUrl: "https://x", hasKey: true, extraHeaders: null, maxOutputTokens: null, enabled: true, createdAt: id });
const mapping = (id: number, modelId: number, providerId: number): Mapping => ({ id, modelId, providerId, upstreamModel: "up", priority: 0, enabled: true });
const MODELS = [model(1, "sonnet"), model(2, "haiku")];
const PROVIDERS = [provider(1, "openai"), provider(2, "anthropic")];
const MAPPINGS = [mapping(1, 1, 1), mapping(2, 2, 2)];
const TOOLS: HostedTool[] = [{
  id: 1, name: "search", description: "", parameters: {}, url: "https://t", bodyTemplate: null, resultPath: "", timeoutMs: 1000, maxResultBytes: 1000, enabled: true, headerNames: [], hasHeaders: false,
}];
const TOOL_DEFAULTS: HostedToolOptions = { streamMode: "progress", maxRounds: 8, maxCalls: 16 };
const MIB = 1024 * 1024;

const service = (id: number, name: string, steps: ServiceDef, extra: Partial<ModelService> = {}): ModelService => ({
  id, name, description: null, steps, enabled: true, summary: "", createdAt: id, ...extra,
});
const STEP = { model: "sonnet", provider: "openai" };
const STT = service(23, "whisper", { timeoutMs: 60000, steps: [STEP], category: "stt" });
const CHAT = service(20, "chat-a", { timeoutMs: 60000, steps: [STEP] });
const SERVICES = [CHAT, STT];
const AGENT_WITH_ASR: AgentDef = { kind: "micro_agent", timeoutMs: 60000, stages: [], asr: { service: "whisper", timeoutMs: 20000 }, hostedTools: TOOL_DEFAULTS };

const ROUTES: Routes = { "GET /tools": { tools: TOOLS }, "POST /services": {}, "PATCH /services/5": {}, "PATCH /services/6": {} };
const setup = async (props: Partial<Props> = {}, routes: Routes = {}, me: User = ADMIN) => {
  const api = mockApi({ ...ROUTES, ...routes }, me);
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const view = await renderPage(
    <ServiceEditor open service={null} services={SERVICES} models={MODELS} providers={PROVIDERS} mappings={MAPPINGS} onClose={onClose} onSaved={onSaved} {...props} />,
  );
  // The binding itself is only drawn for a chat-pipeline service; the tools are fetched either way.
  await waitFor(() => expect(api.sent("GET", "/tools").length).toBeGreaterThan(0));
  await act(async () => {});
  return { api, onClose, onSaved, ...view };
};
const edit = (def: ServiceDef, extra: Partial<ModelService> = {}, routes: Routes = {}) => setup({ service: service(5, "svc", def, extra) }, routes);

const saves = (api: MockApi) => api.mutations().filter((c) => c.path === "/services" || /^\/services\/\d+$/.test(c.path));
const save = async (api: MockApi) => {
  const before = saves(api).length;
  fireEvent.click(button("Save"));
  await waitFor(() => expect(saves(api)).toHaveLength(before + 1));
  return saves(api)[before];
};
const savedBody = async (api: MockApi) => (await save(api)).body as Body;
const savedSteps = async (api: MockApi) => (await savedBody(api)).steps;

const NAME = "Name (exposed model name)";
const cards = () => [...document.querySelectorAll<HTMLElement>(".rounded-xl.bg-ink-850\\/70")];
const rawArea = () => document.querySelector<HTMLTextAreaElement>("textarea.min-h-\\[320px\\]")!;

/** Keeps one editor mounted, as the page does, and walks it through `sequence`. */
function Host({ sequence, kind }: { sequence: Array<ModelService | null>; kind: Props["defaultKind"] }) {
  const [i, setI] = useState(0);
  return (
    <>
      <button onClick={() => setI(i + 1)}>next-target</button>
      <ServiceEditor open service={sequence[i]} services={SERVICES} models={MODELS} providers={PROVIDERS} mappings={MAPPINGS} defaultKind={kind} onClose={() => {}} onSaved={() => {}} />
    </>
  );
}
const host = async (sequence: Array<ModelService | null>, kind: Props["defaultKind"] = "chain") => {
  const api = mockApi(ROUTES, ADMIN);
  await renderPage(<Host sequence={sequence} kind={kind} />);
  await screen.findByText("Hosted server tools");
  return api;
};

describe("WA1: the ASR pre-pass does not leak into the next service", () => {
  const BEFORE = service(5, "agent", AGENT_WITH_ASR);

  it("a new agent opened after an agent with ASR is saved without an ASR pre-pass", async () => {
    const api = await host([BEFORE, null]);
    fireEvent.click(button("next-target"));
    type(field(NAME), "fresh");
    expect(await savedSteps(api)).toEqual({ kind: "micro_agent", timeoutMs: 60000, stages: [], hostedTools: TOOL_DEFAULTS });
  });

  it("an agent without ASR opened after one with it shows the pre-pass switched off", async () => {
    const api = await host([BEFORE, service(6, "plain", { kind: "micro_agent", timeoutMs: 60000, stages: [], hostedTools: TOOL_DEFAULTS })]);
    fireEvent.click(button("next-target"));
    expect("asr" in (await savedSteps(api))).toBe(false);
  });
});

describe("WA2: retry attempts / interval on a step without a stored policy", () => {
  const BARE: ServiceDef = { timeoutMs: 60000, steps: [STEP] };
  const DEFAULT_ON = [429, 499, 502, 503, "timeout", "network"];
  const savedStep = async (api: MockApi) => ((await savedSteps(api)).steps as Record<string, unknown>[])[0];
  const activeRetryChips = () =>
    [...labelEl("Retry on", cards()[0]).parentElement!.querySelector(".flex-wrap")!.querySelectorAll("button")]
      .filter((b) => b.classList.contains("bg-brand-600")).map((b) => b.textContent);

  it.each([
    ["Retry attempts", "5", { maxAttempts: 5, intervalMs: 0 }],
    ["Retry interval (ms)", "250", { maxAttempts: 3, intervalMs: 250 }],
  ])("changing only %s saves the trigger set the chips show", async (label, value, rest) => {
    const { api } = await edit(BARE);
    type(field(label, cards()[0]), value);
    expect(activeRetryChips()).toEqual(DEFAULT_ON.map(String));
    expect(await savedStep(api)).toEqual({ ...STEP, retry: { on: DEFAULT_ON, ...rest } });
  });

  it("deselecting every trigger keeps an explicit empty set, shown as nothing selected", async () => {
    const { api } = await edit({ timeoutMs: 60000, steps: [{ ...STEP, retry: { on: [429], maxAttempts: 3, intervalMs: 0 } }] });
    fireEvent.click(button("429", labelEl("Retry on", cards()[0]).parentElement!));
    expect(activeRetryChips()).toEqual([]);
    expect(await savedStep(api)).toEqual({ ...STEP, retry: { on: [], maxAttempts: 3, intervalMs: 0 } });
  });
});

describe("WA3: Validate reports a failed call and is busy while it runs", () => {
  /** The test runner's process, where a promise nobody handled is reported. */
  type Listener = (reason: unknown) => void;
  const nodeProcess = (globalThis as unknown as { process: { on: (e: string, l: Listener) => void; off: (e: string, l: Listener) => void } }).process;

  it.each<[string, unknown, string]>([
    ["the server's message when the call is refused", fail(400, { error: "bad definition" }), "bad definition"],
    ["'Validation failed' for a non-API failure", () => { throw new TypeError("offline"); }, "Validation failed"],
  ])("toasts %s", async (_name, handler, text) => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    nodeProcess.on("unhandledRejection", onRejection);
    try {
      await setup({}, { "POST /services/validate": handler });
      fireEvent.click(button("Validate"));
      await toastShown(text);
      await waitFor(() => expect(button("Validate").disabled).toBe(false));
      await new Promise((r) => setTimeout(r, 0));
      expect(rejections).toEqual([]);
    } finally {
      nodeProcess.off("unhandledRejection", onRejection);
    }
  });

  it("a failed call after a good one toasts and leaves the editor usable", async () => {
    const { api } = await setup({}, { "POST /services/validate": { valid: true, summary: "fine" } });
    fireEvent.click(button("Validate"));
    await screen.findByText("fine");
    api.on("POST /services/validate", fail(500, { error: "boom" }));
    fireEvent.click(button("Validate"));
    await toastShown("boom");
    await waitFor(() => expect(button("Validate").disabled).toBe(false));
  });

  it("disables Validate, Dry-run and Save while the validation is in flight, and sends it once", async () => {
    const gate = deferred<unknown>();
    const { api } = await setup({}, { "POST /services/validate": () => gate.promise });
    fireEvent.click(button("Validate"));
    await waitFor(() => expect(button("Validate").disabled).toBe(true));
    fireEvent.click(button("Validate"));
    expect(["Raw JSON", "Dry-run", "Cancel", "Save"].map((b) => button(b).disabled)).toEqual([false, true, false, true]);
    await act(async () => { gate.resolve({ valid: true, summary: "fine" }); });
    await toastShown("Workflow is valid");
    expect(api.sent("POST", "/services/validate")).toHaveLength(1);
    expect(["Validate", "Dry-run", "Save"].map((b) => button(b).disabled)).toEqual([false, false, false]);
  });

  it("Validate is disabled while a save or a dry-run is in flight", async () => {
    const gate = deferred<unknown>();
    await setup({}, { "POST /services/test": () => gate.promise });
    fireEvent.click(button("Dry-run"));
    await waitFor(() => expect(button("Validate").disabled).toBe(true));
    await act(async () => { gate.resolve({ ok: true }); });
    await waitFor(() => expect(button("Validate").disabled).toBe(false));
  });
});

describe("WA4: the attachment budget is rewritten only when its field is edited", () => {
  const ATTACHMENT = "Attachment inlining budget (MiB)";
  const withBudget = (maxAttachmentBytes: number): ServiceDef => ({ timeoutMs: 60000, steps: [STEP], maxAttachmentBytes, hostedTools: TOOL_DEFAULTS });

  it.each([[1_500_000], [300 * 1024], [MIB + 1]])("a no-op save keeps a stored budget of %d bytes", async (bytes) => {
    const { api } = await edit(withBudget(bytes));
    expect((await savedSteps(api)).maxAttachmentBytes).toBe(bytes);
  });

  it("editing something else keeps it too, and so does a trip through the raw view", async () => {
    const { api } = await edit(withBudget(1_500_000));
    type(field("Per-attempt timeout (ms)"), "5000");
    fireEvent.click(button("Raw JSON"));
    expect(JSON.parse(rawArea().value).maxAttachmentBytes).toBe(1_500_000);
    fireEvent.click(button("Visual editor"));
    expect(await savedSteps(api)).toEqual({ ...withBudget(1_500_000), timeoutMs: 5000 });
  });

  it.each([["3", 3 * MIB], ["2", 2 * MIB]])("typing %s into the field saves that many MiB", async (typed, bytes) => {
    const { api } = await edit(withBudget(1_500_000));
    expect(field(ATTACHMENT).value).toBe("1");
    type(field(ATTACHMENT), typed);
    expect((await savedSteps(api)).maxAttachmentBytes).toBe(bytes);
  });

  it("clearing the field removes the budget", async () => {
    const { api } = await edit(withBudget(300 * 1024));
    type(field(ATTACHMENT), "");
    expect("maxAttachmentBytes" in (await savedSteps(api))).toBe(false);
  });
});

describe("WA5: a raw-view save binds tools according to the JSON being sent", () => {
  const CHAT_DEF: ServiceDef = { timeoutMs: 60000, steps: [STEP], hostedTools: TOOL_DEFAULTS };
  const IMAGE_DEF: ServiceDef = { timeoutMs: 60000, steps: [STEP], category: "image" };
  const typeRaw = (def: unknown) => {
    fireEvent.click(button("Raw JSON"));
    type(rawArea(), JSON.stringify(def));
  };

  it("a chat service retyped as a media service is saved unbound", async () => {
    const { api } = await edit(CHAT_DEF, { toolIds: [1] });
    typeRaw(IMAGE_DEF);
    expect(await savedBody(api)).toEqual({ name: "svc", description: null, steps: IMAGE_DEF, enabled: true, toolIds: [] });
  });

  it("a media service retyped as a chat service keeps its bound tools", async () => {
    const { api } = await edit(IMAGE_DEF, { toolIds: [1] });
    typeRaw(CHAT_DEF);
    expect((await savedBody(api)).toolIds).toEqual([1]);
  });

  it("a media service retyped as an agent keeps its bound tools and is announced as a Micro Agent", async () => {
    const { api } = await edit(IMAGE_DEF, { toolIds: [1] });
    typeRaw(AGENT_WITH_ASR);
    expect((await savedBody(api)).toolIds).toEqual([1]);
    await toastShown("Micro Agent updated");
  });

  it("the visual view still decides from the form", async () => {
    const { api } = await edit(CHAT_DEF, { toolIds: [1] });
    type(field("Service type"), "image");
    expect((await savedBody(api)).toolIds).toEqual([]);
  });
});

describe("WA6: 'exhausted' is an advance trigger only", () => {
  const TWO: ServiceDef = { timeoutMs: 60000, steps: [STEP, { model: "haiku", provider: "anthropic" }] };
  const box = (label: string) => labelEl(label, cards()[0]).parentElement!;
  const typeInto = (label: string, text: string) => {
    const input = box(label).querySelector<HTMLInputElement>("input")!;
    type(input, text);
    fireEvent.click(button("Add", box(label)));
    return input;
  };
  const savedStep = async (api: MockApi) => ((await savedSteps(api)).steps as Record<string, unknown>[])[0];

  it("the retry-on box rejects it and keeps the text", async () => {
    const { api } = await edit(TWO);
    expect(typeInto("Retry on", "exhausted").value).toBe("exhausted");
    expect(await savedStep(api)).toEqual(STEP);
  });

  it.each([["timeout"], ["network"], ["error"]])("the retry-on box still accepts %s", async (name) => {
    const { api } = await edit({ timeoutMs: 60000, steps: [{ ...STEP, retry: { on: [], maxAttempts: 3, intervalMs: 0 } }, STEP] });
    expect(typeInto("Retry on", name).value).toBe("");
    expect((await savedStep(api)).retry).toEqual({ on: [name], maxAttempts: 3, intervalMs: 0 });
  });

  it("the advance-on box accepts it", async () => {
    const { api } = await edit(TWO);
    expect(typeInto("Advance to next step on", "exhausted").value).toBe("");
    expect(await savedStep(api)).toEqual({ ...STEP, advanceOn: ["exhausted"] });
  });
});

describe("WA7: leaving the raw view needs a JSON object", () => {
  const DEF: ServiceDef = { timeoutMs: 45000, steps: [STEP], hostedTools: TOOL_DEFAULTS };

  it.each([
    ["text that is not JSON", "{ not json"],
    ["a number", "5"],
    ["a string", '"x"'],
    ["a boolean", "true"],
    ["null", "null"],
    ["an array", "[]"],
    ["nothing at all", ""],
  ])("with %s it toasts, stays in the raw view and keeps the typed text", async (_name, text) => {
    const { api } = await edit(DEF);
    fireEvent.click(button("Raw JSON"));
    type(rawArea(), text);
    fireEvent.click(button("Visual editor"));
    await toastShown("Steps JSON is invalid");
    expect(hasButton("Visual editor")).toBe(true);
    expect(rawArea().value).toBe(text);
    // The form behind it was not reset: fixing the text by hand restores the definition.
    type(rawArea(), JSON.stringify(DEF));
    fireEvent.click(button("Visual editor"));
    expect(hasButton("Raw JSON")).toBe(true);
    expect(await savedSteps(api)).toEqual(DEF);
  });

  it("with an object it returns to the form without a toast", async () => {
    const { api } = await edit(DEF);
    fireEvent.click(button("Raw JSON"));
    type(rawArea(), JSON.stringify({ ...DEF, timeoutMs: 7 }));
    fireEvent.click(button("Visual editor"));
    expect(hasButton("Raw JSON")).toBe(true);
    expect(toasts()).toEqual([]);
    expect((await savedSteps(api)).timeoutMs).toBe(7);
  });
});

describe("WA8: a visual save keeps a stored agent's reliableStreaming", () => {
  const RELIABLE: ServiceDef = { kind: "micro_agent", timeoutMs: 60000, stages: [], reliableStreaming: true, hostedTools: TOOL_DEFAULTS };

  it("an untouched save sends the flag back", async () => {
    const { api } = await setup({ service: service(5, "agent", RELIABLE), defaultKind: "chain" });
    expect(await savedSteps(api)).toEqual(RELIABLE);
  });

  it("so does a save after another edit, and the raw view shows it", async () => {
    const { api } = await setup({ service: service(5, "agent", RELIABLE), defaultKind: "chain" });
    type(field("Per-attempt timeout (ms)"), "5000");
    fireEvent.click(button("Raw JSON"));
    expect(JSON.parse(rawArea().value)).toEqual({ ...RELIABLE, timeoutMs: 5000 });
    fireEvent.click(button("Visual editor"));
    expect(await savedSteps(api)).toEqual({ ...RELIABLE, timeoutMs: 5000 });
  });
});
