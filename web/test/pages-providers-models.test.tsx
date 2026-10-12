/**
 * Characterization of the Providers page (table, validating save, connection
 * test, alternate endpoints) and the Model Mapping page (cards, two modals).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Providers } from "../src/pages/Providers";
import { Models } from "../src/pages/Models";
import type { Mapping, Model, Provider, ProviderModels, Proxy, User } from "../src/types";
import {
  ADMIN, MANAGER, button, cells, classes, cls, deferred, fail, field, hasButton, iconButton, isOn, labelEl, mockApi, modal, openModal,
  renderPage, toastShown, toasts, toggle, type, type Routes,
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

const JSON_HEADERS = { "content-type": "application/json" };
const sentJson = (method: string, path: string, body: unknown) => ({ method, path, body, headers: JSON_HEADERS, credentials: "same-origin" });
const sentBare = (method: string, path: string) => ({ method, path, body: undefined, headers: {}, credentials: "same-origin" });
const PAGE_TITLE = "flex items-center gap-2.5 text-2xl font-semibold text-ink-100";
const spinner = () => document.querySelector(".animate-spin");
const errorNote = () => document.querySelector(".border-red-900\\/50.px-4");

const OPENAI: Provider = {
  id: 1, name: "openai", type: "openai_completion", baseUrl: "https://api.openai.com/v1", hasKey: true, extraHeaders: { "x-team": "a" },
  maxOutputTokens: 4096, enabled: true, createdAt: 1, altEndpoints: [{ type: "anthropic", baseUrl: "https://api.openai.com/anthropic" }], proxyId: 3,
};
const CLAUDE: Provider = {
  id: 2, name: "claude", type: "anthropic", baseUrl: "https://api.anthropic.com", hasKey: false, extraHeaders: null,
  maxOutputTokens: null, enabled: false, createdAt: 2,
};
const PROVIDER_MODELS: ProviderModels[] = [{ providerId: 1, models: ["gpt-4o", "gpt-4o-mini"], fetchedAt: 5 }];
const PROXIES: Proxy[] = [
  { id: 3, name: "local", scheme: "http", host: "127.0.0.1", port: 7890, username: null, hasPassword: false, enabled: true, createdAt: 1 },
  { id: 4, name: "spare", scheme: "https", host: "px.example", port: 443, username: null, hasPassword: false, enabled: false, createdAt: 2 },
];

// ---------------------------------------------------------------------------

describe("Providers page", () => {
  const setup = async (routes: Routes = {}, me: User = ADMIN) => {
    const api = mockApi({
      "GET /providers": { providers: [OPENAI, CLAUDE] },
      "GET /provider-models": { providerModels: PROVIDER_MODELS },
      "GET /proxies": { proxies: PROXIES },
      ...routes,
    }, me);
    const view = await renderPage(<Providers />);
    return { api, ...view };
  };
  const loaded = async (routes: Routes = {}, me: User = ADMIN) => {
    const r = await setup(routes, me);
    await screen.findByText("claude");
    return r;
  };
  const rowOf = (name: string) => screen.getByText(name).closest("tr")!;
  const NEW = "New provider";
  const EDIT = "Edit provider";
  const openNew = () => {
    fireEvent.click(button(NEW));
    return openModal(NEW);
  };
  const openEdit = (name: string) => {
    fireEvent.click(iconButton("bi-pencil", rowOf(name)));
    return openModal(EDIT);
  };
  const BLANK = { name: "", type: "openai_completion", baseUrl: "", extraHeaders: null, maxOutputTokens: null, proxyId: null, altEndpoints: null, enabled: true };
  const altUrls = (m: ParentNode) => [...m.querySelectorAll<HTMLInputElement>('input[placeholder="https://…/v1"]')];

  it("loads providers, their stored model lists and the proxies", async () => {
    const { api } = await loaded();
    expect(api.calls.filter((c) => c.path !== "/me" && c.path !== "/settings/ui-language").map((c) => `${c.method} ${c.path}`).sort())
      .toEqual(["GET /provider-models", "GET /providers", "GET /proxies"]);
  });

  it("shows the header and a spinner while loading", async () => {
    const gate = deferred<unknown>();
    const { container } = await setup({ "GET /providers": () => gate.promise });
    const h1 = container.querySelector("h1")!;
    expect(h1.textContent).toBe("Providers");
    expect(classes(h1)).toEqual(cls(PAGE_TITLE));
    expect(classes(h1.querySelector("i"))).toEqual(cls("bi bi-hdd-network text-brand-400"));
    expect(screen.getByText("Upstream API endpoints. Keys are encrypted at rest.")).toBeTruthy();
    expect(spinner()).not.toBeNull();
    expect(container.querySelector("table")).toBeNull();
    const add = button(NEW);
    expect(classes(add)).toEqual(["btn-primary"]);
    expect(classes(add.querySelector("i"))).toEqual(cls("bi bi-plus-lg"));
    await act(async () => { gate.resolve({ providers: [OPENAI, CLAUDE] }); });
    await screen.findByText("claude");
    expect(spinner()).toBeNull();
  });

  it.each([
    ["the provider list", "GET /providers"],
    ["the model lists", "GET /provider-models"],
  ])("shows a load error under the header when %s fails", async (_name, route) => {
    const { container } = await setup({ [route]: fail(500, { error: "db down" }) });
    await waitFor(() => expect(errorNote()).not.toBeNull());
    expect(errorNote()!.textContent).toBe("db down");
    expect(container.querySelector("h1")!.textContent).toBe("Providers");
    expect(container.querySelector("table")).toBeNull();
  });

  it("still lists providers when the proxy list cannot be loaded", async () => {
    await loaded({ "GET /proxies": fail(403, { error: "forbidden" }) });
    expect(errorNote()).toBeNull();
    const select = field<HTMLSelectElement>("Egress proxy", openNew());
    expect([...select.options].map((o) => o.textContent)).toEqual(["Direct connection (no proxy)"]);
  });

  it("shows the empty state with a second New button for an admin", async () => {
    const { container } = await setup({ "GET /providers": { providers: [] } });
    const title = await screen.findByText("No providers yet");
    expect(screen.getByText("Add an upstream like OpenAI or Anthropic to start routing.")).toBeTruthy();
    expect(classes(title.parentElement!.querySelector("i"))).toEqual(cls("bi bi-hdd-network text-4xl text-ink-600"));
    const buttons = [...container.querySelectorAll("button")].filter((b) => b.textContent === NEW);
    expect(buttons).toHaveLength(2);
    expect(classes(buttons[1])).toEqual(["btn-primary"]);
    fireEvent.click(buttons[1]);
    expect(modal(NEW)).not.toBeNull();
  });

  it("lists providers in a table: type, base URL, key, model count, status, actions", async () => {
    const { container } = await loaded();
    expect(classes(container.querySelector("table"))).toEqual(["table"]);
    expect(classes(container.querySelector("table")!.parentElement)).toEqual(cls("card overflow-hidden"));
    expect([...container.querySelectorAll("th")].map((th) => [th.textContent, th.className])).toEqual([
      ["Name", ""], ["Type", ""], ["Base URL", ""], ["Key", ""], ["Models", ""], ["Status", ""], ["Actions", "text-right"],
    ]);
    expect(cells(rowOf("openai"))).toEqual(["openai", "OpenAI (Chat Completions)", "https://api.openai.com/v1", "set", "2", "enabled", ""]);
    expect(cells(rowOf("claude"))).toEqual(["claude", "Anthropic", "https://api.anthropic.com", "none", "none", "disabled", ""]);

    const [name, kind, url, key, models, status, actions] = [...rowOf("openai").querySelectorAll("td")];
    expect(classes(name)).toEqual(cls("font-medium text-ink-100"));
    expect(classes(kind.querySelector("span"))).toEqual(["badge-gray"]);
    expect(classes(url)).toEqual(cls("font-mono text-xs text-ink-400 max-w-[240px] truncate"));
    expect(url.title).toBe("https://api.openai.com/v1");
    expect(classes(key.querySelector("span"))).toEqual(["badge-green"]);
    expect(classes(key.querySelector("i"))).toEqual(cls("bi bi-key-fill"));
    expect(classes(models.querySelector("span"))).toEqual(["badge-blue"]);
    expect(classes(models.querySelector("i"))).toEqual(cls("bi bi-box"));
    expect(classes(status.querySelector("span"))).toEqual(["badge-green"]);
    expect(classes(actions.firstElementChild)).toEqual(cls("flex justify-end gap-1.5"));
    expect(classes(iconButton("bi-pencil", actions))).toEqual(cls("btn-ghost btn-xs"));
    expect(classes(iconButton("bi-trash3", actions))).toEqual(cls("btn-danger btn-xs"));

    const off = [...rowOf("claude").querySelectorAll("td")];
    expect(classes(off[3].querySelector("span"))).toEqual(["badge-gray"]);
    expect(classes(off[3].querySelector("i"))).toEqual(cls("bi bi-dash"));
    expect(classes(off[4].querySelector("span"))).toEqual(["badge-gray"]);
    expect(classes(off[5].querySelector("span"))).toEqual(["badge-red"]);
  });

  it("is read-only for a manager: no New button, 'read only' instead of row actions", async () => {
    await loaded({}, MANAGER);
    expect(hasButton(NEW)).toBe(false);
    expect(rowOf("openai").querySelector("button")).toBeNull();
    const note = rowOf("openai").querySelector("td:last-child span")!;
    expect(note.textContent).toBe("read only");
    expect(classes(note)).toEqual(cls("text-xs text-ink-500"));
  });

  it("opens the create form with its defaults", async () => {
    await loaded();
    const m = openNew();
    expect(classes(m)).toEqual(cls("card flex max-h-[92vh] w-full flex-col max-w-2xl"));
    expect(classes(m.querySelector("h2 i"))).toEqual(cls("bi bi-hdd-network text-brand-400"));
    expect([...m.querySelectorAll(".label")].map((l) => l.textContent)).toEqual([
      "Name", "Type", "Base URL", "Alternate format endpoints (optional)", "API key ", "Max output tokens (optional cap)", "Egress proxy", "Extra headers (JSON, optional)",
    ]);
    const name = field("Name", m);
    const kind = field<HTMLSelectElement>("Type", m);
    const baseUrl = field("Base URL", m);
    const apiKey = field("API key", m);
    const maxOut = field("Max output tokens", m);
    const proxy = field<HTMLSelectElement>("Egress proxy", m);
    const headers = field<HTMLTextAreaElement>("Extra headers (JSON, optional)", m);
    expect([name.value, name.placeholder, classes(name)]).toEqual(["", "e.g. openai-official", ["input"]]);
    expect([kind.value, classes(kind)]).toEqual(["openai_completion", ["select"]]);
    expect([...kind.options].map((o) => [o.value, o.textContent])).toEqual([
      ["openai_completion", "OpenAI (Chat Completions)"], ["openai_responses", "OpenAI (Responses API)"], ["anthropic", "Anthropic"],
    ]);
    expect([baseUrl.value, baseUrl.placeholder, classes(baseUrl)]).toEqual(["", "https://api.openai.com/v1", cls("input font-mono text-xs")]);
    expect([apiKey.value, apiKey.type, apiKey.placeholder, classes(apiKey)]).toEqual(["", "password", "sk-...", cls("input font-mono text-xs")]);
    expect([maxOut.value, maxOut.inputMode, maxOut.placeholder, classes(maxOut)]).toEqual(["", "numeric", "e.g. 131072", cls("input font-mono text-xs")]);
    expect([proxy.value, classes(proxy)]).toEqual(["", ["select"]]);
    expect([...proxy.options].map((o) => [o.value, o.textContent])).toEqual([
      ["", "Direct connection (no proxy)"], ["3", "local — http://127.0.0.1:7890"], ["4", "spare — https://px.example:443 (disabled)"],
    ]);
    expect([headers.value, headers.rows, headers.placeholder, classes(headers)]).toEqual(["", 3, '{"x-custom": "value"}', cls("input font-mono text-xs")]);
    expect(isOn(toggle("Enabled", m))).toBe(true);
    expect(classes(labelEl("Name", m))).toEqual(["label"]);
    expect(classes(labelEl("Max output tokens", m).querySelector("span"))).toEqual(cls("normal-case text-ink-500"));
    expect(classes(name.closest(".grid"))).toEqual(cls("grid gap-4 sm:grid-cols-2"));
    expect(screen.getByText("The /v1-style base; /chat/completions is appended.")).toBeTruthy();
    expect(classes(screen.getByText("The /v1-style base; /chat/completions is appended."))).toEqual(cls("mt-1 text-xs text-ink-500"));
    expect(altUrls(m)).toHaveLength(0);
    expect(classes(button("Add endpoint", m))).toEqual(cls("btn-ghost btn-xs"));

    // Connection-test panel: a title, a hint and the Test button; no result yet.
    const test = button("Test", m);
    expect(classes(test)).toEqual(cls("btn-ghost btn-xs shrink-0"));
    expect(classes(test.querySelector("i"))).toEqual(cls("bi bi-plug"));
    expect(classes(test.closest(".rounded-lg"))).toEqual(cls("rounded-lg border border-ink-800 bg-ink-950/30 p-3"));
    expect(classes(screen.getByText("Connection test"))).toEqual(cls("text-xs font-semibold uppercase tracking-wide text-ink-400"));
    expect(m.querySelector("ul")).toBeNull();
    expect(m.querySelector(".badge-gray, .badge-green")).toBeNull();

    const save = button("Save", m);
    expect(classes(save)).toEqual(["btn-primary"]);
    expect(classes(save.querySelector("i"))).toEqual(cls("bi bi-check-lg"));
    expect(save.disabled).toBe(false);
    expect(classes(button("Cancel", m))).toEqual(["btn-ghost"]);
    expect([...save.parentElement!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Cancel", "Save"]);
  });

  it.each([
    ["openai_completion", "https://api.openai.com/v1", "The /v1-style base; /chat/completions is appended."],
    ["openai_responses", "https://api.openai.com/v1", "The /v1-style base; /responses is appended."],
    ["anthropic", "https://api.anthropic.com", "Host root; /v1/messages is appended."],
  ])("type %s changes the base-URL placeholder and hint", async (value, placeholder, hint) => {
    await loaded();
    const m = openNew();
    type(field("Type", m), value);
    expect(field("Base URL", m).placeholder).toBe(placeholder);
    expect(screen.getByText(hint)).toBeTruthy();
  });

  it("creates with POST /providers: nulls for everything left blank, no apiKey key", async () => {
    const { api } = await loaded({ "POST /providers": { provider: {} } });
    const m = openNew();
    type(field("Name", m), "groq");
    type(field("Base URL", m), "https://api.groq.com/openai/v1");
    fireEvent.click(button("Save", m));
    await toastShown("Provider created");
    expect(api.mutations()).toEqual([sentJson("POST", "/providers", { ...BLANK, name: "groq", baseUrl: "https://api.groq.com/openai/v1" })]);
    expect(modal(NEW)).toBeNull();
    expect(api.sent("GET", "/providers")).toHaveLength(2);
    expect(api.sent("GET", "/provider-models")).toHaveLength(2);
    // The proxy list is fetched once on mount, not on reload.
    expect(api.sent("GET", "/proxies")).toHaveLength(1);
  });

  it("sends every filled field: key, parsed headers, numeric cap, numeric proxy id, type, enabled", async () => {
    const { api } = await loaded({ "POST /providers": {} });
    const m = openNew();
    type(field("Name", m), "anth");
    type(field("Type", m), "anthropic");
    type(field("Base URL", m), "https://api.anthropic.com");
    type(field("API key", m), "sk-secret");
    type(field("Max output tokens", m), " 8192 ");
    type(field("Egress proxy", m), "4");
    type(field("Extra headers (JSON, optional)", m), '{"x-a":"1"}');
    fireEvent.click(toggle("Enabled", m));
    fireEvent.click(button("Save", m));
    await toastShown("Provider created");
    expect(api.mutations()[0].body).toEqual({
      name: "anth", type: "anthropic", baseUrl: "https://api.anthropic.com", extraHeaders: { "x-a": "1" }, maxOutputTokens: 8192,
      proxyId: 4, altEndpoints: null, enabled: false, apiKey: "sk-secret",
    });
  });

  it("sends an untouched create form as it stands (no client-side required fields)", async () => {
    const { api } = await loaded({ "POST /providers": fail(400, { error: "name is required" }) });
    fireEvent.click(button("Save", openNew()));
    await toastShown("name is required");
    expect(api.mutations()).toEqual([sentJson("POST", "/providers", BLANK)]);
    expect(modal(NEW)).not.toBeNull();
    expect(api.sent("GET", "/providers")).toHaveLength(1);
  });

  it("falls back to 'Save failed' for a non-API failure", async () => {
    await loaded({ "POST /providers": () => { throw new TypeError("offline"); } });
    fireEvent.click(button("Save", openNew()));
    await toastShown("Save failed");
  });

  it("shows a spinner on a disabled Save while saving", async () => {
    const gate = deferred<unknown>();
    await loaded({ "POST /providers": () => gate.promise });
    const m = openNew();
    fireEvent.click(button("Save", m));
    await waitFor(() => expect(button("Save", m).disabled).toBe(true));
    expect(classes(button("Save", m).querySelector("i"))).toEqual(cls("bi bi-arrow-repeat animate-spin"));
    await act(async () => { gate.resolve({}); });
    await toastShown("Provider created");
  });

  it.each([["1", 1], ["131072", 131072], [" 42 ", 42]])("accepts the output cap %j as %i", async (raw, value) => {
    const { api } = await loaded({ "POST /providers": {} });
    const m = openNew();
    type(field("Max output tokens", m), raw);
    fireEvent.click(button("Save", m));
    await toastShown("Provider created");
    expect((api.mutations()[0].body as { maxOutputTokens: number }).maxOutputTokens).toBe(value);
  });

  it.each([["0"], ["-1"], ["1.5"], ["abc"], ["01"], ["1e3"], ["12 000"]])("refuses the output cap %j with a toast and sends nothing", async (raw) => {
    const { api } = await loaded();
    const m = openNew();
    type(field("Max output tokens", m), raw);
    fireEvent.click(button("Save", m));
    await toastShown("Max output tokens must be a positive integer");
    expect(api.mutations()).toEqual([]);
    expect(modal(NEW)).not.toBeNull();
  });

  it("refuses unparsable extra headers on save and on test, sending nothing", async () => {
    const { api } = await loaded();
    const m = openNew();
    type(field("Base URL", m), "https://x.example/v1");
    type(field("Extra headers (JSON, optional)", m), "x-a: 1");
    fireEvent.click(button("Save", m));
    await toastShown("Extra headers must be valid JSON");
    fireEvent.click(button("Test", m));
    await waitFor(() => expect(toasts()).toEqual(["Extra headers must be valid JSON", "Extra headers must be valid JSON"]));
    expect(api.mutations()).toEqual([]);
  });

  it("treats whitespace-only extra headers as none", async () => {
    const { api } = await loaded({ "POST /providers": {} });
    const m = openNew();
    type(field("Extra headers (JSON, optional)", m), "  \n ");
    fireEvent.click(button("Save", m));
    await toastShown("Provider created");
    expect((api.mutations()[0].body as { extraHeaders: unknown }).extraHeaders).toBeNull();
  });

  it("alternate endpoints: up to three rows, a different default format, blank URLs dropped on save", async () => {
    const { api } = await loaded({ "POST /providers": {} });
    const m = openNew();
    fireEvent.click(button("Add endpoint", m));
    const firstSelect = m.querySelector<HTMLSelectElement>("select.w-48")!;
    expect(classes(firstSelect)).toEqual(cls("select w-48"));
    expect(firstSelect.value).toBe("openai_responses");
    expect([...firstSelect.options].map((o) => o.textContent)).toEqual(["OpenAI (Chat Completions)", "OpenAI (Responses API)", "Anthropic"]);
    expect(classes(altUrls(m)[0])).toEqual(cls("input font-mono text-xs"));
    expect(classes(altUrls(m)[0].parentElement)).toEqual(cls("mb-2 flex gap-2"));
    expect(classes(iconButton("bi-x-lg", altUrls(m)[0].parentElement!))).toEqual(cls("btn-ghost btn-xs"));

    fireEvent.click(button("Add endpoint", m));
    fireEvent.click(button("Add endpoint", m));
    expect(altUrls(m)).toHaveLength(3);
    expect(hasButton("Add endpoint", m)).toBe(false);

    type(altUrls(m)[0], "https://x.example/responses");
    type(m.querySelectorAll<HTMLSelectElement>("select.w-48")[2], "anthropic");
    type(altUrls(m)[2], "https://x.example/anthropic");
    fireEvent.click(button("Save", m));
    await toastShown("Provider created");
    expect((api.mutations()[0].body as { altEndpoints: unknown }).altEndpoints).toEqual([
      { type: "openai_responses", baseUrl: "https://x.example/responses" },
      { type: "anthropic", baseUrl: "https://x.example/anthropic" },
    ]);
  });

  it("alternate endpoints: defaults to Chat Completions when the primary is another format, and rows can be removed", async () => {
    const { api } = await loaded({ "POST /providers": {} });
    const m = openNew();
    type(field("Type", m), "anthropic");
    fireEvent.click(button("Add endpoint", m));
    expect(m.querySelector<HTMLSelectElement>("select.w-48")!.value).toBe("openai_completion");
    fireEvent.click(button("Add endpoint", m));
    type(altUrls(m)[0], "https://first");
    type(altUrls(m)[1], "https://second");
    fireEvent.click(iconButton("bi-x-lg", altUrls(m)[0].parentElement!));
    expect(altUrls(m).map((i) => i.value)).toEqual(["https://second"]);
    expect(hasButton("Add endpoint", m)).toBe(true);
    fireEvent.click(iconButton("bi-x-lg", altUrls(m)[0].parentElement!));
    fireEvent.click(button("Save", m));
    await toastShown("Provider created");
    expect((api.mutations()[0].body as { altEndpoints: unknown }).altEndpoints).toBeNull();
  });

  it("opens the edit form prefilled, key blank with a keep hint, stored models listed", async () => {
    await loaded();
    const m = openEdit("openai");
    expect(field("Name", m).value).toBe("openai");
    expect(field<HTMLSelectElement>("Type", m).value).toBe("openai_completion");
    expect(field("Base URL", m).value).toBe("https://api.openai.com/v1");
    expect(field("API key", m).value).toBe("");
    expect(labelEl("API key", m).textContent).toBe("API key (leave blank to keep current)");
    expect(field("Max output tokens", m).value).toBe("4096");
    expect(field<HTMLSelectElement>("Egress proxy", m).value).toBe("3");
    expect(field<HTMLTextAreaElement>("Extra headers (JSON, optional)", m).value).toBe(JSON.stringify({ "x-team": "a" }, null, 2));
    expect(altUrls(m).map((i) => i.value)).toEqual(["https://api.openai.com/anthropic"]);
    expect(m.querySelector<HTMLSelectElement>("select.w-48")!.value).toBe("anthropic");
    expect(isOn(toggle("Enabled", m))).toBe(true);

    const stored = screen.getByText("2 models stored");
    expect(classes(stored)).toEqual(["badge-gray"]);
    expect(classes(stored.querySelector("i"))).toEqual(cls("bi bi-clock-history"));
    expect(screen.queryByText("Saved with the provider.")).toBeNull();
    expect([...m.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(m.querySelector<HTMLInputElement>('input[placeholder="Search models..."]')).not.toBeNull();
  });

  it("shows no model panel when editing a provider that has no stored list", async () => {
    await loaded();
    const m = openEdit("claude");
    expect(field("Max output tokens", m).value).toBe("");
    expect(field<HTMLSelectElement>("Egress proxy", m).value).toBe("");
    expect(field<HTMLTextAreaElement>("Extra headers (JSON, optional)", m).value).toBe("");
    expect(isOn(toggle("Enabled", m))).toBe(false);
    expect(m.querySelector("ul")).toBeNull();
    expect(screen.queryByText(/models stored$/)).toBeNull();
  });

  it("updates with PATCH /providers/:id, keeping the stored key and model list untouched", async () => {
    const { api } = await loaded({ "PATCH /providers/1": { provider: {} } });
    const m = openEdit("openai");
    type(field("Name", m), "openai-main");
    fireEvent.click(button("Save", m));
    await toastShown("Provider updated");
    expect(api.mutations()).toEqual([sentJson("PATCH", "/providers/1", {
      name: "openai-main", type: "openai_completion", baseUrl: "https://api.openai.com/v1", extraHeaders: { "x-team": "a" }, maxOutputTokens: 4096,
      proxyId: 3, altEndpoints: [{ type: "anthropic", baseUrl: "https://api.openai.com/anthropic" }], enabled: true,
    })]);
    expect(modal(EDIT)).toBeNull();
    expect(api.sent("GET", "/providers")).toHaveLength(2);
  });

  it("sends a retyped key, and nulls for fields cleared on edit", async () => {
    const { api } = await loaded({ "PATCH /providers/1": {} });
    const m = openEdit("openai");
    type(field("API key", m), "sk-new");
    type(field("Max output tokens", m), "");
    type(field("Egress proxy", m), "");
    type(field("Extra headers (JSON, optional)", m), "");
    fireEvent.click(button("Save", m));
    await toastShown("Provider updated");
    expect(api.mutations()[0].body).toMatchObject({ apiKey: "sk-new", maxOutputTokens: null, proxyId: null, extraHeaders: null });
  });

  it("refuses to test without a base URL", async () => {
    const { api } = await loaded();
    const m = openNew();
    fireEvent.click(button("Test", m));
    await toastShown("Enter a base URL before testing");
    type(field("Base URL", m), "   ");
    fireEvent.click(button("Test", m));
    await waitFor(() => expect(toasts()).toHaveLength(2));
    expect(api.mutations()).toEqual([]);
  });

  it("tests a new provider with an explicit null key; a successful list is saved with it", async () => {
    const { api } = await loaded({
      "POST /providers/test": { ok: true, status: 200, message: "ok", models: ["m-1", "m-2", "m-3"] },
      "POST /providers": {},
    });
    const m = openNew();
    type(field("Name", m), "groq");
    type(field("Base URL", m), "https://x.example/v1");
    fireEvent.click(button("Test", m));
    await toastShown("Connection OK — 3 models fetched");
    expect(api.mutations()).toEqual([sentJson("POST", "/providers/test", { type: "openai_completion", baseUrl: "https://x.example/v1", extraHeaders: null, apiKey: null, proxyId: null })]);
    const fetched = screen.getByText("3 models fetched");
    expect(classes(fetched)).toEqual(["badge-green"]);
    expect(classes(fetched.querySelector("i"))).toEqual(cls("bi bi-check-lg"));
    expect(classes(screen.getByText("Saved with the provider."))).toEqual(["text-ink-500"]);
    expect([...m.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["m-1", "m-2", "m-3"]);
    // Testing does not save or close.
    expect(modal(NEW)).not.toBeNull();

    fireEvent.click(button("Save", m));
    await toastShown("Provider created");
    expect(api.mutations()[1].body).toEqual({ ...BLANK, name: "groq", baseUrl: "https://x.example/v1", availableModels: ["m-1", "m-2", "m-3"] });
  });

  it("tests with the typed key, headers and selected proxy", async () => {
    const { api } = await loaded({ "POST /providers/test": { ok: true, status: 200, message: "ok", models: ["m"] } });
    const m = openEdit("openai");
    type(field("API key", m), "sk-typed");
    type(field("Egress proxy", m), "4");
    fireEvent.click(button("Test", m));
    await toastShown("Connection OK — 1 models fetched");
    expect(api.mutations()[0].body).toEqual({ type: "openai_completion", baseUrl: "https://api.openai.com/v1", extraHeaders: { "x-team": "a" }, apiKey: "sk-typed", proxyId: 4 });
    // A fresh list replaces the stored one in the dialog.
    expect(screen.queryByText("2 models stored")).toBeNull();
    expect([...m.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["m"]);
  });

  it("tests a saved provider by id when the key field is blank", async () => {
    const { api } = await loaded({ "POST /providers/test": { ok: true, status: 200, message: "ok", models: ["m"] } });
    fireEvent.click(button("Test", openEdit("openai")));
    await toastShown("Connection OK — 1 models fetched");
    expect(api.mutations()[0].body).toEqual({ type: "openai_completion", baseUrl: "https://api.openai.com/v1", extraHeaders: { "x-team": "a" }, id: 1, proxyId: 3 });
  });

  it("a reachable provider that reports no models is an error toast with an empty fetched list", async () => {
    const { api } = await loaded({ "POST /providers/test": { ok: true, status: 200, message: "ok", models: [] }, "PATCH /providers/1": {} });
    const m = openEdit("openai");
    fireEvent.click(button("Test", m));
    await toastShown("Connection OK, but the provider reported no models");
    expect(screen.getByText("0 models fetched")).toBeTruthy();
    const none = screen.getByText("No model list yet — run the test to fetch one.");
    expect(classes(none)).toEqual(cls("rounded-lg border border-dashed border-ink-700 px-3 py-2.5 text-xs text-ink-500"));
    fireEvent.click(button("Save", m));
    await toastShown("Provider updated");
    expect((api.mutations()[1].body as { availableModels: unknown }).availableModels).toEqual([]);
  });

  it("a failed test shows the reason in the panel, keeps the stored list, and is not saved", async () => {
    const { api } = await loaded({ "POST /providers/test": { ok: false, status: 401, message: "401 Unauthorized", models: [] }, "PATCH /providers/1": {} });
    const m = openEdit("openai");
    fireEvent.click(button("Test", m));
    await toastShown("401 Unauthorized");
    const reason = [...m.querySelectorAll("span.break-words")].find((s) => s.textContent === "401 Unauthorized")!;
    expect(classes(reason.parentElement)).toEqual(cls("mt-3 flex items-start gap-2 text-xs text-red-300"));
    expect(classes(reason.parentElement!.querySelector("i"))).toEqual(cls("bi bi-exclamation-octagon-fill mt-px shrink-0"));
    expect(screen.getByText("2 models stored")).toBeTruthy();
    fireEvent.click(button("Save", m));
    await toastShown("Provider updated");
    expect(api.mutations()[1].body).not.toHaveProperty("availableModels");
  });

  it.each([
    ["the server's message", fail(400, { error: "base URL is not allowed" }), "base URL is not allowed"],
    ["'Test failed' for a non-API failure", () => { throw new TypeError("offline"); }, "Test failed"],
  ])("shows %s when the test request itself fails", async (_name, handler, text) => {
    await loaded({ "POST /providers/test": handler });
    const m = openEdit("claude");
    fireEvent.click(button("Test", m));
    await toastShown(text);
    expect([...m.querySelectorAll("span.break-words")].map((s) => s.textContent)).toEqual([text]);
  });

  it("disables Test with a spinner while the test runs", async () => {
    const gate = deferred<unknown>();
    await loaded({ "POST /providers/test": () => gate.promise });
    const m = openEdit("openai");
    fireEvent.click(button("Test", m));
    await waitFor(() => expect(button("Test", m).disabled).toBe(true));
    expect(classes(button("Test", m).querySelector("i"))).toEqual(cls("bi bi-arrow-repeat animate-spin"));
    expect(button("Save", m).disabled).toBe(false);
    await act(async () => { gate.resolve({ ok: true, status: 200, message: "ok", models: ["m"] }); });
    await waitFor(() => expect(button("Test", m).disabled).toBe(false));
  });

  it.each([
    ["Cancel", (m: HTMLElement) => button("Cancel", m)],
    ["the close button", (m: HTMLElement) => iconButton("bi-x-lg", m.querySelector("h2")!.parentElement!)],
  ])("closes the form with %s, sending nothing and discarding the edits", async (_name, pick) => {
    const { api } = await loaded();
    type(field("Name", openNew()), "draft");
    fireEvent.click(pick(openModal(NEW)));
    expect(modal(NEW)).toBeNull();
    expect(api.mutations()).toEqual([]);
    expect(field("Name", openNew()).value).toBe("");
  });

  it("asks before deleting; Cancel sends nothing", async () => {
    const { api } = await loaded();
    fireEvent.click(iconButton("bi-trash3", rowOf("openai")));
    const m = openModal("Delete provider");
    expect(screen.getByText('Delete "openai"? Mappings using it will also be removed.')).toBeTruthy();
    await act(async () => { fireEvent.click(button("Cancel", m)); });
    expect(api.mutations()).toEqual([]);
  });

  it("deletes with DELETE /providers/:id after confirmation, toasts and reloads", async () => {
    const { api } = await loaded({ "DELETE /providers/1": { ok: true } });
    fireEvent.click(iconButton("bi-trash3", rowOf("openai")));
    fireEvent.click(button("Confirm", openModal("Delete provider")));
    await toastShown("Provider deleted");
    expect(api.mutations()).toEqual([sentBare("DELETE", "/providers/1")]);
    expect(api.sent("GET", "/providers")).toHaveLength(2);
  });

  it.each([
    ["the server's message", fail(409, { error: "provider is in use" }), "provider is in use"],
    ["'Delete failed' for a non-API failure", () => { throw new TypeError("offline"); }, "Delete failed"],
  ])("toasts %s when the delete is refused", async (_name, handler, text) => {
    const { api } = await loaded({ "DELETE /providers/1": handler });
    fireEvent.click(iconButton("bi-trash3", rowOf("openai")));
    fireEvent.click(button("Confirm", openModal("Delete provider")));
    await toastShown(text);
    expect(api.sent("GET", "/providers")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("Models page", () => {
  const SONNET: Model = { id: 1, name: "sonnet", description: "the smart one", enabled: true, createdAt: 1 };
  const MINI: Model = { id: 2, name: "mini", description: null, enabled: false, createdAt: 2 };
  const MAPPINGS: Mapping[] = [
    { id: 7, modelId: 1, providerId: 1, upstreamModel: "gpt-4o", priority: 0, enabled: true },
    { id: 8, modelId: 1, providerId: 9, upstreamModel: "ghost-model", priority: 1, enabled: true },
  ];
  const setup = async (routes: Routes = {}) => {
    const api = mockApi({
      "GET /models": { models: [SONNET, MINI] },
      "GET /providers": { providers: [OPENAI, CLAUDE] },
      "GET /mappings": { mappings: MAPPINGS },
      "GET /provider-models": { providerModels: PROVIDER_MODELS },
      ...routes,
    }, ADMIN);
    const view = await renderPage(<Models />);
    return { api, ...view };
  };
  const loaded = async (routes: Routes = {}) => {
    const r = await setup(routes);
    await screen.findByText("mini");
    return r;
  };
  const cardOf = (name: string) => screen.getByText(name).closest(".card") as HTMLElement;
  const chips = (card: ParentNode) => [...card.querySelectorAll("span.inline-flex.rounded-lg")];
  const NEW = "New model";
  const EDIT = "Edit model";
  const MAP = "Map provider";
  const openMap = (model: string) => {
    fireEvent.click(button(MAP, cardOf(model)));
    return openModal(MAP);
  };

  it("loads models, providers, mappings and provider model lists", async () => {
    const { api } = await loaded();
    expect(api.calls.filter((c) => c.path !== "/me" && c.path !== "/settings/ui-language").map((c) => `${c.method} ${c.path}`).sort())
      .toEqual(["GET /mappings", "GET /models", "GET /provider-models", "GET /providers"]);
  });

  it("shows the header and a spinner while loading", async () => {
    const gate = deferred<unknown>();
    const { container } = await setup({ "GET /mappings": () => gate.promise });
    const h1 = container.querySelector("h1")!;
    expect(h1.textContent).toBe("Model Mapping");
    expect(classes(h1)).toEqual(cls(PAGE_TITLE));
    expect(classes(h1.querySelector("i"))).toEqual(cls("bi bi-box text-brand-400"));
    expect(screen.getByText("Your internal model names, and which providers serve each one.")).toBeTruthy();
    expect(spinner()).not.toBeNull();
    expect(container.querySelector(".card")).toBeNull();
    const add = button(NEW);
    expect(classes(add)).toEqual(["btn-primary"]);
    expect(classes(add.querySelector("i"))).toEqual(cls("bi bi-plus-lg"));
    await act(async () => { gate.resolve({ mappings: [] }); });
    await screen.findByText("mini");
    expect(spinner()).toBeNull();
  });

  it("shows a load error under the header when any of the four requests fails", async () => {
    const { container } = await setup({ "GET /provider-models": fail(500, { error: "db down" }) });
    await waitFor(() => expect(errorNote()).not.toBeNull());
    expect(errorNote()!.textContent).toBe("db down");
    expect(container.querySelector("h1")!.textContent).toBe("Model Mapping");
    expect(container.querySelector(".card")).toBeNull();
  });

  it("shows the empty state with a hint", async () => {
    await setup({ "GET /models": { models: [] } });
    const title = await screen.findByText("No models yet");
    expect(classes(title.parentElement!.querySelector("i"))).toEqual(cls("bi bi-box text-4xl text-ink-600"));
    expect(screen.getByText("Define a model (e.g. sonnet4.6) then map it to the providers that serve it.")).toBeTruthy();
  });

  it("lists models as cards with status, description, actions and their provider mappings", async () => {
    await loaded();
    const sonnet = cardOf("sonnet");
    expect(classes(sonnet)).toEqual(cls("card card-pad"));
    expect(classes(sonnet.parentElement)).toEqual(["space-y-4"]);
    expect(sonnet.parentElement!.children).toHaveLength(2);
    expect(classes(screen.getByText("sonnet"))).toEqual(cls("font-medium text-ink-100"));
    expect(sonnet.querySelector(".badge-green")!.textContent).toBe("enabled");
    expect(classes(screen.getByText("the smart one"))).toEqual(cls("mt-0.5 text-sm text-ink-400"));
    expect(classes(iconButton("bi-pencil", sonnet))).toEqual(cls("btn-ghost btn-xs"));
    expect(classes(iconButton("bi-trash3", sonnet))).toEqual(cls("btn-danger btn-xs"));
    expect(classes(iconButton("bi-pencil", sonnet).parentElement)).toEqual(cls("flex gap-1.5"));

    const section = button(MAP, sonnet).closest(".border-t")!;
    expect(classes(section)).toEqual(cls("mt-3 border-t border-ink-800 pt-3"));
    expect(classes(section.querySelector("span"))).toEqual(cls("text-xs font-semibold uppercase tracking-wide text-ink-400"));
    expect(section.querySelector("span")!.textContent).toBe("Providers");
    expect(classes(button(MAP, sonnet))).toEqual(cls("btn-ghost btn-xs"));
    expect(classes(button(MAP, sonnet).querySelector("i"))).toEqual(cls("bi bi-plus-lg"));

    const [first, second] = chips(sonnet);
    expect(chips(sonnet)).toHaveLength(2);
    expect(classes(first)).toEqual(cls("inline-flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1 text-xs"));
    expect([...first.querySelectorAll("span")].map((s) => [s.textContent, s.className])).toEqual([["openai", "text-ink-200"], ["gpt-4o", "font-mono text-ink-400"]]);
    expect([...first.querySelectorAll("i")].map((i) => i.className)).toEqual(["bi bi-hdd-network text-brand-400", "bi bi-arrow-right text-ink-600", "bi bi-x-lg"]);
    expect(classes(first.querySelector("button"))).toEqual(cls("text-ink-600 hover:text-red-400"));
    expect(classes(first.parentElement)).toEqual(cls("flex flex-wrap gap-2"));
    // A mapping whose provider is gone shows the bare id.
    expect([...second.querySelectorAll("span")].map((s) => s.textContent)).toEqual(["#9", "ghost-model"]);

    const mini = cardOf("mini");
    expect(mini.querySelector(".badge-red")!.textContent).toBe("disabled");
    expect(mini.querySelector("p.mt-0\\.5")).toBeNull();
    expect(chips(mini)).toHaveLength(0);
    expect(classes(screen.getByText("Not mapped to any provider yet."))).toEqual(cls("text-xs text-ink-500"));
  });

  it("opens an empty create form", async () => {
    await loaded();
    fireEvent.click(button(NEW));
    const m = openModal(NEW);
    expect(classes(m)).toEqual(cls("card flex max-h-[92vh] w-full flex-col max-w-lg"));
    expect(classes(m.querySelector("h2 i"))).toEqual(cls("bi bi-box text-brand-400"));
    expect([...m.querySelectorAll(".label")].map((l) => l.textContent)).toEqual(["Name", "Description (optional)"]);
    const name = field("Name", m);
    expect([name.value, name.placeholder, classes(name)]).toEqual(["", "e.g. sonnet4.6", ["input"]]);
    expect([field("Description (optional)", m).value, classes(field("Description (optional)", m))]).toEqual(["", ["input"]]);
    expect(isOn(toggle("Enabled", m))).toBe(true);
    const save = button("Save", m);
    expect(classes(save)).toEqual(["btn-primary"]);
    expect(classes(save.querySelector("i"))).toEqual(cls("bi bi-check-lg"));
    expect(save.disabled).toBe(false);
    expect([...save.parentElement!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Cancel", "Save"]);
    expect(classes(button("Cancel", m))).toEqual(["btn-ghost"]);
  });

  it("creates with POST /models, sending a blank description as null", async () => {
    const { api } = await loaded({ "POST /models": { model: {} } });
    fireEvent.click(button(NEW));
    const m = openModal(NEW);
    type(field("Name", m), "opus");
    fireEvent.click(button("Save", m));
    await toastShown("Model created");
    expect(api.mutations()).toEqual([sentJson("POST", "/models", { name: "opus", description: null, enabled: true })]);
    expect(modal(NEW)).toBeNull();
    expect(api.sent("GET", "/models")).toHaveLength(2);
    expect(api.sent("GET", "/mappings")).toHaveLength(2);
  });

  it("sends the description and the toggled enabled flag", async () => {
    const { api } = await loaded({ "POST /models": {} });
    fireEvent.click(button(NEW));
    const m = openModal(NEW);
    type(field("Name", m), "opus");
    type(field("Description (optional)", m), "big");
    fireEvent.click(toggle("Enabled", m));
    fireEvent.click(button("Save", m));
    await toastShown("Model created");
    expect(api.mutations()[0].body).toEqual({ name: "opus", description: "big", enabled: false });
  });

  it("sends an untouched create form as it stands and keeps the dialog open when refused", async () => {
    const { api } = await loaded({ "POST /models": fail(400, { error: "name is required" }) });
    fireEvent.click(button(NEW));
    fireEvent.click(button("Save", openModal(NEW)));
    await toastShown("name is required");
    expect(api.mutations()).toEqual([sentJson("POST", "/models", { name: "", description: null, enabled: true })]);
    expect(modal(NEW)).not.toBeNull();
    expect(api.sent("GET", "/models")).toHaveLength(1);
  });

  it("falls back to 'Save failed' for a non-API failure", async () => {
    await loaded({ "POST /models": () => { throw new TypeError("offline"); } });
    fireEvent.click(button(NEW));
    fireEvent.click(button("Save", openModal(NEW)));
    await toastShown("Save failed");
  });

  it("edits with PATCH /models/:id from a prefilled form", async () => {
    const { api } = await loaded({ "PATCH /models/1": { model: {} } });
    fireEvent.click(iconButton("bi-pencil", cardOf("sonnet")));
    const m = openModal(EDIT);
    expect([field("Name", m).value, field("Description (optional)", m).value, isOn(toggle("Enabled", m))]).toEqual(["sonnet", "the smart one", true]);
    type(field("Description (optional)", m), "");
    fireEvent.click(button("Save", m));
    await toastShown("Model updated");
    expect(api.mutations()).toEqual([sentJson("PATCH", "/models/1", { name: "sonnet", description: null, enabled: true })]);
    expect(modal(EDIT)).toBeNull();
  });

  it("prefills a null description as an empty field", async () => {
    await loaded();
    fireEvent.click(iconButton("bi-pencil", cardOf("mini")));
    const m = openModal(EDIT);
    expect([field("Name", m).value, field("Description (optional)", m).value, isOn(toggle("Enabled", m))]).toEqual(["mini", "", false]);
  });

  it("closes the model form with Cancel, sending nothing", async () => {
    const { api } = await loaded();
    fireEvent.click(button(NEW));
    fireEvent.click(button("Cancel", openModal(NEW)));
    expect(modal(NEW)).toBeNull();
    expect(api.mutations()).toEqual([]);
  });

  it("asks before deleting a model; Cancel sends nothing", async () => {
    const { api } = await loaded();
    fireEvent.click(iconButton("bi-trash3", cardOf("sonnet")));
    const m = openModal("Delete model");
    expect(screen.getByText('Delete "sonnet" and its provider mappings?')).toBeTruthy();
    await act(async () => { fireEvent.click(button("Cancel", m)); });
    expect(api.mutations()).toEqual([]);
  });

  it("deletes with DELETE /models/:id after confirmation, toasts and reloads", async () => {
    const { api } = await loaded({ "DELETE /models/1": { ok: true } });
    fireEvent.click(iconButton("bi-trash3", cardOf("sonnet")));
    fireEvent.click(button("Confirm", openModal("Delete model")));
    await toastShown("Model deleted");
    expect(api.mutations()).toEqual([sentBare("DELETE", "/models/1")]);
    expect(api.sent("GET", "/models")).toHaveLength(2);
  });

  it.each([
    ["the server's message", fail(409, { error: "model is used by a service" }), "model is used by a service"],
    ["'Delete failed' for a non-API failure", () => { throw new TypeError("offline"); }, "Delete failed"],
  ])("toasts %s when the model delete is refused", async (_name, handler, text) => {
    await loaded({ "DELETE /models/1": handler });
    fireEvent.click(iconButton("bi-trash3", cardOf("sonnet")));
    fireEvent.click(button("Confirm", openModal("Delete model")));
    await toastShown(text);
  });

  it("removes a mapping immediately with DELETE /mappings/:id: no confirmation, no toast", async () => {
    const { api } = await loaded({ "DELETE /mappings/7": { ok: true } });
    fireEvent.click(chips(cardOf("sonnet"))[0].querySelector("button")!);
    await waitFor(() => expect(api.sent("GET", "/mappings")).toHaveLength(2));
    expect(api.mutations()).toEqual([sentBare("DELETE", "/mappings/7")]);
    expect(document.querySelector(".btn-danger:not(.btn-xs)")).toBeNull();
    expect(toasts()).toEqual([]);
  });

  it.each([
    ["the server's message", fail(409, { error: "mapping is used by a step" }), "mapping is used by a step"],
    ["'Failed' for a non-API failure", () => { throw new TypeError("offline"); }, "Failed"],
  ])("toasts %s when removing a mapping is refused", async (_name, handler, text) => {
    await loaded({ "DELETE /mappings/7": handler });
    fireEvent.click(chips(cardOf("sonnet"))[0].querySelector("button")!);
    await toastShown(text);
  });

  it("refuses to open the mapping form when there is no provider", async () => {
    await loaded({ "GET /providers": { providers: [] } });
    fireEvent.click(button(MAP, cardOf("mini")));
    await toastShown("Create a provider first");
    expect(modal(MAP)).toBeNull();
  });

  it("opens the mapping form on the first provider, with its formats and its model list", async () => {
    await loaded();
    const m = openMap("mini");
    expect(classes(m)).toEqual(cls("card flex max-h-[92vh] w-full flex-col max-w-2xl"));
    expect(classes(m.querySelector("h2 i"))).toEqual(cls("bi bi-diagram-2 text-brand-400"));
    const provider = field<HTMLSelectElement>("Provider", m);
    expect([provider.value, classes(provider)]).toEqual(["1", ["select"]]);
    expect([...provider.options].map((o) => [o.value, o.textContent])).toEqual([["1", "openai (openai_completion)"], ["2", "claude (anthropic)"]]);

    // openai serves two formats, so the per-mapping format choice is offered, unticked.
    expect(labelEl("Enabled formats", m)).toBeTruthy();
    const boxes = [...m.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((b) => [b.closest("label")!.textContent, b.checked])).toEqual([["openai_completion", false], ["anthropic", false]]);
    expect(classes(boxes[0].closest("label"))).toEqual(cls("flex items-center gap-1.5 text-xs text-ink-300"));
    expect(classes(boxes[0].closest("label")!.parentElement)).toEqual(cls("flex flex-wrap gap-3"));

    const upstream = field("Upstream model id", m);
    expect([upstream.value, upstream.placeholder, classes(upstream)]).toEqual(["", "e.g. gpt-4o or claude-sonnet-4-6", cls("input font-mono text-xs")]);
    expect(classes(screen.getByText("Offered by openai (2)"))).toEqual(cls("text-xs text-ink-500"));
    expect([...m.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["gpt-4o", "gpt-4o-mini"]);
    // The upstream field is the search box: the list has none of its own.
    expect(m.querySelector('input[placeholder="Search models..."]')).toBeNull();

    const add = button("Add", m);
    expect(classes(add)).toEqual(["btn-primary"]);
    expect(classes(add.querySelector("i"))).toEqual(cls("bi bi-check-lg"));
    expect(add.disabled).toBe(true);
    expect([...add.parentElement!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Cancel", "Add"]);
  });

  it("typing narrows the provider's list and picking a row fills the field", async () => {
    await loaded();
    const m = openMap("mini");
    type(field("Upstream model id", m), "MINI");
    expect([...m.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["gpt-4o-mini"]);
    expect(button("Add", m).disabled).toBe(false);
    fireEvent.click(button("gpt-4o-mini", m));
    expect(field("Upstream model id", m).value).toBe("gpt-4o-mini");
    expect(classes(button("gpt-4o-mini", m).querySelector("i"))).toEqual(cls("bi bi-check-lg shrink-0"));
    type(field("Upstream model id", m), "nothing-like-it");
    expect(screen.getByText('No model matches "nothing-like-it".')).toBeTruthy();
    expect(button("Add", m).disabled).toBe(false);
  });

  it("maps with POST /mappings; no ticked format is sent as null", async () => {
    const { api } = await loaded({ "POST /mappings": { mapping: {} } });
    const m = openMap("mini");
    type(field("Upstream model id", m), "gpt-4o-mini");
    fireEvent.click(button("Add", m));
    await toastShown("Provider mapped");
    expect(api.mutations()).toEqual([sentJson("POST", "/mappings", { modelId: 2, providerId: 1, upstreamModel: "gpt-4o-mini", families: null })]);
    expect(modal(MAP)).toBeNull();
    expect(api.sent("GET", "/mappings")).toHaveLength(2);
  });

  it("sends the ticked formats in the order they were ticked", async () => {
    const { api } = await loaded({ "POST /mappings": {} });
    const m = openMap("sonnet");
    const box = (name: string) => [...m.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((b) => b.closest("label")!.textContent === name)!;
    fireEvent.click(box("anthropic"));
    fireEvent.click(box("openai_completion"));
    fireEvent.click(box("openai_completion"));
    fireEvent.click(box("openai_completion"));
    type(field("Upstream model id", m), "an-id-the-provider-never-reported");
    fireEvent.click(button("Add", m));
    await toastShown("Provider mapped");
    expect(api.mutations()[0].body).toEqual({ modelId: 1, providerId: 1, upstreamModel: "an-id-the-provider-never-reported", families: ["anthropic", "openai_completion"] });
  });

  it("switching to a single-format provider hides the format choice and shows the empty-list hint", async () => {
    const { api } = await loaded({ "POST /mappings": {} });
    const m = openMap("mini");
    type(field("Provider", m), "2");
    expect(m.querySelector('input[type="checkbox"]')).toBeNull();
    expect(screen.queryByText(/^Offered by/)).toBeNull();
    expect(screen.getByText("No model list for this provider yet — open it under Providers and run the connection test.")).toBeTruthy();
    type(field("Upstream model id", m), "claude-sonnet-4-6");
    fireEvent.click(button("Add", m));
    await toastShown("Provider mapped");
    expect(api.mutations()[0].body).toEqual({ modelId: 2, providerId: 2, upstreamModel: "claude-sonnet-4-6", families: null });
  });

  it.each([
    ["the server's message", fail(409, { error: "already mapped" }), "already mapped"],
    ["'Mapping failed' for a non-API failure", () => { throw new TypeError("offline"); }, "Mapping failed"],
  ])("toasts %s when the mapping is refused and keeps the dialog open", async (_name, handler, text) => {
    await loaded({ "POST /mappings": handler });
    const m = openMap("mini");
    type(field("Upstream model id", m), "x");
    fireEvent.click(button("Add", m));
    await toastShown(text);
    expect(modal(MAP)).not.toBeNull();
  });

  it("closes the mapping form with Cancel, sending nothing", async () => {
    const { api } = await loaded();
    const m = openMap("mini");
    type(field("Upstream model id", m), "x");
    fireEvent.click(button("Cancel", m));
    expect(modal(MAP)).toBeNull();
    expect(api.mutations()).toEqual([]);
    expect(field("Upstream model id", openMap("mini")).value).toBe("");
  });
});
