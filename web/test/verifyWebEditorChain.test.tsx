/**
 * Independent verification (spec WEB-A, items WA2-WA7): the ServiceEditor as a
 * Model Service editor, driven only through its rendered controls. Expected
 * values come from the verification spec, never from the implementation.
 */
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { ServiceEditor } from "../src/components/ServiceEditor";
import type { HostedTool, Mapping, Model, ModelService, Provider, ServiceDef, User } from "../src/types";
import {
  ADMIN, button, deferred, fail, field, hasButton, labelEl, mockApi, renderPage, toastShown, toasts, type, type Handler, type MockApi, type Routes,
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
interface Retry { on: Array<number | string>; maxAttempts: number; intervalMs: number }
interface Step { model: string; provider: string; retry?: Retry; advanceOn?: Array<number | string> }
interface Body { name: string; description: string | null; steps: Record<string, unknown>; enabled: boolean; toolIds?: number[] }

const MIB = 1024 * 1024;
const KIB = 1024;
const model = (id: number, name: string): Model => ({ id, name, description: null, enabled: true, createdAt: id });
const provider = (id: number, name: string): Provider => ({ id, name, type: "openai_completion", baseUrl: "https://x", hasKey: true, extraHeaders: null, maxOutputTokens: null, enabled: true, createdAt: id });
const mapping = (id: number, modelId: number, providerId: number): Mapping => ({ id, modelId, providerId, upstreamModel: "up", priority: 0, enabled: true });
const MODELS = [model(1, "sonnet"), model(2, "haiku")];
const PROVIDERS = [provider(1, "openai"), provider(2, "anthropic")];
const MAPPINGS = [mapping(1, 1, 1), mapping(2, 2, 2)];
const TOOLS: HostedTool[] = [{
  id: 1, name: "search", description: "", parameters: {}, url: "https://t", bodyTemplate: null, resultPath: "", timeoutMs: 1000, maxResultBytes: 1000, enabled: true, headerNames: [], hasHeaders: false,
}];
const HOSTED = { streamMode: "progress", maxRounds: 8, maxCalls: 16 };
const STEP_A = { model: "sonnet", provider: "openai" };
const STEP_B = { model: "haiku", provider: "anthropic" };
/** Two steps, neither with a stored retry policy. */
const TWO = { timeoutMs: 60000, steps: [STEP_A, STEP_B], hostedTools: HOSTED } as unknown as ServiceDef;
const chain = (first: Record<string, unknown>, extra: Record<string, unknown> = {}): ServiceDef =>
  ({ timeoutMs: 60000, steps: [{ ...STEP_A, ...first }, STEP_B], hostedTools: HOSTED, ...extra }) as unknown as ServiceDef;

const service = (steps: ServiceDef, extra: Partial<ModelService> = {}): ModelService => ({
  id: 5, name: "svc", description: null, steps, enabled: true, summary: "", createdAt: 5, ...extra,
});

const setup = async (props: Partial<Props> = {}, routes: Routes = {}, me: User = ADMIN) => {
  const api = mockApi({ "GET /tools": { tools: TOOLS }, "POST /services": {}, "PATCH /services/5": {}, ...routes }, me);
  const view = await renderPage(
    <ServiceEditor open service={null} services={[]} models={MODELS} providers={PROVIDERS} mappings={MAPPINGS} onClose={() => {}} onSaved={() => {}} {...props} />,
  );
  await screen.findByText("Hosted server tools");
  return { api, ...view };
};
const edit = (def: ServiceDef, extra: Partial<ModelService> = {}, routes: Routes = {}) => setup({ service: service(def, extra) }, routes);

const saves = (api: MockApi) => api.mutations().filter((c) => c.path === "/services" || c.path === "/services/5");
const save = async (api: MockApi): Promise<Body> => {
  const before = saves(api).length;
  fireEvent.click(button("Save"));
  await waitFor(() => expect(saves(api)).toHaveLength(before + 1));
  return saves(api)[before].body as Body;
};
const savedStep = async (api: MockApi, i: number): Promise<Step> => ((await save(api)).steps.steps as Step[])[i];

const ATTACHMENT = "Attachment inlining budget (MiB)";
const cards = () => [...document.querySelectorAll<HTMLElement>(".rounded-xl.bg-ink-850\\/70")];
const card = (i: number) => cards()[i];
const retryOn = (i = 0) => labelEl("Retry on", card(i)).parentElement!;
const advanceOn = (i = 0) => labelEl("Advance to next step on", card(i)).parentElement!;
const presetChips = (box: Element) => [...[...box.querySelectorAll(".flex-wrap")][0].querySelectorAll<HTMLButtonElement>("button")];
const selectedChips = (box: Element) => presetChips(box).filter((b) => b.classList.contains("bg-brand-600"));
const customChips = (box: Element) => [...box.querySelectorAll<HTMLButtonElement>("button.inline-flex")].map((b) => b.textContent);
const codeInput = (box: Element) => box.querySelector<HTMLInputElement>("input")!;
/** The triggers a chip row shows as selected, as the values a policy would carry. */
const shownTriggers = (box: Element): Array<number | string> => selectedChips(box).map((b) => {
  const text = b.textContent ?? "";
  return /^\d+$/.test(text) ? Number(text) : text;
});
const asSet = (triggers: Array<number | string>) => triggers.map(String).sort();
const addCode = (box: () => Element, text: string) => {
  type(codeInput(box()), text);
  fireEvent.click(button("Add", box()));
};
const rawArea = () => field<HTMLTextAreaElement>("Steps JSON");
const toRaw = () => fireEvent.click(button("Raw JSON"));
const toForm = () => fireEvent.click(button("Visual editor"));
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(50); });

