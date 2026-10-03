import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceEditor } from "../src/components/ServiceEditor";
import { HostedToolBinding } from "../src/components/HostedToolBinding";
import { I18nProvider } from "../src/lib/i18n";
import type { HostedTool, Mapping, Model, ModelService, Provider, ServiceSteps } from "../src/types";

vi.mock("../src/auth", () => ({ useAuth: () => ({ user: { id: 1, role: "admin" } }) }));
const toastError = vi.fn();
vi.mock("../src/components/Toast", () => ({ useToast: () => ({ success: vi.fn(), error: toastError }) }));
const service: ModelService = {
  id: 1, name: "policy-service", description: null, enabled: true, summary: "", createdAt: 0, toolIds: [],
  steps: { timeoutMs: 60000, steps: [{ model: "model", provider: "provider" }] },
};
const models: Model[] = [{ id: 1, name: "model", description: null, enabled: true, createdAt: 0 }];
const providers: Provider[] = [{ id: 1, name: "provider", type: "anthropic", baseUrl: "http://localhost:8791", hasKey: false,
  extraHeaders: null, maxOutputTokens: null, enabled: true, createdAt: 0 }];
const mappings: Mapping[] = [{ id: 1, modelId: 1, providerId: 1, upstreamModel: "fixture", priority: 0, enabled: true }];
const tool: HostedTool = {
  id: 3, name: "local_lookup", description: "Fixture", parameters: { type: "object" }, url: "http://localhost:8791/tool",
  bodyTemplate: {}, resultPath: "", timeoutMs: 5000, maxResultBytes: 1024, enabled: true, headerNames: [], hasHeaders: false,
  serverTool: { name: "private_search", resultType: "web_search_result", resultPath: "" },
};
let tools: HostedTool[];
let language: "en" | "zh";
let saved: { steps: ServiceSteps; toolIds: number[] } | undefined;
const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
  let result: unknown;
  if (url === "/admin/api/settings/ui-language") result = { language };
  else if (url === "/admin/api/tools") result = { tools };
  else if (url === "/admin/api/services/1") { saved = JSON.parse(String(init.body)); result = {}; }
  else throw new Error(`Unexpected request: ${url}`);
  return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
});
beforeEach(() => { tools = []; language = "en"; saved = undefined; localStorage.clear(); vi.clearAllMocks(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function editor(value = service, expandService = true) {
  const onSaved = vi.fn();
  render(<I18nProvider><ServiceEditor open service={value} services={[service]} models={models} providers={providers} mappings={mappings} onSaved={onSaved} onClose={vi.fn()} /></I18nProvider>);
  if (expandService) fireEvent.click(screen.getByRole("button", { name: /^Advanced(?: Configured)?$/ }));
  return onSaved;
}
const base = () => within(screen.getByRole("group", { name: "Service policy" }));
const upstream = () => within(screen.getByRole("group", { name: "Upstream step 1 policy" }));
const stepAdvanced = (n = 1) => screen.getByRole("button", { name: new RegExp(`^Upstream step ${n} Advanced \\(overrides, server-tool policy\\)(?: Configured)?$`) });
const expandStep = (n = 1) => fireEvent.click(stepAdvanced(n));
const rawInput = () => screen.getAllByRole("textbox").find(element => element.tagName === "TEXTAREA") as HTMLTextAreaElement;
async function save(onSaved: ReturnType<typeof vi.fn>) {
  fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  return saved!;
}

describe("Model Service policy editor", () => {
  it("keeps each step policy collapsed and discoverable independently of service Advanced", async () => {
    const onSaved = editor(service, false);
    const serviceAdvanced = screen.getByRole("button", { name: "Advanced", exact: true });
    expect(serviceAdvanced.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("group", { name: "Service policy" })).toBeNull();
    expect(stepAdvanced().getAttribute("aria-expanded")).toBe("false");
    const stepContentId = stepAdvanced().getAttribute("aria-controls")!;
    expect(document.getElementById(stepContentId)).toBeNull();
    expect(screen.queryByRole("group", { name: "Upstream step 1 policy" })).toBeNull();
    expandStep();
    expect(stepAdvanced().getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(stepContentId)).toBeTruthy();
    expect((upstream().getByRole("combobox", { name: "Policy mode" }) as HTMLSelectElement).value).toBe("inherit");
    expect(upstream().getByText("Using service blacklist: empty list.")).toBeTruthy();
    expect(serviceAdvanced.getAttribute("aria-expanded")).toBe("false");
    expandStep();
    expect(screen.queryByRole("group", { name: "Upstream step 1 policy" })).toBeNull();
    const payload = await save(onSaved);
    expect(payload.steps).not.toHaveProperty("serverToolPolicy");
    expect(payload.steps.steps[0]).not.toHaveProperty("serverToolPolicy");
  });

  it("keeps independent policy controls and configured indicators on each upstream step", async () => {
    const onSaved = editor({ ...service, steps: { timeoutMs: 60000, steps: [
      { model: "model", provider: "provider" },
      { model: "model", provider: "provider", serverToolPolicy: { mode: "whitelist", names: [] } },
    ] } }, false);
    expect(stepAdvanced(1).textContent).not.toContain("Configured");
    expect(stepAdvanced(2).textContent).toContain("Configured");
    expect(screen.queryByRole("group", { name: "Upstream step 2 policy" })).toBeNull();
    expandStep(2);
    const second = within(screen.getByRole("group", { name: "Upstream step 2 policy" }));
    expect((second.getByRole("combobox", { name: "Policy mode" }) as HTMLSelectElement).value).toBe("whitelist");
    expect(screen.queryByRole("group", { name: "Upstream step 1 policy" })).toBeNull();
    fireEvent.click(second.getByRole("button", { name: "Add web_search", exact: true }));
    const payload = await save(onSaved);
    expect(payload.steps.steps[0]).not.toHaveProperty("serverToolPolicy");
    expect(payload.steps.steps[1].serverToolPolicy).toEqual({ mode: "whitelist", names: ["web_search"] });
  });

  it("shows policy and searchable known names without any local tools or bindings", async () => {
    const onSaved = editor();
    expect(screen.queryByRole("group", { name: "Upstream step 1 policy" })).toBeNull();
    expandStep();
    expect((base().getByRole("combobox", { name: "Policy mode" }) as HTMLSelectElement).value).toBe("blacklist");
    expect((upstream().getByRole("combobox", { name: "Policy mode" }) as HTMLSelectElement).value).toBe("inherit");
    expect(screen.getByText(/Bindings describe tool availability/)).toBeTruthy();
    expect(screen.queryByText(/supplied automatically/)).toBeNull();
    fireEvent.change(base().getByRole("searchbox"), { target: { value: "web_" } });
    expect(base().getByRole("button", { name: "Add web_search", exact: true })).toBeTruthy();
    expect(base().queryByRole("button", { name: "Add code_interpreter", exact: true })).toBeNull();
    fireEvent.click(base().getByRole("button", { name: "Add web_search", exact: true }));
    const payload = await save(onSaved);
    expect(payload.steps.serverToolPolicy).toEqual({ mode: "blacklist", names: ["web_search"] });
    expect(payload.steps.steps[0]).not.toHaveProperty("serverToolPolicy");
    expect(payload.toolIds).toEqual([]);
  });

  it("keeps default absence when the policy is untouched", async () => {
    const onSaved = editor();
    const payload = await save(onSaved);
    expect(payload.steps).not.toHaveProperty("serverToolPolicy");
    expect(payload.steps.steps[0]).not.toHaveProperty("serverToolPolicy");
  });

  it.each(["blacklist", "whitelist"])("saves explicit empty %s as a whole upstream override", async mode => {
    const onSaved = editor({ ...service, steps: { ...service.steps,
      serverToolPolicy: { mode: "whitelist", names: ["web_search", "file_search"] },
    } });
    expandStep();
    fireEvent.change(upstream().getByRole("combobox", { name: "Policy mode" }), { target: { value: mode } });
    expect(upstream().getByText(/replaces the entire service policy, including an empty list/)).toBeTruthy();
    const payload = await save(onSaved);
    expect(payload.steps.serverToolPolicy).toEqual({ mode: "whitelist", names: ["web_search", "file_search"] });
    expect(payload.steps.steps[0].serverToolPolicy).toEqual({ mode, names: [] });
    cleanup();
    const reopened = editor({ ...service, steps: payload.steps });
    expect(stepAdvanced().textContent).toContain("Configured");
    expect(stepAdvanced().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("group", { name: "Upstream step 1 policy" })).toBeNull();
    expandStep();
    expect((upstream().getByRole("combobox", { name: "Policy mode" }) as HTMLSelectElement).value).toBe(mode);
    fireEvent.click(screen.getByRole("button", { name: "Raw JSON" }));
    expect(JSON.parse(rawInput().value).steps[0].serverToolPolicy).toEqual({ mode, names: [] });
    fireEvent.click(screen.getByRole("button", { name: "Visual editor" }));
    expandStep();
    expect((await save(reopened)).steps.steps[0].serverToolPolicy).toEqual({ mode, names: [] });
  });

  it("preserves loaded policies and explicit empty override through raw/visual transitions", async () => {
    const definition: ServiceSteps = { timeoutMs: 60000, serverToolPolicy: { mode: "whitelist", names: ["Web_Search"] },
      steps: [{ model: "model", provider: "provider", serverToolPolicy: { mode: "blacklist", names: [] } }] };
    const onSaved = editor({ ...service, steps: definition });
    expandStep();
    fireEvent.click(screen.getByRole("button", { name: "Raw JSON" }));
    const raw = rawInput();
    const parsed = JSON.parse(raw.value);
    expect(parsed.serverToolPolicy).toEqual(definition.serverToolPolicy);
    expect(parsed.steps[0].serverToolPolicy).toEqual({ mode: "blacklist", names: [] });
    fireEvent.click(screen.getByRole("button", { name: "Visual editor" }));
    expect(stepAdvanced().getAttribute("aria-expanded")).toBe("false");
    expandStep();
    expect((upstream().getByRole("combobox", { name: "Policy mode" }) as HTMLSelectElement).value).toBe("blacklist");
    expect((await save(onSaved)).steps.steps[0].serverToolPolicy).toEqual({ mode: "blacklist", names: [] });
  });

  it("removes a saved override when the operator selects inheritance", async () => {
    const onSaved = editor({ ...service, steps: { ...service.steps, steps: [
      { model: "model", provider: "provider", serverToolPolicy: { mode: "whitelist", names: [] } },
    ] } });
    expect(stepAdvanced().textContent).toContain("Configured");
    expandStep();
    fireEvent.change(upstream().getByRole("combobox", { name: "Policy mode" }), { target: { value: "inherit" } });
    expect(upstream().queryByRole("searchbox")).toBeNull();
    expect(stepAdvanced().textContent).not.toContain("Configured");
    const payload = await save(onSaved);
    expect(payload.steps.steps[0]).not.toHaveProperty("serverToolPolicy");
    cleanup();
    const reopened = editor({ ...service, steps: payload.steps });
    expect(stepAdvanced().textContent).not.toContain("Configured");
    expandStep();
    expect((upstream().getByRole("combobox", { name: "Policy mode" }) as HTMLSelectElement).value).toBe("inherit");
    fireEvent.click(screen.getByRole("button", { name: "Raw JSON" }));
    expect(JSON.parse(rawInput().value).steps[0]).not.toHaveProperty("serverToolPolicy");
    fireEvent.click(screen.getByRole("button", { name: "Visual editor" }));
    expect((await save(reopened)).steps.steps[0]).not.toHaveProperty("serverToolPolicy");
  });

  it("adds exact custom names, rejects qualifiers, and recovers by correcting the input", async () => {
    const onSaved = editor();
    const search = base().getByRole("searchbox");
    fireEvent.change(search, { target: { value: "anthropic:web_search" } });
    fireEvent.click(base().getByRole("button", { name: "Add name" }));
    expect(base().getByRole("alert").textContent).toMatch(/exact tool name/);
    for (const name of ["Web_Search", "web_search"]) {
      fireEvent.change(search, { target: { value: name } });
      fireEvent.keyDown(search, { key: "Enter" });
    }
    expect(base().queryByRole("alert")).toBeNull();
    expect((await save(onSaved)).steps.serverToolPolicy).toEqual({ mode: "blacklist", names: ["Web_Search", "web_search"] });
  });

  it("uses custom known declaration names from the catalog without requiring a binding", async () => {
    tools = [tool];
    const onSaved = editor();
    await screen.findByRole("checkbox", { name: "local_lookup" });
    fireEvent.change(base().getByRole("searchbox"), { target: { value: "private" } });
    fireEvent.click(base().getByRole("button", { name: "Add private_search" }));
    const payload = await save(onSaved);
    expect(payload.steps.serverToolPolicy?.names).toEqual(["private_search"]);
    expect(payload.toolIds).toEqual([]);
  });

  const malformedPolicies: [string, unknown][] = [
    ["null policy", null],
    ["missing names", { mode: "blacklist" }],
    ["null names", { mode: "blacklist", names: null }],
    ["string names", { mode: "blacklist", names: "web_search" }],
    ["object names", { mode: "blacklist", names: {} }],
    ["non-string name", { mode: "blacklist", names: [7] }],
    ["unknown mode", { mode: "allow", names: [] }],
    ["missing mode", { names: [] }],
    ["qualified name", { mode: "blacklist", names: ["anthropic:web_search"] }],
  ];
  for (const location of ["root", "step"] as const) {
    it.each(malformedPolicies)(`retains raw text and recovers after correcting a ${location} policy with %s`, async (_label, invalid) => {
      const onSaved = editor();
      expandStep();
      fireEvent.click(screen.getByRole("button", { name: "Raw JSON" }));
      const raw = rawInput();
      const parsed = JSON.parse(raw.value);
      const policyOwner = location === "root" ? parsed : parsed.steps[0];
      policyOwner.serverToolPolicy = invalid;
      const invalidText = JSON.stringify(parsed);
      fireEvent.change(raw, { target: { value: invalidText } });
      fireEvent.click(screen.getByRole("button", { name: "Visual editor" }));
      expect(screen.getByRole("button", { name: "Visual editor" })).toBeTruthy();
      expect(rawInput().value).toBe(invalidText);
      expect(screen.queryByRole("group", { name: "Service policy" })).toBeNull();
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/serverToolPolicy.*mode.*names array/));
      expect(fetchMock.mock.calls.some(([url]) => url === "/admin/api/services/1")).toBe(false);

      policyOwner.serverToolPolicy = { mode: "blacklist", names: [] };
      fireEvent.change(rawInput(), { target: { value: JSON.stringify(parsed) } });
      fireEvent.click(screen.getByRole("button", { name: "Visual editor" }));
      expect(screen.queryByRole("button", { name: "Visual editor" })).toBeNull();
      expect((base().getByRole("combobox", { name: "Policy mode" }) as HTMLSelectElement).value).toBe("blacklist");
      expandStep();
      expect((upstream().getByRole("combobox", { name: "Policy mode" }) as HTMLSelectElement).value).toBe(location === "root" ? "inherit" : "blacklist");
      const payload = await save(onSaved);
      expect(location === "root" ? payload.steps.serverToolPolicy : payload.steps.steps[0].serverToolPolicy).toEqual({ mode: "blacklist", names: [] });
    });
  }

  it("keeps the declaration-only binding explanation localized in Chinese", async () => {
    language = "zh";
    render(<I18nProvider><HostedToolBinding tools={[]} ids={[]} config={{ streamMode: "progress", maxRounds: 8, maxCalls: 16 }} onIds={vi.fn()} onConfig={vi.fn()} /></I18nProvider>);
    expect(await screen.findByText(/绑定仅表示工具可用。客户端必须声明每个服务器工具/)).toBeTruthy();
    expect(screen.queryByText(/Bindings describe tool availability/)).toBeNull();
  });

  it("never renders policy controls in a Micro Agent or its stage editor", () => {
    editor({ ...service, steps: { kind: "micro_agent", timeoutMs: 60000, stages: [{ name: "main", service: service.name, input: [] }] } });
    expect(screen.queryByRole("heading", { name: "Upstream server-tool policy" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Service policy" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Policy mode" })).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it.each(["root", "stage"])("retains raw text rather than dropping a forbidden Micro Agent %s policy", location => {
    editor({ ...service, steps: { kind: "micro_agent", timeoutMs: 60000, stages: [{ name: "main", service: service.name, input: [] }] } });
    fireEvent.click(screen.getByRole("button", { name: "Raw JSON" }));
    const raw = screen.getAllByRole("textbox").find(element => element.tagName === "TEXTAREA") as HTMLTextAreaElement;
    const parsed = JSON.parse(raw.value);
    if (location === "root") parsed.serverToolPolicy = { mode: "whitelist", names: [] };
    else parsed.stages[0].serverToolPolicy = { mode: "whitelist", names: [] };
    const value = JSON.stringify(parsed);
    fireEvent.change(raw, { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Visual editor" }));
    expect(screen.getByRole("button", { name: "Visual editor" })).toBeTruthy();
    expect(raw.value).toBe(value);
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/referenced Model Service/));
  });
});
