import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceEditor } from "../src/components/ServiceEditor";
import { I18nProvider } from "../src/lib/i18n";
import type { HostedTool, Mapping, Model, ModelService, Provider, ServiceSteps } from "../src/types";

vi.mock("../src/auth", () => ({ useAuth: () => ({ user: { id: 1, role: "admin" } }) }));
vi.mock("../src/components/Toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

const service: ModelService = {
  id: 1, name: "chat-service", description: null, enabled: true, summary: "", createdAt: 0,
  steps: { timeoutMs: 60000, steps: [{ model: "chat-model", provider: "primary" }] },
};
const agent: ModelService = {
  ...service, id: 2, name: "chat-agent",
  steps: { kind: "micro_agent", timeoutMs: 60000, stages: [{ name: "main", service: service.name, input: [] }] },
};
const models: Model[] = [{ id: 1, name: "chat-model", description: null, enabled: true, createdAt: 0 }];
const providers: Provider[] = ["primary", "fallback"].map((name, index) => ({
  id: index + 1, name, type: "openai_completion", baseUrl: "http://localhost:8791/v1", hasKey: false,
  extraHeaders: null, maxOutputTokens: null, enabled: true, createdAt: 0,
}));
const mappings: Mapping[] = providers.map(provider => ({
  id: provider.id, modelId: 1, providerId: provider.id, upstreamModel: "mock", priority: 0, enabled: true,
}));
const tool: HostedTool = {
  id: 3, name: "demo_lookup", description: "Mock lookup", parameters: {}, url: "http://localhost:8791/tool",
  bodyTemplate: {}, resultPath: "", timeoutMs: 5000, maxResultBytes: 1024, enabled: true,
  headerNames: [], hasHeaders: false,
};
let saved: Record<string, any> | undefined;
let language: "en" | "zh";
const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
  let response: unknown;
  if (url === "/admin/api/settings/ui-language") response = { language };
  else if (url === "/admin/api/tools") response = { tools: [tool] };
  else if (url.startsWith("/admin/api/services/")) {
    saved = JSON.parse(String(init.body));
    response = {};
  } else throw new Error(`Unexpected request: ${url}`);
  return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
});

