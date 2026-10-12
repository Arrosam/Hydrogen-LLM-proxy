/**
 * Characterization of the ServiceEditor as a Model Service (failure chain)
 * editor: the definition it loads into the form, the exact payload it sends on
 * save / validate / dry-run, the raw-JSON view and what switching back resets,
 * the step list, retry and advance triggers, and its markup classes.
 * The Micro Agent side (stages, OCR, ASR) lives in components-stage-editor.
 */
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { ServiceEditor } from "../src/components/ServiceEditor";
import type { HostedTool, Mapping, Model, ModelService, Provider, ServiceDef, ServiceSteps, Trigger, User } from "../src/types";
import {
  ADMIN, MANAGER, button, classes, cls, deferred, fail, field, hasButton, iconButton, isOn, labelEl, mockApi, openModal,
  renderPage, toastShown, toasts, toggle, type, type MockApi, type Routes,
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

const model = (id: number, name: string): Model => ({ id, name, description: null, enabled: true, createdAt: id });
const provider = (id: number, name: string): Provider => ({ id, name, type: "openai_completion", baseUrl: "https://x", hasKey: true, extraHeaders: null, maxOutputTokens: null, enabled: true, createdAt: id });
const mapping = (id: number, modelId: number, providerId: number): Mapping => ({ id, modelId, providerId, upstreamModel: "up", priority: 0, enabled: true });
/** sonnet is served by openai then azure, haiku by anthropic, orphan by nobody. */
const MODELS = [model(1, "sonnet"), model(2, "haiku"), model(3, "orphan")];
const PROVIDERS = [provider(1, "openai"), provider(2, "anthropic"), provider(3, "azure")];
const MAPPINGS = [mapping(1, 1, 1), mapping(2, 1, 3), mapping(3, 2, 2)];
const tool = (id: number, name: string, enabled = true): HostedTool => ({
  id, name, description: "", parameters: {}, url: "https://t", bodyTemplate: null, resultPath: "", timeoutMs: 1000, maxResultBytes: 1000, enabled, headerNames: [], hasHeaders: false,
});
const TOOLS = [tool(1, "search"), tool(2, "calc", false)];
const TOOL_DEFAULTS = { streamMode: "progress", maxRounds: 8, maxCalls: 16 };
const DEFAULT_RETRY_ON = [429, 499, 502, 503, "timeout", "network"];

const service = (id: number, name: string, steps: ServiceDef, extra: Partial<ModelService> = {}): ModelService => ({
  id, name, description: null, steps, enabled: true, summary: "", createdAt: id, ...extra,
});

/** Every field the form knows, none at its default, in the order the editor writes them. */
const FULL: ServiceSteps = {
  timeoutMs: 45000,
  steps: [
    { model: "sonnet", provider: "openai", retry: { on: [429, 418, "timeout"], maxAttempts: 5, intervalMs: 250 }, advanceOn: [503, "exhausted"], overrides: { temperature: 0.2 } },
    { model: "haiku", provider: "anthropic" },
  ],
  category: "ocr",
  reliableStreaming: true,
  maxAttachmentBytes: 8 * MIB,
  thinkingFormat: "think_tags",
  thinkingDelimiters: { open: "<a>", close: "</a>" },
  hostedTools: { streamMode: "all", maxRounds: 4, maxCalls: 9 },
};
const FULL_SVC = service(5, "svc", FULL, { description: "desc", enabled: false, toolIds: [1] });
const FULL_BODY: Body = { name: "svc", description: "desc", steps: FULL as unknown as Record<string, unknown>, enabled: false, toolIds: [1] };
/** What a brand-new Model Service saves when only a name was typed. */
const NEW_STEPS = { timeoutMs: 60000, steps: [{ model: "sonnet", provider: "openai" }], hostedTools: TOOL_DEFAULTS };
const TWO_STEPS: ServiceSteps = { timeoutMs: 60000, steps: [{ model: "sonnet", provider: "openai" }, { model: "haiku", provider: "anthropic" }] };

const setup = async (props: Partial<Props> = {}, routes: Routes = {}, me: User = ADMIN) => {
  const api = mockApi({ "GET /tools": { tools: TOOLS }, "POST /services": {}, "PATCH /services/5": {}, ...routes }, me);
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const view = await renderPage(
    <ServiceEditor open service={null} services={[]} models={MODELS} providers={PROVIDERS} mappings={MAPPINGS} onClose={onClose} onSaved={onSaved} {...props} />,
  );
  if (me.role === "admin") await screen.findByText("Hosted server tools");
  return { api, onClose, onSaved, ...view };
};
const edit = (def: ServiceDef, extra: Partial<ModelService> = {}, routes: Routes = {}, me: User = ADMIN) =>
  setup({ service: service(5, "svc", def, extra) }, routes, me);

/** Click Save and return the request it produced. */
const save = async (api: MockApi) => {
  const before = api.mutations().length;
  fireEvent.click(button("Save"));
  await waitFor(() => expect(api.mutations()).toHaveLength(before + 1));
  return api.mutations()[before];
};
const savedBody = async (api: MockApi) => (await save(api)).body as Body;
const savedSteps = async (api: MockApi) => (await savedBody(api)).steps;
const savedStep = async (api: MockApi, i: number) => ((await savedSteps(api)).steps as Record<string, unknown>[])[i];

const NAME = "Name (exposed model name)";
const TIMEOUT = "Per-attempt timeout (ms)";
const DESCRIPTION = "Description (optional)";
const ATTACHMENT = "Attachment inlining budget (MiB)";
const cards = () => [...document.querySelectorAll<HTMLElement>(".rounded-xl.bg-ink-850\\/70")];
const card = (i: number) => cards()[i];
const stepPairs = () => cards().map((c) => `${field<HTMLSelectElement>("Model", c).value}@${field<HTMLSelectElement>("Provider", c).value}`);
const retryOn = (c: HTMLElement) => labelEl("Retry on", c).parentElement!;
const advanceOn = (c: HTMLElement) => labelEl("Advance to next step on", c).parentElement!;
const CHIP = "rounded-md px-2 py-0.5 text-xs font-medium transition-colors";
const CHIP_ON = `${CHIP} bg-brand-600 text-white`;
const CHIP_OFF = `${CHIP} border border-ink-700 bg-ink-900 text-ink-400 hover:text-ink-200`;
const presetChips = (box: Element) => [...box.querySelectorAll<HTMLButtonElement>(".flex-wrap")][0].querySelectorAll("button");
const activeChips = (box: Element) => [...presetChips(box)].filter((b) => b.classList.contains("bg-brand-600")).map((b) => b.textContent);
const customChips = (box: Element) => [...box.querySelectorAll<HTMLButtonElement>("button.inline-flex")];
const codeInput = (box: Element) => box.querySelector<HTMLInputElement>("input")!;
const rawArea = () => document.querySelector<HTMLTextAreaElement>("textarea.min-h-\\[320px\\]")!;
const options = (select: HTMLSelectElement) => [...select.options].map((o) => [o.value, o.textContent]);

// ---------------------------------------------------------------------------

describe("ServiceEditor: shell", () => {
  it("renders nothing while closed and asks for nothing", async () => {
    const { api, container } = await setup({ open: false }, {}, MANAGER);
    expect(container.querySelector(".card")).toBeNull();
    expect(api.calls.map((c) => c.path).filter((p) => p !== "/me" && p !== "/settings/ui-language")).toEqual([]);
  });

  it.each([
    ["an admin", ADMIN, ["GET /tools"]],
    ["a manager", MANAGER, []],
  ])("on open, %s loads the hosted tools or nothing", async (_name, me, expected) => {
    const { api } = await setup({}, {}, me);
    expect(api.calls.filter((c) => c.path !== "/me" && c.path !== "/settings/ui-language").map((c) => `${c.method} ${c.path}`)).toEqual(expected);
  });

  it("is a wide modal with five footer actions, none disabled at rest", async () => {
    await setup();
    const m = openModal("New Model Service");
    expect(classes(m)).toEqual(cls("card flex max-h-[92vh] w-full flex-col max-w-4xl"));
    expect(classes(m.querySelector("h2 i"))).toEqual(cls("bi bi-diagram-3 text-brand-400"));
    const footer = button("Save", m).parentElement!;
    expect([...footer.children].map((c) => [c.tagName, c.textContent, c.className])).toEqual([
      ["BUTTON", "Raw JSON", "btn-ghost"], ["BUTTON", "Validate", "btn-ghost"], ["BUTTON", "Dry-run", "btn-ghost"],
      ["DIV", "", "flex-1"], ["BUTTON", "Cancel", "btn-ghost"], ["BUTTON", "Save", "btn-primary"],
    ]);
    expect([...footer.querySelectorAll("button")].map((b) => b.querySelector("i")?.className ?? null)).toEqual([
      "bi bi-code-slash", "bi bi-check2-circle", "bi bi-play-circle", null, "bi bi-check-lg",
    ]);
    expect([...footer.querySelectorAll("button")].map((b) => b.disabled)).toEqual([false, false, false, false, false]);
    expect(classes(m.querySelector(".card-pad")!.firstElementChild)).toEqual(["space-y-5"]);
  });

  it("Cancel and the title-bar close button call onClose and send nothing", async () => {
    const { api, onClose, onSaved } = await setup();
    fireEvent.click(button("Cancel"));
    fireEvent.click(iconButton("bi-x-lg", openModal("New Model Service").querySelector("h2")!.parentElement!));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSaved).not.toHaveBeenCalled();
    expect(api.mutations()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("ServiceEditor: a new Model Service", () => {
  it("opens with its defaults in every field", async () => {
    await setup();
    const name = field(NAME);
    expect([name.value, name.placeholder, name.type, classes(name)]).toEqual(["", "e.g. sonnet-any", "text", ["input"]]);
    const timeout = field(TIMEOUT);
    expect([timeout.value, timeout.type, timeout.inputMode, classes(timeout)]).toEqual(["60000", "text", "numeric", ["input"]]);
    expect(classes(name.closest(".grid"))).toEqual(cls("grid grid-cols-2 gap-4"));
    expect([field(DESCRIPTION).value, classes(field(DESCRIPTION))]).toEqual(["", ["input"]]);
    expect([NAME, TIMEOUT, DESCRIPTION].map((l) => [labelEl(l).tagName, classes(labelEl(l))])).toEqual([["LABEL", ["label"]], ["LABEL", ["label"]], ["LABEL", ["label"]]]);

    const category = field<HTMLSelectElement>("Service type");
    expect([category.value, classes(category)]).toEqual(["chat", cls("select w-auto")]);
    expect(options(category)).toEqual([
      ["chat", "Chat (LLM)"], ["ocr", "OCR (image to text)"], ["image", "Image generation"], ["video", "Video generation"],
      ["tts", "Text to speech (TTS)"], ["stt", "Speech to text (ASR)"], ["embedding", "Embeddings"], ["rerank", "Reranker"],
    ]);
    expect(category.parentElement!.querySelector("p")).toBeNull();

    expect([isOn(toggle("Enabled")), isOn(toggle("Reliable streaming"))]).toEqual([true, false]);
    expect(classes(toggle("Enabled").closest("label")!.parentElement)).toEqual(cls("flex flex-wrap items-center gap-x-6 gap-y-2"));
    expect(screen.queryByText(/^Streams the upstream response and buffers it/)).toBeNull();

    expect([field("search").checked, field("calc").checked]).toEqual([false, false]);
    expect([field<HTMLSelectElement>("Streaming delivery").value, field("Maximum model rounds").value, field("Maximum tool calls").value]).toEqual(["progress", "8", "16"]);

    const thinking = field<HTMLSelectElement>("Thinking format");
    expect([thinking.value, classes(thinking)]).toEqual(["original", cls("select w-auto")]);
    expect(options(thinking)).toEqual([
      ["original", "Original (pass through)"], ["reasoning_content", "reasoning_content"], ["reasoning", "reasoning"],
      ["think_tags", "<think> tags in the answer"], ["none", "Hide from the client"],
    ]);
    const hint = screen.getByText(/^Whatever the upstream produced reaches the client untouched/);
    expect(classes(hint)).toEqual(cls("mt-1 text-xs text-ink-500"));
    const open = field("Thinking starts with");
    const close = field("Thinking ends with");
    expect([open.value, open.placeholder, classes(open)]).toEqual(["", "e.g. <|channel|>analysis<|message|>", ["input"]]);
    expect([close.value, close.placeholder, classes(close)]).toEqual(["", "e.g. <|channel|>final<|message|>", ["input"]]);
    expect(classes(open.closest(".grid"))).toEqual(cls("mt-3 grid grid-cols-2 gap-3"));
    expect(classes(screen.getByText(/^Optional\. State the exact text your model wraps/))).toEqual(cls("mt-1 text-xs text-ink-500"));

    const budget = field(ATTACHMENT);
    expect([budget.value, budget.type, budget.inputMode, classes(budget)]).toEqual(["0", "text", "numeric", ["input"]]);
    expect(classes(screen.getByText(/^Optional\. Caps the total bytes of URL attachments/))).toEqual(cls("mt-1 text-xs text-ink-500"));
    expect(classes(screen.getByText("Model Service: try each (model, provider) in turn until one succeeds."))).toEqual(cls("text-xs text-ink-500"));
  });

  it("starts with one step: the first model on its first mapped provider, retry and triggers at the server defaults", async () => {
    await setup();
    expect(stepPairs()).toEqual(["sonnet@openai"]);
    const c = card(0);
    expect([field("Retry attempts", c).value, field("Retry interval (ms)", c).value]).toEqual(["3", "0"]);
    expect([...presetChips(retryOn(c))].map((b) => b.textContent)).toEqual(["429", "499", "500", "502", "503", "529", "timeout", "network", "error"]);
    expect(activeChips(retryOn(c))).toEqual(["429", "499", "502", "503", "timeout", "network"]);
    expect(customChips(retryOn(c))).toEqual([]);
    // The only step is the last one: it has nowhere to advance to.
    expect(c.querySelectorAll(".label")).toHaveLength(5);
    expect(screen.queryByText("on failure")).toBeNull();
  });

  it.each([
    ["no model exists", { models: [] }],
    ["the first model has no mapped provider", { models: [MODELS[2], MODELS[0]] }],
  ])("starts with no step when %s", async (_name, props) => {
    const { api } = await setup(props);
    expect(cards()).toEqual([]);
    const hint = screen.getByText("No steps. Add at least one (model, provider) attempt.");
    expect(classes(hint)).toEqual(cls("rounded-lg border border-dashed border-ink-700 px-4 py-6 text-center text-xs text-ink-500"));
    expect(screen.queryByText(/^if the last step still fails/)).toBeNull();
    type(field(NAME), "x");
    expect(await savedSteps(api)).toEqual({ timeoutMs: 60000, steps: [], hostedTools: TOOL_DEFAULTS });
  });

  it("refuses to save without a name, and a blank one counts as none", async () => {
    const { api, onClose } = await setup();
    fireEvent.click(button("Save"));
    await toastShown("Name is required");
    type(field(NAME), "   ");
    fireEvent.click(button("Save"));
    await waitFor(() => expect(toasts()).toEqual(["Name is required", "Name is required"]));
    expect(api.mutations()).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    expect(button("Save").disabled).toBe(false);
  });

  it("creates with POST /services, then toasts, reloads and closes", async () => {
    const { api, onClose, onSaved } = await setup();
    type(field(NAME), "fresh");
    expect(await save(api)).toEqual(sentJson("POST", "/services", { name: "fresh", description: null, steps: NEW_STEPS, enabled: true, toolIds: [] }));
    await toastShown("Model Service created");
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("sends the name as typed, untrimmed", async () => {
    const { api } = await setup();
    type(field(NAME), " padded ");
    expect((await savedBody(api)).name).toBe(" padded ");
  });

  it("a manager sees no hosted-tool binding and sends no toolIds, but still the tool limits", async () => {
    const { api } = await setup({}, {}, MANAGER);
    expect(screen.queryByText("Hosted server tools")).toBeNull();
    type(field(NAME), "fresh");
    expect(await save(api)).toEqual(sentJson("POST", "/services", { name: "fresh", description: null, steps: NEW_STEPS, enabled: true }));
  });

  it.each([
    ["the server's message", fail(409, { error: "name already used" }), "name already used"],
    ["'Save failed' for a non-API failure", () => { throw new TypeError("offline"); }, "Save failed"],
  ])("toasts %s when the save is refused, stays open and can be retried", async (_name, handler, text) => {
    const { api, onClose, onSaved } = await setup({}, { "POST /services": handler });
    type(field(NAME), "fresh");
    await save(api);
    await toastShown(text);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(button("Save").disabled).toBe(false));
  });

  it("disables Save, Dry-run and Validate, and nothing else, while the save is in flight", async () => {
    const gate = deferred<unknown>();
    const { onClose } = await setup({}, { "POST /services": () => gate.promise });
    type(field(NAME), "fresh");
    fireEvent.click(button("Save"));
    await waitFor(() => expect(button("Save").disabled).toBe(true));
    expect(["Raw JSON", "Validate", "Dry-run", "Cancel"].map((b) => button(b).disabled)).toEqual([false, true, true, false]);
    await act(async () => { gate.resolve({}); });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(button("Save").disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("ServiceEditor: editing a Model Service", () => {
  it("is titled with the service's name and fills every field from the stored definition", async () => {
    await setup({ service: FULL_SVC });
    const m = openModal('Edit "svc"');
    expect(classes(m.querySelector("h2 i"))).toEqual(cls("bi bi-diagram-3 text-brand-400"));
    expect([field(NAME).value, field(TIMEOUT).value, field(DESCRIPTION).value]).toEqual(["svc", "45000", "desc"]);
    expect(field<HTMLSelectElement>("Service type").value).toBe("ocr");
    expect([isOn(toggle("Enabled")), isOn(toggle("Reliable streaming"))]).toEqual([false, true]);
    expect([field("search").checked, field("calc").checked]).toEqual([true, false]);
    expect([field<HTMLSelectElement>("Streaming delivery").value, field("Maximum model rounds").value, field("Maximum tool calls").value]).toEqual(["all", "4", "9"]);
    expect([field<HTMLSelectElement>("Thinking format").value, field("Thinking starts with").value, field("Thinking ends with").value]).toEqual(["think_tags", "<a>", "</a>"]);
    expect(screen.getByText(/^Fold the thinking into the answer text/)).toBeTruthy();
    expect(field(ATTACHMENT).value).toBe("8");
    expect(stepPairs()).toEqual(["sonnet@openai", "haiku@anthropic"]);
    expect([field("Retry attempts", card(0)).value, field("Retry interval (ms)", card(0)).value]).toEqual(["5", "250"]);
    expect(activeChips(retryOn(card(0)))).toEqual(["429", "timeout"]);
    expect(customChips(retryOn(card(0))).map((b) => b.textContent)).toEqual(["418"]);
    expect(activeChips(advanceOn(card(0)))).toEqual(["503", "exhausted"]);
    expect([field("Retry attempts", card(1)).value, field("Retry interval (ms)", card(1)).value]).toEqual(["3", "0"]);
    expect(activeChips(retryOn(card(1)))).toEqual(DEFAULT_RETRY_ON.map(String));
  });

  it("round-trips: saving an untouched definition PATCHes exactly what was stored", async () => {
    const { api, onClose, onSaved } = await setup({ service: FULL_SVC });
    expect(await save(api)).toEqual(sentJson("PATCH", "/services/5", FULL_BODY));
    await toastShown("Model Service updated");
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  const withSteps = (patch: Record<string, unknown>, drop: string[] = []): Body => {
    const steps: Record<string, unknown> = { ...FULL_BODY.steps, ...patch };
    for (const k of drop) delete steps[k];
    return { ...FULL_BODY, steps };
  };
  const withStep = (i: number, patch: Record<string, unknown>): Body =>
    withSteps({ steps: FULL.steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) });
  const RETRY = FULL.steps[0].retry!;

  it.each<[string, () => void, Body]>([
    ["the name", () => type(field(NAME), "renamed"), { ...FULL_BODY, name: "renamed" }],
    ["a cleared description (sent as null)", () => type(field(DESCRIPTION), ""), { ...FULL_BODY, description: null }],
    ["the enabled switch", () => fireEvent.click(toggle("Enabled")), { ...FULL_BODY, enabled: true }],
    ["the timeout", () => type(field(TIMEOUT), "120000"), withSteps({ timeoutMs: 120000 })],
    ["the category back to chat (key dropped)", () => type(field("Service type"), "chat"), withSteps({}, ["category"])],
    ["reliable streaming off (key dropped)", () => fireEvent.click(toggle("Reliable streaming")), withSteps({}, ["reliableStreaming"])],
    ["the thinking format", () => type(field("Thinking format"), "none"), withSteps({ thinkingFormat: "none" })],
    ["the thinking format back to original (key dropped)", () => type(field("Thinking format"), "original"), withSteps({}, ["thinkingFormat"])],
    ["a thinking delimiter", () => type(field("Thinking ends with"), "</b>"), withSteps({ thinkingDelimiters: { open: "<a>", close: "</b>" } })],
    ["half a delimiter pair (both dropped)", () => type(field("Thinking starts with"), ""), withSteps({}, ["thinkingDelimiters"])],
    ["the attachment budget", () => type(field(ATTACHMENT), "3"), withSteps({ maxAttachmentBytes: 3 * MIB })],
    ["the attachment budget at 0 (key dropped)", () => type(field(ATTACHMENT), "0"), withSteps({}, ["maxAttachmentBytes"])],
    ["a second bound tool", () => fireEvent.click(field("calc")), { ...FULL_BODY, toolIds: [1, 2] }],
    ["an unbound tool", () => fireEvent.click(field("search")), { ...FULL_BODY, toolIds: [] }],
    ["the tool streaming mode", () => type(field("Streaming delivery"), "final"), withSteps({ hostedTools: { streamMode: "final", maxRounds: 4, maxCalls: 9 } })],
    ["the tool round limit", () => type(field("Maximum model rounds"), "12"), withSteps({ hostedTools: { streamMode: "all", maxRounds: 12, maxCalls: 9 } })],
    ["the tool call limit", () => type(field("Maximum tool calls"), "40"), withSteps({ hostedTools: { streamMode: "all", maxRounds: 4, maxCalls: 40 } })],
    ["a step's provider", () => type(field("Provider", card(0)), "azure"), withStep(0, { provider: "azure" })],
    ["a step's model (its provider follows)", () => type(field("Model", card(1)), "sonnet"), withStep(1, { model: "sonnet", provider: "openai" })],
    ["a step's retry attempts", () => type(field("Retry attempts", card(0)), "2"), withStep(0, { retry: { ...RETRY, maxAttempts: 2 } })],
    ["a step's retry interval", () => type(field("Retry interval (ms)", card(0)), "1000"), withStep(0, { retry: { ...RETRY, intervalMs: 1000 } })],
    ["a retry trigger added", () => fireEvent.click(button("network", retryOn(card(0)))), withStep(0, { retry: { ...RETRY, on: [429, 418, "timeout", "network"] } })],
    ["a retry trigger removed", () => fireEvent.click(button("429", retryOn(card(0)))), withStep(0, { retry: { ...RETRY, on: [418, "timeout"] } })],
    ["a custom retry code removed by its chip", () => fireEvent.click(customChips(retryOn(card(0)))[0]), withStep(0, { retry: { ...RETRY, on: [429, "timeout"] } })],
    ["an advance trigger added", () => fireEvent.click(button("error", advanceOn(card(0)))), withStep(0, { advanceOn: [503, "exhausted", "error"] })],
    ["an advance trigger removed", () => fireEvent.click(button("exhausted", advanceOn(card(0)))), withStep(0, { advanceOn: [503] })],
  ])("changing only %s changes only that in the payload", async (_name, change, expected) => {
    const { api } = await setup({ service: FULL_SVC });
    change();
    expect(await save(api)).toEqual(sentJson("PATCH", "/services/5", expected));
  });

  it("changing only a step's overrides changes only that step's overrides", async () => {
    const { api } = await setup({ service: FULL_SVC });
    fireEvent.click(button("Advanced (overrides: top_P, top_K, maxTokens, etc.)●", card(0)));
    const row = card(0).querySelector<HTMLInputElement>('input[placeholder="content — JSON or text"]')!;
    type(row, "0.9");
    expect(await save(api)).toEqual(sentJson("PATCH", "/services/5", withStep(0, { overrides: { temperature: 0.9 } })));
  });

  it("adds the default tool limits to a chat definition stored without them, and nothing else", async () => {
    const { api } = await edit(TWO_STEPS);
    expect(await savedBody(api)).toEqual({ name: "svc", description: null, steps: { ...TWO_STEPS, hostedTools: TOOL_DEFAULTS }, enabled: true, toolIds: [] });
  });

  it("falls back to 60000 ms when the stored definition has no timeout", async () => {
    const { api } = await edit({ steps: [{ model: "haiku", provider: "anthropic" }] } as unknown as ServiceDef);
    expect(field(TIMEOUT).value).toBe("60000");
    expect((await savedSteps(api)).timeoutMs).toBe(60000);
  });

  it("drops what the server treats as absent: an explicit 'original' format and half a delimiter pair", async () => {
    const { api } = await edit({ ...TWO_STEPS, thinkingFormat: "original", thinkingDelimiters: { open: "<a>", close: "" }, hostedTools: TOOL_DEFAULTS as ServiceSteps["hostedTools"] });
    expect(field("Thinking starts with").value).toBe("<a>");
    expect(await savedSteps(api)).toEqual({ ...TWO_STEPS, hostedTools: TOOL_DEFAULTS });
  });

  it("folds a step's legacy flat 'thinking' into its overrides, where an existing override wins", async () => {
    const { api } = await edit({
      timeoutMs: 60000,
      steps: [
        { model: "sonnet", provider: "openai", thinking: "high" },
        { model: "haiku", provider: "anthropic", thinking: "low", overrides: { thinking: "max", topP: 0.5 } },
      ],
    });
    expect((await savedSteps(api)).steps).toEqual([
      { model: "sonnet", provider: "openai", overrides: { thinking: "high" } },
      { model: "haiku", provider: "anthropic", overrides: { thinking: "max", topP: 0.5 } },
    ]);
  });

  it("shows the attachment budget in whole MiB", async () => {
    await edit({ ...TWO_STEPS, maxAttachmentBytes: 8 * MIB });
    expect(field(ATTACHMENT).value).toBe("8");
  });

  it("a media category hides and stops sending everything chat-only, and unbinds the tools", async () => {
    const { api } = await setup({ service: FULL_SVC });
    type(field("Service type"), "image");
    const hint = screen.getByText("Served on /v1/images/generations (OpenAI-style passthrough with this chain's retry/fallback). Not usable inside a Micro Agent.");
    expect(classes(hint)).toEqual(cls("mt-1 text-[11px] text-ink-600"));
    expect(screen.queryByText("Hosted server tools")).toBeNull();
    expect(screen.queryByText("Reliable streaming")).toBeNull();
    expect(screen.queryByText("Thinking format")).toBeNull();
    expect(screen.queryByText(ATTACHMENT)).toBeNull();
    expect(isOn(toggle("Enabled"))).toBe(false);
    expect(cards()).toHaveLength(2);
    const body = await savedBody(api);
    expect(body.toolIds).toEqual([]);
    expect(body.steps).toEqual({ timeoutMs: 45000, steps: FULL.steps, category: "image", maxAttachmentBytes: 8 * MIB });
  });

  it.each([
    ["video", "/v1/videos"], ["tts", "/v1/audio/speech"], ["stt", "/v1/audio/transcriptions"], ["embedding", "/v1/embeddings"], ["rerank", "/v1/rerank"],
  ])("category %s names its endpoint %s and is saved as the category", async (category, endpoint) => {
    const { api } = await edit(TWO_STEPS);
    type(field("Service type"), category);
    expect(screen.getByText(new RegExp(`^Served on ${endpoint} \\(OpenAI-style passthrough`))).toBeTruthy();
    expect(await savedSteps(api)).toEqual({ ...TWO_STEPS, category });
  });

  it("category ocr keeps the chat-only sections and shows its own hint", async () => {
    const { api } = await edit(TWO_STEPS);
    type(field("Service type"), "ocr");
    expect(classes(screen.getByText(/^For OCR models like DeepSeek-OCR or GLM-OCR/))).toEqual(cls("mt-1 text-[11px] text-ink-600"));
    expect(screen.getByText("Hosted server tools")).toBeTruthy();
    expect(screen.getByText("Thinking format")).toBeTruthy();
    expect(await savedSteps(api)).toEqual({ ...TWO_STEPS, category: "ocr", hostedTools: TOOL_DEFAULTS });
  });

  it("turning reliable streaming on explains it and saves the flag", async () => {
    const { api } = await edit(TWO_STEPS);
    fireEvent.click(toggle("Reliable streaming"));
    expect(classes(screen.getByText(/^Streams the upstream response and buffers it/))).toEqual(cls("-mt-2 text-xs text-ink-500"));
    expect(await savedSteps(api)).toEqual({ ...TWO_STEPS, reliableStreaming: true, hostedTools: TOOL_DEFAULTS });
  });

  it.each([
    ["reasoning_content", /^Find the thinking wherever it is/],
    ["reasoning", /^Same, delivered as reasoning only/],
    ["think_tags", /^Fold the thinking into the answer text/],
    ["none", /^The client never sees the thinking/],
  ])("thinking format %s shows its hint and is saved", async (format, hint) => {
    const { api } = await edit(TWO_STEPS);
    type(field("Thinking format"), format);
    expect(screen.getByText(hint)).toBeTruthy();
    expect(await savedSteps(api)).toEqual({ ...TWO_STEPS, thinkingFormat: format, hostedTools: TOOL_DEFAULTS });
  });

  it("saves delimiters only as a pair, with or without a format", async () => {
    const { api } = await edit(TWO_STEPS);
    type(field("Thinking ends with"), "</t>");
    expect(await savedSteps(api)).toEqual({ ...TWO_STEPS, hostedTools: TOOL_DEFAULTS });
    type(field("Thinking starts with"), "<t>");
    expect(await savedSteps(api)).toEqual({ ...TWO_STEPS, thinkingDelimiters: { open: "<t>", close: "</t>" }, hostedTools: TOOL_DEFAULTS });
  });
});

// ---------------------------------------------------------------------------

describe("ServiceEditor: numeric fields", () => {
  it.each([
    ["a plain number", "120000", "120000", 120000],
    ["zero, the minimum", "0", "0", 0],
    ["a negative number (clamped to 0)", "-5", "0", 0],
    ["a fraction (truncated)", "1500.9", "1500", 1500],
    ["empty (0)", "", "0", 0],
    ["blank (0)", "   ", "0", 0],
    ["non-numeric (0)", "abc", "0", 0],
    ["a very large number (no maximum)", "999999999", "999999999", 999999999],
  ])("the timeout takes %s", async (_name, typed, shown, sent) => {
    const { api } = await edit(TWO_STEPS);
    type(field(TIMEOUT), typed);
    expect(field(TIMEOUT).value).toBe(shown);
    expect((await savedSteps(api)).timeoutMs).toBe(sent);
  });

  it.each([
    ["one MiB", "1", "1", MIB],
    ["a large budget (no maximum)", "4096", "4096", 4096 * MIB],
    ["zero (unlimited: key omitted)", "0", "0", undefined],
    ["a negative number (clamped to 0, omitted)", "-1", "0", undefined],
    ["a fraction (truncated)", "2.7", "2", 2 * MIB],
    ["empty (0, omitted)", "", "0", undefined],
    ["non-numeric (0, omitted)", "lots", "0", undefined],
  ])("the attachment budget takes %s", async (_name, typed, shown, sent) => {
    const { api } = await edit({ ...TWO_STEPS, maxAttachmentBytes: 5 * MIB });
    type(field(ATTACHMENT), typed);
    expect(field(ATTACHMENT).value).toBe(shown);
    expect((await savedSteps(api)).maxAttachmentBytes).toBe(sent);
  });

  const RETRY_STEP: ServiceSteps = { timeoutMs: 60000, steps: [{ model: "sonnet", provider: "openai", retry: { on: [429], maxAttempts: 4, intervalMs: 100 } }] };

  it.each([
    ["one, the minimum", "1", "1", 1],
    ["zero (raised to 1)", "0", "1", 1],
    ["a negative number (raised to 1)", "-3", "1", 1],
    ["a fraction (truncated)", "2.9", "2", 2],
    ["empty (1)", "", "1", 1],
    ["non-numeric (1)", "many", "1", 1],
    ["a large number (no maximum)", "1000", "1000", 1000],
  ])("retry attempts take %s", async (_name, typed, shown, sent) => {
    const { api } = await edit(RETRY_STEP);
    type(field("Retry attempts", card(0)), typed);
    expect(field("Retry attempts", card(0)).value).toBe(shown);
    expect((await savedStep(api, 0)).retry).toEqual({ on: [429], maxAttempts: sent, intervalMs: 100 });
  });

  it.each([
    ["zero, the minimum", "0", "0", 0],
    ["a negative number (clamped to 0)", "-10", "0", 0],
    ["a fraction (truncated)", "250.5", "250", 250],
    ["empty (0)", "", "0", 0],
    ["non-numeric (0)", "soon", "0", 0],
    ["a large number (no maximum)", "3600000", "3600000", 3600000],
  ])("the retry interval takes %s", async (_name, typed, shown, sent) => {
    const { api } = await edit(RETRY_STEP);
    type(field("Retry interval (ms)", card(0)), typed);
    expect(field("Retry interval (ms)", card(0)).value).toBe(shown);
    expect((await savedStep(api, 0)).retry).toEqual({ on: [429], maxAttempts: 4, intervalMs: sent });
  });

  it("the numeric inputs are text inputs that select their content on focus and on click", async () => {
    await edit(RETRY_STEP);
    for (const input of [field(TIMEOUT), field(ATTACHMENT), field("Retry attempts", card(0)), field("Retry interval (ms)", card(0))]) {
      expect([input.type, input.inputMode, classes(input)]).toEqual(["text", "numeric", ["input"]]);
      input.setSelectionRange(0, 0);
      fireEvent.focus(input);
      expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
      input.setSelectionRange(0, 0);
      fireEvent.click(input);
      expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
    }
  });
});

// ---------------------------------------------------------------------------

describe("ServiceEditor: retry policy and triggers", () => {
  it("a step saved without a retry policy stays without one", async () => {
    const { api } = await edit(TWO_STEPS);
    expect(await savedStep(api, 0)).toEqual({ model: "sonnet", provider: "openai" });
  });

  it("toggling a trigger on a step without a policy starts from the server's default set", async () => {
    const { api } = await edit(TWO_STEPS);
    fireEvent.click(button("500", retryOn(card(0))));
    expect(activeChips(retryOn(card(0)))).toEqual(["429", "499", "500", "502", "503", "timeout", "network"]);
    expect(await savedStep(api, 0)).toEqual({ model: "sonnet", provider: "openai", retry: { on: [...DEFAULT_RETRY_ON, 500], maxAttempts: 3, intervalMs: 0 } });
    fireEvent.click(button("429", retryOn(card(0))));
    expect((await savedStep(api, 0)).retry).toEqual({ on: [499, 502, 503, "timeout", "network", 500], maxAttempts: 3, intervalMs: 0 });
    // The other step is untouched.
    expect(await savedStep(api, 1)).toEqual({ model: "haiku", provider: "anthropic" });
  });

  it("a policy brought back to 3 attempts, no interval and the default triggers is dropped from the step again", async () => {
    const { api } = await edit({ timeoutMs: 60000, steps: [{ model: "sonnet", provider: "openai", retry: { on: DEFAULT_RETRY_ON as Trigger[], maxAttempts: 4, intervalMs: 0 } }] });
    expect(activeChips(retryOn(card(0)))).toEqual(DEFAULT_RETRY_ON.map(String));
    type(field("Retry attempts", card(0)), "3");
    expect(await savedStep(api, 0)).toEqual({ model: "sonnet", provider: "openai" });
    // With the policy gone the chips show the server defaults again.
    expect(activeChips(retryOn(card(0)))).toEqual(DEFAULT_RETRY_ON.map(String));
  });

  it("draws preset chips as on/off pills and a custom code as a removable pill", async () => {
    await setup({ service: FULL_SVC });
    const box = retryOn(card(0));
    expect(classes(box.querySelector(".space-y-2"))).toEqual(["space-y-2"]);
    expect(classes(presetChips(box)[0].parentElement)).toEqual(cls("flex flex-wrap gap-1.5"));
    expect(classes(button("429", box))).toEqual(cls(CHIP_ON));
    expect(classes(button("499", box))).toEqual(cls(CHIP_OFF));
    expect([...presetChips(box)].every((b) => b.type === "button")).toBe(true);
    const custom = customChips(box)[0];
    expect(classes(custom)).toEqual(cls("inline-flex items-center gap-1 rounded-md bg-brand-600 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-brand-500"));
    expect([custom.title, custom.type, custom.querySelector("i")!.className]).toEqual(["Click to remove", "button", "bi bi-x-lg text-[10px]"]);
    expect(classes(custom.parentElement)).toEqual(cls("flex flex-wrap gap-1.5"));

    const input = codeInput(box);
    expect([input.type, input.inputMode, input.placeholder, input.value, classes(input)]).toEqual(["text", "numeric", "HTTP code...", "", cls("input w-32 text-xs")]);
    expect(classes(input.parentElement)).toEqual(cls("flex items-center gap-2"));
    const add = button("Add", box);
    expect([classes(add), add.disabled, add.querySelector("i")!.className]).toEqual([cls("btn-ghost btn-xs"), true, "bi bi-plus-lg"]);
    expect(classes(screen.getAllByText("Type any HTTP code (100-599), press Enter to add")[0])).toEqual(cls("text-[11px] text-ink-500"));

    expect([...presetChips(advanceOn(card(0)))].map((b) => b.textContent)).toEqual(["429", "499", "500", "502", "503", "529", "timeout", "network", "error", "exhausted"]);
    const advanceLabel = labelEl("Advance to next step on", card(0));
    expect(advanceLabel.querySelector("span")!.textContent).toBe("(empty = any failure)");
    expect(classes(advanceLabel.querySelector("span"))).toEqual(cls("normal-case text-ink-500"));
  });

  it.each([
    ["100, the lowest code", "100", [...DEFAULT_RETRY_ON, 100], ""],
    ["599, the highest code", "599", [...DEFAULT_RETRY_ON, 599], ""],
    ["a code padded with spaces", " 418 ", [...DEFAULT_RETRY_ON, 418], ""],
    ["a symbolic trigger by name", "error", [...DEFAULT_RETRY_ON, "error"], ""],
  ])("the custom code box accepts %s and empties itself", async (_name, typed, on, left) => {
    const { api } = await edit(TWO_STEPS);
    const box = retryOn(card(0));
    type(codeInput(box), typed);
    expect(button("Add", box).disabled).toBe(false);
    fireEvent.click(button("Add", box));
    expect(codeInput(box).value).toBe(left);
    expect((await savedStep(api, 0)).retry).toEqual({ on, maxAttempts: 3, intervalMs: 0 });
  });

  it.each([
    ["99, just below the range", "99"],
    ["600, just above the range", "600"],
    ["a fraction", "429.5"],
    ["a word that is not a trigger", "teapot"],
  ])("the custom code box rejects %s and keeps the text", async (_name, typed) => {
    const { api } = await edit(TWO_STEPS);
    const box = retryOn(card(0));
    type(codeInput(box), typed);
    fireEvent.click(button("Add", box));
    expect(codeInput(box).value).toBe(typed);
    expect(await savedStep(api, 0)).toEqual({ model: "sonnet", provider: "openai" });
  });

  it.each([["429"], ["timeout"]])("adding %s when it is already selected changes nothing but empties the box", async (typed) => {
    const { api } = await edit(TWO_STEPS);
    const box = retryOn(card(0));
    type(codeInput(box), typed);
    fireEvent.click(button("Add", box));
    expect(codeInput(box).value).toBe("");
    expect(await savedStep(api, 0)).toEqual({ model: "sonnet", provider: "openai" });
  });

  it("Enter adds the code, other keys do not, and blank text keeps Add disabled", async () => {
    const { api } = await edit(TWO_STEPS);
    const box = retryOn(card(0));
    type(codeInput(box), "   ");
    expect(button("Add", box).disabled).toBe(true);
    type(codeInput(box), "451");
    fireEvent.keyDown(codeInput(box), { key: "Tab" });
    expect(codeInput(box).value).toBe("451");
    fireEvent.keyDown(codeInput(box), { key: "Enter" });
    expect(codeInput(box).value).toBe("");
    expect(customChips(box).map((b) => b.textContent)).toEqual(["451"]);
    expect((await savedStep(api, 0)).retry).toEqual({ on: [...DEFAULT_RETRY_ON, 451], maxAttempts: 3, intervalMs: 0 });
  });

  it("advance triggers start empty, take custom codes, and an emptied list is sent as []", async () => {
    const { api } = await edit(TWO_STEPS);
    const box = advanceOn(card(0));
    expect(activeChips(box)).toEqual([]);
    fireEvent.click(button("exhausted", box));
    type(codeInput(box), "404");
    fireEvent.click(button("Add", box));
    expect(await savedStep(api, 0)).toEqual({ model: "sonnet", provider: "openai", advanceOn: ["exhausted", 404] });
    fireEvent.click(button("exhausted", box));
    fireEvent.click(customChips(box)[0]);
    expect(await savedStep(api, 0)).toEqual({ model: "sonnet", provider: "openai", advanceOn: [] });
    // Only a step with a successor can advance.
    expect(card(1).textContent).not.toContain("Advance to next step on");
  });
});

// ---------------------------------------------------------------------------

describe("ServiceEditor: the step list", () => {
  const THREE: ServiceSteps = { timeoutMs: 60000, steps: [{ model: "sonnet", provider: "openai" }, { model: "haiku", provider: "anthropic" }, { model: "sonnet", provider: "azure" }] };

  it("draws the list header, each step card and the connectors between them", async () => {
    await edit(TWO_STEPS);
    const heading = screen.getByText("Failure chain (drag to reorder)");
    expect([heading.tagName, classes(heading)]).toEqual(["SPAN", cls("label mb-0")]);
    expect(classes(heading.parentElement)).toEqual(cls("mb-2 flex items-center justify-between"));
    const add = button("Add step");
    expect([classes(add), add.querySelector("i")!.className]).toEqual([cls("btn-ghost btn-xs"), "bi bi-plus-lg"]);

    const c = card(0);
    expect(classes(c)).toEqual(cls("rounded-xl border border-ink-700 bg-ink-850/70 p-3"));
    expect(classes(c.parentElement!.parentElement)).toEqual(["space-y-1"]);
    const header = c.firstElementChild!;
    expect(classes(header)).toEqual(cls("mb-2.5 flex items-center gap-2"));
    const [handle, badge, spacer, duplicate, remove] = [...header.children] as HTMLElement[];
    expect([handle.tagName, handle.getAttribute("draggable"), handle.title, classes(handle)]).toEqual(["SPAN", "true", "Drag to reorder", cls("cursor-grab text-ink-600 hover:text-ink-300")]);
    expect(handle.querySelector("i")!.className).toBe("bi bi-grip-vertical");
    expect([badge.textContent, classes(badge)]).toEqual(["Step 1", ["badge-blue"]]);
    expect(spacer.className).toBe("flex-1");
    expect([classes(duplicate), duplicate.title, duplicate.querySelector("i")!.className]).toEqual([cls("btn-ghost btn-xs"), "Duplicate with a different provider", "bi bi-files"]);
    expect([classes(remove), remove.title, remove.querySelector("i")!.className]).toEqual([cls("btn-danger btn-xs"), "", "bi bi-trash3"]);

    const modelSelect = field<HTMLSelectElement>("Model", c);
    const providerSelect = field<HTMLSelectElement>("Provider", c);
    expect([classes(modelSelect), classes(providerSelect)]).toEqual([["select"], ["select"]]);
    expect(classes(modelSelect.closest(".grid"))).toEqual(cls("grid grid-cols-2 gap-3"));
    expect(options(modelSelect)).toEqual([["sonnet", "sonnet"], ["haiku", "haiku"], ["orphan", "orphan"]]);
    expect(options(providerSelect)).toEqual([["openai", "openai"], ["azure", "azure"]]);
    expect(classes(field("Retry attempts", c).closest(".grid"))).toEqual(cls("mt-3 grid grid-cols-2 gap-3"));
    expect(classes(retryOn(c))).toEqual(["mt-3"]);
    expect(classes(advanceOn(c))).toEqual(["mt-3"]);
    expect([...c.querySelectorAll(".label")].map((l) => [l.tagName, l.className])).toEqual(Array(6).fill(["LABEL", "label"]));

    const connector = screen.getByText("on failure");
    expect(classes(connector)).toEqual(cls("flex items-center gap-2 py-1 pl-4 text-xs text-ink-500"));
    expect(connector.querySelector("i")!.className).toBe("bi bi-arrow-down");
    expect(connector.parentElement).toBe(c.parentElement);
    expect(screen.getAllByText("on failure")).toHaveLength(1);
    const last = screen.getByText("if the last step still fails, the upstream error is returned to the client");
    expect(classes(last)).toEqual(cls("flex items-center gap-2 pl-4 pt-1 text-xs text-ink-500"));
    expect(last.querySelector("i")!.className).toBe("bi bi-x-octagon");
    expect(cards().map((x) => x.querySelector(".badge-blue")!.textContent)).toEqual(["Step 1", "Step 2"]);
  });

  it("Add step appends the first model on its first provider, without a retry policy", async () => {
    const { api } = await edit({ timeoutMs: 60000, steps: [{ model: "haiku", provider: "anthropic" }] });
    fireEvent.click(button("Add step"));
    expect(stepPairs()).toEqual(["haiku@anthropic", "sonnet@openai"]);
    expect((await savedSteps(api)).steps).toEqual([{ model: "haiku", provider: "anthropic" }, { model: "sonnet", provider: "openai" }]);
  });

  it.each([
    ["no model exists", { models: [] }, { model: "", provider: "" }],
    ["the first model has no provider", { models: [MODELS[2]] }, { model: "orphan", provider: "" }],
  ])("Add step still adds a step when %s", async (_name, props, step) => {
    const { api } = await setup(props);
    fireEvent.click(button("Add step"));
    expect(cards()).toHaveLength(1);
    expect(options(field<HTMLSelectElement>("Provider", card(0)))).toEqual([["", "(no providers mapped)"]]);
    type(field(NAME), "x");
    expect((await savedSteps(api)).steps).toEqual([step]);
  });

  it("changing a step's model keeps its provider when still mapped, else takes the first, else none", async () => {
    const { api } = await edit({ timeoutMs: 60000, steps: [{ model: "sonnet", provider: "azure" }] });
    type(field("Model", card(0)), "sonnet");
    expect(stepPairs()).toEqual(["sonnet@azure"]);
    type(field("Model", card(0)), "haiku");
    expect(stepPairs()).toEqual(["haiku@anthropic"]);
    type(field("Model", card(0)), "orphan");
    expect(options(field<HTMLSelectElement>("Provider", card(0)))).toEqual([["", "(no providers mapped)"]]);
    expect(await savedStep(api, 0)).toEqual({ model: "orphan", provider: "" });
  });

  it("Duplicate inserts a deep copy right after, switched to another provider of the same model when there is one", async () => {
    const { api } = await setup({ service: FULL_SVC });
    fireEvent.click(iconButton("bi-files", card(0)));
    expect(stepPairs()).toEqual(["sonnet@openai", "sonnet@azure", "haiku@anthropic"]);
    fireEvent.click(iconButton("bi-files", card(2)));
    expect(stepPairs()).toEqual(["sonnet@openai", "sonnet@azure", "haiku@anthropic", "haiku@anthropic"]);
    // Editing the copy leaves the original alone.
    fireEvent.click(button("429", retryOn(card(1))));
    expect((await savedSteps(api)).steps).toEqual([
      FULL.steps[0],
      { ...FULL.steps[0], provider: "azure", retry: { ...FULL.steps[0].retry, on: [418, "timeout"] } },
      FULL.steps[1], FULL.steps[1],
    ]);
  });

  it("Remove deletes that step; the last one leaves the empty hint", async () => {
    const { api } = await edit(THREE);
    fireEvent.click(iconButton("bi-trash3", card(1)));
    expect(stepPairs()).toEqual(["sonnet@openai", "sonnet@azure"]);
    expect((await savedSteps(api)).steps).toEqual([THREE.steps[0], THREE.steps[2]]);
    fireEvent.click(iconButton("bi-trash3", card(0)));
    fireEvent.click(iconButton("bi-trash3", card(0)));
    expect(screen.getByText("No steps. Add at least one (model, provider) attempt.")).toBeTruthy();
    expect((await savedSteps(api)).steps).toEqual([]);
  });

  const drag = (from: number, to: number) => {
    fireEvent.dragStart(card(from).querySelector("[draggable]")!);
    fireEvent.drop(card(to));
  };

  it.each([
    ["the first onto the last", 0, 2, [1, 2, 0]],
    ["the last onto the first", 2, 0, [2, 0, 1]],
    ["the first onto the second", 0, 1, [1, 0, 2]],
    ["a step onto itself", 1, 1, [0, 1, 2]],
  ])("dragging %s moves it to that position", async (_name, from, to, order) => {
    const { api } = await edit(THREE);
    drag(from, to);
    expect((await savedSteps(api)).steps).toEqual(order.map((i) => THREE.steps[i]));
  });

  it("a drop after the drag ended, or with no drag at all, moves nothing", async () => {
    const { api } = await edit(THREE);
    fireEvent.drop(card(2));
    fireEvent.dragStart(card(0).querySelector("[draggable]")!);
    fireEvent.dragEnd(card(0).querySelector("[draggable]")!);
    fireEvent.drop(card(2));
    expect((await savedSteps(api)).steps).toEqual(THREE.steps);
  });

  it("an open Advanced section travels with its step when the list changes", async () => {
    await edit(THREE);
    fireEvent.click(button("Advanced (overrides: top_P, top_K, maxTokens, etc.)", card(1)));
    expect(cards().map((c) => c.textContent!.includes("Parameter overrides"))).toEqual([false, true, false]);
    drag(1, 0);
    expect(cards().map((c) => c.textContent!.includes("Parameter overrides"))).toEqual([true, false, false]);
    fireEvent.click(iconButton("bi-files", card(0)));
    expect(cards().map((c) => c.textContent!.includes("Parameter overrides"))).toEqual([true, false, false, false]);
    fireEvent.click(iconButton("bi-trash3", card(0)));
    expect(cards().map((c) => c.textContent!.includes("Parameter overrides"))).toEqual([false, false, false]);
  });

  it("the per-step Advanced section is closed by default, flags existing overrides and edits them", async () => {
    const { api } = await setup({ service: FULL_SVC });
    const plain = button("Advanced (overrides: top_P, top_K, maxTokens, etc.)", card(1));
    expect([classes(plain), plain.type, classes(plain.parentElement)]).toEqual([cls("text-xs text-ink-500 hover:text-ink-300"), "button", ["mt-3"]]);
    expect(plain.querySelector("i")!.className).toBe("bi bi-chevron-right mr-1");
    expect(plain.querySelector("span")).toBeNull();
    const flagged = button("Advanced (overrides: top_P, top_K, maxTokens, etc.)●", card(0));
    expect([flagged.querySelector("span")!.textContent, classes(flagged.querySelector("span"))]).toEqual(["●", cls("ml-1 text-brand-400")]);
    expect(card(1).textContent).not.toContain("Parameter overrides");

    fireEvent.click(plain);
    expect(plain.querySelector("i")!.className).toBe("bi bi-chevron-down mr-1");
    const panel = plain.nextElementSibling!;
    expect(classes(panel)).toEqual(["mt-2"]);
    expect(classes(panel.firstElementChild)).toEqual(cls("rounded-lg border border-ink-800 bg-ink-950/40 p-3"));
    fireEvent.click(button("Add parameter", card(1)));
    type(card(1).querySelector('input[placeholder="parameter"]')!, "topP");
    type(card(1).querySelector('input[placeholder="content — JSON or text"]')!, "0.5");
    expect(await savedStep(api, 1)).toEqual({ model: "haiku", provider: "anthropic", overrides: { topP: 0.5 } });
    // Removing the last override leaves no overrides key in the payload.
    fireEvent.click(iconButton("bi-x-lg", card(1)));
    expect(await savedStep(api, 1)).toEqual({ model: "haiku", provider: "anthropic" });
    fireEvent.click(plain);
    expect(card(1).textContent).not.toContain("Parameter overrides");
  });
});

// ---------------------------------------------------------------------------

describe("ServiceEditor: validate and dry-run", () => {
  it("Validate posts the current definition and shows the summary in a brand note", async () => {
    const { api, onClose } = await setup({ service: FULL_SVC }, { "POST /services/validate": { valid: true, summary: "sonnet@openai, then haiku@anthropic" } });
    fireEvent.click(button("Validate"));
    await toastShown("Workflow is valid");
    expect(api.mutations()).toEqual([sentJson("POST", "/services/validate", { steps: FULL })]);
    const summary = screen.getByText("sonnet@openai, then haiku@anthropic");
    expect(classes(summary)).toEqual(["text-ink-200"]);
    expect(classes(summary.parentElement)).toEqual(cls("flex items-start gap-2 rounded-lg border border-brand-700/40 bg-brand-700/10 px-3 py-2 text-sm text-brand-400"));
    expect(summary.parentElement!.querySelector("i")!.className).toBe("bi bi-signpost-split mt-0.5");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Validate works without a name and shows no note for an empty summary", async () => {
    const { api } = await setup({}, { "POST /services/validate": { valid: true } });
    fireEvent.click(button("Validate"));
    await toastShown("Workflow is valid");
    expect(api.mutations()[0].body).toEqual({ steps: NEW_STEPS });
    expect(document.querySelector(".bi-signpost-split")).toBeNull();
  });

  it.each([
    ["the server's reason", { valid: false, error: "step 2: unknown model" }, "step 2: unknown model"],
    ["'Invalid workflow' when no reason is given", { valid: false }, "Invalid workflow"],
  ])("an invalid definition toasts %s and removes an earlier summary", async (_name, answer, text) => {
    const { api } = await setup({ service: FULL_SVC }, { "POST /services/validate": { valid: true, summary: "fine" } });
    fireEvent.click(button("Validate"));
    await screen.findByText("fine");
    api.on("POST /services/validate", answer);
    fireEvent.click(button("Validate"));
    await toastShown(text);
    expect(screen.queryByText("fine")).toBeNull();
  });

  it("Dry-run posts the definition with the prompt 'ping' and reports who served it", async () => {
    const { api, onClose } = await setup({ service: FULL_SVC }, { "POST /services/test": { ok: true, served: { model: "sonnet", provider: "openai" }, output: "pong" } });
    fireEvent.click(button("Dry-run"));
    await toastShown('Served by sonnet@openai: "pong"');
    expect(api.mutations()).toEqual([sentJson("POST", "/services/test", { steps: FULL, prompt: "ping" })]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([
    ["blanks when the answer names nobody", { ok: true }, 'Served by @: ""'],
    ["the upstream message when it did not serve", { ok: false, message: "all steps failed" }, "Dry-run failed: all steps failed"],
    ["an empty reason when none is given", { ok: false }, "Dry-run failed: "],
    ["the server's message when the call is refused", fail(400, { error: "bad definition" }), "bad definition"],
    ["'Dry-run failed' for a non-API failure", () => { throw new TypeError("offline"); }, "Dry-run failed"],
  ])("Dry-run toasts %s", async (_name, handler, text) => {
    await setup({ service: FULL_SVC }, { "POST /services/test": handler });
    fireEvent.click(button("Dry-run"));
    await toastShown(text);
    await waitFor(() => expect(button("Dry-run").disabled).toBe(false));
  });

  it("disables Dry-run, Save and Validate while the dry-run is in flight", async () => {
    const gate = deferred<unknown>();
    await setup({ service: FULL_SVC }, { "POST /services/test": () => gate.promise });
    fireEvent.click(button("Dry-run"));
    await waitFor(() => expect(button("Dry-run").disabled).toBe(true));
    expect(["Raw JSON", "Validate", "Cancel", "Save"].map((b) => button(b).disabled)).toEqual([false, true, false, true]);
    await act(async () => { gate.resolve({ ok: true }); });
    await waitFor(() => expect(button("Dry-run").disabled).toBe(false));
    expect(button("Save").disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("ServiceEditor: raw JSON view", () => {
  const toRaw = () => fireEvent.click(button("Raw JSON"));
  const toForm = () => fireEvent.click(button("Visual editor"));
  const setRaw = (def: unknown) => type(rawArea(), typeof def === "string" ? def : JSON.stringify(def));

  it("shows the form's definition pretty-printed, keys in the order the editor writes them", async () => {
    await setup({ service: FULL_SVC });
    toRaw();
    expect(rawArea().value).toBe(JSON.stringify(FULL, null, 2));
    expect(Object.keys(JSON.parse(rawArea().value) as object)).toEqual([
      "timeoutMs", "steps", "category", "reliableStreaming", "maxAttachmentBytes", "thinkingFormat", "thinkingDelimiters", "hostedTools",
    ]);
  });

  it("shows a new service's definition", async () => {
    await setup();
    toRaw();
    expect(rawArea().value).toBe(JSON.stringify(NEW_STEPS, null, 2));
  });

  it("replaces the step list with one textarea and hides the form-only sections", async () => {
    await setup({ service: FULL_SVC });
    toRaw();
    expect(hasButton("Raw JSON")).toBe(false);
    expect(classes(button("Visual editor"))).toEqual(["btn-ghost"]);
    expect(button("Visual editor").querySelector("i")!.className).toBe("bi bi-code-slash");
    expect(classes(rawArea())).toEqual(cls("input min-h-[320px] font-mono text-xs"));
    expect(field<HTMLTextAreaElement>("Steps JSON")).toBe(rawArea());
    expect(classes(labelEl("Steps JSON"))).toEqual(["label"]);
    expect(cards()).toEqual([]);
    expect(hasButton("Add step")).toBe(false);
    expect(screen.queryByText("Hosted server tools")).toBeNull();
    expect(screen.queryByText(ATTACHMENT)).toBeNull();
    expect(screen.queryByText("Model Service: try each (model, provider) in turn until one succeeds.")).toBeNull();
    // These stay on screen beside the textarea.
    expect([field(NAME).value, field(TIMEOUT).value, field(DESCRIPTION).value]).toEqual(["svc", "45000", "desc"]);
    expect(field<HTMLSelectElement>("Service type").value).toBe("ocr");
    expect(field<HTMLSelectElement>("Thinking format").value).toBe("think_tags");
    expect(isOn(toggle("Reliable streaming"))).toBe(true);
  });

  it("switching straight back leaves the definition as it was", async () => {
    const { api } = await setup({ service: FULL_SVC });
    toRaw();
    toForm();
    expect(hasButton("Raw JSON")).toBe(true);
    expect(await save(api)).toEqual(sentJson("PATCH", "/services/5", FULL_BODY));
  });

  it("switching back loads every definition field from the JSON, and leaves name, description, enabled and bound tools alone", async () => {
    const { api } = await setup({ service: FULL_SVC });
    type(field(NAME), "renamed");
    fireEvent.click(field("calc"));
    toRaw();
    const next = {
      timeoutMs: 9000,
      steps: [{ model: "haiku", provider: "anthropic", retry: { on: [500], maxAttempts: 2, intervalMs: 10 } }],
      category: "chat",
      reliableStreaming: false,
      maxAttachmentBytes: 2 * MIB,
      thinkingFormat: "reasoning",
      thinkingDelimiters: { open: "[", close: "]" },
      hostedTools: { streamMode: "final", maxRounds: 2, maxCalls: 3 },
    };
    setRaw(next);
    toForm();
    expect([field(NAME).value, field(DESCRIPTION).value, isOn(toggle("Enabled"))]).toEqual(["renamed", "desc", false]);
    expect([field("search").checked, field("calc").checked]).toEqual([true, true]);
    expect([field(TIMEOUT).value, field<HTMLSelectElement>("Service type").value, isOn(toggle("Reliable streaming")), field(ATTACHMENT).value]).toEqual(["9000", "chat", false, "2"]);
    expect([field<HTMLSelectElement>("Thinking format").value, field("Thinking starts with").value, field("Thinking ends with").value]).toEqual(["reasoning", "[", "]"]);
    expect([field<HTMLSelectElement>("Streaming delivery").value, field("Maximum model rounds").value, field("Maximum tool calls").value]).toEqual(["final", "2", "3"]);
    expect(stepPairs()).toEqual(["haiku@anthropic"]);
    expect([field("Retry attempts", card(0)).value, field("Retry interval (ms)", card(0)).value, activeChips(retryOn(card(0)))]).toEqual(["2", "10", ["500"]]);
    expect(await savedBody(api)).toEqual({
      name: "renamed", description: "desc", enabled: false, toolIds: [1, 2],
      steps: { timeoutMs: 9000, steps: next.steps, maxAttachmentBytes: 2 * MIB, thinkingFormat: "reasoning", thinkingDelimiters: { open: "[", close: "]" }, hostedTools: next.hostedTools },
    });
  });

  it("switching back from an empty object resets every definition field to its default", async () => {
    const { api } = await setup({ service: FULL_SVC });
    toRaw();
    setRaw({});
    toForm();
    expect([field(TIMEOUT).value, field<HTMLSelectElement>("Service type").value, isOn(toggle("Reliable streaming")), field(ATTACHMENT).value]).toEqual(["60000", "chat", false, "0"]);
    expect([field<HTMLSelectElement>("Thinking format").value, field("Thinking starts with").value, field("Thinking ends with").value]).toEqual(["original", "", ""]);
    expect([field<HTMLSelectElement>("Streaming delivery").value, field("Maximum model rounds").value, field("Maximum tool calls").value]).toEqual(["progress", "8", "16"]);
    expect(cards()).toEqual([]);
    expect(await savedBody(api)).toEqual({ ...FULL_BODY, steps: { timeoutMs: 60000, steps: [], hostedTools: TOOL_DEFAULTS } });
  });

  it("switching back folds a legacy flat 'thinking' into overrides and drops keys the form does not know", async () => {
    const { api } = await edit(TWO_STEPS);
    toRaw();
    setRaw({ timeoutMs: 60000, steps: [{ model: "sonnet", provider: "openai", thinking: "high" }], somethingElse: true });
    toForm();
    expect(await savedSteps(api)).toEqual({ timeoutMs: 60000, steps: [{ model: "sonnet", provider: "openai", overrides: { thinking: "high" } }], hostedTools: TOOL_DEFAULTS });
  });

  it("switching back with invalid JSON toasts, stays in the raw view with the text as typed and keeps the form's previous state", async () => {
    const { api } = await setup({ service: FULL_SVC });
    toRaw();
    setRaw("{ not json");
    toForm();
    await toastShown("Steps JSON is invalid");
    expect(hasButton("Visual editor")).toBe(true);
    expect(rawArea().value).toBe("{ not json");
    // The form behind the raw view is untouched: valid text brings it back as it was.
    setRaw(JSON.stringify(FULL));
    toForm();
    expect(hasButton("Raw JSON")).toBe(true);
    expect(stepPairs()).toEqual(["sonnet@openai", "haiku@anthropic"]);
    expect(await save(api)).toEqual(sentJson("PATCH", "/services/5", FULL_BODY));
  });

  it("an agent definition typed into a new Model Service turns the editor into a Micro Agent editor", async () => {
    const { api } = await setup();
    type(field(NAME), "x");
    toRaw();
    setRaw({ kind: "micro_agent", timeoutMs: 1000, stages: [{ name: "only", input: [] }] });
    toForm();
    const m = openModal("New Micro Agent");
    expect(classes(m.querySelector("h2 i"))).toEqual(cls("bi bi-robot text-brand-400"));
    expect(screen.queryByText("Service type")).toBeNull();
    expect(screen.queryByText("Reliable streaming")).toBeNull();
    expect(screen.getByText(/^Micro Agent: a decision tree of stages/)).toBeTruthy();
    expect(await savedSteps(api)).toEqual({ kind: "micro_agent", timeoutMs: 1000, stages: [{ name: "only", input: [] }], hostedTools: TOOL_DEFAULTS });
    await toastShown("Micro Agent created");
    // And a failure chain typed over it turns it back.
    toRaw();
    expect(field<HTMLTextAreaElement>("Chain JSON")).toBe(rawArea());
    setRaw(TWO_STEPS);
    toForm();
    expect(openModal("New Model Service")).toBeTruthy();
    expect(stepPairs()).toEqual(["sonnet@openai", "haiku@anthropic"]);
    expect(await savedSteps(api)).toEqual({ ...TWO_STEPS, hostedTools: TOOL_DEFAULTS });
  });

  it("Save in the raw view sends the typed JSON verbatim, unknown keys included, without touching the form", async () => {
    const { api } = await setup({ service: FULL_SVC });
    toRaw();
    const typed = { timeoutMs: 1, steps: [{ model: "sonnet", provider: "openai", thinking: "high" }], custom: { a: 1 } };
    setRaw(typed);
    expect(await save(api)).toEqual(sentJson("PATCH", "/services/5", { ...FULL_BODY, steps: typed }));
    await toastShown("Model Service updated");
    expect(rawArea().value).toBe(JSON.stringify(typed));
    expect(field(TIMEOUT).value).toBe("45000");
  });

  it("Validate and Dry-run in the raw view send the typed JSON", async () => {
    const { api } = await setup({ service: FULL_SVC }, { "POST /services/validate": { valid: true, summary: "ok then" }, "POST /services/test": { ok: false, message: "no" } });
    toRaw();
    setRaw({ timeoutMs: 2, steps: [] });
    fireEvent.click(button("Validate"));
    await screen.findByText("ok then");
    fireEvent.click(button("Dry-run"));
    await toastShown("Dry-run failed: no");
    expect(api.mutations()).toEqual([
      sentJson("POST", "/services/validate", { steps: { timeoutMs: 2, steps: [] } }),
      sentJson("POST", "/services/test", { steps: { timeoutMs: 2, steps: [] }, prompt: "ping" }),
    ]);
  });

  it("an emptied raw view is sent as an empty object", async () => {
    const { api } = await setup({ service: FULL_SVC });
    toRaw();
    setRaw("");
    expect(await savedSteps(api)).toEqual({});
  });

  it.each([["Save"], ["Validate"], ["Dry-run"]])("%s with invalid JSON in the raw view toasts and sends nothing", async (action) => {
    const { api, onClose } = await setup({ service: FULL_SVC });
    toRaw();
    setRaw("{ not json");
    fireEvent.click(button(action));
    await toastShown("Steps JSON is invalid");
    expect(api.mutations()).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    expect([button("Save").disabled, button("Dry-run").disabled]).toEqual([false, false]);
  });

  it("the JSON is checked before the name", async () => {
    const { api } = await setup();
    toRaw();
    setRaw("nope");
    fireEvent.click(button("Save"));
    await toastShown("Steps JSON is invalid");
    setRaw("{}");
    fireEvent.click(button("Save"));
    await toastShown("Name is required");
    expect(api.mutations()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("ServiceEditor: reopening for another service", () => {
  const OTHER = service(6, "other", { timeoutMs: 1000, steps: [{ model: "haiku", provider: "anthropic" }], category: "image" }, { description: "o" });

  /** Keeps one editor mounted, as the page does, and walks it through `sequence`. */
  function Host({ sequence }: { sequence: Array<{ service: ModelService | null; open?: boolean }> }) {
    const [i, setI] = useState(0);
    const cur = sequence[i];
    return (
      <>
        <button onClick={() => setI(i + 1)}>next-target</button>
        <ServiceEditor open={cur.open ?? true} service={cur.service} services={[]} models={MODELS} providers={PROVIDERS} mappings={MAPPINGS} onClose={() => {}} onSaved={() => {}} />
      </>
    );
  }
  const host = async (sequence: Array<{ service: ModelService | null; open?: boolean }>) => {
    const api = mockApi({ "GET /tools": { tools: TOOLS }, "POST /services": {}, "PATCH /services/5": {}, "PATCH /services/6": {} }, ADMIN);
    await renderPage(<Host sequence={sequence} />);
    await screen.findByText("Hosted server tools");
    return api;
  };
  const next = () => fireEvent.click(button("next-target"));

  it("loads the next service over the previous one, edits included", async () => {
    const api = await host([{ service: FULL_SVC }, { service: OTHER }]);
    type(field(NAME), "edited");
    fireEvent.click(iconButton("bi-trash3", card(0)));
    next();
    expect(openModal('Edit "other"')).toBeTruthy();
    expect(await save(api)).toEqual(sentJson("PATCH", "/services/6", { name: "other", description: "o", steps: OTHER.steps, enabled: true, toolIds: [] }));
  });

  it("a new service after an edit starts from the blank defaults", async () => {
    const api = await host([{ service: FULL_SVC }, { service: null }]);
    next();
    expect(openModal("New Model Service")).toBeTruthy();
    expect([field(NAME).value, field(DESCRIPTION).value, field(TIMEOUT).value, isOn(toggle("Enabled"))]).toEqual(["", "", "60000", true]);
    type(field(NAME), "fresh");
    expect(await save(api)).toEqual(sentJson("POST", "/services", { name: "fresh", description: null, steps: NEW_STEPS, enabled: true, toolIds: [] }));
  });

  it("reopening the same service discards unsaved edits and leaves the raw view", async () => {
    const api = await host([{ service: FULL_SVC }, { service: FULL_SVC, open: false }, { service: FULL_SVC }]);
    type(field(NAME), "edited");
    type(field(TIMEOUT), "1");
    fireEvent.click(field("calc"));
    fireEvent.click(button("Raw JSON"));
    next();
    expect(document.querySelector(".card")).toBeNull();
    next();
    expect(hasButton("Raw JSON")).toBe(true);
    expect(await save(api)).toEqual(sentJson("PATCH", "/services/5", FULL_BODY));
  });

  it("an earlier validation summary is gone when the editor is opened again", async () => {
    const api = await host([{ service: FULL_SVC }, { service: OTHER }]);
    api.on("POST /services/validate", { valid: true, summary: "fine" });
    fireEvent.click(button("Validate"));
    await screen.findByText("fine");
    next();
    expect(screen.queryByText("fine")).toBeNull();
  });
});
