/**
 * Independent verification, spec section WEB-B: WB4 and WB5 (API key form
 * validation) and WB10 (Settings cards). Expected values come from the spec
 * and the i18n tables only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Tokens } from "../src/pages/Tokens";
import type { ModelService, Token } from "../src/types";
import { ADMIN, button, deferred, fail, field, iconButton, mockApi, modal, openModal, renderPage, toastShown, toasts, type, type MockApi, type Routes } from "./helpers";
import { ALLOWLIST, ENV, ENV_BODY, RESPONSES, RETENTION, RUNTIME, card, flush, input, loaded, setup } from "./settings-harness";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const offline = () => { throw new TypeError("Failed to fetch"); };
const errorIn = (within: ParentNode) => within.querySelector(".border-red-900\\/50");
/** Give a wrongly sent request every chance to leave before asserting that none did. */
const settle = () => act(async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 20)); });

// ---------------------------------------------------------------------------
// WB4 / WB5
// ---------------------------------------------------------------------------

describe("Tokens form", () => {
  const service = (id: number, name: string): ModelService => ({
    id, name, description: null, steps: { timeoutMs: 60000, steps: [{ model: "sonnet", provider: "openai" }] }, enabled: true, summary: "", createdAt: id,
  });
  const EXPIRY = new Date(2027, 0, 2, 3, 4).getTime();
  const LAPTOP: Token = {
    id: 1, name: "laptop", keyPrefix: "hk_abc", ownerUserId: 1, scopeServices: null, maxRequests: null, maxTokens: null,
    usedRequests: 5, usedTokens: 1234, expiresAt: null, enabled: true, createdAt: 1, hasStoredKey: true,
  };
  const CI: Token = { ...LAPTOP, id: 2, name: "ci", keyPrefix: "hk_xyz", scopeServices: [10], expiresAt: EXPIRY, createdAt: 2 };
  const ISSUE = "Issue API key";
  const EDIT = "Edit API key";
  const CREATED = "API key created";
  const SCOPE_EMPTY = "Select at least one Model Service, or allow all";
  const BAD_EXPIRY = "Expiry is not a valid date and time";
  const ALL = "Allow all Model Services";
  const EXPIRES = "Expires at (optional)";
  const page = async (routes: Routes = {}) => {
    const api = mockApi({
      "GET /tokens": { tokens: [LAPTOP, CI] }, "GET /services": { services: [service(10, "svc-a"), service(11, "svc-b")] },
      "POST /tokens": { secret: "hk_live_SECRET", token: { id: 3 } }, "PATCH /tokens/1": { token: {} }, "PATCH /tokens/2": { token: {} }, ...routes,
    }, ADMIN);
    await renderPage(<Tokens />);
    await screen.findByText("laptop");
    return api;
  };
  const openIssue = () => {
    fireEvent.click(button(ISSUE));
    const m = openModal(ISSUE);
    type(field("Name", m), "phone");
    return m;
  };
  const openEdit = (name: string) => {
    fireEvent.click(button("Edit", screen.getByText(name).closest("tr")!));
    return openModal(EDIT);
  };
  const body = (api: MockApi) => api.mutations()[0].body as Record<string, unknown>;
  /**
   * Put a value into the expiry box that the control itself would not hand
   * out (a datetime-local box sanitises free text), the way a browser without
   * a native picker - or a pasted value - can.
   */
  const forceValue = (el: HTMLInputElement, value: string) => {
    Object.defineProperty(el, "value", { configurable: true, get: () => value, set: () => {} });
    fireEvent.change(el);
    fireEvent.input(el);
  };

  describe("WB4: scope", () => {
    it("issue: 'Allow all' unticked with no service selected sends nothing and toasts the validation text", async () => {
      const api = await page();
      const m = openIssue();
      fireEvent.click(field(ALL, m));
      expect([field("svc-a", m).checked, field("svc-b", m).checked]).toEqual([false, false]);
      fireEvent.click(button("Issue", m));
      await toastShown(SCOPE_EMPTY);
      await settle();
      expect(api.mutations()).toEqual([]);
      expect(modal(ISSUE)).not.toBeNull();
      expect(modal(CREATED)).toBeNull();
    });

    it("issue: ticking a service and unticking it again is still 'none selected'", async () => {
      const api = await page();
      const m = openIssue();
      fireEvent.click(field(ALL, m));
      fireEvent.click(field("svc-a", m));
      fireEvent.click(field("svc-a", m));
      fireEvent.click(button("Issue", m));
      await toastShown(SCOPE_EMPTY);
      await settle();
      expect(api.mutations()).toEqual([]);
    });

    it("edit: unticking the only scoped service sends nothing and toasts the validation text", async () => {
      const api = await page();
      const m = openEdit("ci");
      expect(field(ALL, m).checked).toBe(false);
      fireEvent.click(field("svc-a", m));
      fireEvent.click(button("Save", m));
      await toastShown(SCOPE_EMPTY);
      await settle();
      expect(api.mutations()).toEqual([]);
      expect(modal(EDIT)).not.toBeNull();
    });

    it("edit: unticking 'Allow all' on an unscoped key and saving sends nothing", async () => {
      const api = await page();
      const m = openEdit("laptop");
      fireEvent.click(field(ALL, m));
      fireEvent.click(button("Save", m));
      await toastShown(SCOPE_EMPTY);
      await settle();
      expect(api.mutations()).toEqual([]);
    });

    it("the validation toast is translated", async () => {
      const api = await page({ "GET /settings/ui-language": { language: "zh" } });
      await waitFor(() => expect(document.querySelector("h1")!.textContent).toBe("API 密钥"));
      fireEvent.click(button("签发 API 密钥"));
      const m = openModal("签发 API 密钥");
      type(field("名称", m), "phone");
      fireEvent.click(field("允许全部模型服务", m));
      fireEvent.click(button("签发", m));
      await toastShown("请至少选择一个模型服务，或允许全部");
      await settle();
      expect(api.mutations()).toEqual([]);
    });

    it("issue: one service ticked saves scopeServices: [id]", async () => {
      const api = await page();
      const m = openIssue();
      fireEvent.click(field(ALL, m));
      fireEvent.click(field("svc-b", m));
      fireEvent.click(button("Issue", m));
      await waitFor(() => expect(modal(CREATED)).not.toBeNull());
      expect(api.mutations().map((c) => `${c.method} ${c.path}`)).toEqual(["POST /tokens"]);
      expect(body(api).scopeServices).toEqual([11]);
      expect(toasts()).not.toContain(SCOPE_EMPTY);
    });

    it("issue: 'Allow all' saves scopeServices: null", async () => {
      const api = await page();
      fireEvent.click(button("Issue", openIssue()));
      await waitFor(() => expect(modal(CREATED)).not.toBeNull());
      expect(body(api).scopeServices).toBeNull();
    });

    it("issue: 'Allow all' re-ticked after a selection saves null, without a validation toast", async () => {
      const api = await page();
      const m = openIssue();
      fireEvent.click(field(ALL, m));
      fireEvent.click(field(ALL, m));
      fireEvent.click(button("Issue", m));
      await waitFor(() => expect(modal(CREATED)).not.toBeNull());
      expect(body(api).scopeServices).toBeNull();
      expect(toasts()).toEqual([]);
    });

    it("edit: one service ticked saves [id]; 'Allow all' saves null", async () => {
      const api = await page();
      let m = openEdit("laptop");
      fireEvent.click(field(ALL, m));
      fireEvent.click(field("svc-a", m));
      fireEvent.click(button("Save", m));
      await toastShown("API key updated");
      expect(body(api).scopeServices).toEqual([10]);
      await waitFor(() => expect(modal(EDIT)).toBeNull());

      m = openEdit("ci");
      fireEvent.click(field(ALL, m));
      fireEvent.click(button("Save", m));
      await waitFor(() => expect(api.mutations()).toHaveLength(2));
      expect((api.mutations()[1].body as Record<string, unknown>).scopeServices).toBeNull();
    });
  });

  describe("WB5: expiry", () => {
    it.each([
      ["free text", "tomorrow-ish"],
      ["a date with an impossible month", "2027-13-45T99:99"],
      ["a year beyond what a date can hold", "300000-01-01T00:00"],
    ])("issue: %s sends nothing and toasts the validation text", async (_name, value) => {
      const api = await page();
      const m = openIssue();
      forceValue(field(EXPIRES, m), value);
      fireEvent.click(button("Issue", m));
      await toastShown(BAD_EXPIRY);
      await settle();
      expect(api.mutations()).toEqual([]);
      expect(modal(ISSUE)).not.toBeNull();
      expect(modal(CREATED)).toBeNull();
    });

    it("edit: an unparsable expiry sends nothing (in particular not expiresAt: null) and toasts the validation text", async () => {
      const api = await page();
      const m = openEdit("ci");
      forceValue(field(EXPIRES, m), "not a date");
      fireEvent.click(button("Save", m));
      await toastShown(BAD_EXPIRY);
      await settle();
      expect(api.mutations()).toEqual([]);
      expect(modal(EDIT)).not.toBeNull();
    });

    it("issue: an empty expiry saves 'never expires' (null)", async () => {
      const api = await page();
      const m = openIssue();
      expect(field(EXPIRES, m).value).toBe("");
      fireEvent.click(button("Issue", m));
      await waitFor(() => expect(modal(CREATED)).not.toBeNull());
      expect(body(api).expiresAt).toBeNull();
      expect(toasts()).toEqual([]);
    });

    it("edit: clearing a stored expiry saves null", async () => {
      const api = await page();
      const m = openEdit("ci");
      expect(field(EXPIRES, m).value).toBe("2027-01-02T03:04");
      type(field(EXPIRES, m), "");
      fireEvent.click(button("Save", m));
      await toastShown("API key updated");
      expect(body(api).expiresAt).toBeNull();
    });

    it("issue: a valid date saves its time", async () => {
      const api = await page();
      const m = openIssue();
      type(field(EXPIRES, m), "2027-01-02T03:04");
      fireEvent.click(button("Issue", m));
      await waitFor(() => expect(modal(CREATED)).not.toBeNull());
      expect(body(api).expiresAt).toBe(EXPIRY);
    });

    it("edit: a changed valid date saves its time, an untouched one the stored time", async () => {
      const api = await page();
      let m = openEdit("ci");
      type(field(EXPIRES, m), "2028-06-07T08:09");
      fireEvent.click(button("Save", m));
      await toastShown("API key updated");
      expect(body(api).expiresAt).toBe(new Date(2028, 5, 7, 8, 9).getTime());
      await waitFor(() => expect(modal(EDIT)).toBeNull());

      m = openEdit("ci");
      fireEvent.click(button("Save", m));
      await waitFor(() => expect(api.mutations()).toHaveLength(2));
      expect((api.mutations()[1].body as Record<string, unknown>).expiresAt).toBe(EXPIRY);
    });
  });
});

