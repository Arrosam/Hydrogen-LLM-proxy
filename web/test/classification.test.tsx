import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceEditor } from "../src/components/ServiceEditor";
import { I18nProvider } from "../src/lib/i18n";
import { ModelBench } from "../src/pages/ModelBench";
import type { BenchTargets, Mapping, Model, ModelService, Provider } from "../src/types";

vi.mock("../src/auth", () => ({ useAuth: () => ({ user: { id: 1, role: "admin" } }) }));
vi.mock("../src/components/Toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

const classification: ModelService = {
  id: 11, name: "semantic-router", description: null, enabled: true, summary: "", createdAt: 0,
  steps: {
    category: "classification", timeoutMs: 12000,
    steps: [
      { model: "jev", provider: "typesafe", retry: { on: [429, "network"], maxAttempts: 4, intervalMs: 50 }, advanceOn: ["exhausted"] },
      { model: "laya", provider: "local", overrides: { extra: { temperature: 0.1 } } },
    ],
  },
};
const chat: ModelService = {
  id: 12, name: "chat-service", description: null, enabled: true, summary: "", createdAt: 0,
  steps: { timeoutMs: 60000, steps: [{ model: "jev", provider: "typesafe" }] },
};
const agent: ModelService = {
  id: 13, name: "chat-agent", description: null, enabled: true, summary: "", createdAt: 0,
  steps: { kind: "micro_agent", timeoutMs: 60000, stages: [{ name: "main", service: chat.name, input: [] }] },
};
const services = [classification, chat, agent];
const models: Model[] = [
  { id: 1, name: "jev", description: null, enabled: true, createdAt: 0 },
  { id: 2, name: "laya", description: null, enabled: true, createdAt: 0 },
];
const providers: Provider[] = [
  { id: 1, name: "typesafe", type: "openai_completion", baseUrl: "https://api.typesafe.ai/v1", hasKey: true, extraHeaders: null, maxOutputTokens: null, enabled: true, createdAt: 0 },
  { id: 2, name: "local", type: "openai_completion", baseUrl: "http://localhost:8080/v1", hasKey: false, extraHeaders: null, maxOutputTokens: null, enabled: true, createdAt: 0 },
];
const mappings: Mapping[] = [
  { id: 1, modelId: 1, providerId: 1, upstreamModel: "jev-latest", priority: 0, enabled: true },
  { id: 2, modelId: 2, providerId: 2, upstreamModel: "laya", priority: 0, enabled: true },
];
const targets: BenchTargets = {
  services: [
    { id: classification.id, name: classification.name, category: "classification", kind: "model_service", enabled: true, valid: true },
    { id: chat.id, name: chat.name, category: "chat", kind: "model_service", enabled: true, valid: true },
    { id: agent.id, name: agent.name, category: "chat", kind: "micro_agent", enabled: true, valid: true },
  ],
  mappings: [{ modelId: 1, model: "jev", providerId: 1, provider: "typesafe", upstreamModel: "jev-latest", families: ["openai_completion"], enabled: true }],
};

type RequestRecord = { url: string; init: RequestInit; body?: Record<string, any> };
let requests: RequestRecord[];
let language: "en" | "zh";
const answer = { model: "jev-latest", answers: { is_urgent: { type: "noul", noul: 0.95 } } };
const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
  const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
  requests.push({ url, init, body });
  let response: unknown;
  if (url === "/admin/api/settings/ui-language") response = { language };
  else if (url === "/admin/api/tools") response = { tools: [] };
  else if (url === "/admin/api/tokens") response = { tokens: [] };
  else if (url === "/admin/api/bench/targets") response = targets;
  else if (url === "/admin/api/services" || url === `/admin/api/services/${classification.id}`) response = {};
  else if (url === "/admin/api/bench/media") response = { ok: true, status: 200, latencyMs: 10, response: answer, upstreamRequest: body?.body };
  else if (url === "/v1/systemone") response = answer;
  else throw new Error(`Unexpected request: ${url}`);
  return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
});