// ---------------------------------------------------------------------------

describe("WA2: retry policy on a step that has none stored", () => {
  it("shows a non-empty default trigger set selected in the chips", async () => {
    await edit(TWO);
    expect(shownTriggers(retryOn()).length).toBeGreaterThan(0);
  });

  it("changing only the retry attempts sends the default triggers shown in the chips, not []", async () => {
    const { api } = await edit(TWO);
    const shown = shownTriggers(retryOn());
    type(field("Retry attempts", card(0)), "5");
    const step = await savedStep(api, 0);
    expect(step.retry).toBeDefined();
    expect(step.retry!.on).not.toEqual([]);
    expect(asSet(step.retry!.on)).toEqual(asSet(shown));
    expect([step.retry!.maxAttempts, step.retry!.intervalMs]).toEqual([5, 0]);
  });

  it("changing only the retry interval sends the default triggers shown in the chips, not []", async () => {
    const { api } = await edit(TWO);
    const shown = shownTriggers(retryOn());
    type(field("Retry interval (ms)", card(0)), "250");
    const step = await savedStep(api, 0);
    expect(step.retry).toBeDefined();
    expect(step.retry!.on).not.toEqual([]);
    expect(asSet(step.retry!.on)).toEqual(asSet(shown));
    expect([step.retry!.maxAttempts, step.retry!.intervalMs]).toEqual([3, 250]);
  });

  it("changing attempts and interval together still sends the default triggers", async () => {
    const { api } = await edit(TWO);
    const shown = shownTriggers(retryOn());
    type(field("Retry attempts", card(0)), "2");
    type(field("Retry interval (ms)", card(0)), "1000");
    const step = await savedStep(api, 0);
    expect(asSet(step.retry?.on ?? [])).toEqual(asSet(shown));
    expect([step.retry?.maxAttempts, step.retry?.intervalMs]).toEqual([2, 1000]);
  });

  it("the chips still show the same selection after the attempts were changed", async () => {
    await edit(TWO);
    const shown = shownTriggers(retryOn());
    type(field("Retry attempts", card(0)), "5");
    expect(asSet(shownTriggers(retryOn()))).toEqual(asSet(shown));
  });

  it("leaves the other step without a policy", async () => {
    const { api } = await edit(TWO);
    type(field("Retry attempts", card(0)), "5");
    expect(await savedStep(api, 1)).toEqual(STEP_B);
  });

  it("deselecting every chip and saving sends on: []", async () => {
    const { api } = await edit(TWO);
    for (let guard = 0; guard < 30 && selectedChips(retryOn()).length > 0; guard++) fireEvent.click(selectedChips(retryOn())[0]);
    expect(selectedChips(retryOn())).toEqual([]);
    const step = await savedStep(api, 0);
    expect(step.retry).toBeDefined();
    expect(step.retry!.on).toEqual([]);
  });

  it("deselecting every chip after changing the attempts sends on: [] with those attempts", async () => {
    const { api } = await edit(TWO);
    type(field("Retry attempts", card(0)), "4");
    for (let guard = 0; guard < 30 && selectedChips(retryOn()).length > 0; guard++) fireEvent.click(selectedChips(retryOn())[0]);
    const step = await savedStep(api, 0);
    expect(step.retry?.on).toEqual([]);
    expect(step.retry?.maxAttempts).toBe(4);
  });

  it("a stored policy with on: [] is kept as on: [] (it is not the default)", async () => {
    const { api } = await edit(chain({ retry: { on: [], maxAttempts: 3, intervalMs: 0 } }));
    expect(selectedChips(retryOn())).toEqual([]);
    expect((await savedStep(api, 0)).retry).toEqual({ on: [], maxAttempts: 3, intervalMs: 0 });
  });

  it("an untouched step without a policy is saved without one", async () => {
    const { api } = await edit(TWO);
    expect(await savedStep(api, 0)).toEqual(STEP_A);
  });

  it.each([
    ["attempts changed and set back to 3", "Retry attempts", "5", "3"],
    ["interval changed and set back to 0", "Retry interval (ms)", "100", "0"],
  ])("a policy equal to the server default is omitted: %s", async (_name, label, away, back) => {
    const { api } = await edit(TWO);
    type(field(label, card(0)), away);
    type(field(label, card(0)), back);
    expect(await savedStep(api, 0)).toEqual(STEP_A);
  });

  // Owner's decision: an untouched definition round-trips exactly, so a policy
  // stored explicitly is kept even when it happens to equal the server default.
  it("a stored policy equal to the server default (3 attempts, 0 interval, default triggers) is kept as stored on an untouched save", async () => {
    await edit(TWO);
    const defaults = shownTriggers(retryOn());
    expect(defaults.length).toBeGreaterThan(0);
    cleanup();
    const stored = { on: defaults, maxAttempts: 3, intervalMs: 0 };
    const { api } = await edit(chain({ retry: stored }));
    expect((await savedStep(api, 0)).retry).toEqual(stored);
  });

  it("a stored non-default policy keeps its own triggers when only the attempts change", async () => {
    const { api } = await edit(chain({ retry: { on: [429], maxAttempts: 4, intervalMs: 100 } }));
    expect((await savedStep(api, 0)).retry).toEqual({ on: [429], maxAttempts: 4, intervalMs: 100 });
    type(field("Retry attempts", card(0)), "6");
    expect((await savedStep(api, 0)).retry).toEqual({ on: [429], maxAttempts: 6, intervalMs: 100 });
  });
});