// ---------------------------------------------------------------------------
// WB10
// ---------------------------------------------------------------------------

describe("WB10(a): Settings log retention", () => {
  const PATH = "/settings/log-retention";
  const save = () => button("Save", card(RETENTION));

  it.each([
    ["the server's message", fail(500, { error: "db down" }), "db down"],
    ["a network failure", offline, null],
  ])("shows an error in the card when loading fails with %s, and Save stays disabled", async (_name, handler, text) => {
    const { api } = await loaded({ [`GET ${PATH}`]: handler });
    const note = errorIn(card(RETENTION));
    expect(note).not.toBeNull();
    expect((note!.textContent ?? "").length).toBeGreaterThan(0);
    if (text) expect(note!.textContent).toBe(text);
    expect(save().disabled).toBe(true);
    fireEvent.click(save());
    await settle();
    expect(api.mutations()).toEqual([]);
  });

  it("Save is disabled while the stored value is loading, and pressing it sends nothing (no days: 0)", async () => {
    const gate = deferred<unknown>();
    const { api } = await setup({ [`GET ${PATH}`]: () => gate.promise, [`PUT ${PATH}`]: { days: 0, pruned: 0 } });
    await flush();
    expect(save().disabled).toBe(true);
    fireEvent.click(save());
    fireEvent.keyDown(input(RETENTION), { key: "Enter" });
    await settle();
    expect(api.mutations()).toEqual([]);
    expect(errorIn(card(RETENTION))).toBeNull();

    await act(async () => { gate.resolve({ days: 7 }); });
    await flush();
    expect(input(RETENTION).value).toBe("7");
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await waitFor(() => expect(api.mutations()).toHaveLength(1));
    expect(api.mutations()[0].body).toEqual({ days: 7 });
  });

  it("a successful load shows no error and saves the typed value (unchanged)", async () => {
    const { api } = await loaded({ [`PUT ${PATH}`]: { days: 12, pruned: 0 } });
    expect(errorIn(card(RETENTION))).toBeNull();
    expect(save().disabled).toBe(false);
    type(input(RETENTION), "12");
    fireEvent.click(save());
    await toastShown("Keeping the last 12 days");
    expect(api.mutations()[0].body).toEqual({ days: 12 });
  });
});

