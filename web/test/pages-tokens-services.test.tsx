/**
 * Characterization of the API Keys page (table, issue/edit/duplicate, reveal
 * and copy the secret) and the Model Services / Micro Agents list page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Tokens } from "../src/pages/Tokens";
import { ModelServices } from "../src/pages/ModelServices";
import { formatDate, formatNumber } from "../src/lib/format";
import type { Mapping, Model, ModelService, Provider, ServiceDef, Token, User } from "../src/types";
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
  delete (document as unknown as { execCommand?: unknown }).execCommand;
});

const JSON_HEADERS = { "content-type": "application/json" };
const sentJson = (method: string, path: string, body: unknown) => ({ method, path, body, headers: JSON_HEADERS, credentials: "same-origin" });
const sentBare = (method: string, path: string) => ({ method, path, body: undefined, headers: {}, credentials: "same-origin" });
const PAGE_TITLE = "flex items-center gap-2.5 text-2xl font-semibold text-ink-100";
const spinner = () => document.querySelector(".animate-spin");
const errorNote = () => document.querySelector(".border-red-900\\/50.px-4");
/** jsdom has no clipboard: route copies through the legacy path and decide its outcome. */
const stubCopy = (ok: boolean) => {
  const exec = vi.fn(() => ok);
  (document as unknown as { execCommand: unknown }).execCommand = exec;
  return exec;
};

const service = (id: number, name: string, steps: ServiceDef, extra: Partial<ModelService> = {}): ModelService => ({
  id, name, description: null, steps, enabled: true, summary: `${name} summary`, createdAt: id, ...extra,
});
const STEP = { model: "sonnet", provider: "openai" };
const SVC_A = service(10, "svc-a", { timeoutMs: 60000, steps: [STEP] });
const SVC_B = service(11, "svc-b", { timeoutMs: 60000, steps: [STEP] });

// ---------------------------------------------------------------------------