// ---------------------------------------------------------------------------

describe("WA3: validate failures and busy buttons", () => {
  it.each<[string, Handler, string]>([
    ["the server's message (500)", fail(500, { error: "validator down" }), "validator down"],
    ["the server's message (400)", fail(400, { error: "bad shape" }), "bad shape"],
    ["'Validation failed' for a network failure", () => { throw new TypeError("offline"); }, "Validation failed"],
  ])("a failed validate request toasts %s", async (_name, handler, text) => {
    const { api } = await edit(TWO, {}, { "POST /services/validate": handler });
    fireEvent.click(button("Validate"));
    await toastShown(text);
    expect(api.sent("POST", "/services/validate")).toHaveLength(1);
    expect(toasts()).not.toContain("Workflow is valid");
    await waitFor(() => expect(["Validate", "Dry-run", "Save"].map((b) => button(b).disabled)).toEqual([false, false, false]));
  });

  it("a successful validate still toasts that the workflow is valid", async () => {
    await edit(TWO, {}, { "POST /services/validate": { valid: true, summary: "fine" } });
    fireEvent.click(button("Validate"));
    await toastShown("Workflow is valid");
    expect(toasts()).not.toContain("Validation failed");
  });

  it("a validate answer of valid:false still toasts the server's reason", async () => {
    await edit(TWO, {}, { "POST /services/validate": { valid: false, error: "step 2: unknown model" } });
    fireEvent.click(button("Validate"));
    await toastShown("step 2: unknown model");
  });

  it.each<[string, string, unknown]>([
    ["Validate", "POST /services/validate", { valid: true }],
    ["Dry-run", "POST /services/test", { ok: true }],
    ["Save", "PATCH /services/5", {}],
  ])("while a %s request is in flight Validate, Dry-run and Save are all disabled", async (action, route, answer) => {
    const gate = deferred<unknown>();
    const { api } = await edit(TWO, {}, { [route]: () => gate.promise });
    expect(["Validate", "Dry-run", "Save"].map((b) => button(b).disabled)).toEqual([false, false, false]);
    fireEvent.click(button(action));
    await waitFor(() => expect(api.mutations()).toHaveLength(1));
    await waitFor(() => expect(["Validate", "Dry-run", "Save"].map((b) => button(b).disabled)).toEqual([true, true, true]));
    await act(async () => { gate.resolve(answer); });
    await waitFor(() => expect(["Validate", "Dry-run", "Save"].map((b) => button(b).disabled)).toEqual([false, false, false]));
  });

  it("pressing the other two buttons while a validate is in flight sends nothing more", async () => {
    const gate = deferred<unknown>();
    const { api } = await edit(TWO, {}, { "POST /services/validate": () => gate.promise, "POST /services/test": { ok: true } });
    fireEvent.click(button("Validate"));
    await waitFor(() => expect(api.mutations()).toHaveLength(1));
    await waitFor(() => expect(button("Save").disabled).toBe(true));
    fireEvent.click(button("Save"));
    fireEvent.click(button("Dry-run"));
    fireEvent.click(button("Validate"));
    await settle();
    expect(api.mutations()).toHaveLength(1);
    await act(async () => { gate.resolve({ valid: true }); });
  });

  it("the buttons come back after a validate request that failed while in flight", async () => {
    const gate = deferred<unknown>();
    await edit(TWO, {}, { "POST /services/validate": () => gate.promise });
    fireEvent.click(button("Validate"));
    await waitFor(() => expect(button("Validate").disabled).toBe(true));
    await act(async () => { gate.reject(new TypeError("offline")); });
    await toastShown("Validation failed");
    await waitFor(() => expect(["Validate", "Dry-run", "Save"].map((b) => button(b).disabled)).toEqual([false, false, false]));
  });
});