describe("WB10(b): Settings allowlist", () => {
  const PATH = "/settings/upstream-allowlist";
  const chips = () => [...card(ALLOWLIST).querySelectorAll(".font-mono.inline-flex")].map((c) => c.textContent);
  const add = (value: string) => {
    type(input(ALLOWLIST), value);
    fireEvent.click(button("Add", card(ALLOWLIST)));
  };

  it.each([
    ["the server's message", fail(500, { error: "db down" }), "db down"],
    ["a network failure", offline, null],
  ])("shows an error in the card when loading fails with %s", async (_name, handler, text) => {
    await loaded({ [`GET ${PATH}`]: handler });
    const note = errorIn(card(ALLOWLIST));
    expect(note).not.toBeNull();
    expect((note!.textContent ?? "").length).toBeGreaterThan(0);
    if (text) expect(note!.textContent).toBe(text);
    // A failed load is not presented as an empty list.
    expect(screen.queryByText("No entries — all private hosts blocked.")).toBeNull();
  });

  it.each([
    ["the server refuses it", fail(400, { error: "not a valid CIDR" }), "not a valid CIDR"],
    ["the network fails", offline, "Save failed"],
  ])("when adding an entry fails because %s, the typed entry stays in the input", async (_name, handler, text) => {
    const { api } = await loaded({ [`PUT ${PATH}`]: handler });
    add("192.168.1.10/33");
    await toastShown(text);
    await flush();
    expect(api.sent("PUT", PATH)).toHaveLength(1);
    expect(input(ALLOWLIST).value).toBe("192.168.1.10/33");
    expect(chips()).toEqual(["10.0.0.0/8", "nas.local"]);
  });

  it("when adding with Enter fails, the typed entry stays as well", async () => {
    await loaded({ [`PUT ${PATH}`]: fail(400, { error: "not a valid CIDR" }) });
    type(input(ALLOWLIST), "10.0.0.0/");
    fireEvent.keyDown(input(ALLOWLIST), { key: "Enter" });
    await toastShown("not a valid CIDR");
    await flush();
    expect(input(ALLOWLIST).value).toBe("10.0.0.0/");
  });

  it("a successful add still empties the input and a successful load shows no error (unchanged)", async () => {
    const { api } = await loaded({ [`PUT ${PATH}`]: { entries: [] } });
    expect(errorIn(card(ALLOWLIST))).toBeNull();
    expect(chips()).toEqual(["10.0.0.0/8", "nas.local"]);
    add("192.168.1.10");
    await toastShown("Allowlist updated");
    await flush();
    expect(api.mutations()[0].body).toEqual({ entries: ["10.0.0.0/8", "nas.local", "192.168.1.10"] });
    expect(input(ALLOWLIST).value).toBe("");
  });
});

