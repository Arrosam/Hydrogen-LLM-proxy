/**
 * Independent verification, spec section WEB-B: WB1 (button classes), WB2
 * (i18n of the Tools page, the hosted-tool binding and the Responses card),
 * WB7 (cleared / out-of-range number fields) and WB8 (Tools feedback).
 * Every expected value comes from the spec, the i18n tables or what a fresh
 * form shows as its default - never from the implementation.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Tools } from "../src/pages/Tools";
import { Check } from "../src/pages/Check";
import { Settings } from "../src/pages/Settings";
import { HostedToolBinding } from "../src/components/HostedToolBinding";
import { ServiceEditor } from "../src/components/ServiceEditor";
import type { HostedTool, HostedToolOptions, Mapping, Model, ModelService, Provider, ServiceDef } from "../src/types";
import {
  ADMIN, button, fail, field, hasButton, mockApi, modal, openModal, renderPage, toastShown, toasts, toggle, type, type MockApi, type Routes,
} from "./helpers";
import { BASE as SETTINGS_ROUTES, card as settingsCard, flush } from "./settings-harness";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const SRC = path.resolve(__dirname, "../src");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** The two translation tables, read as data from the i18n source text. */
const I18N = (() => {
  const text = read("lib/i18n.tsx");
  const split = text.indexOf("const zh: Dict");
  const table = (chunk: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const m of chunk.matchAll(/"([A-Za-z0-9_.]+)":\s*("(?:[^"\\]|\\.)*")/g)) out[m[1]] = JSON.parse(m[2]) as string;
    return out;
  };
  return { en: table(text.slice(0, split)), zh: table(text.slice(split)) };
})();
const CJK = /[㐀-鿿]/;
/** A `{name}` placeholder (but not the literal `{{arguments}}` of the template hint, nor a bare `{}`). */
const interpolated = (s: string): boolean => /(^|[^{])\{[A-Za-z]+\}(?!\})/.test(s);
const pageText = (): string => document.body.textContent ?? "";
const ZH: Routes = { "GET /settings/ui-language": { language: "zh" } };
const offline = () => { throw new TypeError("Failed to fetch"); };

const SAMPLE_SCHEMA = { type: "object", properties: { query: { type: "string", description: "Search query" } }, required: ["query"], additionalProperties: false };
const SEARCH: HostedTool = {
  id: 5, name: "search", description: "Search the docs", parameters: { type: "object" }, url: "https://adapter.example/call",
  bodyTemplate: { q: "{{arguments.query}}" }, resultPath: "/data", timeoutMs: 5000, maxResultBytes: 1024, enabled: false,
  headerNames: ["Authorization", "X-Team"], hasHeaders: true, serverTool: { name: "web_search", resultType: "web_search_result", resultPath: "/results" },
};
const PLAIN: HostedTool = {
  id: 6, name: "calc", description: "Do sums", parameters: SAMPLE_SCHEMA, url: "https://calc.example/run", bodyTemplate: { tool: "{{tool.name}}" },
  resultPath: "", timeoutMs: 30000, maxResultBytes: 65536, enabled: true, headerNames: [], hasHeaders: false,
};
const toolsPage = async (routes: Routes = {}) => {
  const api = mockApi({ "GET /tools": { tools: [SEARCH, PLAIN] }, ...routes }, ADMIN);
  const view = await renderPage(<Tools />);
  if (!("GET /tools" in routes)) await screen.findByText("calc");
  return { api, ...view };
};
const cardOf = (name: string) => screen.getByText(name).closest("article") as HTMLElement;
const t = (lang: "en" | "zh", key: string): string => {
  const v = I18N[lang][key];
  if (v === undefined) throw new Error(`no i18n key ${key}`);
  return v;
};

// ---------------------------------------------------------------------------
// WB1
// ---------------------------------------------------------------------------