// ---------------------------------------------------------------------------

describe("WA4: attachment budget that is not a whole number of MiB", () => {
  it.each([
    ["1.5 MiB", 1.5 * MIB],
    ["300 KiB", 300 * KIB],
    ["1 byte", 1],
    ["1 MiB + 1 byte", MIB + 1],
    ["a whole 8 MiB (unchanged neighbour)", 8 * MIB],
  ])("opening and saving without touching the field sends the same bytes: %s", async (_name, bytes) => {
    const { api } = await edit(chain({}, { maxAttachmentBytes: bytes }));
    expect((await save(api)).steps.maxAttachmentBytes).toBe(bytes);
  });

  it.each([
    ["1.5 MiB", 1.5 * MIB],
    ["300 KiB", 300 * KIB],
  ])("editing another field leaves a stored %s budget as it was", async (_name, bytes) => {
    const { api } = await edit(chain({}, { maxAttachmentBytes: bytes }));
    type(field("Per-attempt timeout (ms)"), "1000");
    type(field("Name (exposed model name)"), "renamed");
    const body = await save(api);
    expect(body.steps.maxAttachmentBytes).toBe(bytes);
    expect([body.name, body.steps.timeoutMs]).toEqual(["renamed", 1000]);
  });

  it.each([
    ["1.5 MiB", 1.5 * MIB, "2", 2 * MIB],
    ["1.5 MiB", 1.5 * MIB, "1", MIB],
    ["300 KiB", 300 * KIB, "3", 3 * MIB],
    ["300 KiB", 300 * KIB, "1", MIB],
    ["8 MiB", 8 * MIB, "5", 5 * MIB],
  ])("editing the field of a stored %s budget sends the typed MiB value in bytes", async (_name, bytes, typed, sent) => {
    const { api } = await edit(chain({}, { maxAttachmentBytes: bytes }));
    // A change event carrying the text the box already shows is no edit at all (React drops it), and a
    // user cannot produce one either: when the box already reads the target, clear it first, then type.
    if (field(ATTACHMENT).value === typed) type(field(ATTACHMENT), "");
    type(field(ATTACHMENT), typed);
    expect(field(ATTACHMENT).value).toBe(typed);
    expect((await save(api)).steps.maxAttachmentBytes).toBe(sent);
  });

  it("a second save without touching the field still sends the same bytes", async () => {
    const { api } = await edit(chain({}, { maxAttachmentBytes: 1.5 * MIB }));
    await save(api);
    expect((await save(api)).steps.maxAttachmentBytes).toBe(1.5 * MIB);
  });

  it("a service stored without a budget is saved without one", async () => {
    const { api } = await edit(TWO);
    expect((await save(api)).steps.maxAttachmentBytes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("WA5: saving from the Raw JSON view decides toolIds from the JSON", () => {
  const STEPS = [STEP_A];

  it.each(["image", "video", "tts", "stt", "embedding", "rerank"])(
    "raw JSON for the non-chat category %s sends toolIds: [] although the form had a tool bound", async (category) => {
      const { api } = await edit(TWO, { toolIds: [1] });
      expect(field("search").checked).toBe(true);
      toRaw();
      const typed = { timeoutMs: 1000, steps: STEPS, category };
      type(rawArea(), JSON.stringify(typed));
      const body = await save(api);
      expect(body.toolIds).toEqual([]);
      expect(body.steps).toEqual(typed);
    });

  it("raw JSON for a chat chain keeps the bound tool", async () => {
    const { api } = await edit(TWO, { toolIds: [1] });
    toRaw();
    type(rawArea(), JSON.stringify({ timeoutMs: 1000, steps: STEPS }));
    expect((await save(api)).toolIds).toEqual([1]);
  });

  it("raw JSON with an explicit chat category keeps the bound tool", async () => {
    const { api } = await edit(TWO, { toolIds: [1] });
    toRaw();
    type(rawArea(), JSON.stringify({ timeoutMs: 1000, steps: STEPS, category: "chat" }));
    expect((await save(api)).toolIds).toEqual([1]);
  });

  it("an untouched raw view of a chat service keeps the bound tool", async () => {
    const { api } = await edit(TWO, { toolIds: [1] });
    toRaw();
    expect((await save(api)).toolIds).toEqual([1]);
  });

  it("raw JSON for a Micro Agent typed over a chat chain keeps the bound tool", async () => {
    const { api } = await edit(TWO, { toolIds: [1] });
    toRaw();
    type(rawArea(), JSON.stringify({ kind: "micro_agent", timeoutMs: 1000, stages: [] }));
    expect((await save(api)).toolIds).toEqual([1]);
  });

  it("a tool ticked in the form and then a media category typed as raw JSON sends toolIds: []", async () => {
    const { api } = await edit(TWO);
    fireEvent.click(field("search"));
    toRaw();
    type(rawArea(), JSON.stringify({ timeoutMs: 1000, steps: STEPS, category: "image" }));
    expect((await save(api)).toolIds).toEqual([]);
  });

  it("the same media definition saved from the form also sends toolIds: [] (unchanged neighbour)", async () => {
    const { api } = await edit(TWO, { toolIds: [1] });
    type(field("Service type"), "image");
    expect((await save(api)).toolIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("WA6: 'exhausted' in the custom trigger boxes", () => {
  it("is rejected in 'Retry on' when added with the button", async () => {
    const { api } = await edit(TWO);
    addCode(retryOn, "exhausted");
    expect(customChips(retryOn())).not.toContain("exhausted");
    expect(presetChips(retryOn()).map((b) => b.textContent)).not.toContain("exhausted");
    const step = await savedStep(api, 0);
    expect(step.retry?.on ?? []).not.toContain("exhausted");
  });

  it("is rejected in 'Retry on' when added with Enter", async () => {
    const { api } = await edit(TWO);
    type(codeInput(retryOn()), "exhausted");
    fireEvent.keyDown(codeInput(retryOn()), { key: "Enter" });
    expect(customChips(retryOn())).not.toContain("exhausted");
    const step = await savedStep(api, 0);
    expect(step.retry?.on ?? []).not.toContain("exhausted");
  });

  it("is rejected in 'Retry on' of a step that already has its own policy", async () => {
    const { api } = await edit(chain({ retry: { on: [429], maxAttempts: 4, intervalMs: 100 } }));
    addCode(retryOn, "exhausted");
    expect(customChips(retryOn())).not.toContain("exhausted");
    expect((await savedStep(api, 0)).retry).toEqual({ on: [429], maxAttempts: 4, intervalMs: 100 });
  });

  it("is accepted in 'Advance to next step on'", async () => {
    const { api } = await edit(TWO);
    addCode(advanceOn, "exhausted");
    expect((await savedStep(api, 0)).advanceOn).toEqual(["exhausted"]);
  });

  it("is accepted in 'Advance to next step on' with Enter", async () => {
    const { api } = await edit(TWO);
    type(codeInput(advanceOn()), "exhausted");
    fireEvent.keyDown(codeInput(advanceOn()), { key: "Enter" });
    expect((await savedStep(api, 0)).advanceOn).toEqual(["exhausted"]);
  });

  it("'Retry on' still accepts an HTTP code and a symbolic trigger typed into the box", async () => {
    const { api } = await edit(chain({ retry: { on: [429], maxAttempts: 4, intervalMs: 100 } }));
    addCode(retryOn, "418");
    addCode(retryOn, "error");
    expect((await savedStep(api, 0)).retry).toEqual({ on: [429, 418, "error"], maxAttempts: 4, intervalMs: 100 });
  });
});

// ---------------------------------------------------------------------------

describe("WA7: switching from Raw JSON back to the visual editor", () => {
  it.each([
    ["invalid JSON", "{ not json"],
    ["a number", "5"],
    ["a string", '"x"'],
    ["null", "null"],
    ["an array", "[]"],
    ["empty text", ""],
  ])("with %s it toasts an error, stays in the raw view and keeps the text", async (_name, text) => {
    const { api } = await edit(TWO);
    toRaw();
    type(rawArea(), text);
    expect(toasts()).toEqual([]);
    toForm();
    await waitFor(() => expect(toasts().length).toBeGreaterThan(0));
    expect(hasButton("Visual editor")).toBe(true);
    expect(hasButton("Raw JSON")).toBe(false);
    expect(rawArea().value).toBe(text);
    expect(cards()).toEqual([]);
    expect(api.mutations()).toEqual([]);
  });

  it("after a refused switch, valid text brings the form back", async () => {
    await edit(TWO);
    toRaw();
    type(rawArea(), "[]");
    toForm();
    await waitFor(() => expect(toasts().length).toBeGreaterThan(0));
    type(rawArea(), JSON.stringify({ timeoutMs: 1000, steps: [STEP_B] }));
    toForm();
    expect(hasButton("Raw JSON")).toBe(true);
    expect(cards()).toHaveLength(1);
  });

  it.each([
    ["an empty object", {}, 0],
    ["a full definition", { timeoutMs: 1000, steps: [STEP_B, STEP_A, STEP_B] }, 3],
  ])("with %s it returns to the form without a toast", async (_name, def, steps) => {
    await edit(TWO);
    toRaw();
    type(rawArea(), JSON.stringify(def));
    toForm();
    expect(hasButton("Raw JSON")).toBe(true);
    expect(hasButton("Visual editor")).toBe(false);
    expect(cards()).toHaveLength(steps);
    await settle();
    expect(toasts()).toEqual([]);
  });

  it("with the untouched text it returns to the form", async () => {
    await edit(TWO);
    toRaw();
    toForm();
    expect(hasButton("Raw JSON")).toBe(true);
    expect(cards()).toHaveLength(2);
  });
});