describe("WB10(c): Settings Responses retention", () => {
  const PATH = "/settings/response-retention";
  const save = () => { fireEvent.click(button("Save", card(RESPONSES))); };

  it.each([
    ["just above the upper bound", "3651"],
    ["far above the upper bound", "100000"],
    ["just below the lower bound", "-1"],
    ["a fraction", "1.5"],
    ["a fraction inside the range's upper end", "3649.5"],
  ])("rejects %s (%s) with a toast and sends nothing", async (_name, typed) => {
    const { api } = await loaded({ [`PUT ${PATH}`]: { days: 0 } });
    type(input(RESPONSES), typed);
    save();
    await waitFor(() => expect(toasts().length).toBeGreaterThan(0));
    await settle();
    expect(api.mutations()).toEqual([]);
    expect(toasts()).not.toContain("Response retention saved");
  });

  it.each([
    ["the lower bound", "0", 0],
    ["one", "1", 1],
    ["a typical value", "45", 45],
    ["the upper bound", "3650", 3650],
  ])("accepts %s and sends it", async (_name, typed, days) => {
    const { api } = await loaded({ [`PUT ${PATH}`]: { days } });
    type(input(RESPONSES), typed);
    save();
    await toastShown("Response retention saved");
    expect(api.mutations().map((c) => [c.method, c.path, c.body])).toEqual([["PUT", PATH, { days }]]);
  });

  it("shows 'Save failed' for a network error, not the browser's message", async () => {
    await loaded({ [`PUT ${PATH}`]: offline });
    save();
    await toastShown("Save failed");
    expect(toasts()).not.toContain("Failed to fetch");
  });

  it("shows the server's message for a refused save (unchanged)", async () => {
    await loaded({ [`PUT ${PATH}`]: fail(400, { error: "days out of range" }) });
    save();
    await toastShown("days out of range");
    expect(toasts()).not.toContain("Save failed");
  });
});

