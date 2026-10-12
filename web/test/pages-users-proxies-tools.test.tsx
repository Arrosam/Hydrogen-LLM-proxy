/**
 * Characterization of three list-with-modal CRUD pages: Users (table), Proxies
 * (cards, validating payload, test action) and Tools (cards, body-footer editor).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Users } from "../src/pages/Users";
import { Proxies } from "../src/pages/Proxies";
import { Tools } from "../src/pages/Tools";
import { formatDate } from "../src/lib/format";
import type { HostedTool, Proxy, User } from "../src/types";
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

// ---------------------------------------------------------------------------

describe("Users page", () => {
  const OLD: User = { id: 3, username: "old", role: "manager", enabled: false, mustChangePassword: false, createdAt: 1_700_000_200_000 };
  const USERS = [ADMIN, MANAGER, OLD];
  const setup = async (routes: Routes = {}, me: User = ADMIN) => {
    const api = mockApi({ "GET /users": { users: USERS }, ...routes }, me);
    const view = await renderPage(<Users />);
    return { api, ...view };
  };
  const loaded = async (routes: Routes = {}, me: User = ADMIN) => {
    const r = await setup(routes, me);
    await screen.findByText("mia");
    return r;
  };
  const rowOf = (name: string) => screen.getByText(name).closest("tr")!;

  it("shows the header and a spinner while the list is loading", async () => {
    const gate = deferred<unknown>();
    const { container } = await setup({ "GET /users": () => gate.promise });
    const h1 = container.querySelector("h1")!;
    expect(h1.textContent).toBe("Users");
    expect(classes(h1)).toEqual(cls(PAGE_TITLE));
    expect(classes(h1.querySelector("i"))).toEqual(cls("bi bi-people text-brand-400"));
    expect(classes(screen.getByText("Console accounts. Managers can do everything except issue API keys."))).toEqual(cls("mt-1 text-sm text-ink-400"));
    expect(spinner()).not.toBeNull();
    expect(container.querySelector("table")).toBeNull();
    const add = button("New user");
    expect(classes(add)).toEqual(["btn-primary"]);
    expect(classes(add.querySelector("i"))).toEqual(cls("bi bi-person-plus"));
    await act(async () => { gate.resolve({ users: USERS }); });
    await screen.findByText("mia");
    expect(spinner()).toBeNull();
  });

  it("shows the load error under the header, with no table and no empty state", async () => {
    const { container } = await setup({ "GET /users": fail(500, { error: "db down" }) });
    await waitFor(() => expect(errorNote()).not.toBeNull());
    expect(errorNote()!.textContent).toBe("db down");
    expect(container.querySelector("h1")!.textContent).toBe("Users");
    expect(container.querySelector("table")).toBeNull();
    expect(screen.queryByText("No users")).toBeNull();
    expect(spinner()).toBeNull();
  });

  it("shows the empty state when there are no users", async () => {
    const { container } = await setup({ "GET /users": { users: [] } });
    const title = await screen.findByText("No users");
    expect(classes(title.parentElement!.querySelector("i"))).toEqual(cls("bi bi-people text-4xl text-ink-600"));
    expect(container.querySelector("table")).toBeNull();
  });

  it("lists users in a table with role, status, creation date and row actions", async () => {
    const { container } = await loaded();
    expect(classes(container.querySelector("table"))).toEqual(["table"]);
    expect(classes(container.querySelector("table")!.parentElement)).toEqual(cls("card overflow-hidden"));
    expect([...container.querySelectorAll("th")].map((th) => [th.textContent, th.className])).toEqual([
      ["Username", ""], ["Role", ""], ["Status", ""], ["Created", ""], ["Actions", "text-right"],
    ]);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(cells(rowOf("root"))).toEqual(["rootyou", "Admin", "active", formatDate(ADMIN.createdAt), ""]);
    expect(cells(rowOf("mia"))).toEqual(["mia", "Manager", "active", formatDate(MANAGER.createdAt), ""]);
    expect(cells(rowOf("old"))).toEqual(["old", "Manager", "disabled", formatDate(OLD.createdAt), ""]);

    const [nameTd, roleTd, statusTd, createdTd, actionsTd] = [...rowOf("root").querySelectorAll("td")];
    expect(classes(nameTd)).toEqual(cls("font-medium text-ink-100"));
    expect(classes(nameTd.querySelector("span"))).toEqual(cls("ml-2 badge-gray"));
    expect(classes(roleTd.querySelector("span"))).toEqual(["badge-blue"]);
    expect(classes(roleTd.querySelector("i"))).toEqual(cls("bi bi-shield-lock"));
    expect(classes(statusTd.querySelector("span"))).toEqual(["badge-green"]);
    expect(classes(createdTd)).toEqual(cls("text-xs text-ink-400"));
    expect(classes(actionsTd.firstElementChild)).toEqual(cls("flex justify-end gap-1.5"));

    expect(rowOf("mia").querySelector("td span.badge-gray")!.textContent).toBe("Manager");
    expect(classes(rowOf("mia").querySelector("td:nth-child(2) i"))).toEqual(cls("bi bi-person-gear"));
    expect(classes(rowOf("old").querySelector("td:nth-child(3) span"))).toEqual(["badge-red"]);
    expect(rowOf("mia").querySelector(".ml-2")).toBeNull();

    const edit = iconButton("bi-pencil", rowOf("mia"));
    const del = iconButton("bi-trash3", rowOf("mia"));
    expect(classes(edit)).toEqual(cls("btn-ghost btn-xs"));
    expect(classes(del)).toEqual(cls("btn-danger btn-xs"));
    expect([edit.disabled, del.disabled]).toEqual([false, false]);
  });

  it("disables deleting your own account only", async () => {
    await loaded();
    expect(iconButton("bi-trash3", rowOf("root")).disabled).toBe(true);
    expect(iconButton("bi-pencil", rowOf("root")).disabled).toBe(false);
    expect(iconButton("bi-trash3", rowOf("old")).disabled).toBe(false);
  });

  it("opens an empty create form: username, password, role (manager) and an enabled toggle", async () => {
    await loaded();
    expect(modal("New user")).toBeNull();
    fireEvent.click(button("New user"));
    const m = openModal("New user");
    expect(classes(m)).toEqual(cls("card flex max-h-[92vh] w-full flex-col max-w-lg"));
    expect(classes(m.querySelector("h2 i"))).toEqual(cls("bi bi-person text-brand-400"));
    expect([...m.querySelectorAll(".label")].map((l) => l.textContent)).toEqual(["Username", "Password", "Role"]);
    expect(classes(labelEl("Username", m))).toEqual(["label"]);
    const username = field("Username", m);
    const password = field("Password", m);
    const role = field<HTMLSelectElement>("Role", m);
    expect([username.value, classes(username)]).toEqual(["", ["input"]]);
    expect([password.value, password.type, password.placeholder, classes(password)]).toEqual(["", "password", "at least 8 characters", ["input"]]);
    expect([role.value, classes(role)]).toEqual(["manager", ["select"]]);
    expect([...role.options].map((o) => [o.value, o.textContent])).toEqual([["manager", "Manager"], ["admin", "Admin"]]);
    expect(isOn(toggle("Enabled", m))).toBe(true);
    expect(toggle("Enabled", m).disabled).toBe(false);
    expect(classes(username.closest(".space-y-4"))).toEqual(["space-y-4"]);

    const cancel = button("Cancel", m);
    const save = button("Save", m);
    expect(classes(cancel)).toEqual(["btn-ghost"]);
    expect(classes(save)).toEqual(["btn-primary"]);
    expect(classes(save.querySelector("i"))).toEqual(cls("bi bi-check-lg"));
    expect(save.disabled).toBe(false);
    expect([...save.parentElement!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Cancel", "Save"]);
  });

  it("creates a user with POST /users, toasts, closes and reloads", async () => {
    const { api } = await loaded({ "POST /users": { user: { id: 9 } } });
    fireEvent.click(button("New user"));
    const m = openModal("New user");
    type(field("Username", m), "neo");
    type(field("Password", m), "pw-123456");
    type(field("Role", m), "admin");
    fireEvent.click(toggle("Enabled", m));
    expect(isOn(toggle("Enabled", m))).toBe(false);
    fireEvent.click(button("Save", m));
    await toastShown("User created");
    expect(api.mutations()).toEqual([sentJson("POST", "/users", { username: "neo", password: "pw-123456", role: "admin", enabled: false })]);
    expect(modal("New user")).toBeNull();
    expect(api.sent("GET", "/users")).toHaveLength(2);
  });

  it("sends an untouched create form as it stands (no client-side validation)", async () => {
    const { api } = await loaded({ "POST /users": fail(400, { error: "username is required" }) });
    fireEvent.click(button("New user"));
    fireEvent.click(button("Save", openModal("New user")));
    await toastShown("username is required");
    expect(api.mutations()).toEqual([sentJson("POST", "/users", { username: "", password: "", role: "manager", enabled: true })]);
    // A refused save keeps the dialog open with the values intact, and does not reload.
    expect(modal("New user")).not.toBeNull();
    expect(button("Save", openModal("New user")).disabled).toBe(false);
    expect(api.sent("GET", "/users")).toHaveLength(1);
  });

  it("falls back to 'Save failed' when the save fails without an API error", async () => {
    await loaded({ "POST /users": () => { throw new TypeError("Failed to fetch"); } });
    fireEvent.click(button("New user"));
    fireEvent.click(button("Save", openModal("New user")));
    await toastShown("Save failed");
  });

  it("disables Save while the request is in flight", async () => {
    const gate = deferred<unknown>();
    await loaded({ "POST /users": () => gate.promise });
    fireEvent.click(button("New user"));
    fireEvent.click(button("Save", openModal("New user")));
    await waitFor(() => expect(button("Save", openModal("New user")).disabled).toBe(true));
    await act(async () => { gate.resolve({}); });
    await toastShown("User created");
  });

  it("opens the edit form without a username field, password blank", async () => {
    await loaded();
    fireEvent.click(iconButton("bi-pencil", rowOf("old")));
    const m = openModal("Edit user");
    expect([...m.querySelectorAll(".label")].map((l) => l.textContent)).toEqual(["Reset password (optional)", "Role"]);
    expect(field("Reset password (optional)", m).value).toBe("");
    expect(field<HTMLSelectElement>("Role", m).value).toBe("manager");
    expect(isOn(toggle("Enabled", m))).toBe(false);
    expect(toggle("Enabled", m).disabled).toBe(false);
    expect(m.querySelector("p.mt-1")).toBeNull();
  });

  it("updates with PATCH /users/:id, omitting a blank password", async () => {
    const { api } = await loaded({ "PATCH /users/3": { user: {} } });
    fireEvent.click(iconButton("bi-pencil", rowOf("old")));
    const m = openModal("Edit user");
    type(field("Role", m), "admin");
    fireEvent.click(toggle("Enabled", m));
    fireEvent.click(button("Save", m));
    await toastShown("User updated");
    expect(api.mutations()).toEqual([sentJson("PATCH", "/users/3", { role: "admin", enabled: true })]);
    expect(modal("Edit user")).toBeNull();
    expect(api.sent("GET", "/users")).toHaveLength(2);
  });

  it("includes the password in the PATCH when one was typed", async () => {
    const { api } = await loaded({ "PATCH /users/2": { user: {} } });
    fireEvent.click(iconButton("bi-pencil", rowOf("mia")));
    const m = openModal("Edit user");
    type(field("Reset password (optional)", m), "new-pass-1");
    fireEvent.click(button("Save", m));
    await toastShown("User updated");
    expect(api.mutations()).toEqual([sentJson("PATCH", "/users/2", { role: "manager", enabled: true, password: "new-pass-1" })]);
  });

  it("locks the Enabled toggle when editing yourself, and says why", async () => {
    await loaded();
    fireEvent.click(iconButton("bi-pencil", rowOf("root")));
    const m = openModal("Edit user");
    expect(toggle("Enabled", m).disabled).toBe(true);
    const reason = screen.getByText("You cannot deactivate your own account.");
    expect(classes(reason)).toEqual(cls("mt-1 text-xs text-ink-500"));
  });

  it("locks the Enabled toggle for the last enabled admin", async () => {
    await loaded({}, MANAGER);
    fireEvent.click(iconButton("bi-pencil", rowOf("root")));
    expect(toggle("Enabled", openModal("Edit user")).disabled).toBe(true);
    expect(screen.getByText("The last admin cannot be deactivated.")).toBeTruthy();
  });

  it("does not lock the toggle for an admin when another enabled admin exists", async () => {
    const second: User = { ...OLD, id: 4, username: "boss", role: "admin", enabled: true };
    await loaded({ "GET /users": { users: [...USERS, second] } }, MANAGER);
    fireEvent.click(iconButton("bi-pencil", rowOf("boss")));
    expect(toggle("Enabled", openModal("Edit user")).disabled).toBe(false);
    expect(screen.queryByText("The last admin cannot be deactivated.")).toBeNull();
  });

  it.each([
    ["Cancel", (m: HTMLElement) => button("Cancel", m)],
    ["the close button", (m: HTMLElement) => iconButton("bi-x-lg", m)],
  ])("closes the form with %s, sending nothing and discarding the edits", async (_name, pick) => {
    const { api } = await loaded();
    fireEvent.click(button("New user"));
    type(field("Username", openModal("New user")), "draft");
    fireEvent.click(pick(openModal("New user")));
    expect(modal("New user")).toBeNull();
    expect(api.mutations()).toEqual([]);
    fireEvent.click(button("New user"));
    expect(field("Username", openModal("New user")).value).toBe("");
  });

  it("asks before deleting and does nothing on Cancel", async () => {
    const { api } = await loaded();
    fireEvent.click(iconButton("bi-trash3", rowOf("mia")));
    const m = openModal("Delete user");
    expect(screen.getByText('Delete "mia"?')).toBeTruthy();
    await act(async () => { fireEvent.click(button("Cancel", m)); });
    expect(modal("Delete user")).toBeNull();
    expect(api.mutations()).toEqual([]);
    expect(toasts()).toEqual([]);
  });

  it("deletes with DELETE /users/:id after confirmation, toasts and reloads", async () => {
    const { api } = await loaded({ "DELETE /users/2": { ok: true } });
    fireEvent.click(iconButton("bi-trash3", rowOf("mia")));
    fireEvent.click(button("Confirm", openModal("Delete user")));
    await toastShown("User deleted");
    expect(api.mutations()).toEqual([sentBare("DELETE", "/users/2")]);
    expect(api.sent("GET", "/users")).toHaveLength(2);
    expect(modal("Delete user")).toBeNull();
  });

  it.each([
    ["the server's message", fail(409, { error: "Cannot delete the last admin" }), "Cannot delete the last admin"],
    ["'Delete failed' for a non-API failure", () => { throw new TypeError("offline"); }, "Delete failed"],
  ])("toasts %s when the delete is refused, without reloading", async (_name, handler, text) => {
    const { api } = await loaded({ "DELETE /users/2": handler });
    fireEvent.click(iconButton("bi-trash3", rowOf("mia")));
    fireEvent.click(button("Confirm", openModal("Delete user")));
    await toastShown(text);
    expect(api.sent("GET", "/users")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("Proxies page", () => {
  const LOCAL: Proxy = { id: 3, name: "local", scheme: "http", host: "127.0.0.1", port: 7890, username: "u1", hasPassword: true, enabled: true, createdAt: 1 };
  const SPARE: Proxy = { id: 4, name: "spare", scheme: "https", host: "px.example", port: 443, username: null, hasPassword: false, enabled: false, createdAt: 2 };
  const setup = async (routes: Routes = {}, me: User = ADMIN) => {
    const api = mockApi({ "GET /proxies": { proxies: [LOCAL, SPARE] }, ...routes }, me);
    const view = await renderPage(<Proxies />);
    return { api, ...view };
  };
  const loaded = async (routes: Routes = {}, me: User = ADMIN) => {
    const r = await setup(routes, me);
    await screen.findByText("local");
    return r;
  };
  const cardOf = (name: string) => screen.getByText(name).closest(".card") as HTMLElement;
  const openNew = () => {
    fireEvent.click(button("New proxy"));
    return openModal("New proxy");
  };

  it("while loading shows the page header above a labelled spinner", async () => {
    const gate = deferred<unknown>();
    const { container } = await setup({ "GET /proxies": () => gate.promise });
    expect(spinner()).not.toBeNull();
    expect(screen.getByText("Loading proxies…")).toBeTruthy();
    expect(container.querySelector("h1")!.textContent).toBe("Proxies");
    expect(hasButton("New proxy")).toBe(true);
    await act(async () => { gate.resolve({ proxies: [] }); });
    await screen.findByText("No proxies yet");
    expect(container.querySelector("h1")!.textContent).toBe("Proxies");
  });

  it("on a load error shows the error note under the page header", async () => {
    const { container } = await setup({ "GET /proxies": fail(500, { error: "db down" }) });
    await waitFor(() => expect(errorNote()).not.toBeNull());
    expect(errorNote()!.textContent).toBe("db down");
    expect(container.querySelector("h1")!.textContent).toBe("Proxies");
    expect(hasButton("New proxy")).toBe(true);
  });

  it("shows the empty state with a hint under the header", async () => {
    const { container } = await setup({ "GET /proxies": { proxies: [] } });
    const title = await screen.findByText("No proxies yet");
    expect(classes(title.parentElement!.querySelector("i"))).toEqual(cls("bi bi-shuffle text-4xl text-ink-600"));
    expect(screen.getByText(/^Add one to route a provider's traffic through it\./)).toBeTruthy();
    const h1 = container.querySelector("h1")!;
    expect(classes(h1)).toEqual(cls(PAGE_TITLE));
    expect(classes(h1.querySelector("i"))).toEqual(cls("bi bi-shuffle text-brand-400"));
    expect(screen.getByText(/^Outbound network hops\./)).toBeTruthy();
    const add = button("New proxy");
    expect(classes(add)).toEqual(["btn-primary"]);
    expect(classes(add.querySelector("i"))).toEqual(cls("bi bi-plus-lg"));
  });

  it("lists proxies as cards with status, address, credential hint and admin actions", async () => {
    await loaded();
    const local = cardOf("local");
    expect(classes(local)).toEqual(cls("card card-pad"));
    expect(classes(local.parentElement)).toEqual(cls("grid grid-cols-1 gap-3 lg:grid-cols-2"));
    expect(local.parentElement!.children).toHaveLength(2);
    expect(classes(screen.getByText("local"))).toEqual(cls("font-medium text-ink-100"));
    expect(classes(local.querySelector("i"))).toEqual(cls("bi bi-shuffle text-brand-400"));
    const badge = local.querySelector("span.badge-green")!;
    expect(badge.textContent).toBe("enabled");
    const address = local.querySelector(".font-mono")!;
    expect(address.textContent).toBe("http://u1@127.0.0.1:7890");
    expect(classes(address)).toEqual(cls("mt-1 font-mono text-xs text-ink-400"));
    const stored = local.querySelector("i.bi-key")!.parentElement!;
    expect(stored.textContent).toBe("password stored");
    expect(classes(stored)).toEqual(cls("mt-1 text-xs text-ink-500"));

    const edit = button("Edit", local);
    const del = iconButton("bi-trash", local);
    expect(classes(edit)).toEqual(cls("btn-ghost btn-xs"));
    expect(classes(edit.querySelector("i"))).toEqual(cls("bi bi-pencil"));
    expect(classes(del)).toEqual(cls("btn-danger btn-xs"));
    expect(classes(edit.parentElement)).toEqual(cls("flex shrink-0 gap-1.5"));

    const spare = cardOf("spare");
    expect(spare.querySelector("span.badge-gray")!.textContent).toBe("disabled");
    expect(spare.querySelector(".font-mono")!.textContent).toBe("https://px.example:443");
    expect(spare.querySelector("i.bi-key")).toBeNull();
  });

  it("is read-only for a manager: no New, Edit or Delete", async () => {
    await loaded({}, MANAGER);
    expect(hasButton("New proxy")).toBe(false);
    expect(cardOf("local").querySelector("button")).toBeNull();
    expect(cardOf("spare").querySelector("button")).toBeNull();
  });

  it("opens the create form with its defaults; Save is disabled until there is a name", async () => {
    await loaded();
    const m = openNew();
    expect(classes(m)).toEqual(cls("card flex max-h-[92vh] w-full flex-col max-w-lg"));
    expect(classes(m.querySelector("h2 i"))).toEqual(cls("bi bi-shuffle text-brand-400"));
    expect([...m.querySelectorAll(".label")].map((l) => l.textContent)).toEqual(["Name", "Scheme", "Host", "Port", "Username optional", "Password "]);
    const name = field("Name", m);
    const scheme = field<HTMLSelectElement>("Scheme", m);
    const host = field("Host", m);
    const port = field("Port", m);
    const username = field("Username", m);
    const password = field("Password", m);
    expect([name.value, name.placeholder, classes(name)]).toEqual(["", "local-xray", ["input"]]);
    expect([scheme.value, classes(scheme), [...scheme.options].map((o) => o.value)]).toEqual(["http", ["select"], ["http", "https"]]);
    expect([host.value, host.placeholder, classes(host)]).toEqual(["", "127.0.0.1", cls("input font-mono text-xs")]);
    expect([port.value, port.inputMode, classes(port)]).toEqual(["7890", "numeric", cls("input font-mono text-xs")]);
    expect([username.value, username.autocomplete, classes(username)]).toEqual(["", "off", ["input"]]);
    expect([password.value, password.type, password.autocomplete, classes(password)]).toEqual(["", "password", "new-password", ["input"]]);
    expect(classes(labelEl("Username", m).querySelector("span"))).toEqual(cls("normal-case text-ink-500"));
    expect(isOn(toggle("enabled", m))).toBe(true);
    expect(classes(screen.getByText(/^A local proxy on 127\.0\.0\.1 is fine/))).toEqual(cls("-mt-2 text-xs text-ink-500"));
    expect(classes(screen.getByText("Disabling a proxy returns every provider using it to a direct connection."))).toEqual(cls("text-xs text-ink-500"));
    expect(classes(name.closest(".grid"))).toEqual(cls("grid grid-cols-2 gap-4"));
    expect(classes(host.closest(".grid"))).toEqual(cls("grid grid-cols-3 gap-4"));
    expect(classes(host.parentElement)).toEqual(["col-span-2"]);

    // Footer: Test on the left, Cancel + Save on the right.
    const test = button("Test", m);
    const save = button("Save", m);
    expect(classes(test)).toEqual(["btn-ghost"]);
    expect(classes(test.querySelector("i"))).toEqual(cls("bi bi-plug"));
    expect(classes(test.parentElement)).toEqual(cls("flex w-full items-center justify-between gap-2"));
    expect(classes(save.parentElement)).toEqual(cls("flex gap-2"));
    expect([...save.parentElement!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Cancel", "Save"]);
    expect(classes(button("Cancel", m))).toEqual(["btn-ghost"]);
    expect(classes(save)).toEqual(["btn-primary"]);
    expect(save.disabled).toBe(true);
    type(name, "   ");
    expect(button("Save", m).disabled).toBe(true);
    type(name, "p");
    expect(button("Save", m).disabled).toBe(false);
  });

  it("creates with POST /proxies: trimmed strings, numeric port, null username, no password key", async () => {
    const { api } = await loaded({ "POST /proxies": { proxy: {} } });
    const m = openNew();
    type(field("Name", m), "  edge  ");
    type(field("Scheme", m), "https");
    type(field("Host", m), " proxy.example ");
    type(field("Port", m), " 8443 ");
    type(field("Username", m), "   ");
    fireEvent.click(button("Save", m));
    await toastShown("Proxy created");
    expect(api.mutations()).toEqual([sentJson("POST", "/proxies", { name: "edge", scheme: "https", host: "proxy.example", port: 8443, username: null, enabled: true })]);
    expect(modal("New proxy")).toBeNull();
    expect(api.sent("GET", "/proxies")).toHaveLength(2);
  });

  it("includes username and password when given, and the toggled enabled flag", async () => {
    const { api } = await loaded({ "POST /proxies": { proxy: {} } });
    const m = openNew();
    type(field("Name", m), "edge");
    type(field("Host", m), "h");
    type(field("Username", m), " bob ");
    type(field("Password", m), " s3cret ");
    fireEvent.click(toggle("enabled", m));
    fireEvent.click(button("Save", m));
    await toastShown("Proxy created");
    expect(api.mutations()[0].body).toEqual({ name: "edge", scheme: "http", host: "h", port: 7890, username: "bob", enabled: false, password: " s3cret " });
  });

  it.each([["1", 1], ["65535", 65535], ["0080", 80]])("accepts the port %j as %i", async (raw, port) => {
    const { api } = await loaded({ "POST /proxies": {} });
    const m = openNew();
    type(field("Name", m), "edge");
    type(field("Host", m), "h");
    type(field("Port", m), raw);
    fireEvent.click(button("Save", m));
    await toastShown("Proxy created");
    expect((api.mutations()[0].body as { port: number }).port).toBe(port);
  });

  it.each([[""], ["0"], ["65536"], ["-1"], ["1.5"], ["abc"], ["80a"]])("refuses the port %j with a toast and sends nothing", async (raw) => {
    const { api } = await loaded();
    const m = openNew();
    type(field("Name", m), "edge");
    type(field("Host", m), "h");
    type(field("Port", m), raw);
    fireEvent.click(button("Save", m));
    await toastShown("Port must be between 1 and 65535");
    fireEvent.click(button("Test", m));
    expect(api.mutations()).toEqual([]);
    expect(modal("New proxy")).not.toBeNull();
  });

  it.each([[""], ["   "]])("refuses a blank host (%j) with a toast and sends nothing", async (host) => {
    const { api } = await loaded();
    const m = openNew();
    type(field("Name", m), "edge");
    type(field("Host", m), host);
    fireEvent.click(button("Save", m));
    await toastShown("A proxy needs a host");
    expect(api.mutations()).toEqual([]);
  });

  it("checks the port before the host", async () => {
    await loaded();
    const m = openNew();
    type(field("Name", m), "edge");
    type(field("Port", m), "0");
    fireEvent.click(button("Save", m));
    await toastShown("Port must be between 1 and 65535");
    expect(toasts()).toEqual(["Port must be between 1 and 65535"]);
  });

  it("opens the edit form prefilled, with a blank password and a keep hint", async () => {
    await loaded();
    fireEvent.click(button("Edit", cardOf("local")));
    const m = openModal("Edit “local”");
    expect([field("Name", m).value, field<HTMLSelectElement>("Scheme", m).value, field("Host", m).value, field("Port", m).value, field("Username", m).value, field("Password", m).value])
      .toEqual(["local", "http", "127.0.0.1", "7890", "u1", ""]);
    expect(labelEl("Password", m).textContent).toBe("Password (leave blank to keep the stored one)");
    expect(isOn(toggle("enabled", m))).toBe(true);
    expect(button("Save", m).disabled).toBe(false);
  });

  it("updates with PATCH /proxies/:id, leaving the password out when it was not retyped", async () => {
    const { api } = await loaded({ "PATCH /proxies/3": { proxy: {} } });
    fireEvent.click(button("Edit", cardOf("local")));
    type(field("Host", openModal("Edit “local”")), "10.0.0.1");
    fireEvent.click(button("Save", openModal("Edit “local”")));
    await toastShown("Proxy updated");
    expect(api.mutations()).toEqual([sentJson("PATCH", "/proxies/3", { name: "local", scheme: "http", host: "10.0.0.1", port: 7890, username: "u1", enabled: true })]);
    expect(api.sent("GET", "/proxies")).toHaveLength(2);
  });

  it("sends a retyped password in the PATCH", async () => {
    const { api } = await loaded({ "PATCH /proxies/4": {} });
    fireEvent.click(button("Edit", cardOf("spare")));
    const m = openModal("Edit “spare”");
    type(field("Password", m), "pw");
    fireEvent.click(button("Save", m));
    await toastShown("Proxy updated");
    expect(api.mutations()[0]).toEqual(sentJson("PATCH", "/proxies/4", { name: "spare", scheme: "https", host: "px.example", port: 443, username: null, enabled: false, password: "pw" }));
  });

  it.each([
    ["the server's message", fail(409, { error: "name already used" }), "name already used"],
    ["'Save failed' for a non-API failure", () => { throw new TypeError("offline"); }, "Save failed"],
  ])("toasts %s when the save is refused and keeps the dialog open", async (_name, handler, text) => {
    const { api } = await loaded({ "POST /proxies": handler });
    const m = openNew();
    type(field("Name", m), "edge");
    type(field("Host", m), "h");
    fireEvent.click(button("Save", m));
    await toastShown(text);
    expect(modal("New proxy")).not.toBeNull();
    expect(api.sent("GET", "/proxies")).toHaveLength(1);
  });

  it("tests an unsaved proxy inline, exactly as typed, and shows a green result with latency", async () => {
    const { api } = await loaded({ "POST /proxies/test": { ok: true, status: 204, latencyMs: 12, url: "https://probe", message: "reached the probe" } });
    const m = openNew();
    type(field("Name", m), "edge");
    type(field("Host", m), "h");
    type(field("Password", m), "pw");
    fireEvent.click(button("Test", m));
    await toastShown("Reached the target through the proxy");
    expect(api.mutations()).toEqual([sentJson("POST", "/proxies/test", { proxy: { name: "edge", scheme: "http", host: "h", port: 7890, username: null, enabled: true, password: "pw" } })]);
    const box = screen.getByText("reached the probe");
    expect(classes(box)).toEqual(cls("rounded-lg border px-4 py-3 text-sm border-emerald-900/50 bg-emerald-950/30 text-emerald-300"));
    expect(classes(box.querySelector("i"))).toEqual(cls("bi bi-check-circle-fill mr-2"));
    expect(box.querySelector("span")!.textContent).toBe("12 ms");
    expect(classes(box.querySelector("span"))).toEqual(cls("ml-2 text-ink-500"));
    // Testing does not save or close.
    expect(modal("New proxy")).not.toBeNull();
    expect(api.sent("GET", "/proxies")).toHaveLength(1);
  });

  it("tests a saved proxy by id when the password field is untouched", async () => {
    const { api } = await loaded({ "POST /proxies/test": { ok: false, status: 0, latencyMs: 0, url: "https://probe", message: "connect ECONNREFUSED" } });
    fireEvent.click(button("Edit", cardOf("local")));
    fireEvent.click(button("Test", openModal("Edit “local”")));
    await toastShown("Could not reach the target through the proxy");
    expect(api.mutations()).toEqual([sentJson("POST", "/proxies/test", { id: 3 })]);
    const box = screen.getByText("connect ECONNREFUSED");
    expect(classes(box)).toEqual(cls("rounded-lg border px-4 py-3 text-sm border-red-900/50 bg-red-950/30 text-red-300"));
    expect(classes(box.querySelector("i"))).toEqual(cls("bi bi-exclamation-octagon-fill mr-2"));
    expect(box.querySelector("span")).toBeNull();
  });

  it("tests a saved proxy inline once a password was retyped", async () => {
    const { api } = await loaded({ "POST /proxies/test": { ok: true, status: 200, latencyMs: 1, url: "u", message: "ok" } });
    fireEvent.click(button("Edit", cardOf("local")));
    const m = openModal("Edit “local”");
    type(field("Password", m), "new");
    fireEvent.click(button("Test", m));
    await toastShown("Reached the target through the proxy");
    expect(api.mutations()[0].body).toEqual({ proxy: { name: "local", scheme: "http", host: "127.0.0.1", port: 7890, username: "u1", enabled: true, password: "new" } });
  });

  it("shows 'Testing…' on a disabled button while the test runs", async () => {
    const gate = deferred<unknown>();
    await loaded({ "POST /proxies/test": () => gate.promise });
    fireEvent.click(button("Edit", cardOf("local")));
    const m = openModal("Edit “local”");
    fireEvent.click(button("Test", m));
    await waitFor(() => expect(hasButton("Testing…", m)).toBe(true));
    expect(button("Testing…", m).disabled).toBe(true);
    expect(classes(button("Testing…", m).querySelector("i"))).toEqual(cls("bi bi-arrow-repeat animate-spin"));
    expect(button("Save", m).disabled).toBe(false);
    await act(async () => { gate.resolve({ ok: true, status: 200, latencyMs: 1, url: "u", message: "ok" }); });
    await waitFor(() => expect(hasButton("Test", m)).toBe(true));
  });

  it.each([
    ["the server's message", fail(400, { error: "proxy host is not allowed" }), "proxy host is not allowed"],
    ["'Proxy test failed' for a non-API failure", () => { throw new TypeError("offline"); }, "Proxy test failed"],
  ])("toasts %s when the test request itself fails, showing no result box", async (_name, handler, text) => {
    await loaded({ "POST /proxies/test": handler });
    fireEvent.click(button("Edit", cardOf("local")));
    const m = openModal("Edit “local”");
    fireEvent.click(button("Test", m));
    await toastShown(text);
    expect(m.querySelector(".rounded-lg.border.px-4")).toBeNull();
  });

  it("forgets the test result when the dialog is reopened", async () => {
    await loaded({ "POST /proxies/test": { ok: true, status: 200, latencyMs: 1, url: "u", message: "probe ok" } });
    fireEvent.click(button("Edit", cardOf("local")));
    fireEvent.click(button("Test", openModal("Edit “local”")));
    await screen.findByText("probe ok");
    fireEvent.click(button("Cancel", openModal("Edit “local”")));
    expect(modal("Edit “local”")).toBeNull();
    fireEvent.click(button("Edit", cardOf("local")));
    expect(screen.queryByText("probe ok")).toBeNull();
  });

  it("asks before deleting; Cancel sends nothing", async () => {
    const { api } = await loaded();
    fireEvent.click(iconButton("bi-trash", cardOf("local")));
    const m = openModal("Delete proxy");
    expect(screen.getByText("Delete “local”? Providers still using it must be detached first.")).toBeTruthy();
    await act(async () => { fireEvent.click(button("Cancel", m)); });
    expect(api.mutations()).toEqual([]);
  });

  it("deletes with DELETE /proxies/:id after confirmation, toasts and reloads", async () => {
    const { api } = await loaded({ "DELETE /proxies/3": { ok: true } });
    fireEvent.click(iconButton("bi-trash", cardOf("local")));
    fireEvent.click(button("Confirm", openModal("Delete proxy")));
    await toastShown("Proxy deleted");
    expect(api.mutations()).toEqual([sentBare("DELETE", "/proxies/3")]);
    expect(api.sent("GET", "/proxies")).toHaveLength(2);
  });

  it.each([
    ["the server's message naming the providers", fail(409, { error: "Still used by: openai" }), "Still used by: openai"],
    ["'Delete failed' for a non-API failure", () => { throw new TypeError("offline"); }, "Delete failed"],
  ])("toasts %s when the delete is refused", async (_name, handler, text) => {
    const { api } = await loaded({ "DELETE /proxies/3": handler });
    fireEvent.click(iconButton("bi-trash", cardOf("local")));
    fireEvent.click(button("Confirm", openModal("Delete proxy")));
    await toastShown(text);
    expect(api.sent("GET", "/proxies")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("Tools page", () => {
  const SAMPLE_SCHEMA = { type: "object", properties: { query: { type: "string", description: "Search query" } }, required: ["query"], additionalProperties: false };
  const SAMPLE_BODY = { tool: "{{tool.name}}", arguments: "{{arguments}}", session_id: "{{session.id}}", call_id: "{{call.id}}" };
  const SEARCH: HostedTool = {
    id: 5, name: "search", description: "Search the docs", parameters: { type: "object" }, url: "https://adapter.example/call",
    bodyTemplate: { q: "{{arguments.query}}" }, resultPath: "/data", timeoutMs: 5000, maxResultBytes: 1024, enabled: false,
    headerNames: ["Authorization", "X-Team"], hasHeaders: true, serverTool: { name: "web_search", resultType: "web_search_result", resultPath: "/results" },
  };
  const PLAIN: HostedTool = {
    id: 6, name: "calc", description: "Do sums", parameters: SAMPLE_SCHEMA, url: "https://calc.example/run", bodyTemplate: SAMPLE_BODY,
    resultPath: "", timeoutMs: 30000, maxResultBytes: 65536, enabled: true, headerNames: [], hasHeaders: false,
  };
  const setup = async (routes: Routes = {}) => {
    const api = mockApi({ "GET /tools": { tools: [SEARCH, PLAIN] }, ...routes }, ADMIN);
    const view = await renderPage(<Tools />);
    return { api, ...view };
  };
  const loaded = async (routes: Routes = {}) => {
    const r = await setup(routes);
    await screen.findByText("calc");
    return r;
  };
  const cardOf = (name: string) => screen.getByText(name).closest("article") as HTMLElement;
  const NEW_TITLE = "Register server tool";
  const openNew = () => {
    fireEvent.click(button("Register tool"));
    return openModal(NEW_TITLE);
  };
  const area = (label: string, m: ParentNode) => field<HTMLTextAreaElement>(label, m);

  it("shows the header and a spinner while loading", async () => {
    const gate = deferred<unknown>();
    const { container } = await setup({ "GET /tools": () => gate.promise });
    const h1 = container.querySelector("h1")!;
    expect(h1.textContent).toBe("Server tools");
    expect(classes(h1)).toEqual(cls(PAGE_TITLE));
    expect(classes(h1.querySelector("i"))).toEqual(cls("bi bi-tools text-brand-400"));
    expect(screen.getByText("Define tool parameters and HTTP forwarding, then bind tools to a Model Service or Micro Agent.")).toBeTruthy();
    expect(spinner()).not.toBeNull();
    const add = button("Register tool");
    expect(classes(add)).toEqual(["btn-primary"]);
    expect(classes(add.querySelector("i"))).toEqual(cls("bi bi-plus-lg"));
    expect(container.querySelector("article")).toBeNull();
    await act(async () => { gate.resolve({ tools: [] }); });
    await screen.findByText("Make an HTTP API available to your model");
    expect(spinner()).toBeNull();
  });

  it("shows the load error under the header", async () => {
    const { container } = await setup({ "GET /tools": fail(500, { error: "db down" }) });
    await waitFor(() => expect(errorNote()).not.toBeNull());
    expect(errorNote()!.textContent).toBe("db down");
    expect(container.querySelector("h1")!.textContent).toBe("Server tools");
    expect(container.querySelector("article")).toBeNull();
    expect(screen.queryByText("Make an HTTP API available to your model")).toBeNull();
  });

  it("shows its own empty card when no tool is registered", async () => {
    await setup({ "GET /tools": { tools: [] } });
    const title = await screen.findByText("Make an HTTP API available to your model");
    expect(classes(title)).toEqual(cls("mt-4 font-semibold"));
    const card = title.parentElement!;
    expect(classes(card)).toEqual(cls("card p-10 text-center"));
    expect(classes(card.querySelector("i"))).toEqual(cls("bi bi-tools text-3xl text-brand-400"));
    const body = screen.getByText("Hydrogen manages the tool loop, sessions and responses. Your configured adapter implements the tool logic.");
    expect(classes(body)).toEqual(cls("mx-auto mt-2 max-w-xl text-sm text-ink-400"));
  });

  it("lists tools as cards with state, description, endpoint and Edit/Delete", async () => {
    await loaded();
    const search = cardOf("search");
    expect(classes(search)).toEqual(cls("card flex items-center justify-between gap-4 p-5"));
    expect(classes(search.parentElement)).toEqual(["space-y-3"]);
    expect(search.parentElement!.children).toHaveLength(2);
    expect(classes(screen.getByText("search"))).toEqual(["font-semibold"]);
    const state = screen.getByText("Disabled");
    expect(search.contains(state)).toBe(true);
    expect(classes(state)).toEqual(cls("text-xs text-ink-500"));
    expect(classes(screen.getByText("Search the docs"))).toEqual(cls("mt-1 text-sm text-ink-400"));
    const endpoint = search.querySelector("p.font-mono")!;
    expect(endpoint.textContent).toBe("POST https://adapter.example/call");
    expect(classes(endpoint)).toEqual(cls("mt-2 truncate font-mono text-xs text-ink-500"));
    expect([...search.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Edit", "Delete"]);
    expect(classes(button("Edit", search).parentElement)).toEqual(cls("flex shrink-0 gap-2"));

    const calc = cardOf("calc");
    const on = calc.querySelector("span")!;
    expect(on.textContent).toBe("Enabled");
    expect(classes(on)).toEqual(cls("text-xs text-brand-400"));
  });

  it("opens the register form with sample schema, sample template and defaults", async () => {
    await loaded();
    const m = openNew();
    expect(classes(m)).toEqual(cls("card flex max-h-[92vh] w-full flex-col max-w-4xl"));
    expect(m.querySelector("h2 i")).toBeNull();
    const name = field("Tool name", m);
    expect([name.value, name.maxLength, name.placeholder, classes(name)]).toEqual(["", 64, "search_documents", ["input"]]);
    expect([field("Description (shown to the model)", m).value, classes(field("Description (shown to the model)", m))]).toEqual(["", ["input"]]);
    const url = field("POST URL", m);
    expect([url.value, url.type, url.placeholder, classes(url)]).toEqual(["", "url", "https://adapter.example.com/tools/call", cls("input w-full font-mono")]);
    const headers = field("Authentication and headers (JSON)", m);
    expect([headers.value, headers.type, headers.autocomplete, classes(headers)]).toEqual(["", "password", "new-password", cls("input w-full font-mono")]);
    expect(screen.getByText("Leave blank to keep saved headers; enter {} to clear. Headers are stored encrypted.")).toBeTruthy();
    const schema = area("Parameter JSON Schema (draft 7)", m);
    const template = area("POST JSON request template", m);
    expect(schema.value).toBe(JSON.stringify(SAMPLE_SCHEMA, null, 2));
    expect(template.value).toBe(JSON.stringify(SAMPLE_BODY, null, 2));
    expect([schema.rows, schema.getAttribute("spellcheck"), classes(schema)]).toEqual([10, "false", cls("input w-full font-mono text-xs")]);
    expect(field("Result JSON Pointer", m).value).toBe("/result");
    const timeout = field("Timeout (ms)", m);
    const maxBytes = field("Maximum response bytes", m);
    expect([timeout.type, timeout.value, timeout.min, timeout.max]).toEqual(["number", "30000", "100", "600000"]);
    expect([maxBytes.type, maxBytes.value, maxBytes.min, maxBytes.max]).toEqual(["number", "65536", "1", "1048576"]);
    expect(area("Sample tool arguments", m).value).toBe('{"query":"example"}');
    expect(area("Sample API response", m).value).toBe('{"result":{"answer":"example"}}');
    expect(area("Sample tool arguments", m).rows).toBe(3);
    expect(isOn(toggle("Enable tool", m))).toBe(true);
    expect(isOn(toggle("Round-trip as a server tool", m))).toBe(false);
    expect(m.querySelector('input[placeholder="web_search"]')).toBeNull();
    expect(classes(labelEl("Tool name", m))).toEqual(["label"]);
    expect([...m.querySelectorAll("summary")].map((s) => [s.textContent, s.className])).toEqual([
      ["Server-side tool round trip (client protocol)", "cursor-pointer text-sm font-medium"],
      ["Preview mapping (no HTTP request is sent)", "cursor-pointer text-sm font-medium"],
    ]);
    expect(classes(m.querySelector("details"))).toEqual(cls("rounded-lg border border-ink-700 p-4"));
    expect(classes(screen.getByText(/^Use \{\{arguments\}\}/))).toEqual(cls("rounded-lg bg-ink-800 p-3 text-xs leading-relaxed text-ink-300"));

    // The actions live at the end of the body, not in a modal footer.
    const save = button("Save tool", m);
    expect(classes(save)).toEqual(["btn-primary"]);
    expect(save.disabled).toBe(false);
    expect(classes(save.parentElement)).toEqual(cls("flex justify-end gap-3"));
    expect([...save.parentElement!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Cancel", "Save tool"]);
    expect(save.closest(".card-pad")).not.toBeNull();
    expect(m.children).toHaveLength(2);
  });

  it("registers with POST /tools, sending the samples, the defaults and empty headers", async () => {
    const { api } = await loaded({ "POST /tools": { tool: {} } });
    const m = openNew();
    type(field("Tool name", m), "lookup");
    type(field("Description (shown to the model)", m), "Look things up");
    type(field("POST URL", m), "https://a.example/call");
    fireEvent.click(button("Save tool", m));
    await toastShown("Tool saved");
    expect(api.mutations()).toEqual([sentJson("POST", "/tools", {
      name: "lookup", description: "Look things up", url: "https://a.example/call", parameters: SAMPLE_SCHEMA, bodyTemplate: SAMPLE_BODY,
      resultPath: "/result", timeoutMs: 30000, maxResultBytes: 65536, enabled: true, headers: {},
    })]);
    expect(modal(NEW_TITLE)).toBeNull();
    expect(api.sent("GET", "/tools")).toHaveLength(2);
  });

  it("sends every edited field: parsed JSON, numeric limits, headers and the enabled flag", async () => {
    const { api } = await loaded({ "POST /tools": {} });
    const m = openNew();
    type(field("Tool name", m), "lookup");
    type(field("Authentication and headers (JSON)", m), '{"Authorization":"Bearer x"}');
    type(area("Parameter JSON Schema (draft 7)", m), '{"type":"object","properties":{}}');
    type(area("POST JSON request template", m), '{"q":"{{arguments.q}}"}');
    type(field("Result JSON Pointer", m), "");
    type(field("Timeout (ms)", m), "1500");
    type(field("Maximum response bytes", m), "2048");
    fireEvent.click(toggle("Enable tool", m));
    fireEvent.click(button("Save tool", m));
    await toastShown("Tool saved");
    expect(api.mutations()[0].body).toEqual({
      name: "lookup", description: "", url: "", parameters: { type: "object", properties: {} }, bodyTemplate: { q: "{{arguments.q}}" },
      resultPath: "", timeoutMs: 1500, maxResultBytes: 2048, enabled: false, headers: { Authorization: "Bearer x" },
    });
  });

  it.each([
    ["Parameter JSON Schema (draft 7)"],
    ["POST JSON request template"],
  ])("refuses invalid JSON in %s with an inline error and sends nothing", async (label) => {
    const { api } = await loaded();
    const m = openNew();
    type(area(label, m), "{not json");
    fireEvent.click(button("Save tool", m));
    await waitFor(() => expect(m.querySelector(".border-red-900\\/50")).not.toBeNull());
    expect(api.mutations()).toEqual([]);
    expect(modal(NEW_TITLE)).not.toBeNull();
    expect(button("Save tool", m).disabled).toBe(false);
    expect(toasts()).toEqual([]);
  });

  it("refuses invalid header JSON with an inline error", async () => {
    const { api } = await loaded();
    const m = openNew();
    type(field("Authentication and headers (JSON)", m), "Bearer x");
    fireEvent.click(button("Save tool", m));
    await waitFor(() => expect(m.querySelector(".border-red-900\\/50")).not.toBeNull());
    expect(api.mutations()).toEqual([]);
  });

  it("shows a refused save inline (not as a toast) and keeps the dialog open", async () => {
    await loaded({ "POST /tools": fail(400, { error: "name must match [a-zA-Z0-9_-]" }) });
    const m = openNew();
    fireEvent.click(button("Save tool", m));
    await waitFor(() => expect(m.querySelector(".border-red-900\\/50")?.textContent).toBe("name must match [a-zA-Z0-9_-]"));
    expect(classes(m.querySelector(".border-red-900\\/50"))).toEqual(cls("flex items-center gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300"));
    expect(toasts()).toEqual([]);
    expect(modal(NEW_TITLE)).not.toBeNull();
  });

  it("server-tool contract: reveals three fields, requires a name, defaults the result type", async () => {
    const { api } = await loaded({ "POST /tools": {} });
    const m = openNew();
    type(field("Tool name", m), "lookup");
    fireEvent.click(toggle("Round-trip as a server tool", m));
    const declared = field("Name the client declares", m);
    const resultType = field("Result block type", m);
    const entries = field("Result entries JSON Pointer", m);
    expect([declared.value, declared.maxLength, declared.placeholder, classes(declared)]).toEqual(["", 64, "web_search", cls("input w-full font-mono")]);
    expect([resultType.value, resultType.maxLength, resultType.placeholder]).toEqual(["web_search_result", 128, "web_search_result"]);
    expect([entries.value, entries.placeholder]).toEqual(["", "/results"]);

    fireEvent.click(button("Save tool", m));
    await waitFor(() => expect(m.querySelector(".border-red-900\\/50")?.textContent).toBe("The server-tool contract needs the name a client declares"));
    expect(api.mutations()).toEqual([]);

    type(declared, "  web_search  ");
    type(resultType, "   ");
    type(entries, " /items ");
    fireEvent.click(button("Save tool", m));
    await toastShown("Tool saved");
    expect((api.mutations()[0].body as { serverTool: unknown }).serverTool).toEqual({ name: "web_search", resultType: "web_search_result", resultPath: "/items" });
  });

  it("opens the edit form prefilled from the tool, headers blank with the saved names listed", async () => {
    await loaded();
    fireEvent.click(button("Edit", cardOf("search")));
    const m = openModal("Edit search");
    expect(field("Tool name", m).value).toBe("search");
    expect(field("Description (shown to the model)", m).value).toBe("Search the docs");
    expect(field("POST URL", m).value).toBe("https://adapter.example/call");
    expect(field("Authentication and headers (JSON)", m).value).toBe("");
    expect(screen.getByText("Leave blank to keep saved headers; enter {} to clear. Headers are stored encrypted. Authorization, X-Team")).toBeTruthy();
    expect(area("Parameter JSON Schema (draft 7)", m).value).toBe(JSON.stringify({ type: "object" }, null, 2));
    expect(area("POST JSON request template", m).value).toBe(JSON.stringify({ q: "{{arguments.query}}" }, null, 2));
    expect([field("Result JSON Pointer", m).value, field("Timeout (ms)", m).value, field("Maximum response bytes", m).value]).toEqual(["/data", "5000", "1024"]);
    expect(isOn(toggle("Enable tool", m))).toBe(false);
    expect(isOn(toggle("Round-trip as a server tool", m))).toBe(true);
    expect([field("Name the client declares", m).value, field("Result block type", m).value, field("Result entries JSON Pointer", m).value]).toEqual(["web_search", "web_search_result", "/results"]);
  });

  it("updates with PATCH /tools/:id and leaves headers out when the field is blank", async () => {
    const { api } = await loaded({ "PATCH /tools/5": { tool: {} } });
    fireEvent.click(button("Edit", cardOf("search")));
    const m = openModal("Edit search");
    type(field("Description (shown to the model)", m), "Better search");
    fireEvent.click(button("Save tool", m));
    await toastShown("Tool saved");
    expect(api.mutations()).toEqual([sentJson("PATCH", "/tools/5", {
      name: "search", description: "Better search", url: "https://adapter.example/call", parameters: { type: "object" }, bodyTemplate: { q: "{{arguments.query}}" },
      resultPath: "/data", timeoutMs: 5000, maxResultBytes: 1024, enabled: false,
      serverTool: { name: "web_search", resultType: "web_search_result", resultPath: "/results" },
    })]);
    expect(modal("Edit search")).toBeNull();
    expect(api.sent("GET", "/tools")).toHaveLength(2);
  });

  it.each([
    ["replaces headers when new ones are typed", '{"X-Team":"b"}', { "X-Team": "b" }],
    ["clears headers when {} is typed", "{}", {}],
  ])("on edit %s", async (_name, typed, headers) => {
    const { api } = await loaded({ "PATCH /tools/5": {} });
    fireEvent.click(button("Edit", cardOf("search")));
    const m = openModal("Edit search");
    type(field("Authentication and headers (JSON)", m), typed);
    fireEvent.click(button("Save tool", m));
    await toastShown("Tool saved");
    expect((api.mutations()[0].body as { headers: unknown }).headers).toEqual(headers);
  });

  it("drops the server-tool contract from the PATCH when it is switched off", async () => {
    const { api } = await loaded({ "PATCH /tools/5": {} });
    fireEvent.click(button("Edit", cardOf("search")));
    const m = openModal("Edit search");
    fireEvent.click(toggle("Round-trip as a server tool", m));
    fireEvent.click(button("Save tool", m));
    await toastShown("Tool saved");
    expect(api.mutations()[0].body).not.toHaveProperty("serverTool");
  });

  it("previews the mapping through POST /tools/preview and prints the answer", async () => {
    const answer = { request: { q: "example" }, result: { answer: "example" } };
    const { api } = await loaded({ "POST /tools/preview": answer });
    fireEvent.click(button("Edit", cardOf("search")));
    const m = openModal("Edit search");
    type(area("Sample tool arguments", m), '{"query":"cats"}');
    fireEvent.click(button("Preview", m));
    await waitFor(() => expect(m.querySelector("pre")).not.toBeNull());
    expect(api.mutations()).toEqual([sentJson("POST", "/tools/preview", {
      toolName: "search", bodyTemplate: { q: "{{arguments.query}}" }, arguments: { query: "cats" }, result: { result: { answer: "example" } }, resultPath: "/data",
    })]);
    const pre = m.querySelector("pre")!;
    expect(pre.textContent).toBe(JSON.stringify(answer, null, 2));
    expect(classes(pre)).toEqual(cls("overflow-auto rounded bg-ink-950 p-3 text-xs"));
    expect(modal("Edit search")).not.toBeNull();
  });

  it("previews an unnamed tool as 'example' and reports bad sample JSON inline", async () => {
    const { api } = await loaded({ "POST /tools/preview": {} });
    const m = openNew();
    fireEvent.click(button("Preview", m));
    await waitFor(() => expect(api.mutations()).toHaveLength(1));
    expect((api.mutations()[0].body as { toolName: string }).toolName).toBe("example");
    type(area("Sample API response", m), "nope");
    fireEvent.click(button("Preview", m));
    await waitFor(() => expect(m.querySelector(".border-red-900\\/50")).not.toBeNull());
    expect(api.mutations()).toHaveLength(1);
  });

  it.each([
    ["Cancel", (m: HTMLElement) => button("Cancel", m)],
    ["the close button", (m: HTMLElement) => iconButton("bi-x-lg", m)],
  ])("closes the editor with %s, sending nothing and discarding the edits", async (_name, pick) => {
    const { api } = await loaded();
    type(field("Tool name", openNew()), "draft");
    fireEvent.click(pick(openModal(NEW_TITLE)));
    expect(modal(NEW_TITLE)).toBeNull();
    expect(api.mutations()).toEqual([]);
    expect(field("Tool name", openNew()).value).toBe("");
  });

  it("asks before deleting; Cancel sends nothing", async () => {
    const { api } = await loaded();
    fireEvent.click(button("Delete", cardOf("search")));
    const m = openModal("Delete tool");
    expect(screen.getByText("Delete search and remove its service bindings?")).toBeTruthy();
    await act(async () => { fireEvent.click(button("Cancel", m)); });
    expect(api.mutations()).toEqual([]);
  });

  it("deletes with DELETE /tools/:id after confirmation and reloads", async () => {
    const { api } = await loaded({ "DELETE /tools/5": { ok: true } });
    fireEvent.click(button("Delete", cardOf("search")));
    fireEvent.click(button("Confirm", openModal("Delete tool")));
    await waitFor(() => expect(api.sent("GET", "/tools")).toHaveLength(2));
    expect(api.mutations()).toEqual([sentBare("DELETE", "/tools/5")]);
  });

  it("toasts the error message when the delete is refused", async () => {
    const { api } = await loaded({ "DELETE /tools/5": fail(409, { error: "tool is bound to a service" }) });
    fireEvent.click(button("Delete", cardOf("search")));
    fireEvent.click(button("Confirm", openModal("Delete tool")));
    await toastShown("tool is bound to a service");
    expect(api.sent("GET", "/tools")).toHaveLength(1);
  });
});