beforeEach(() => {
  requests = [];
  language = "en";
  localStorage.clear();
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderEditor(service: ModelService | null = null, defaultKind: "resilience" | "chain" = "resilience") {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<I18nProvider><ServiceEditor open service={service} services={services} models={models} providers={providers} mappings={mappings} defaultKind={defaultKind} onSaved={onSaved} onClose={onClose} /></I18nProvider>);
  return { onSaved, onClose };
}
function chooseClassification(label = "Semantic classification (Jev / Laya)") {
  const option = screen.getByRole("option", { name: label });
  fireEvent.change(option.parentElement!, { target: { value: "classification" } });
}
function editableBody(): HTMLTextAreaElement {
  fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
  return screen.getAllByRole("textbox").find(el => el.tagName === "TEXTAREA" && (el as HTMLTextAreaElement).value.startsWith("{")) as HTMLTextAreaElement;
}
async function renderBench() {
  render(<I18nProvider><ModelBench /></I18nProvider>);
  await waitFor(() => expect((screen.getByRole("button", { name: "Send", exact: true }) as HTMLButtonElement).disabled).toBe(false));
}

describe("classification service editor", () => {
  it("selects native classification, hides chat controls, and saves its category", async () => {
    const { onSaved, onClose } = renderEditor();
    fireEvent.change(screen.getByPlaceholderText("e.g. sonnet-any"), { target: { value: "new-classifier" } });
    chooseClassification();
    expect(screen.getByText(/Served on \/v1\/systemone using Jev/).textContent).toContain("typed questions (choice, score, noul)");
    expect(screen.getByText(/not an OpenAI chat-compatible API/).textContent).toContain("retry/fallback");
    expect(screen.queryByText("Reliable streaming", { exact: true })).toBeNull();
    expect(screen.queryByText("Thinking format", { exact: true })).toBeNull();
    expect(screen.queryByText("Upstream thinking decoder", { exact: true })).toBeNull();
    expect(screen.queryByText("Hosted server tools", { exact: true })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Raw JSON" }));
    const raw = screen.getAllByRole("textbox").find(el => el.tagName === "TEXTAREA") as HTMLTextAreaElement;
    const definition = JSON.parse(raw.value);
    expect(definition).toEqual({ category: "classification", timeoutMs: 60000, steps: [{ model: "jev", provider: "typesafe" }] });
    fireEvent.click(screen.getByRole("button", { name: "Visual editor" }));
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(onClose).toHaveBeenCalledOnce();
    const saved = requests.find(r => r.url === "/admin/api/services")!;
    expect(saved.init.method).toBe("POST");
    expect(saved.body).toEqual({ name: "new-classifier", description: null, enabled: true, toolIds: [], steps: definition });
  });

  it("loads and updates classification without losing the retry/fallback definition", async () => {
    const { onSaved } = renderEditor(classification);
    expect((screen.getByRole("option", { name: "Semantic classification (Jev / Laya)" }).parentElement as HTMLSelectElement).value).toBe("classification");
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    const saved = requests.find(r => r.url === `/admin/api/services/${classification.id}`)!;
    expect(saved.init.method).toBe("PATCH");
    expect(saved.body?.steps).toEqual(classification.steps);
  });

  it("localizes the classification label and native endpoint hint in Chinese", async () => {
    language = "zh";
    localStorage.setItem("hydrogen.ui_language", "zh");
    renderEditor();
    chooseClassification("语义分类（Jev / Laya）");
    expect(screen.getByText(/通过 \/v1\/systemone 使用 Jev/).textContent).toContain("类型化 questions（choice、score、noul）");
    expect(screen.getByText(/不是 OpenAI 对话兼容 API/).textContent).toContain("不可在微型代理中使用");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it("does not offer or implicitly select classification in a new Micro Agent stage", () => {
    renderEditor(null, "chain");
    fireEvent.click(screen.getByRole("button", { name: "Add stage", exact: true }));
    expect(screen.queryByRole("option", { name: classification.name, exact: true })).toBeNull();
    expect(screen.getByRole("option", { name: chat.name, exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Raw JSON" }));
    const raw = screen.getAllByRole("textbox").find(el => el.tagName === "TEXTAREA") as HTMLTextAreaElement;
    expect(JSON.parse(raw.value).stages[0].service).toBe(chat.name);
  });
});

describe("classification Model Bench", () => {
  it("sends native choice/score/noul defaults through the non-chat internal route", async () => {
    await renderBench();
    expect(screen.queryByText("Stream", { exact: true })).toBeNull();
    expect(screen.queryByText("System prompt", { exact: true })).toBeNull();
    expect(screen.queryByText("Model format (what the bench speaks)", { exact: true })).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    const state = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(state.value).toContain("payouts");
    fireEvent.change(state, { target: { value: "I was charged twice. Please refund me today." } });
    fireEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
    await screen.findByRole("heading", { name: "Response", exact: true });
    const sent = requests.find(r => r.url === "/admin/api/bench/media")!;
    expect(sent.body).toMatchObject({ category: "classification", target: { kind: "service", serviceId: classification.id }, timeoutMs: 300000 });
    expect(sent.body?.body).toEqual({
      model: classification.name, state: state.value,
      questions: {
        department: { type: "choice", instructions: expect.any(String), criteria: { billing: expect.any(String), technical: expect.any(String), sales: expect.any(String) } },
        frustration: { type: "score", instructions: expect.any(String), criteria: ["Calm", "Frustrated", "Very angry"] },
        is_urgent: { type: "noul", instructions: expect.any(String), criteria: { true: expect.any(String), false: expect.any(String) } },
      },
    });
    expect(requests.some(r => r.url === "/admin/api/bench/chat")).toBe(false);
  });

  it("edits structured state/questions and sends JSON to /v1/systemone with the client key", async () => {
    await renderBench();
    fireEvent.click(screen.getByRole("button", { name: "Proxy chain", exact: true }));
    fireEvent.change(screen.getByPlaceholderText("or paste a key"), { target: { value: "hpk-client-secret" } });
    const raw = editableBody();
    const generated = JSON.parse(raw.value);
    expect(Object.values(generated.questions).map((q: any) => q.type)).toEqual(["choice", "score", "noul"]);
    fireEvent.change(raw, { target: { value: "{" } });
    expect((screen.getByRole("button", { name: "Send", exact: true }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Not valid JSON:/)).toBeTruthy();
    const edited = {
      ...generated,
      state: [{ text: "The integration is broken", account: { plan: "pro" } }],
      questions: {
        ...generated.questions,
        department: { ...generated.questions.department, instructions: { question: "Which team?", context: ["customer support"] } },
        is_urgent: { type: "noul", instructions: ["Does the state describe an outage?", "Consider the account plan."] },
      },
    };
    fireEvent.change(raw, { target: { value: JSON.stringify(edited) } });
    fireEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
    await screen.findByRole("heading", { name: "Response", exact: true });
    const sent = requests.find(r => r.url === "/v1/systemone")!;
    expect(sent.init).toMatchObject({ method: "POST", credentials: "omit", headers: { authorization: "Bearer hpk-client-secret", "content-type": "application/json" } });
    expect(sent.body).toEqual(edited);
    expect(sent.body).not.toHaveProperty("messages");
    expect(sent.body).not.toHaveProperty("stream");
    expect(requests.some(r => r.url === "/v1/chat/completions" || r.url === "/admin/api/bench/media")).toBe(false);
  });

  it("keeps classification state separate when switching to and from chat", async () => {
    await renderBench();
    const classificationText = "Please fix today's failed payment.";
    fireEvent.change(screen.getByRole("textbox"), { target: { value: classificationText } });
    const serviceSelect = screen.getByRole("option", { name: `${chat.name} · chat`, exact: true }).parentElement!;
    fireEvent.change(serviceSelect, { target: { value: String(chat.id) } });
    const chatTextareas = screen.getAllByRole("textbox");
    expect((chatTextareas[1] as HTMLTextAreaElement).value).toBe("Reply with the single word: pong.");
    fireEvent.change(chatTextareas[1], { target: { value: "Explain retry policies." } });
    fireEvent.change(serviceSelect, { target: { value: String(classification.id) } });
    const raw = editableBody();
    expect(JSON.parse(raw.value)).toMatchObject({ model: classification.name, state: classificationText });
    expect(JSON.parse(raw.value)).not.toHaveProperty("messages");
    fireEvent.click(screen.getByRole("button", { name: "Back to generated", exact: true }));
    fireEvent.change(serviceSelect, { target: { value: String(chat.id) } });
    expect((screen.getAllByRole("textbox")[1] as HTMLTextAreaElement).value).toBe("Explain retry policies.");
  });

  it("offers classification for raw mappings and keeps them internal-only", async () => {
    await renderBench();
    fireEvent.click(screen.getByRole("button", { name: "Raw model", exact: true }));
    chooseClassification();
    await waitFor(() => expect((screen.getByRole("button", { name: "Send", exact: true }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole("button", { name: "Proxy chain", exact: true }) as HTMLButtonElement).disabled).toBe(true);
    const raw = editableBody();
    expect(JSON.parse(raw.value)).toMatchObject({ model: "jev@typesafe", state: expect.any(String), questions: { department: { type: "choice" } } });
    fireEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
    await screen.findByRole("heading", { name: "Response", exact: true });
    expect(requests.find(r => r.url === "/admin/api/bench/media")?.body).toMatchObject({
      category: "classification", target: { kind: "raw", model: "jev", provider: "typesafe", providerFormat: "openai_completion" },
    });
  });
});