describe("WB10(d): Settings prompt-cache TTL", () => {
  const PATH = "/settings/env";
  const CACHE_TTL = "Auto cache TTL (minutes, Anthropic breakpoint)";
  const INVALID = "Auto cache TTL must be a whole number between 1 and 1440 minutes";
  const env = () => card(RUNTIME);
  const save = () => { fireEvent.click(button("Save", env())); };

  it.each([
    ["zero (just below the lower bound)", "0"],
    ["just above the upper bound", "1441"],
    ["far above the upper bound", "100000"],
    ["a fraction", "1.5"],
    ["a fraction at the upper end", "1439.5"],
    ["empty", ""],
    ["only spaces", "   "],
    ["a negative number", "-1"],
  ])("rejects %s with its toast and sends nothing", async (_name, typed) => {
    const { api } = await loaded({ [`PUT ${PATH}`]: ENV });
    type(field(CACHE_TTL, env()), typed);
    save();
    await toastShown(INVALID);
    await settle();
    expect(api.mutations()).toEqual([]);
    expect(toasts()).not.toContain("Runtime settings saved");
  });

  it.each([
    ["the lower bound", "1", 1],
    ["a typical value", "60", 60],
    ["just below the upper bound", "1439", 1439],
    ["the upper bound", "1440", 1440],
  ])("accepts %s and sends it with the other values untouched", async (_name, typed, sent) => {
    const { api } = await loaded({ [`PUT ${PATH}`]: ENV });
    type(field(CACHE_TTL, env()), typed);
    save();
    await toastShown("Runtime settings saved");
    expect(api.mutations().map((c) => [c.method, c.path, c.body])).toEqual([["PUT", PATH, { ...ENV_BODY, promptCacheTtlMinutes: sent }]]);
  });

  it("the rejection toast is translated", async () => {
    const { api } = await loaded({ "GET /settings/ui-language": { language: "zh" }, [`PUT ${PATH}`]: ENV });
    const c = card("运行时环境");
    const box = [...c.querySelectorAll("input")].find((i) => i.value === String(ENV.promptCacheTtlMinutes))!;
    type(box, "1441");
    fireEvent.click(iconButton("bi-check-lg", c));
    await toastShown("自动缓存有效期必须是 1 到 1440 分钟之间的整数");
    await settle();
    expect(api.mutations()).toEqual([]);
  });
});