describe("WB1: button classes on the Tools and Check pages", () => {
  const UNDEFINED_CLASSES = ".btn-secondary, .btn-sm";
  const css = read("index.css");
  const isDefined = (name: string) => new RegExp(`\\.${name}(?![A-Za-z0-9_-])`).test(css);

  it("index.css is readable and defines the classes the spec names as defined", () => {
    expect(isDefined("btn-ghost")).toBe(true);
    expect(isDefined("btn-primary")).toBe(true);
    // A made-up name is reported as undefined (the scan can fail).
    expect(isDefined("btn-does-not-exist")).toBe(false);
  });

  it("every btn-* class used anywhere in web/src is defined in index.css", () => {
    const used = new Map<string, string>();
    for (const file of sourceFiles(SRC)) {
      for (const m of fs.readFileSync(file, "utf8").matchAll(/(?<![A-Za-z0-9_-])btn-[a-z0-9]+(?:-[a-z0-9]+)*(?![A-Za-z0-9_-])/g)) {
        if (!used.has(m[0])) used.set(m[0], path.relative(SRC, file));
      }
    }
    expect(used.size).toBeGreaterThan(2);
    const missing = [...used].filter(([name]) => !isDefined(name)).map(([name, file]) => `${name} (${file})`);
    expect(missing).toEqual([]);
  });

  it.each(["pages/Tools.tsx", "pages/Check.tsx"])("%s does not mention btn-secondary or btn-sm", (file) => {
    const text = read(file);
    expect(text).not.toMatch(/(?<![A-Za-z0-9_-])btn-secondary(?![A-Za-z0-9_-])/);
    expect(text).not.toMatch(/(?<![A-Za-z0-9_-])btn-sm(?![A-Za-z0-9_-])/);
  });

  it("Tools list: no btn-secondary / btn-sm element; Edit and Delete are btn-ghost", async () => {
    await toolsPage();
    expect(document.querySelectorAll(UNDEFINED_CLASSES)).toHaveLength(0);
    for (const name of ["search", "calc"]) {
      expect(button("Edit", cardOf(name)).classList.contains("btn-ghost")).toBe(true);
      expect(button("Delete", cardOf(name)).classList.contains("btn-ghost")).toBe(true);
    }
    // Unchanged neighbour: the page's main action keeps its primary class.
    expect(button("Register tool").classList.contains("btn-primary")).toBe(true);
  });

  it("Tools editor: no btn-secondary / btn-sm element; Preview and Cancel are btn-ghost, Save stays primary", async () => {
    await toolsPage({ "POST /tools/preview": { request: {}, result: {} } });
    fireEvent.click(button("Edit", cardOf("search")));
    const m = openModal("Edit search");
    fireEvent.click(toggle("Round-trip as a server tool", m));
    fireEvent.click(button("Preview", m));
    await waitFor(() => expect(m.querySelector("pre")).not.toBeNull());
    expect(document.querySelectorAll(UNDEFINED_CLASSES)).toHaveLength(0);
    expect(button("Preview", m).classList.contains("btn-ghost")).toBe(true);
    expect(button("Cancel", m).classList.contains("btn-ghost")).toBe(true);
    expect(button("Save tool", m).classList.contains("btn-primary")).toBe(true);
  });

  it("Tools empty state and delete dialog: no btn-secondary / btn-sm element", async () => {
    await toolsPage();
    fireEvent.click(button("Delete", cardOf("search")));
    expect(openModal("Delete tool")).toBeTruthy();
    expect(document.querySelectorAll(UNDEFINED_CLASSES)).toHaveLength(0);
    cleanup();
    await toolsPage({ "GET /tools": { tools: [] } });
    await screen.findByText("Make an HTTP API available to your model");
    expect(document.querySelectorAll(UNDEFINED_CLASSES)).toHaveLength(0);
  });

  it("every button class on the Tools page (list and editor) that starts with btn- is defined", async () => {
    await toolsPage();
    fireEvent.click(button("Edit", cardOf("search")));
    const names = new Set([...document.querySelectorAll("button")].flatMap((b) => [...b.classList]).filter((c) => c.startsWith("btn-")));
    expect(names.size).toBeGreaterThan(0);
    expect([...names].filter((n) => !isDefined(n))).toEqual([]);
  });

  it("Check page: no btn-secondary / btn-sm element in the form, the result view or the error view", async () => {
    vi.useRealTimers();
    const result = {
      key: { name: "laptop", scopeServiceCount: 0, maxRequests: 100, maxTokens: null, usedRequests: 5, usedTokens: 1234, expiresAt: null, enabled: true, createdAt: 1 },
      status: { valid: true, expired: false, requestsExceeded: false, tokensExceeded: false, checkedAt: Date.now() },
    };
    const api = mockApi({ "POST /check": result });
    const view = await renderPage(<Check />);
    const defined = () => [...document.querySelectorAll("button, a")].flatMap((b) => [...b.classList]).filter((c) => c.startsWith("btn-")).filter((n) => !isDefined(n));
    expect(document.querySelectorAll(UNDEFINED_CLASSES)).toHaveLength(0);
    expect(defined()).toEqual([]);
    type(view.container.querySelector("input")!, "sk-secret-key-1234567890");
    fireEvent.submit(view.container.querySelector("form")!);
    await screen.findByText("Details");
    expect(hasButton("Check another")).toBe(true);
    expect(document.querySelectorAll(UNDEFINED_CLASSES)).toHaveLength(0);
    expect(defined()).toEqual([]);
    view.unmount();
    cleanup();

    api.on("POST /check", fail(401, { error: "invalid key" }));
    const again = await renderPage(<Check />);
    type(again.container.querySelector("input")!, "sk-bad");
    fireEvent.submit(again.container.querySelector("form")!);
    await screen.findByText("invalid key");
    expect(document.querySelectorAll(UNDEFINED_CLASSES)).toHaveLength(0);
    expect(defined()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// WB2
// ---------------------------------------------------------------------------

describe("WB2: Tools page, hosted-tool binding and the Responses card follow the UI language", () => {
  it("the i18n tables were read: both languages carry the keys under test", () => {
    for (const lang of ["en", "zh"] as const) {
      expect(Object.keys(I18N[lang]).filter((k) => k.startsWith("tools.")).length).toBeGreaterThan(20);
      expect(Object.keys(I18N[lang]).filter((k) => k.startsWith("hostedTools.")).length).toBeGreaterThan(5);
      expect(Object.keys(I18N[lang]).filter((k) => k.startsWith("settings.responseRetention")).length).toBeGreaterThanOrEqual(4);
    }
    expect(t("en", "tools.title")).toBe("Server tools");
    expect(CJK.test(t("zh", "tools.title"))).toBe(true);
  });

  it("source scan: no hard-coded bilingual ternary (`zh ?`) in the three files", () => {
    const files = ["pages/Tools.tsx", "components/HostedToolBinding.tsx", "pages/Settings.tsx"];
    // Whichever other source file renders the Responses card's strings is scanned as well.
    for (const file of sourceFiles(SRC)) {
      const rel = path.relative(SRC, file);
      if (rel !== path.join("lib", "i18n.tsx") && fs.readFileSync(file, "utf8").includes("settings.responseRetention") && !files.includes(rel)) files.push(rel);
    }
    const offenders = files.filter((file) => /\bzh\s*\?(?!\.)/.test(read(file)));
    expect(offenders).toEqual([]);
  });

  /** Put the Tools page into the state that shows the most strings. */
  const showEverything = async (routes: Routes, lang: "en" | "zh") => {
    await toolsPage(routes);
    fireEvent.click(button(t(lang, "tools.action.register")));
    const m = openModal(t(lang, "tools.modal.createTitle"));
    fireEvent.click(toggle(t(lang, "tools.serverTool.toggle"), m));
    return m;
  };
  /** Keys under a prefix whose English text is on screen right now. */
  const shownKeys = (prefixes: string[]): string[] =>
    Object.keys(I18N.en).filter((k) => prefixes.some((p) => k.startsWith(p)) && !interpolated(I18N.en[k]) && pageText().includes(I18N.en[k]));

  it("Tools page in English: English strings from the table, and not one Chinese character", async () => {
    const m = await showEverything({}, "en");
    expect(document.querySelector("h1")!.textContent).toBe("Server tools");
    for (const key of [
      "tools.subtitle", "tools.action.register", "tools.state.enabled", "tools.state.disabled", "tools.form.name", "tools.form.description",
      "tools.form.headers", "tools.form.headers.hint", "tools.form.schema", "tools.form.template", "tools.form.template.hint", "tools.form.resultPath",
      "tools.form.timeoutMs", "tools.form.maxResultBytes", "tools.serverTool.summary", "tools.serverTool.toggle", "tools.serverTool.name",
      "tools.serverTool.resultType", "tools.serverTool.resultPath", "tools.preview.summary", "tools.preview.arguments", "tools.preview.result",
      "tools.preview.run", "tools.form.enabled", "tools.action.save",
    ]) expect(pageText(), key).toContain(t("en", key));
    expect(hasButton("Cancel", m)).toBe(true);
    expect(CJK.test(pageText())).toBe(false);
  });

  it("Tools page in Chinese: every table string the English page shows appears in its Chinese form", async () => {
    await showEverything({}, "en");
    const keys = shownKeys(["tools."]);
    expect(keys.length).toBeGreaterThanOrEqual(25);
    cleanup();
    vi.unstubAllGlobals();

    await showEverything(ZH, "zh");
    const text = pageText();
    expect(document.querySelector("h1")!.textContent).toBe(t("zh", "tools.title"));
    const missing = keys.filter((k) => !text.includes(I18N.zh[k]));
    expect(missing).toEqual([]);
    // ...and its English form is gone (unless the Chinese text legitimately contains it).
    const leftovers = keys.filter((k) => I18N.en[k] !== I18N.zh[k] && !I18N.zh[k].includes(I18N.en[k]) && I18N.en[k].length > 12 && text.includes(I18N.en[k]));
    expect(leftovers).toEqual([]);
    // The generic actions are translated as well.
    expect(hasButton(t("zh", "common.cancel"))).toBe(true);
    expect(hasButton("Cancel")).toBe(false);
  });

  it("Tools list and empty state in Chinese: state labels, row actions, empty card", async () => {
    await toolsPage(ZH);
    expect(cardOf("search").textContent).toContain(t("zh", "tools.state.disabled"));
    expect(cardOf("calc").textContent).toContain(t("zh", "tools.state.enabled"));
    expect(hasButton(t("zh", "common.edit"), cardOf("search"))).toBe(true);
    expect(hasButton(t("zh", "common.delete"), cardOf("search"))).toBe(true);
    expect(hasButton("Edit")).toBe(false);
    expect(hasButton("Delete")).toBe(false);
    fireEvent.click(button(t("zh", "common.delete"), cardOf("search")));
    expect(openModal(t("zh", "tools.confirm.deleteTitle")).textContent).toContain(t("zh", "tools.confirm.deleteBody").replace("{name}", "search"));
    cleanup();
    vi.unstubAllGlobals();

    await toolsPage({ ...ZH, "GET /tools": { tools: [] } });
    await screen.findByText(t("zh", "tools.empty.title"));
    expect(pageText()).toContain(t("zh", "tools.empty.hint"));
    expect(pageText()).not.toContain("Make an HTTP API available to your model");
  });

  it("Tools toasts are translated: saved and deleted, both languages", async () => {
    const run = async (lang: "en" | "zh") => {
      const { api } = await toolsPage({ ...(lang === "zh" ? ZH : {}), "PATCH /tools/5": {}, "DELETE /tools/5": { ok: true } });
      fireEvent.click(button(t(lang, "common.edit"), cardOf("search")));
      fireEvent.click(button(t(lang, "tools.action.save")));
      await toastShown(t(lang, "tools.toast.saved"));
      await waitFor(() => expect(api.sent("GET", "/tools")).toHaveLength(2));
      fireEvent.click(button(t(lang, "common.delete"), cardOf("search")));
      fireEvent.click(button(t(lang, "common.confirm"), openModal(t(lang, "tools.confirm.deleteTitle"))));
      await toastShown(t(lang, "tools.toast.deleted"));
      cleanup();
      vi.unstubAllGlobals();
    };
    await run("en");
    await run("zh");
  });

  const tool = (id: number, name: string, enabled = true): HostedTool => ({
    id, name, enabled, description: "", parameters: {}, url: "https://t.example/x", bodyTemplate: {}, resultPath: "/result",
    timeoutMs: 30000, maxResultBytes: 65536, headerNames: [], hasHeaders: false,
  });
  const CONFIG: HostedToolOptions = { streamMode: "progress", maxRounds: 4, maxCalls: 8 };
  const binding = async (tools: HostedTool[], routes: Routes = {}) => {
    mockApi(routes, ADMIN);
    return renderPage(<HostedToolBinding tools={tools} ids={[]} config={CONFIG} onIds={() => {}} onConfig={() => {}} />);
  };
  const BINDING_KEYS = [
    "hostedTools.title", "hostedTools.hint", "hostedTools.stream", "hostedTools.stream.hint", "hostedTools.stream.all", "hostedTools.stream.progress",
    "hostedTools.stream.final", "hostedTools.maxRounds", "hostedTools.maxCalls",
  ];

  it.each(["en", "zh"] as const)("hosted-tool binding in %s: every string from that language's table", async (lang) => {
    await binding([tool(1, "search"), tool(2, "fetch", false)], lang === "zh" ? ZH : {});
    await waitFor(() => expect(pageText()).toContain(t(lang, "hostedTools.title")));
    for (const key of [...BINDING_KEYS, "hostedTools.disabled"]) expect(pageText(), key).toContain(t(lang, key));
    const other = lang === "en" ? "zh" : "en";
    for (const key of BINDING_KEYS) expect(pageText(), key).not.toContain(t(other, key));
    if (lang === "en") expect(CJK.test(pageText())).toBe(false);
    cleanup();
    vi.unstubAllGlobals();

    await binding([], lang === "zh" ? ZH : {});
    await waitFor(() => expect(pageText()).toContain(t(lang, "hostedTools.register")));
    expect(pageText()).not.toContain(t(other, "hostedTools.register"));
  });

  it.each(["en", "zh"] as const)("Settings 'Responses and tool session history' card in %s: title, hint, label, Save and its toasts", async (lang) => {
    const api = mockApi({ ...SETTINGS_ROUTES, ...(lang === "zh" ? ZH : {}), "PUT /settings/response-retention": { days: 14 } }, ADMIN);
    await renderPage(<Settings />);
    await flush();
    const c = settingsCard(t(lang, "settings.responseRetention"));
    const other = lang === "en" ? "zh" : "en";
    expect(c.textContent).toContain(t(lang, "settings.responseRetention.hint"));
    expect(c.textContent).toContain(t(lang, "settings.responseRetention.days"));
    for (const key of ["settings.responseRetention", "settings.responseRetention.hint", "settings.responseRetention.days"]) {
      expect(c.textContent, key).not.toContain(t(other, key));
    }
    if (lang === "en") expect(CJK.test(c.textContent ?? "")).toBe(false);
    const save = button(t(lang, "common.save"), c);
    fireEvent.click(save);
    await toastShown(t(lang, "settings.responseRetention.toast.saved"));
    expect(api.sent("PUT", "/settings/response-retention")).toHaveLength(1);

    // A network failure falls back to the translated "Save failed".
    api.on("PUT /settings/response-retention", offline);
    fireEvent.click(save);
    await toastShown(t(lang, "common.saveFailed"));
    // Every toast of this card is in the page's language.
    for (const text of toasts()) expect(CJK.test(text), text).toBe(lang === "zh");
  });
});

// ---------------------------------------------------------------------------
// WB7
// ---------------------------------------------------------------------------

describe("WB7: Tools editor timeout / max bytes", () => {
  const TIMEOUT = "Timeout (ms)";
  const MAX_BYTES = "Maximum response bytes";
  const KEY = { [TIMEOUT]: "timeoutMs", [MAX_BYTES]: "maxResultBytes" } as const;
  type Label = keyof typeof KEY;
  const openNew = async () => {
    const r = await toolsPage({ "POST /tools": { tool: {} }, "PATCH /tools/5": { tool: {} } });
    fireEvent.click(button("Register tool"));
    const m = openModal("Register server tool");
    type(field("Tool name", m), "lookup");
    return { ...r, m };
  };
  const saved = async (api: MockApi, m: HTMLElement): Promise<Record<string, unknown>> => {
    fireEvent.click(button("Save tool", m));
    await waitFor(() => expect(api.mutations()).toHaveLength(1));
    return api.mutations()[0].body as Record<string, unknown>;
  };

  it.each<[Label]>([[TIMEOUT], [MAX_BYTES]])("%s: a cleared field saves the default a fresh form shows, never 0 or less than the minimum", async (label) => {
    const { api, m } = await openNew();
    const input = field(label, m);
    const fallback = Number(input.value);
    const min = Number(input.min);
    // The fresh form's default is a usable value to begin with.
    expect(Number.isInteger(fallback) && fallback >= min && min >= 1).toBe(true);
    type(input, "");
    const body = await saved(api, m);
    expect(body[KEY[label]]).not.toBe(0);
    expect(body[KEY[label]]).toBe(fallback);
  });

  it("both fields cleared at once: both defaults are sent", async () => {
    const { api, m } = await openNew();
    const defaults = { timeoutMs: Number(field(TIMEOUT, m).value), maxResultBytes: Number(field(MAX_BYTES, m).value) };
    type(field(TIMEOUT, m), "");
    type(field(MAX_BYTES, m), "");
    expect(await saved(api, m)).toMatchObject(defaults);
  });

  it.each<[Label]>([[TIMEOUT], [MAX_BYTES]])("%s: clearing the field of an existing tool does not save 0 or a value below the minimum", async (label) => {
    const { api } = await toolsPage({ "PATCH /tools/5": { tool: {} } });
    fireEvent.click(button("Edit", cardOf("search")));
    const m = openModal("Edit search");
    const input = field(label, m);
    const [min, max] = [Number(input.min), Number(input.max)];
    type(input, "");
    const value = (await saved(api, m))[KEY[label]] as number;
    expect(typeof value).toBe("number");
    expect(value).not.toBe(0);
    expect(value).toBeGreaterThanOrEqual(min);
    expect(value).toBeLessThanOrEqual(max);
  });

  it.each<[Label, string, string]>([
    [TIMEOUT, "the minimum", "min"], [TIMEOUT, "the maximum", "max"], [TIMEOUT, "a typical value", "1500"],
    [MAX_BYTES, "the minimum", "min"], [MAX_BYTES, "the maximum", "max"], [MAX_BYTES, "a typical value", "2048"],
  ])("%s: %s is sent as typed", async (label, _name, which) => {
    const { api, m } = await openNew();
    const input = field(label, m);
    const typed = which === "min" ? input.min : which === "max" ? input.max : which;
    type(input, typed);
    expect((await saved(api, m))[KEY[label]]).toBe(Number(typed));
  });

  it.each<[Label, string, number]>([
    [TIMEOUT, "one above the maximum", 1], [TIMEOUT, "far above the maximum", 10_000_000],
    [MAX_BYTES, "one above the maximum", 1], [MAX_BYTES, "far above the maximum", 10_000_000],
  ])("%s: %s is capped at the maximum", async (label, _name, excess) => {
    const { api, m } = await openNew();
    const input = field(label, m);
    const max = Number(input.max);
    expect(max).toBeGreaterThan(0);
    type(input, String(max + excess));
    expect((await saved(api, m))[KEY[label]]).toBe(max);
  });

  it("the declared ranges are the documented ones (so the caps above are meaningful)", async () => {
    const { m } = await openNew();
    expect([field(TIMEOUT, m).min, field(TIMEOUT, m).max]).toEqual(["100", "600000"]);
    expect([field(MAX_BYTES, m).min, field(MAX_BYTES, m).max]).toEqual(["1", "1048576"]);
  });
});

describe("WB7: hosted-tool rounds / calls", () => {
  const ROUNDS = "Maximum model rounds";
  const CALLS = "Maximum tool calls";
  const KEY = { [ROUNDS]: "maxRounds", [CALLS]: "maxCalls" } as const;
  type Label = keyof typeof KEY;
  const model = (id: number, name: string): Model => ({ id, name, description: null, enabled: true, createdAt: id });
  const provider = (id: number, name: string): Provider => ({ id, name, type: "openai_completion", baseUrl: "https://x", hasKey: true, extraHeaders: null, maxOutputTokens: null, enabled: true, createdAt: id });
  const MODELS = [model(1, "sonnet")];
  const PROVIDERS = [provider(1, "openai")];
  const MAPPINGS: Mapping[] = [{ id: 1, modelId: 1, providerId: 1, upstreamModel: "up", priority: 0, enabled: true }];
  const TOOL: HostedTool = { id: 1, name: "search", description: "", parameters: {}, url: "https://t", bodyTemplate: null, resultPath: "", timeoutMs: 1000, maxResultBytes: 1000, enabled: true, headerNames: [], hasHeaders: false };
  const STORED: ServiceDef = { timeoutMs: 60000, steps: [{ model: "sonnet", provider: "openai" }], hostedTools: { streamMode: "all", maxRounds: 4, maxCalls: 9 } };
  const SERVICE: ModelService = { id: 5, name: "svc", description: null, steps: STORED, enabled: true, summary: "", createdAt: 5, toolIds: [1] };
  const editor = async (service: ModelService | null) => {
    const api = mockApi({ "GET /tools": { tools: [TOOL] }, "POST /services": {}, "PATCH /services/5": {} }, ADMIN);
    await renderPage(<ServiceEditor open service={service} services={[]} models={MODELS} providers={PROVIDERS} mappings={MAPPINGS} onClose={() => {}} onSaved={() => {}} />);
    await screen.findByText("Hosted server tools");
    if (!service) type(field("Name (exposed model name)"), "fresh");
    return api;
  };
  const savedTools = async (api: MockApi): Promise<Record<string, unknown>> => {
    fireEvent.click(button("Save"));
    await waitFor(() => expect(api.mutations()).toHaveLength(1));
    const steps = (api.mutations()[0].body as { steps: { hostedTools?: Record<string, unknown> } }).steps;
    expect(steps.hostedTools).toBeDefined();
    return steps.hostedTools!;
  };

  it.each<[Label]>([[ROUNDS], [CALLS]])("%s: a cleared field on a new service saves the default the fresh form shows, never 0", async (label) => {
    const api = await editor(null);
    const input = field(label);
    const fallback = Number(input.value);
    expect(Number.isInteger(fallback) && fallback >= Number(input.min) && Number(input.min) >= 1).toBe(true);
    type(input, "");
    const tools = await savedTools(api);
    expect(tools[KEY[label]]).not.toBe(0);
    expect(tools[KEY[label]]).toBe(fallback);
  });

  it.each<[Label]>([[ROUNDS], [CALLS]])("%s: clearing a stored value does not save 0 or a value below the minimum", async (label) => {
    const api = await editor(SERVICE);
    const input = field(label);
    const [min, max] = [Number(input.min), Number(input.max)];
    type(input, "");
    const value = (await savedTools(api))[KEY[label]] as number;
    expect(typeof value).toBe("number");
    expect(value).not.toBe(0);
    expect(value).toBeGreaterThanOrEqual(min);
    expect(value).toBeLessThanOrEqual(max);
  });

  it.each<[Label, string, string]>([
    [ROUNDS, "the minimum", "min"], [ROUNDS, "the maximum", "max"], [ROUNDS, "a typical value", "12"],
    [CALLS, "the minimum", "min"], [CALLS, "the maximum", "max"], [CALLS, "a typical value", "40"],
  ])("%s: %s is sent as typed, and the other limit is untouched", async (label, _name, which) => {
    const api = await editor(SERVICE);
    const input = field(label);
    const typed = which === "min" ? input.min : which === "max" ? input.max : which;
    type(input, typed);
    expect(await savedTools(api)).toEqual({ streamMode: "all", maxRounds: 4, maxCalls: 9, [KEY[label]]: Number(typed) });
  });

  it.each<[Label, string, number]>([
    [ROUNDS, "one above the maximum", 1], [ROUNDS, "far above the maximum", 100_000],
    [CALLS, "one above the maximum", 1], [CALLS, "far above the maximum", 100_000],
  ])("%s: %s is capped at the maximum", async (label, _name, excess) => {
    const api = await editor(SERVICE);
    const input = field(label);
    const max = Number(input.max);
    expect(max).toBeGreaterThan(0);
    type(input, String(max + excess));
    expect((await savedTools(api))[KEY[label]]).toBe(max);
  });

  it("the binding itself never reports a limit of 0, below its minimum or above its maximum", async () => {
    mockApi({}, ADMIN);
    const onConfig = vi.fn<(c: HostedToolOptions) => void>();
    const view = await renderPage(<HostedToolBinding tools={[]} ids={[]} config={{ streamMode: "progress", maxRounds: 4, maxCalls: 8 }} onIds={() => {}} onConfig={onConfig} />);
    for (const [label, key] of [[ROUNDS, "maxRounds"], [CALLS, "maxCalls"]] as const) {
      const input = field(label, view.container);
      const [min, max] = [Number(input.min), Number(input.max)];
      for (const typed of ["", "0", String(max + 1)]) {
        fireEvent.change(input, { target: { value: typed } });
        fireEvent.blur(input);
      }
      for (const [config] of onConfig.mock.calls) {
        expect(config[key]).toBeGreaterThanOrEqual(min);
        expect(config[key]).toBeLessThanOrEqual(max);
      }
    }
    await act(async () => {});
  });
});

// ---------------------------------------------------------------------------
// WB8
// ---------------------------------------------------------------------------

describe("WB8: Tools feedback", () => {
  const confirmDelete = (lang: "en" | "zh" = "en") => {
    fireEvent.click(button(t(lang, "common.delete"), cardOf("search")));
    fireEvent.click(button(t(lang, "common.confirm"), openModal(t(lang, "tools.confirm.deleteTitle"))));
  };
  /** Wait until `text` is on screen, as a toast or as an inline note. */
  const shown = (text: string) => waitFor(() => expect(pageText()).toContain(text));

  it("a successful delete shows the success toast and reloads", async () => {
    const { api } = await toolsPage({ "DELETE /tools/5": { ok: true } });
    confirmDelete();
    await toastShown("Tool deleted");
    await waitFor(() => expect(api.sent("GET", "/tools")).toHaveLength(2));
    expect(api.mutations().map((c) => `${c.method} ${c.path}`)).toEqual(["DELETE /tools/5"]);
  });

  it("a cancelled delete shows no toast (unchanged)", async () => {
    const { api } = await toolsPage({ "DELETE /tools/5": { ok: true } });
    fireEvent.click(button("Delete", cardOf("search")));
    await act(async () => { fireEvent.click(button("Cancel", openModal("Delete tool"))); });
    expect(api.mutations()).toEqual([]);
    expect(toasts()).toEqual([]);
  });

  it("a delete that fails on the network toasts 'Delete failed', not the browser's message, and no success toast", async () => {
    await toolsPage({ "DELETE /tools/5": offline });
    confirmDelete();
    await toastShown("Delete failed");
    expect(pageText()).not.toContain("Failed to fetch");
    expect(toasts()).not.toContain("Tool deleted");
  });

  it("a refused delete shows the server's message as is", async () => {
    await toolsPage({ "DELETE /tools/5": fail(409, { error: "tool is bound to a service" }) });
    confirmDelete();
    await toastShown("tool is bound to a service");
    expect(toasts()).not.toContain("Delete failed");
    expect(toasts()).not.toContain("Tool deleted");
  });

  it.each([
    ["creating", "POST /tools", () => { fireEvent.click(button("Register tool")); return openModal("Register server tool"); }],
    ["editing", "PATCH /tools/5", () => { fireEvent.click(button("Edit", cardOf("search"))); return openModal("Edit search"); }],
  ])("a save that fails on the network while %s shows 'Save failed', not the browser's message, and keeps the editor", async (_name, route, open) => {
    await toolsPage({ [route]: offline });
    const m = open();
    fireEvent.click(button("Save tool", m));
    await shown("Save failed");
    expect(pageText()).not.toContain("Failed to fetch");
    expect(toasts()).not.toContain("Tool saved");
    expect(m.isConnected).toBe(true);
  });

  it("a refused save shows the server's message as is", async () => {
    await toolsPage({ "POST /tools": fail(400, { error: "name must match [a-zA-Z0-9_-]" }) });
    fireEvent.click(button("Register tool"));
    fireEvent.click(button("Save tool", openModal("Register server tool")));
    await shown("name must match [a-zA-Z0-9_-]");
    expect(pageText()).not.toContain("Save failed");
  });

  it("a successful save still toasts 'Tool saved' (unchanged)", async () => {
    await toolsPage({ "POST /tools": { tool: {} } });
    fireEvent.click(button("Register tool"));
    fireEvent.click(button("Save tool", openModal("Register server tool")));
    await toastShown("Tool saved");
    expect(modal("Register server tool")).toBeNull();
  });

  it("a preview that fails on the network shows 'Preview failed', not the browser's message", async () => {
    await toolsPage({ "POST /tools/preview": offline });
    fireEvent.click(button("Edit", cardOf("search")));
    const m = openModal("Edit search");
    fireEvent.click(button("Preview", m));
    await shown("Preview failed");
    expect(pageText()).not.toContain("Failed to fetch");
    expect(m.querySelector("pre")).toBeNull();
  });

  it("a refused preview shows the server's message as is", async () => {
    await toolsPage({ "POST /tools/preview": fail(400, { error: "resultPath does not resolve" }) });
    fireEvent.click(button("Edit", cardOf("search")));
    fireEvent.click(button("Preview", openModal("Edit search")));
    await shown("resultPath does not resolve");
    expect(pageText()).not.toContain("Preview failed");
  });

  it("the fallbacks are translated: Chinese UI shows the Chinese texts for delete, save and preview", async () => {
    await toolsPage({ ...ZH, "DELETE /tools/5": offline, "PATCH /tools/5": offline, "POST /tools/preview": offline });
    confirmDelete("zh");
    await toastShown(t("zh", "common.deleteFailed"));
    fireEvent.click(button(t("zh", "common.edit"), cardOf("search")));
    const m = openModal(t("zh", "tools.modal.editTitle").replace("{name}", "search"));
    fireEvent.click(button(t("zh", "tools.preview.run"), m));
    await shown(t("zh", "tools.preview.failed"));
    fireEvent.click(button(t("zh", "tools.action.save"), m));
    await shown(t("zh", "common.saveFailed"));
    for (const english of ["Failed to fetch", "Delete failed", "Save failed", "Preview failed"]) expect(pageText()).not.toContain(english);
  });
});
