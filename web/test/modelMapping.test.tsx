import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Models } from "../src/pages/Models";
import { I18nProvider } from "../src/lib/i18n";
import type { Mapping, Model, Provider } from "../src/types";

const success = vi.fn(), error = vi.fn();
vi.mock("../src/components/Toast", () => ({ useToast: () => ({ success, error }) }));
const model: Model = { id: 1, name: "stable-model", description: null, enabled: true, createdAt: 0 };
const provider: Provider = { id: 2, name: "stable-provider", type: "openai_completion", baseUrl: "http://mock/v1", hasKey: false,
  extraHeaders: null, maxOutputTokens: null, enabled: true, createdAt: 0,
  altEndpoints: [{ type: "anthropic", baseUrl: "http://mock/anthropic" }],
};
const original: Mapping & { families: string[] } = { id: 17, modelId: 1, providerId: 2, upstreamModel: "old-unlisted-id", priority: 4, enabled: true, families: ["anthropic"] };
const serviceDefinition = { timeoutMs: 60000, steps: [{ model: model.name, provider: provider.name }] };
let mapping: Mapping & { families: string[] };
let requests: Array<{ path: string; method: string; body?: any }>;
let failSave: boolean;
const fetchMock = vi.fn(async (path: string, init: RequestInit = {}) => {
  const method = init.method ?? "GET", body = init.body ? JSON.parse(String(init.body)) : undefined;
  requests.push({ path, method, body });
  let response: unknown;
  if (path === "/admin/api/settings/ui-language") response = { language: "en" };
  else if (path === "/admin/api/models") response = { models: [model] };
  else if (path === "/admin/api/providers") response = { providers: [provider] };
  else if (path === "/admin/api/mappings" && method === "GET") response = { mappings: [mapping] };
  else if (path === "/admin/api/provider-models") response = { providerModels: [{ providerId: provider.id, models: ["listed-new-id"], fetchedAt: 1 }] };
  else if (path === "/admin/api/mappings/17" && method === "PATCH") {
    if (failSave) return new Response(JSON.stringify({ error: "Update rejected" }), { status: 400 });
    mapping = { ...mapping, ...body }; response = { mapping };
  } else if (path === "/admin/api/mappings" && method === "POST") response = { mapping: { id: 18, ...body } };
  else throw new Error(`Unexpected request: ${method} ${path}`);
  return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
});
beforeEach(() => { mapping = { ...original, families: [...original.families] }; requests = []; failSave = false; localStorage.clear(); vi.clearAllMocks(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function openEdit() {
  render(<I18nProvider><Models /></I18nProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Edit", exact: true }));
  await screen.findByRole("heading", { name: "Edit mapping", exact: true });
}
const mutations = () => requests.filter(request => request.method !== "GET");

describe("in-place model mapping editing", () => {
  it("updates the same mapping while preserving model/provider references and format allowlist", async () => {
    const originalService = JSON.parse(JSON.stringify(serviceDefinition));
    await openEdit();
    const modelField = screen.getByLabelText("Model", { exact: true }) as HTMLInputElement;
    const providerField = screen.getByLabelText("Provider", { exact: true }) as HTMLInputElement;
    expect(modelField.value).toBe(model.name); expect(modelField.readOnly).toBe(true);
    expect(providerField.value).toBe(provider.name); expect(providerField.readOnly).toBe(true);
    expect((screen.getByLabelText("Upstream model id") as HTMLInputElement).value).toBe("old-unlisted-id");
    fireEvent.change(screen.getByLabelText("Upstream model id"), { target: { value: "new-custom-id" } });
    fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "-2" } });
    fireEvent.click(screen.getByRole("switch", { name: "Mapping enabled" }));
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    await waitFor(() => expect(success).toHaveBeenCalledWith("Mapping updated"));
    expect(mutations()).toEqual([{ path: "/admin/api/mappings/17", method: "PATCH", body: { upstreamModel: "new-custom-id", priority: -2, enabled: false } }]);
    expect(mapping).toEqual({ ...original, upstreamModel: "new-custom-id", priority: -2, enabled: false });
    expect(serviceDefinition).toEqual(originalService);
    expect(requests.some(request => request.path.includes("/services") || request.method === "DELETE")).toBe(false);
    await screen.findByText("new-custom-id", { exact: true });
  });

  it("can save the existing upstream id even when it is missing from discovery", async () => {
    await openEdit();
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    await waitFor(() => expect(success).toHaveBeenCalledOnce());
    expect(mutations()[0].body.upstreamModel).toBe(original.upstreamModel);
  });

  it("cancels without mutating or recreating a mapping", async () => {
    await openEdit();
    fireEvent.change(screen.getByLabelText("Upstream model id"), { target: { value: "unsaved" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
    expect(screen.queryByRole("heading", { name: "Edit mapping" })).toBeNull();
    expect(mutations()).toHaveLength(0);
    expect(mapping).toEqual(original);
  });

  it("keeps the editor and inputs after a failed patch", async () => {
    failSave = true; await openEdit();
    fireEvent.change(screen.getByLabelText("Upstream model id"), { target: { value: "new-id" } });
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    await screen.findByText("Update rejected");
    expect(screen.getByRole("heading", { name: "Edit mapping" })).toBeTruthy();
    expect((screen.getByLabelText("Upstream model id") as HTMLInputElement).value).toBe("new-id");
    expect(mapping).toEqual(original);
  });

  it("rejects fractional priority and blank upstream names locally", async () => {
    await openEdit();
    fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    expect(screen.getByText("Enter a whole number.")).toBeTruthy();
    expect(mutations()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Upstream model id"), { target: { value: "   " } });
    expect((screen.getByRole("button", { name: "Save", exact: true }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps new-mapping creation as POST rather than PATCH", async () => {
    render(<I18nProvider><Models /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Map provider", exact: true }));
    expect(screen.getByRole("heading", { name: "Map provider", exact: true })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Upstream model id"), { target: { value: "another-upstream" } });
    fireEvent.click(screen.getByRole("button", { name: "Add", exact: true }));
    await waitFor(() => expect(success).toHaveBeenCalledWith("Provider mapped"));
    expect(mutations()[0]).toEqual({ path: "/admin/api/mappings", method: "POST", body: { modelId: 1, providerId: 2, upstreamModel: "another-upstream", families: null } });
  });
});