beforeEach(() => {
  saved = undefined;
  language = "en";
  localStorage.clear();
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderEditor(value: ModelService = service, services: ModelService[] = [service, agent]) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const editor = (current: ModelService) => <I18nProvider><ServiceEditor open service={current} services={services} models={models} providers={providers} mappings={mappings} onSaved={onSaved} onClose={onClose} /></I18nProvider>;
  const result = render(editor(value));
  return { onSaved, rerender: (current: ModelService) => result.rerender(editor(current)) };
}
function advancedButton() {
  return screen.getByRole("button", { name: /^Advanced(?: Configured)?$/ });
}
function expandAdvanced() {
  fireEvent.click(advancedButton());
}
function thinkingSwitch() {
  return screen.getByRole("switch", { name: "Thinking format" });
}
function rawDefinition() {
  fireEvent.click(screen.getByRole("button", { name: "Raw JSON" }));
  const textarea = screen.getAllByRole("textbox").find(element => element.tagName === "TEXTAREA") as HTMLTextAreaElement;
  return { textarea, definition: JSON.parse(textarea.value) };
}
async function save(onSaved: ReturnType<typeof vi.fn>) {
  fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  return saved!;
}

describe("service Advanced section", () => {
  it.each([service, agent])("starts collapsed in $name and keeps the main workflow visible", value => {
    renderEditor(value);
    expect(advancedButton().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Hosted server tools", { exact: true })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Thinking format" })).toBeNull();
    expect(screen.queryByText("Upstream thinking decoder", { exact: true })).toBeNull();
    expect(screen.queryByLabelText("Attachment inlining budget (MiB)")).toBeNull();
    if (value === service) expect(screen.getByText("Failure chain (drag to reorder)", { exact: true })).toBeTruthy();
    else expect(screen.getByDisplayValue("main")).toBeTruthy();
    expandAdvanced();
    const section = advancedButton().closest("section")!;
    expect(within(section).getByText("Hosted server tools", { exact: true })).toBeTruthy();
    expect(within(section).getByRole("switch", { name: "Thinking format" })).toBeTruthy();
    expect(within(section).queryByText("Upstream thinking decoder", { exact: true })).toBeNull();
    expect(within(section).getByRole("heading", { name: "Thinking", exact: true })).toBeTruthy();
    expect(within(section).getByRole("group", { name: "Hosted server tools", exact: true })).toBeTruthy();
    expect(within(section).getByRole("group", { name: "Attachments", exact: true })).toBeTruthy();
    expect(within(section).getByLabelText("Attachment inlining budget (MiB)")).toBeTruthy();
    const toggle = thinkingSwitch();
    fireEvent.click(toggle);
    const decoder = within(section).getByText("Upstream thinking decoder", { exact: true });
    expect(toggle.compareDocumentPosition(decoder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    if (value === agent) expect(screen.getByText(/Turning this agent's toggle off bypasses decoding throughout the run/)).toBeTruthy();
  });

  it.each([service, agent])("defaults translation off and omits thinkingFormat when saving $name", async value => {
    const { onSaved } = renderEditor(value);
    expandAdvanced();
    expect(thinkingSwitch().getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("combobox", { name: "Translate to" })).toBeNull();
    expect(screen.getByText(/Off: pass thinking through unchanged/)).toBeTruthy();
    expect(screen.queryByText("Upstream thinking decoder", { exact: true })).toBeNull();
    expect(screen.queryByText(/Each upstream uses its own declared grammar/)).toBeNull();
    const payload = await save(onSaved);
    expect(payload.steps).not.toHaveProperty("thinkingFormat");
    expect(payload.steps.thinkingProcessing).toBe(false);
  });

  it("shows only translation targets when enabled and remembers the target across off/on", () => {
    renderEditor();
    expandAdvanced();
    fireEvent.click(thinkingSwitch());
    const target = screen.getByRole("combobox", { name: "Translate to" }) as HTMLSelectElement;
    const thinkingSection = screen.getByRole("heading", { name: "Thinking", exact: true }).closest("section")!;
    expect(thinkingSection.className).toBe("rounded-lg border border-ink-700");
    expect(target.value).toBe("reasoning_content");
    expect([...target.options].map(option => option.value)).toEqual(["reasoning_content", "reasoning", "think_tags", "none"]);
    fireEvent.change(target, { target: { value: "think_tags" } });
    fireEvent.click(thinkingSwitch());
    expect(screen.queryByRole("combobox", { name: "Translate to" })).toBeNull();
    expect(rawDefinition().definition).not.toHaveProperty("thinkingFormat");
    fireEvent.click(screen.getByRole("button", { name: "Visual editor" }));
    fireEvent.click(thinkingSwitch());
    fireEvent.change(screen.getByRole("combobox", { name: "Translate to" }), { target: { value: "think_tags" } });
    fireEvent.click(thinkingSwitch());
    fireEvent.click(thinkingSwitch());
    expect((screen.getByRole("combobox", { name: "Translate to" }) as HTMLSelectElement).value).toBe("think_tags");
    const enabled = rawDefinition().definition;
    expect(enabled.thinkingFormat).toBe("think_tags");
    expect(enabled.thinkingProcessing).toBe(true);
    expect(screen.queryByRole("switch", { name: "Thinking format" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Advanced(?: Configured)?$/ })).toBeNull();
  });

  it.each(["reasoning_content", "reasoning", "think_tags", "none"] as const)("loads and preserves existing %s translation while collapsed", async thinkingFormat => {
    const { onSaved } = renderEditor({ ...service, steps: { ...service.steps, thinkingFormat } });
    expect(advancedButton().getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Configured", { exact: true })).toBeTruthy();
    expandAdvanced();
    expect(thinkingSwitch().getAttribute("aria-checked")).toBe("true");
    expect((screen.getByRole("combobox", { name: "Translate to" }) as HTMLSelectElement).value).toBe(thinkingFormat);
    fireEvent.click(advancedButton());
    expect((await save(onSaved)).steps.thinkingFormat).toBe(thinkingFormat);
  });

  it("maps explicit original in raw JSON to off and active formats to on", () => {
    renderEditor();
    const { textarea, definition } = rawDefinition();
    fireEvent.change(textarea, { target: { value: JSON.stringify({ ...definition, thinkingProcessing: true, thinkingFormat: "reasoning" }) } });
    fireEvent.click(screen.getByRole("button", { name: "Visual editor" }));
    expandAdvanced();
    expect(thinkingSwitch().getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("Translate to") as HTMLSelectElement).value).toBe("reasoning");
    const raw = rawDefinition();
    fireEvent.change(raw.textarea, { target: { value: JSON.stringify({ ...raw.definition, thinkingProcessing: false, thinkingFormat: "original" }) } });
    fireEvent.click(screen.getByRole("button", { name: "Visual editor" }));
    expect(thinkingSwitch().getAttribute("aria-checked")).toBe("false");
    expect(rawDefinition().definition).not.toHaveProperty("thinkingFormat");
  });

  it("hides all parser options when off, preserves their settings, and saves the runtime bypass", async () => {
    const steps: ServiceSteps = {
      timeoutMs: 60000, thinkingFormat: "reasoning",
      steps: [
        { model: "chat-model", provider: "primary", thinkingParser: { mode: "custom", delimiters: { open: "[start]", close: "[end]" }, unterminated: "reasoning" } },
        { model: "chat-model", provider: "fallback", thinkingParser: { mode: "think_tags", unterminated: "error" } },
      ],
    };
    const { onSaved } = renderEditor({ ...service, steps });
    expandAdvanced();
    const decoders = screen.getAllByRole("combobox", { name: "Upstream thinking decoder" });
    expect(decoders.map(element => (element as HTMLSelectElement).value)).toEqual(["custom", "think_tags"]);
    fireEvent.click(thinkingSwitch());
    expect(screen.queryByRole("combobox", { name: "Upstream thinking decoder" })).toBeNull();
    expect(screen.queryByText("If the block does not close", { exact: true })).toBeNull();
    expect(screen.queryByText(/Each upstream uses its own declared grammar/)).toBeNull();
    fireEvent.click(thinkingSwitch());
    expect(screen.getAllByRole("combobox", { name: "Upstream thinking decoder" }).map(element => (element as HTMLSelectElement).value)).toEqual(["custom", "think_tags"]);
    fireEvent.click(thinkingSwitch());
    fireEvent.click(advancedButton());
    const payload = await save(onSaved);
    expect(payload.steps).not.toHaveProperty("thinkingFormat");
    expect(payload.steps.thinkingProcessing).toBe(false);
    expect(payload.steps.steps[0].thinkingParser).toEqual(steps.steps[0].thinkingParser);
    expect(payload.steps.steps[1].thinkingParser).toEqual(steps.steps[1].thinkingParser);
  });

  it("reloads an explicitly disabled service with saved parsers and a stale active format as off", () => {
    renderEditor({ ...service, steps: { ...service.steps, thinkingProcessing: false, thinkingFormat: "none" } });
    expandAdvanced();
    expect(thinkingSwitch().getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("combobox", { name: "Upstream thinking decoder" })).toBeNull();
    const raw = rawDefinition();
    expect(raw.definition.thinkingProcessing).toBe(false);
    expect(raw.definition).not.toHaveProperty("thinkingFormat");
    fireEvent.change(raw.textarea, { target: { value: JSON.stringify({ ...raw.definition, thinkingProcessing: true, thinkingFormat: "reasoning" }) } });
    fireEvent.click(screen.getByRole("button", { name: "Visual editor" }));
    expect(thinkingSwitch().getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("combobox", { name: "Upstream thinking decoder" })).toBeTruthy();
  });

  it.each([false, true])("preserves legacy decoder-only configuration with original presentation (explicit on=%s)", async explicit => {
    const legacy: ModelService = { ...service, steps: { ...service.steps,
      ...(explicit ? { thinkingProcessing: true, thinkingFormat: "original" as const } : {}),
      steps: [{ model: "chat-model", provider: "primary", thinkingParser: { mode: "think_tags" } }],
    } };
    const { onSaved } = renderEditor(legacy);
    expandAdvanced();
    expect(thinkingSwitch().getAttribute("aria-checked")).toBe("true");
    expect((screen.getByRole("combobox", { name: "Translate to" }) as HTMLSelectElement).value).toBe("original");
    const payload = await save(onSaved);
    expect(payload.steps.thinkingProcessing).toBe(true);
    expect(payload.steps).not.toHaveProperty("thinkingFormat");
    expect(payload.steps.steps).toEqual((legacy.steps as ServiceSteps).steps);
  });

  it("preserves decoders reached through legacy nested-agent references", async () => {
    const decoderService: ModelService = { ...service, steps: { ...service.steps,
      steps: [{ model: "chat-model", provider: "primary", thinkingParser: { mode: "think_tags" } }],
    } };
    const nested: ModelService = { ...agent, id: 3, name: "nested-agent" };
    const parent: ModelService = { ...agent, steps: { kind: "micro_agent", timeoutMs: 60000,
      stages: [{ name: "main", service: nested.name, input: [] }],
    } };
    const { onSaved } = renderEditor(parent, [decoderService, nested, parent]);
    expandAdvanced();
    expect(thinkingSwitch().getAttribute("aria-checked")).toBe("true");
    expect((screen.getByRole("combobox", { name: "Translate to" }) as HTMLSelectElement).value).toBe("original");
    const payload = await save(onSaved);
    expect(payload.steps.thinkingProcessing).toBe(true);
    expect(payload.steps).not.toHaveProperty("thinkingFormat");
  });

  it("preserves hosted tool bindings and attachment budget after collapsing", async () => {
    const { onSaved } = renderEditor();
    expandAdvanced();
    fireEvent.click(await screen.findByRole("checkbox", { name: "demo_lookup" }));
    fireEvent.change(screen.getByLabelText("Streaming delivery"), { target: { value: "final" } });
    fireEvent.change(screen.getByLabelText("Attachment inlining budget (MiB)"), { target: { value: "24" } });
    fireEvent.click(advancedButton());
    expandAdvanced();
    expect((screen.getByLabelText("Attachment inlining budget (MiB)") as HTMLInputElement).value).toBe("24");
    expect((screen.getByRole("checkbox", { name: "demo_lookup" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(advancedButton());
    expect(await save(onSaved)).toMatchObject({ toolIds: [tool.id], steps: { maxAttachmentBytes: 24 * 1024 * 1024, hostedTools: { streamMode: "final", maxRounds: 8, maxCalls: 16 } } });
  });

  it("resets the section and translation state when opening another service", () => {
    const { rerender } = renderEditor({ ...service, steps: { ...service.steps, thinkingFormat: "none" } });
    expandAdvanced();
    rerender(agent);
    expect(advancedButton().getAttribute("aria-expanded")).toBe("false");
    expandAdvanced();
    expect(thinkingSwitch().getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByLabelText("Translate to")).toBeNull();
  });

  it("localizes the new section and translation controls in Chinese", async () => {
    language = "zh";
    localStorage.setItem("hydrogen.ui_language", "zh");
    renderEditor();
    fireEvent.click(await screen.findByRole("button", { name: "高级设置", exact: true }));
    const toggle = screen.getByRole("switch", { name: "思考格式" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect((screen.getByRole("combobox", { name: "转换为" }) as HTMLSelectElement).value).toBe("reasoning_content");
    expect(screen.getByRole("combobox", { name: "上游思考解码器" })).toBeTruthy();
    expect(screen.getByLabelText("附件内联上限（MiB）")).toBeTruthy();
  });
});