describe("Tokens page", () => {
  /** Has seconds and milliseconds, which the datetime-local field cannot show. */
  const EXPIRY = new Date(2027, 0, 2, 3, 4, 35, 123).getTime();
  const EXPIRY_MINUTE = new Date(2027, 0, 2, 3, 4).getTime();
  const LAPTOP: Token = {
    id: 1, name: "laptop", keyPrefix: "hk_abc", ownerUserId: 1, scopeServices: null, maxRequests: 100, maxTokens: null,
    usedRequests: 5, usedTokens: 1234, expiresAt: null, enabled: true, createdAt: 1, hasStoredKey: true,
  };
  const CI: Token = {
    id: 2, name: "ci", keyPrefix: "hk_xyz", ownerUserId: 1, scopeServices: [10, 99], maxRequests: null, maxTokens: 5000,
    usedRequests: 0, usedTokens: 10, expiresAt: EXPIRY, enabled: false, createdAt: 2, hasStoredKey: false,
  };
  const setup = async (routes: Routes = {}, me: User = ADMIN) => {
    const api = mockApi({ "GET /tokens": { tokens: [LAPTOP, CI] }, "GET /services": { services: [SVC_A, SVC_B] }, ...routes }, me);
    const view = await renderPage(<Tokens />);
    return { api, ...view };
  };
  const loaded = async (routes: Routes = {}, me: User = ADMIN) => {
    const r = await setup(routes, me);
    await screen.findByText("laptop");
    return r;
  };
  const rowOf = (name: string) => screen.getByText(name).closest("tr")!;
  const ISSUE = "Issue API key";
  const EDIT = "Edit API key";
  const CREATED = "API key created";
  const openIssue = () => {
    fireEvent.click(button(ISSUE));
    return openModal(ISSUE);
  };
  const BLANK = { name: "", scopeServices: null, maxRequests: null, maxTokens: null, expiresAt: null, enabled: true };

  it("loads the keys and the services", async () => {
    const { api } = await loaded();
    expect(api.calls.filter((c) => c.path !== "/me" && c.path !== "/settings/ui-language").map((c) => `${c.method} ${c.path}`).sort())
      .toEqual(["GET /services", "GET /tokens"]);
  });

  it("shows the header and a spinner while loading", async () => {
    const gate = deferred<unknown>();
    const { container } = await setup({ "GET /tokens": () => gate.promise });
    const h1 = container.querySelector("h1")!;
    expect(h1.textContent).toBe("API Keys");
    expect(classes(h1)).toEqual(cls(PAGE_TITLE));
    expect(classes(h1.querySelector("i"))).toEqual(cls("bi bi-key text-brand-400"));
    expect(screen.getByText("The keys your clients authenticate with. Scope each to specific Model Services and set optional quotas.")).toBeTruthy();
    expect(spinner()).not.toBeNull();
    expect(container.querySelector("table")).toBeNull();
    const add = button(ISSUE);
    expect(classes(add)).toEqual(["btn-primary"]);
    expect(classes(add.querySelector("i"))).toEqual(cls("bi bi-plus-lg"));
    await act(async () => { gate.resolve({ tokens: [LAPTOP, CI] }); });
    await screen.findByText("laptop");
    expect(spinner()).toBeNull();
  });

  it.each([
    ["the key list", "GET /tokens"],
    ["the service list", "GET /services"],
  ])("shows a load error under the header when %s fails", async (_name, route) => {
    const { container } = await setup({ [route]: fail(500, { error: "db down" }) });
    await waitFor(() => expect(errorNote()).not.toBeNull());
    expect(errorNote()!.textContent).toBe("db down");
    expect(container.querySelector("h1")!.textContent).toBe("API Keys");
    expect(container.querySelector("table")).toBeNull();
  });

  it.each([
    ["an admin", ADMIN, "Issue an API key to let a client call your Model Service endpoints."],
    ["a manager", MANAGER, "Ask an admin to issue an API key."],
  ])("shows the empty state with the hint for %s", async (_name, me, hint) => {
    await setup({ "GET /tokens": { tokens: [] } }, me);
    const title = await screen.findByText("No API keys yet");
    expect(classes(title.parentElement!.querySelector("i"))).toEqual(cls("bi bi-key text-4xl text-ink-600"));
    expect(screen.getByText(hint)).toBeTruthy();
  });

  it("lists keys in a table: prefix, scope, usage against quota, expiry, a status switch and actions", async () => {
    const { container } = await loaded();
    expect(classes(container.querySelector("table"))).toEqual(["table"]);
    expect(classes(container.querySelector("table")!.parentElement)).toEqual(cls("card overflow-hidden"));
    expect([...container.querySelectorAll("th")].map((th) => [th.textContent, th.className])).toEqual([
      ["Name", ""], ["Prefix", ""], ["Scope", ""], ["Requests", ""], ["Tokens", ""], ["Expires", ""], ["Status", ""], ["Actions", "text-right"],
    ]);
    expect(cells(rowOf("laptop"))).toEqual(["laptop", "hk_abc...", "all Model Services", "5 / 100", formatNumber(1234), "never", "", "Copy keyDuplicateEditRevoke"]);
    expect(cells(rowOf("ci"))).toEqual(["ci", "hk_xyz...", "svc-a, #99", "0", `10 / ${formatNumber(5000)}`, formatDate(EXPIRY), "", "Copy keyDuplicateEditRevoke"]);

    const [name, prefix, scope, requests, tokens, expires, status, actions] = [...rowOf("laptop").querySelectorAll("td")];
    expect(classes(name)).toEqual(cls("font-medium text-ink-100"));
    expect(classes(prefix)).toEqual(cls("font-mono text-xs text-ink-400"));
    expect(classes(scope)).toEqual(["text-xs"]);
    expect(classes(scope.querySelector("span"))).toEqual(["badge-gray"]);
    expect(classes(requests)).toEqual(cls("text-xs text-ink-300"));
    expect(classes(tokens)).toEqual(cls("text-xs text-ink-300"));
    expect(classes(expires)).toEqual(cls("text-xs text-ink-400"));
    expect(isOn(status.querySelector("button")!)).toBe(true);
    expect(classes(actions.firstElementChild)).toEqual(cls("flex justify-end gap-1.5"));
    expect(classes(rowOf("ci").querySelector("td:nth-child(3) span"))).toEqual(["text-ink-300"]);
    expect(isOn(rowOf("ci").querySelector("td:nth-child(7) button")!)).toBe(false);

    const copy = button("Copy key", actions);
    expect(classes(copy)).toEqual(cls("btn-ghost btn-xs"));
    expect(classes(copy.querySelector("i"))).toEqual(cls("bi bi-clipboard"));
    expect([copy.disabled, copy.title]).toEqual([false, ""]);
    expect(classes(button("Duplicate", actions))).toEqual(cls("btn-ghost btn-xs"));
    expect(classes(button("Duplicate", actions).querySelector("i"))).toEqual(cls("bi bi-files"));
    expect(classes(button("Edit", actions))).toEqual(cls("btn-ghost btn-xs"));
    expect(classes(button("Edit", actions).querySelector("i"))).toEqual(cls("bi bi-pencil"));
    expect(classes(button("Revoke", actions))).toEqual(cls("btn-danger btn-xs"));
    expect(classes(button("Revoke", actions).querySelector("i"))).toEqual(cls("bi bi-x-circle"));
  });

  it("disables Copy key, with an explanation, for a key issued before secrets were stored", async () => {
    await loaded();
    const copy = button("Copy key", rowOf("ci"));
    expect(copy.disabled).toBe(true);
    expect(copy.title).toBe("Issued before keys were stored - revoke and reissue to make it copyable");
  });

  it("is read-only for a manager: a hint instead of Issue, badges instead of switches, no row buttons", async () => {
    const { container } = await loaded({}, MANAGER);
    expect(hasButton(ISSUE)).toBe(false);
    const hint = screen.getByText("only admins can issue API keys");
    expect(classes(hint)).toEqual(["badge-gray"]);
    expect(classes(hint.querySelector("i"))).toEqual(cls("bi bi-shield-lock"));
    expect(container.querySelector("tbody button")).toBeNull();
    expect(cells(rowOf("laptop")).slice(6)).toEqual(["enabled", "read only"]);
    expect(cells(rowOf("ci")).slice(6)).toEqual(["disabled", "read only"]);
    expect(classes(rowOf("laptop").querySelector("td:nth-child(7) span"))).toEqual(["badge-green"]);
    expect(classes(rowOf("ci").querySelector("td:nth-child(7) span"))).toEqual(["badge-red"]);
    expect(classes(rowOf("ci").querySelector("td:last-child span"))).toEqual(cls("text-xs text-ink-500"));
  });

  it("opens the issue form with its defaults; Issue is disabled until there is a name", async () => {
    await loaded();
    const m = openIssue();
    expect(classes(m)).toEqual(cls("card flex max-h-[92vh] w-full flex-col max-w-2xl"));
    expect(classes(m.querySelector("h2 i"))).toEqual(cls("bi bi-key text-brand-400"));
    expect([...m.querySelectorAll(".label")].map((l) => l.textContent)).toEqual(["Name", "Scope", "Max requests (optional)", "Max tokens (optional)", "Expires at (optional)"]);
    const name = field("Name", m);
    const all = field("Allow all Model Services", m);
    const maxRequests = field("Max requests (optional)", m);
    const maxTokens = field("Max tokens (optional)", m);
    const expires = field("Expires at (optional)", m);
    expect([name.value, name.placeholder, classes(name)]).toEqual(["", "e.g. my-laptop", ["input"]]);
    expect([all.type, all.checked]).toEqual(["checkbox", true]);
    expect(classes(all.closest("label"))).toEqual(cls("mb-2 flex items-center gap-2 text-sm text-ink-300"));
    expect([maxRequests.type, maxRequests.value, classes(maxRequests)]).toEqual(["number", "", ["input"]]);
    expect([maxTokens.type, maxTokens.value, classes(maxTokens)]).toEqual(["number", "", ["input"]]);
    expect([expires.type, expires.value, classes(expires)]).toEqual(["datetime-local", "", ["input"]]);
    expect(classes(maxRequests.closest(".grid"))).toEqual(cls("grid grid-cols-2 gap-3"));
    expect(isOn(toggle("Enabled", m))).toBe(true);
    expect(classes(labelEl("Name", m))).toEqual(["label"]);
    // The per-service list only appears once "all" is unticked.
    expect(m.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);

    const issue = button("Issue", m);
    expect(classes(issue)).toEqual(["btn-primary"]);
    expect(classes(issue.querySelector("i"))).toEqual(cls("bi bi-check-lg"));
    expect(issue.disabled).toBe(true);
    expect([...issue.parentElement!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Cancel", "Issue"]);
    expect(classes(button("Cancel", m))).toEqual(["btn-ghost"]);
    type(name, "x");
    expect(button("Issue", m).disabled).toBe(false);
  });

  it("issues with POST /tokens and then reveals the secret once, without a toast", async () => {
    const { api } = await loaded({ "POST /tokens": { secret: "hk_live_SECRET", token: { id: 3 } } });
    const m = openIssue();
    type(field("Name", m), "phone");
    fireEvent.click(button("Issue", m));
    await waitFor(() => expect(modal(CREATED)).not.toBeNull());
    expect(api.mutations()).toEqual([sentJson("POST", "/tokens", { ...BLANK, name: "phone" })]);
    expect(modal(ISSUE)).toBeNull();
    expect(api.sent("GET", "/tokens")).toHaveLength(2);
    expect(toasts()).toEqual([]);

    const created = openModal(CREATED);
    expect(classes(created)).toEqual(cls("card flex max-h-[92vh] w-full flex-col max-w-lg"));
    expect(classes(created.querySelector("h2 i"))).toEqual(cls("bi bi-clipboard-check text-brand-400"));
    const warning = screen.getByText(/^Keep this key secret/);
    expect(classes(warning)).toEqual(cls("flex items-center gap-2 rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-300"));
    expect(classes(warning.querySelector("i"))).toEqual(cls("bi bi-exclamation-triangle-fill"));
    const code = created.querySelector("code")!;
    expect(code.textContent).toBe("hk_live_SECRET");
    expect(code.title).toBe("Click to select");
    expect(classes(code)).toEqual(cls("flex-1 cursor-text overflow-x-auto rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 font-mono text-xs text-brand-400"));
    expect(classes(iconButton("bi-clipboard", created))).toEqual(["btn-ghost"]);
    const done = button("Done", created);
    expect(classes(done)).toEqual(["btn-primary"]);
    fireEvent.click(done);
    expect(modal(CREATED)).toBeNull();
    expect(screen.queryByText("hk_live_SECRET")).toBeNull();
  });

  it("clicking the revealed secret selects it", async () => {
    await loaded({ "POST /tokens": { secret: "hk_live_SECRET" } });
    const m = openIssue();
    type(field("Name", m), "phone");
    fireEvent.click(button("Issue", m));
    await waitFor(() => expect(modal(CREATED)).not.toBeNull());
    fireEvent.click(openModal(CREATED).querySelector("code")!);
    expect(window.getSelection()?.toString()).toBe("hk_live_SECRET");
  });

  it.each([
    [true, "Copied to clipboard"],
    [false, "Copy failed - select the key and copy it manually"],
  ])("copies the revealed secret (copy succeeded: %s) and says so", async (ok, text) => {
    await loaded({ "POST /tokens": { secret: "hk_live_SECRET" } });
    const exec = stubCopy(ok);
    const m = openIssue();
    type(field("Name", m), "phone");
    fireEvent.click(button("Issue", m));
    await waitFor(() => expect(modal(CREATED)).not.toBeNull());
    fireEvent.click(iconButton("bi-clipboard", openModal(CREATED)));
    await toastShown(text);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(modal(CREATED)).not.toBeNull();
  });

  it("sends quotas as numbers, the chosen services, a parsed expiry and the enabled flag", async () => {
    const { api } = await loaded({ "POST /tokens": { secret: "s" } });
    const m = openIssue();
    type(field("Name", m), "scoped");
    fireEvent.click(field("Allow all Model Services", m));
    const list = field("svc-a", m).closest(".rounded-lg")!;
    expect(classes(list)).toEqual(cls("max-h-36 space-y-1 overflow-y-auto rounded-lg border border-ink-800 p-2"));
    expect([...list.querySelectorAll("label")].map((l) => [l.textContent, l.querySelector("input")!.checked])).toEqual([["svc-a", false], ["svc-b", false]]);
    expect(classes(field("svc-a", m).closest("label"))).toEqual(cls("flex items-center gap-2 text-sm text-ink-300"));
    expect(classes(field("svc-a", m).closest("label")!.querySelector("span"))).toEqual(cls("font-mono text-xs"));
    fireEvent.click(field("svc-b", m));
    fireEvent.click(field("svc-a", m));
    type(field("Max requests (optional)", m), "100");
    type(field("Max tokens (optional)", m), "2500000");
    type(field("Expires at (optional)", m), "2027-01-02T03:04");
    fireEvent.click(toggle("Enabled", m));
    fireEvent.click(button("Issue", m));
    await waitFor(() => expect(modal(CREATED)).not.toBeNull());
    expect(api.mutations()[0].body).toEqual({ name: "scoped", scopeServices: [11, 10], maxRequests: 100, maxTokens: 2500000, expiresAt: EXPIRY_MINUTE, enabled: false });
  });

  it("says so when there is no service to scope to", async () => {
    await loaded({ "GET /services": { services: [] } });
    const m = openIssue();
    fireEvent.click(field("Allow all Model Services", m));
    expect(classes(screen.getByText("No Model Services to scope to."))).toEqual(cls("text-xs text-ink-500"));
  });

  it.each([
    ["the server's message", fail(400, { error: "name already used" }), "name already used"],
    ["'Create failed' for a non-API failure", () => { throw new TypeError("offline"); }, "Create failed"],
  ])("toasts %s when issuing is refused and keeps the form open", async (_name, handler, text) => {
    const { api } = await loaded({ "POST /tokens": handler });
    const m = openIssue();
    type(field("Name", m), "phone");
    fireEvent.click(button("Issue", m));
    await toastShown(text);
    expect(modal(ISSUE)).not.toBeNull();
    expect(modal(CREATED)).toBeNull();
    expect(api.sent("GET", "/tokens")).toHaveLength(1);
  });

  it("disables Issue while the request is in flight", async () => {
    const gate = deferred<unknown>();
    await loaded({ "POST /tokens": () => gate.promise });
    const m = openIssue();
    type(field("Name", m), "phone");
    fireEvent.click(button("Issue", m));
    await waitFor(() => expect(button("Issue", m).disabled).toBe(true));
    await act(async () => { gate.resolve({ secret: "s" }); });
    await waitFor(() => expect(modal(CREATED)).not.toBeNull());
  });

  it("opens the edit form prefilled from the key, with Save instead of Issue", async () => {
    await loaded();
    fireEvent.click(button("Edit", rowOf("ci")));
    const m = openModal(EDIT);
    expect(field("Name", m).value).toBe("ci");
    expect(field("Allow all Model Services", m).checked).toBe(false);
    expect([field("svc-a", m).checked, field("svc-b", m).checked]).toEqual([true, false]);
    expect([field("Max requests (optional)", m).value, field("Max tokens (optional)", m).value]).toEqual(["", "5000"]);
    expect(field("Expires at (optional)", m).value).toBe("2027-01-02T03:04");
    expect(isOn(toggle("Enabled", m))).toBe(false);
    expect(hasButton("Issue", m)).toBe(false);
    expect(classes(button("Save", m))).toEqual(["btn-primary"]);
    expect(button("Save", m).disabled).toBe(false);
  });

  it("updates with PATCH /tokens/:id, keeping the exact stored expiry and unknown scope ids", async () => {
    const { api } = await loaded({ "PATCH /tokens/2": { token: {} } });
    fireEvent.click(button("Edit", rowOf("ci")));
    const m = openModal(EDIT);
    type(field("Name", m), "ci-runner");
    fireEvent.click(field("svc-b", m));
    fireEvent.click(button("Save", m));
    await toastShown("API key updated");
    expect(api.mutations()).toEqual([sentJson("PATCH", "/tokens/2", { name: "ci-runner", scopeServices: [10, 99, 11], maxRequests: null, maxTokens: 5000, expiresAt: EXPIRY, enabled: false })]);
    expect(modal(EDIT)).toBeNull();
    expect(modal(CREATED)).toBeNull();
    expect(api.sent("GET", "/tokens")).toHaveLength(2);
  });

  it("sends a changed expiry at minute precision, a cleared one as null, and 'all' as a null scope", async () => {
    const { api } = await loaded({ "PATCH /tokens/2": {} });
    fireEvent.click(button("Edit", rowOf("ci")));
    type(field("Expires at (optional)", openModal(EDIT)), "2027-01-02T03:05");
    fireEvent.click(button("Save", openModal(EDIT)));
    await waitFor(() => expect(api.mutations()).toHaveLength(1));
    expect((api.mutations()[0].body as { expiresAt: number }).expiresAt).toBe(EXPIRY_MINUTE + 60_000);

    await waitFor(() => expect(modal(EDIT)).toBeNull());
    fireEvent.click(button("Edit", rowOf("ci")));
    const m = openModal(EDIT);
    type(field("Expires at (optional)", m), "");
    fireEvent.click(field("Allow all Model Services", m));
    type(field("Max tokens (optional)", m), "");
    fireEvent.click(button("Save", m));
    await waitFor(() => expect(api.mutations()).toHaveLength(2));
    expect(api.mutations()[1].body).toEqual({ name: "ci", scopeServices: null, maxRequests: null, maxTokens: null, expiresAt: null, enabled: false });
  });

  it.each([
    ["the server's message", fail(400, { error: "name already used" }), "name already used"],
    ["'Update failed' for a non-API failure", () => { throw new TypeError("offline"); }, "Update failed"],
  ])("toasts %s when the update is refused and keeps the form open", async (_name, handler, text) => {
    await loaded({ "PATCH /tokens/1": handler });
    fireEvent.click(button("Edit", rowOf("laptop")));
    fireEvent.click(button("Save", openModal(EDIT)));
    await toastShown(text);
    expect(modal(EDIT)).not.toBeNull();
  });

  it("Save is disabled when the name is emptied", async () => {
    await loaded();
    fireEvent.click(button("Edit", rowOf("laptop")));
    const m = openModal(EDIT);
    type(field("Name", m), "");
    expect(button("Save", m).disabled).toBe(true);
  });

  it("duplicates into the issue form as a new key named '(copy)'", async () => {
    const { api } = await loaded({ "POST /tokens": { secret: "hk_dup" } });
    fireEvent.click(button("Duplicate", rowOf("ci")));
    expect(modal(EDIT)).toBeNull();
    const m = openModal(ISSUE);
    expect(field("Name", m).value).toBe("ci (copy)");
    expect([field("svc-a", m).checked, field("Max tokens (optional)", m).value, field("Expires at (optional)", m).value, isOn(toggle("Enabled", m))])
      .toEqual([true, "5000", "2027-01-02T03:04", false]);
    fireEvent.click(button("Issue", m));
    await waitFor(() => expect(modal(CREATED)).not.toBeNull());
    expect(api.mutations()).toEqual([sentJson("POST", "/tokens", { name: "ci (copy)", scopeServices: [10, 99], maxRequests: null, maxTokens: 5000, expiresAt: EXPIRY_MINUTE, enabled: false })]);
    expect(openModal(CREATED).querySelector("code")!.textContent).toBe("hk_dup");
  });

  it("closing an edit and then issuing does not reuse the edited key", async () => {
    const { api } = await loaded({ "POST /tokens": { secret: "s" } });
    fireEvent.click(button("Edit", rowOf("ci")));
    fireEvent.click(button("Cancel", openModal(EDIT)));
    expect(modal(EDIT)).toBeNull();
    const m = openIssue();
    expect(field("Name", m).value).toBe("");
    expect(field("Allow all Model Services", m).checked).toBe(true);
    type(field("Name", m), "fresh");
    fireEvent.click(button("Issue", m));
    await waitFor(() => expect(modal(CREATED)).not.toBeNull());
    expect(api.mutations().map((c) => `${c.method} ${c.path}`)).toEqual(["POST /tokens"]);
  });

  it("the row switch flips enabled with a one-field PATCH and reloads, without a toast", async () => {
    const { api } = await loaded({ "PATCH /tokens/1": {}, "PATCH /tokens/2": {} });
    fireEvent.click(rowOf("laptop").querySelector("td:nth-child(7) button")!);
    await waitFor(() => expect(api.sent("GET", "/tokens")).toHaveLength(2));
    fireEvent.click(rowOf("ci").querySelector("td:nth-child(7) button")!);
    await waitFor(() => expect(api.sent("GET", "/tokens")).toHaveLength(3));
    expect(api.mutations()).toEqual([sentJson("PATCH", "/tokens/1", { enabled: false }), sentJson("PATCH", "/tokens/2", { enabled: true })]);
    expect(toasts()).toEqual([]);
  });

  it.each([
    ["the server's message", fail(403, { error: "forbidden" }), "forbidden"],
    ["'Failed' for a non-API failure", () => { throw new TypeError("offline"); }, "Failed"],
  ])("toasts %s when the row switch is refused", async (_name, handler, text) => {
    await loaded({ "PATCH /tokens/1": handler });
    fireEvent.click(rowOf("laptop").querySelector("td:nth-child(7) button")!);
    await toastShown(text);
  });

  it.each([
    [true, "Copied to clipboard"],
    [false, "Copy failed - select the key and copy it manually"],
  ])("Copy key fetches the secret with POST /tokens/:id/secret and copies it (copy succeeded: %s)", async (ok, text) => {
    const { api } = await loaded({ "POST /tokens/1/secret": { secret: "hk_row_secret" } });
    let copied = "";
    (document as unknown as { execCommand: unknown }).execCommand = vi.fn(() => {
      copied = document.querySelector("textarea")!.value;
      return ok;
    });
    fireEvent.click(button("Copy key", rowOf("laptop")));
    await toastShown(text);
    expect(api.mutations()).toEqual([sentJson("POST", "/tokens/1/secret", {})]);
    expect(copied).toBe("hk_row_secret");
    expect(screen.queryByText("hk_row_secret")).toBeNull();
  });

  it.each([
    ["the server's message", fail(404, { error: "secret is not stored" }), "secret is not stored"],
    ["'Failed' for a non-API failure", () => { throw new TypeError("offline"); }, "Failed"],
  ])("toasts %s when the secret cannot be fetched, and copies nothing", async (_name, handler, text) => {
    await loaded({ "POST /tokens/1/secret": handler });
    const exec = stubCopy(true);
    fireEvent.click(button("Copy key", rowOf("laptop")));
    await toastShown(text);
    expect(exec).not.toHaveBeenCalled();
  });

  it("asks before revoking; Cancel sends nothing", async () => {
    const { api } = await loaded();
    fireEvent.click(button("Revoke", rowOf("laptop")));
    const m = openModal("Revoke API key");
    expect(screen.getByText('Revoke "laptop"? Any client using it will stop working immediately.')).toBeTruthy();
    await act(async () => { fireEvent.click(button("Cancel", m)); });
    expect(api.mutations()).toEqual([]);
  });

  it("revokes with DELETE /tokens/:id after confirmation, toasts and reloads", async () => {
    const { api } = await loaded({ "DELETE /tokens/1": { ok: true } });
    fireEvent.click(button("Revoke", rowOf("laptop")));
    fireEvent.click(button("Confirm", openModal("Revoke API key")));
    await toastShown("API key revoked");
    expect(api.mutations()).toEqual([sentBare("DELETE", "/tokens/1")]);
    expect(api.sent("GET", "/tokens")).toHaveLength(2);
  });

  it.each([
    ["the server's message", fail(403, { error: "forbidden" }), "forbidden"],
    ["'Failed' for a non-API failure", () => { throw new TypeError("offline"); }, "Failed"],
  ])("toasts %s when revoking is refused", async (_name, handler, text) => {
    const { api } = await loaded({ "DELETE /tokens/1": handler });
    fireEvent.click(button("Revoke", rowOf("laptop")));
    fireEvent.click(button("Confirm", openModal("Revoke API key")));
    await toastShown(text);
    expect(api.sent("GET", "/tokens")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("ModelServices page", () => {
  const MODEL: Model = { id: 1, name: "sonnet", description: null, enabled: true, createdAt: 1 };
  const PROVIDER: Provider = { id: 1, name: "openai", type: "openai_completion", baseUrl: "https://api.openai.com/v1", hasKey: true, extraHeaders: null, maxOutputTokens: null, enabled: true, createdAt: 1 };
  const MAPPING: Mapping = { id: 7, modelId: 1, providerId: 1, upstreamModel: "gpt-4o", priority: 0, enabled: true };
  const CHAT = service(1, "sonnet-any", { timeoutMs: 60000, steps: [STEP, { model: "sonnet", provider: "openai" }] }, { description: "resilient sonnet", summary: "sonnet@openai, then sonnet@openai" });
  const IMAGE = service(2, "painter", { category: "image", timeoutMs: 60000, steps: [STEP] }, { enabled: false });
  const AGENT = service(3, "router", { kind: "micro_agent", timeoutMs: 60000, stages: [] }, { summary: "routes things" });
  const ALL = [CHAT, IMAGE, AGENT];
  const setup = async (kind: "resilience" | "chain" | undefined, routes: Routes = {}) => {
    const api = mockApi({
      "GET /services": { services: ALL },
      "GET /models": { models: [MODEL] },
      "GET /providers": { providers: [PROVIDER] },
      "GET /mappings": { mappings: [MAPPING] },
      "GET /tools": { tools: [] },
      ...routes,
    }, ADMIN);
    const view = await renderPage(kind ? <ModelServices kind={kind} /> : <ModelServices />);
    return { api, ...view };
  };
  const loaded = async (kind: "resilience" | "chain" | undefined, name: string, routes: Routes = {}) => {
    const r = await setup(kind, routes);
    await screen.findByText(name);
    return r;
  };
  const cardOf = (name: string) => screen.getByText(name).closest(".card") as HTMLElement;
  const NEW_SERVICE = "New Model Service";
  const NEW_AGENT = "New Micro Agent";

  it("loads services, models, providers and mappings", async () => {
    const { api } = await loaded("resilience", "sonnet-any");
    expect(api.calls.filter((c) => !["/me", "/settings/ui-language", "/tools"].includes(c.path)).map((c) => `${c.method} ${c.path}`).sort())
      .toEqual(["GET /mappings", "GET /models", "GET /providers", "GET /services"]);
  });

  it.each([
    ["resilience" as const, "Model Services", "bi-diagram-3", NEW_SERVICE, /^How this proxy serves a model to clients/],
    ["chain" as const, "Micro Agents", "bi-robot", NEW_AGENT, /^Composable pipelines/],
  ])("%s: shows its own header and a spinner while loading", async (kind, title, icon, newLabel, subtitle) => {
    const gate = deferred<unknown>();
    const { container } = await setup(kind, { "GET /services": () => gate.promise });
    const h1 = container.querySelector("h1")!;
    expect(h1.textContent).toBe(title);
    expect(classes(h1)).toEqual(cls(PAGE_TITLE));
    expect(classes(h1.querySelector("i"))).toEqual(cls(`bi ${icon} text-brand-400`));
    expect(screen.getByText(subtitle)).toBeTruthy();
    expect(spinner()).not.toBeNull();
    expect(container.querySelector(".card")).toBeNull();
    const add = button(newLabel);
    expect(classes(add)).toEqual(["btn-primary"]);
    expect(classes(add.querySelector("i"))).toEqual(cls("bi bi-plus-lg"));
    await act(async () => { gate.resolve({ services: [] }); });
    await waitFor(() => expect(spinner()).toBeNull());
  });

  it("defaults to the Model Services view when no kind is given", async () => {
    const { container } = await loaded(undefined, "sonnet-any");
    expect(container.querySelector("h1")!.textContent).toBe("Model Services");
  });

  it("shows a load error under the header when any of the four requests fails", async () => {
    const { container } = await setup("resilience", { "GET /mappings": fail(500, { error: "db down" }) });
    await waitFor(() => expect(errorNote()).not.toBeNull());
    expect(errorNote()!.textContent).toBe("db down");
    expect(container.querySelector("h1")!.textContent).toBe("Model Services");
    expect(container.querySelector(".card")).toBeNull();
  });

  it("resilience: lists only non-agent services as cards", async () => {
    await loaded("resilience", "sonnet-any");
    expect(screen.queryByText("router")).toBeNull();
    const chat = cardOf("sonnet-any");
    expect(classes(chat)).toEqual(cls("card card-pad"));
    expect(classes(chat.parentElement)).toEqual(cls("grid gap-4 md:grid-cols-2"));
    expect(chat.parentElement!.children).toHaveLength(2);
    expect(classes(screen.getByText("sonnet-any"))).toEqual(cls("truncate font-mono text-sm font-semibold text-ink-100"));
    expect(classes(chat.querySelector("i"))).toEqual(cls("bi bi-diagram-3 text-brand-400"));
    expect(chat.querySelector(".badge-green")!.textContent).toBe("enabled");
    // A chat service carries no category badge.
    expect(chat.querySelector(".badge-blue")).toBeNull();
    expect(classes(screen.getByText("resilient sonnet"))).toEqual(cls("mt-1 text-xs text-ink-400"));
    const count = screen.getByText("2 steps");
    expect(classes(count)).toEqual(cls("badge-gray shrink-0"));
    const summary = screen.getByText("sonnet@openai, then sonnet@openai");
    expect(classes(summary.parentElement)).toEqual(cls("mt-3 flex items-start gap-2 rounded-lg bg-ink-950/50 px-3 py-2 text-xs text-ink-300"));
    expect(classes(summary.parentElement!.querySelector("i"))).toEqual(cls("bi bi-signpost-split mt-0.5 text-ink-500"));
    const edit = button("Edit", chat);
    expect(classes(edit)).toEqual(cls("btn-ghost btn-xs"));
    expect(classes(edit.querySelector("i"))).toEqual(cls("bi bi-pencil"));
    expect(classes(iconButton("bi-trash3", chat))).toEqual(cls("btn-danger btn-xs"));
    expect(classes(edit.parentElement)).toEqual(cls("mt-3 flex justify-end gap-1.5"));

    const image = cardOf("painter");
    expect(image.querySelector(".badge-red")!.textContent).toBe("disabled");
    expect(image.querySelector(".badge-blue")!.textContent).toBe("Image generation");
    expect(image.querySelector(".badge-gray")!.textContent).toBe("1 steps");
    expect(image.querySelector("p")).toBeNull();
    expect(screen.getByText("painter summary")).toBeTruthy();
  });

  it("chain: lists only agents, with the robot icon and a stage count", async () => {
    await loaded("chain", "router");
    expect(screen.queryByText("sonnet-any")).toBeNull();
    const agent = cardOf("router");
    expect(agent.parentElement!.children).toHaveLength(1);
    expect(classes(agent.querySelector("i"))).toEqual(cls("bi bi-robot text-brand-400"));
    expect(agent.querySelector(".badge-gray")!.textContent).toBe("0 stages");
    expect(agent.querySelector(".badge-blue")).toBeNull();
    expect(screen.getByText("routes things")).toBeTruthy();
  });

  it("resilience, empty but creatable: a hint and a second New button", async () => {
    const { container } = await setup("resilience", { "GET /services": { services: [AGENT] } });
    const title = await screen.findByText("No Model Services yet");
    expect(classes(title.parentElement!.querySelector("i"))).toEqual(cls("bi bi-diagram-3 text-4xl text-ink-600"));
    expect(screen.getByText(/^Create a Model Service to expose a resilient endpoint/)).toBeTruthy();
    const buttons = [...container.querySelectorAll("button")].filter((b) => b.textContent === NEW_SERVICE);
    expect(buttons).toHaveLength(2);
    expect(classes(buttons[1])).toEqual(["btn-primary"]);
  });

  it.each([
    ["no model", { "GET /models": { models: [] } }],
    ["no mapping", { "GET /mappings": { mappings: [] } }],
  ])("resilience, empty with %s: explains the prerequisite, offers no second button, and New only toasts", async (_name, routes) => {
    const { api, container } = await setup("resilience", { "GET /services": { services: [] }, ...routes });
    await screen.findByText("No Model Services yet");
    expect(screen.getByText("First add a provider, then create a model and map it under Model Mapping. Then build a Model Service here.")).toBeTruthy();
    expect([...container.querySelectorAll("button")].filter((b) => b.textContent === NEW_SERVICE)).toHaveLength(1);
    fireEvent.click(button(NEW_SERVICE));
    await toastShown("Create a model and map it to a provider under Model Mapping first");
    expect(modal(NEW_SERVICE)).toBeNull();
    expect(api.mutations()).toEqual([]);
  });

  it("chain, empty but creatable: a hint and a second New button", async () => {
    const { container } = await setup("chain", { "GET /services": { services: [CHAT] } });
    const title = await screen.findByText("No Micro Agents yet");
    expect(classes(title.parentElement!.querySelector("i"))).toEqual(cls("bi bi-robot text-4xl text-ink-600"));
    expect(screen.getByText(/^Build a Micro Agent: stages that each run a Model Service/)).toBeTruthy();
    expect([...container.querySelectorAll("button")].filter((b) => b.textContent === NEW_AGENT)).toHaveLength(2);
  });

  it("chain, empty with no Model Service: explains the prerequisite and New only toasts", async () => {
    await setup("chain", { "GET /services": { services: [AGENT] } });
    await screen.findByText("router");
    expect(screen.queryByText("No Micro Agents yet")).toBeNull();
    fireEvent.click(button(NEW_AGENT));
    await toastShown("Create at least one Model Service first — Micro Agent stages run them.");
    expect(modal(NEW_AGENT)).toBeNull();

    cleanup();
    vi.unstubAllGlobals();
    const second = await setup("chain", { "GET /services": { services: [] } });
    await screen.findByText("No Micro Agents yet");
    expect(screen.getByText("First create a Model Service. Then compose Micro Agents here.")).toBeTruthy();
    expect([...second.container.querySelectorAll("button")].filter((b) => b.textContent === NEW_AGENT)).toHaveLength(1);
  });

  it.each([
    ["resilience" as const, "sonnet-any", NEW_SERVICE, "bi bi-diagram-3 text-brand-400"],
    ["chain" as const, "router", NEW_AGENT, "bi bi-robot text-brand-400"],
  ])("%s: New opens the editor as a wide modal titled for the kind, and closing it sends nothing", async (kind, name, title, icon) => {
    const { api } = await loaded(kind, name);
    expect(modal(title)).toBeNull();
    fireEvent.click(button(title));
    const m = openModal(title);
    expect(classes(m)).toEqual(cls("card flex max-h-[92vh] w-full flex-col max-w-4xl"));
    expect(classes(m.querySelector("h2 i"))).toEqual(cls(icon));
    fireEvent.click(iconButton("bi-x-lg", m.querySelector("h2")!.parentElement!));
    expect(modal(title)).toBeNull();
    expect(api.mutations()).toEqual([]);
  });

  it("Edit opens the editor titled with the service's name", async () => {
    await loaded("resilience", "sonnet-any");
    fireEvent.click(button("Edit", cardOf("sonnet-any")));
    const m = openModal('Edit "sonnet-any"');
    expect(classes(m)).toEqual(cls("card flex max-h-[92vh] w-full flex-col max-w-4xl"));
    fireEvent.click(iconButton("bi-x-lg", m.querySelector("h2")!.parentElement!));
    expect(modal('Edit "sonnet-any"')).toBeNull();
    // Closing an edit does not leave the editor in "new" mode.
    expect(modal(NEW_SERVICE)).toBeNull();
  });

  it.each([
    ["resilience" as const, "sonnet-any", "Delete Model Service", "/services/1"],
    ["chain" as const, "router", "Delete Micro Agent", "/services/3"],
  ])("%s: asks before deleting with its own title; Cancel sends nothing; Confirm deletes, toasts and reloads", async (kind, name, title, path) => {
    const { api } = await loaded(kind, name, { [`DELETE ${path}`]: { ok: true } });
    fireEvent.click(iconButton("bi-trash3", cardOf(name)));
    expect(screen.getByText(`Delete "${name}"? Clients using this endpoint will start receiving 404s.`)).toBeTruthy();
    await act(async () => { fireEvent.click(button("Cancel", openModal(title))); });
    expect(api.mutations()).toEqual([]);

    fireEvent.click(iconButton("bi-trash3", cardOf(name)));
    fireEvent.click(button("Confirm", openModal(title)));
    await toastShown("Deleted");
    expect(api.mutations()).toEqual([sentBare("DELETE", path)]);
    expect(api.sent("GET", "/services")).toHaveLength(2);
  });

  it.each([
    ["the server's message", fail(409, { error: "service is used by an agent" }), "service is used by an agent"],
    ["'Delete failed' for a non-API failure", () => { throw new TypeError("offline"); }, "Delete failed"],
  ])("toasts %s when the delete is refused", async (_name, handler, text) => {
    const { api } = await loaded("resilience", "sonnet-any", { "DELETE /services/1": handler });
    fireEvent.click(iconButton("bi-trash3", cardOf("sonnet-any")));
    fireEvent.click(button("Confirm", openModal("Delete Model Service")));
    await toastShown(text);
    expect(api.sent("GET", "/services")).toHaveLength(1);
  });
});
