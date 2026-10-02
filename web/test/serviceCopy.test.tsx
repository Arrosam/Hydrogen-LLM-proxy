import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelServices } from "../src/pages/ModelServices";
import { I18nProvider } from "../src/lib/i18n";
import type { ModelService } from "../src/types";

let role = "admin";
const success = vi.fn(), error = vi.fn();
vi.mock("../src/auth", () => ({ useAuth: () => ({ user: { id: 1, role } }) }));
vi.mock("../src/components/Toast", () => ({ useToast: () => ({ success, error }) }));
vi.mock("../src/components/ServiceEditor", () => ({ ServiceEditor: () => null }));

const service: ModelService = {
  id: 1, name: "chat", description: "A fallback service", enabled: false, summary: "try m@p", createdAt: 0, toolIds: [7],
  steps: { timeoutMs: 60000, thinkingProcessing: true, thinkingFormat: "reasoning", maxAttachmentBytes: 20971520,
    hostedTools: { streamMode: "final", maxRounds: 3, maxCalls: 6 },
    steps: [{ model: "m", provider: "p", thinkingParser: { mode: "custom", delimiters: { open: "[think]", close: "[/think]" }, unterminated: "reasoning" },
      overrides: { temperature: 0.3, extra: { vendor_setting: "kept" } }, retry: { on: [429, "timeout"], maxAttempts: 2, intervalMs: 100 } }],
  },
};
const agent: ModelService = { ...service, id: 2, name: "agent", enabled: true, steps: { kind: "micro_agent", timeoutMs: 12000, thinkingProcessing: false,
  stages: [{ name: "main", service: "chat", input: [{ kind: "last_user" }], transitions: [{ when: { type: "always" }, goto: "end", output: "main" }] }],
  ocr: { service: "ocr", timeoutMs: 5000 }, asr: { service: "speech" }, output: "main", hostedTools: { streamMode: "progress", maxRounds: 8, maxCalls: 16 },
} };
let services: ModelService[];
let requests: Array<{ path: string; method: string; body: any }>;
let failure: boolean;
const fetchMock = vi.fn(async (path: string, init: RequestInit = {}) => {
  const method = init.method ?? "GET", body = init.body ? JSON.parse(String(init.body)) : undefined;
  requests.push({ path, method, body });
  let response: unknown;
  if (path === "/admin/api/settings/ui-language") response = { language: "en" };
  else if (path === "/admin/api/services" && method === "POST") {
    if (failure) return new Response(JSON.stringify({ error: "Unable to copy this definition" }), { status: 400 });
    const created = { ...service, ...body, id: 20, createdAt: 1 };
    services = [...services, created]; response = { service: created };
  } else if (path === "/admin/api/services") response = { services };
  else if (path === "/admin/api/models") response = { models: [] };
  else if (path === "/admin/api/providers") response = { providers: [] };
  else if (path === "/admin/api/mappings") response = { mappings: [] };
  else throw new Error(`Unexpected request: ${method} ${path}`);
  return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
});
beforeEach(() => { role = "admin"; failure = false; requests = []; services = [service, agent]; localStorage.clear(); vi.clearAllMocks(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function open(kind: "resilience" | "chain" = "resilience") {
  render(<I18nProvider><ModelServices kind={kind} /></I18nProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Copy", exact: true }));
}
const posts = () => requests.filter(request => request.method === "POST");

describe("Model Service and Micro Agent copies", () => {
  it.each([["resilience", service], ["chain", agent]] as const)("copies %s without altering its source definition or references", async (kind, source) => {
    const original = JSON.parse(JSON.stringify(source));
    await open(kind);
    expect((screen.getByLabelText("Name (exposed model name)") as HTMLInputElement).value).toBe(`${source.name}-copy`);
    expect(posts()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Name (exposed model name)"), { target: { value: `${source.name}-clone` } });
    const modal = screen.getByRole("heading", { name: `Copy "${source.name}"` }).closest(".card")!;
    fireEvent.click(within(modal).getByRole("button", { name: "Copy", exact: true }));
    await waitFor(() => expect(success).toHaveBeenCalledOnce());
    expect(posts()[0]).toEqual({ path: "/admin/api/services", method: "POST", body: { name: `${source.name}-clone`, description: source.description,
      enabled: source.enabled, steps: source.steps, toolIds: [7] } });
    expect(source).toEqual(original);
    expect(requests.some(request => ["DELETE", "PATCH"].includes(request.method))).toBe(false);
    await screen.findByText(`${source.name}-clone`, { exact: true });
  });

  it("chooses a free copy name and rejects duplicate names without a request", async () => {
    services.push({ ...service, id: 3, name: "chat-copy" }, { ...service, id: 4, name: "chat-copy-2" });
    render(<I18nProvider><ModelServices /></I18nProvider>);
    fireEvent.click((await screen.findAllByRole("button", { name: "Copy", exact: true }))[0]);
    expect((screen.getByLabelText("Name (exposed model name)") as HTMLInputElement).value).toBe("chat-copy-3");
    fireEvent.change(screen.getByLabelText("Name (exposed model name)"), { target: { value: "chat" } });
    const modal = screen.getByRole("heading", { name: 'Copy "chat"' }).closest(".card")!;
    fireEvent.click(within(modal).getByRole("button", { name: "Copy", exact: true }));
    expect(screen.getByText("A service with this name already exists.")).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it("cancels without creating anything", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
    expect(screen.queryByRole("heading", { name: 'Copy "chat"' })).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it("keeps the name and modal open when copying fails", async () => {
    failure = true; await open();
    const modal = screen.getByRole("heading", { name: 'Copy "chat"' }).closest(".card")!;
    fireEvent.click(within(modal).getByRole("button", { name: "Copy", exact: true }));
    await screen.findByText("Unable to copy this definition");
    expect(screen.getByRole("heading", { name: 'Copy "chat"' })).toBeTruthy();
    expect((screen.getByLabelText("Name (exposed model name)") as HTMLInputElement).value).toBe("chat-copy");
  });

  it("does not send admin-only tool bindings from a non-admin copy", async () => {
    role = "user"; await open();
    expect(screen.getByText(/Only admins can copy hosted-tool bindings/)).toBeTruthy();
    const modal = screen.getByRole("heading", { name: 'Copy "chat"' }).closest(".card")!;
    fireEvent.click(within(modal).getByRole("button", { name: "Copy", exact: true }));
    await waitFor(() => expect(success).toHaveBeenCalledOnce());
    expect(posts()[0].body).not.toHaveProperty("toolIds");
    expect(posts()[0].body.steps).toEqual(service.steps);
  });
});
