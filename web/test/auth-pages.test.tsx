/** Login and SetPassword: what they render, what they send, and how they report failure. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Login } from "../src/pages/Login";
import { SetPassword } from "../src/pages/SetPassword";
import type { User } from "../src/types";
import { ADMIN, authState, button, classes, cls, deferred, fail, field, labelEl, mockApi, renderPage, type, type Routes } from "./helpers";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const ERROR_BOX = "flex items-center gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300";
const errorBox = (): HTMLElement | null => document.querySelector("form .border-red-900\\/50");

describe("Login", () => {
  const setup = async (routes: Routes = {}) => {
    const api = mockApi(routes);
    const view = await renderPage(<Login />);
    expect(authState()).toBe("anonymous");
    return { api, ...view };
  };
  const fill = (username: string, password: string) => {
    type(field("Username"), username);
    type(field("Password"), password);
  };

  it("renders the brand, the two fields and the submit button", async () => {
    const { container } = await setup();
    const h1 = container.querySelector("h1")!;
    expect(h1.textContent).toBe("Hydrogen");
    expect(classes(h1)).toEqual(cls("text-xl font-semibold text-ink-100"));
    const subtitle = screen.getByText("Sign in to the LLM proxy console");
    expect(classes(subtitle)).toEqual(cls("text-sm text-ink-500"));
    expect(classes(container.firstElementChild)).toEqual(cls("flex min-h-screen items-center justify-center px-4"));
    expect(classes(container.firstElementChild!.firstElementChild)).toEqual(cls("w-full max-w-sm"));
    expect(classes(container.querySelector("svg"))).toEqual(cls("h-14 w-14"));

    const form = container.querySelector("form")!;
    expect(classes(form)).toEqual(cls("card card-pad space-y-4"));
    expect([...form.querySelectorAll(".label")].map((l) => l.textContent)).toEqual(["Username", "Password"]);
    expect(classes(labelEl("Username"))).toEqual(["label"]);

    const username = field("Username");
    const password = field("Password");
    expect([username.type, username.value, username.autocomplete, classes(username)]).toEqual(["text", "", "username", ["input"]]);
    expect([password.type, password.value, password.autocomplete, classes(password)]).toEqual(["password", "", "current-password", ["input"]]);
    expect(document.activeElement).toBe(username);

    const submit = button("Sign in");
    expect(classes(submit)).toEqual(cls("btn-primary w-full"));
    expect(submit.disabled).toBe(false);
    expect(classes(submit.querySelector("i"))).toEqual(cls("bi bi-box-arrow-in-right"));
    expect(errorBox()).toBeNull();
  });

  it("posts the credentials to /login and signs the user in", async () => {
    const { api } = await setup({ "POST /login": { user: ADMIN } });
    fill("root", "hunter22");
    fireEvent.click(button("Sign in"));
    await waitFor(() => expect(authState()).toBe("root:admin:ok"));
    expect(api.mutations()).toEqual([
      { method: "POST", path: "/login", body: { username: "root", password: "hunter22" }, headers: { "content-type": "application/json" }, credentials: "same-origin" },
    ]);
    expect(errorBox()).toBeNull();
  });

  it("sends the fields as typed: no trimming and no client-side validation of empty values", async () => {
    const { api } = await setup({ "POST /login": fail(401, { error: "Invalid username or password" }) });
    fireEvent.click(button("Sign in"));
    await waitFor(() => expect(errorBox()).not.toBeNull());
    fill("  root ", " pw ");
    fireEvent.click(button("Sign in"));
    await waitFor(() => expect(api.mutations()).toHaveLength(2));
    expect(api.mutations().map((c) => c.body)).toEqual([{ username: "", password: "" }, { username: "  root ", password: " pw " }]);
  });

  it("shows the server's error message in a red box and stays signed out", async () => {
    await setup({ "POST /login": fail(401, { error: "Invalid username or password" }) });
    fill("root", "wrong");
    fireEvent.click(button("Sign in"));
    await waitFor(() => expect(errorBox()).not.toBeNull());
    const box = errorBox()!;
    expect(box.textContent).toBe("Invalid username or password");
    expect(classes(box)).toEqual(cls(ERROR_BOX));
    expect(classes(box.querySelector("i"))).toEqual(cls("bi bi-exclamation-circle"));
    expect(authState()).toBe("anonymous");
    expect(button("Sign in").disabled).toBe(false);
    // The typed values are kept for another attempt.
    expect([field("Username").value, field("Password").value]).toEqual(["root", "wrong"]);
  });

  it("shows the status line for a non-JSON error body", async () => {
    await setup({ "POST /login": fail(502, "<html>Bad Gateway</html>") });
    fireEvent.click(button("Sign in"));
    await waitFor(() => expect(errorBox()?.textContent).toBe("Request failed (502)"));
  });

  it("shows a network failure by its own message", async () => {
    await setup({ "POST /login": () => { throw new TypeError("Failed to fetch"); } });
    fireEvent.click(button("Sign in"));
    await waitFor(() => expect(errorBox()?.textContent).toBe("Failed to fetch"));
  });

  it("falls back to 'Login failed' when the rejection is not an Error", async () => {
    await setup({ "POST /login": () => Promise.reject("nope") });
    fireEvent.click(button("Sign in"));
    await waitFor(() => expect(errorBox()?.textContent).toBe("Login failed"));
  });

  it("disables the button with a spinner while the request is in flight, and clears a previous error", async () => {
    const gate = deferred<unknown>();
    let attempt = 0;
    await setup({ "POST /login": () => (++attempt === 1 ? fail(401, { error: "bad" }) : gate.promise) });
    fireEvent.click(button("Sign in"));
    await waitFor(() => expect(errorBox()?.textContent).toBe("bad"));

    fireEvent.click(button("Sign in"));
    await waitFor(() => expect(button("Sign in").disabled).toBe(true));
    expect(classes(button("Sign in").querySelector("i"))).toEqual(cls("bi bi-arrow-repeat animate-spin"));
    expect(errorBox()).toBeNull();

    await act(async () => { gate.resolve({ user: ADMIN }); });
    await waitFor(() => expect(button("Sign in").disabled).toBe(false));
    expect(authState()).toBe("root:admin:ok");
  });
});

describe("SetPassword", () => {
  const FRESH: User = { ...ADMIN, mustChangePassword: true };
  const setup = async (routes: Routes = {}) => {
    const api = mockApi(routes, FRESH);
    const view = await renderPage(<SetPassword />);
    expect(authState()).toBe("root:admin:must-change");
    return { api, ...view };
  };
  const fill = (current: string, next: string, confirm: string) => {
    type(field("Current password"), current);
    type(field("New password"), next);
    type(field("Confirm password"), confirm);
  };
  const SUBMIT = "Set password and continue";

  it("renders the title, who is signed in, three password fields and two buttons", async () => {
    const { container } = await setup();
    const h1 = container.querySelector("h1")!;
    expect(h1.textContent).toBe("Create your password");
    expect(classes(h1)).toEqual(cls("text-xl font-semibold text-ink-100"));
    expect(classes(screen.getByText("Signed in as root. Set a password to continue."))).toEqual(cls("text-sm text-ink-500"));
    expect(classes(container.firstElementChild)).toEqual(cls("flex min-h-screen items-center justify-center px-4"));
    expect(classes(container.firstElementChild!.firstElementChild)).toEqual(cls("w-full max-w-sm"));
    const badge = container.querySelector("i.bi-shield-lock")!;
    expect(classes(badge)).toEqual(cls("bi bi-shield-lock text-2xl"));
    expect(classes(badge.parentElement)).toEqual(cls("flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600/20 text-brand-400"));

    const form = container.querySelector("form")!;
    expect(classes(form)).toEqual(cls("card card-pad space-y-4"));
    expect([...form.querySelectorAll(".label")].map((l) => l.textContent)).toEqual(["Current password", "New password", "Confirm password"]);
    const current = field("Current password");
    const next = field("New password");
    const confirm = field("Confirm password");
    expect([current.type, current.autocomplete, current.required, classes(current)]).toEqual(["password", "current-password", true, ["input"]]);
    expect([next.type, next.autocomplete, next.required, next.placeholder, classes(next)]).toEqual(["password", "new-password", false, "at least 8 characters", ["input"]]);
    expect([confirm.type, confirm.autocomplete, confirm.required, classes(confirm)]).toEqual(["password", "new-password", false, ["input"]]);
    expect(document.activeElement).toBe(next);

    const submit = button(SUBMIT);
    expect(classes(submit)).toEqual(cls("btn-primary w-full"));
    expect(classes(submit.querySelector("i"))).toEqual(cls("bi bi-check-lg"));
    const signOut = button("Sign out");
    expect(classes(signOut)).toEqual(cls("btn-ghost w-full btn-xs"));
    expect(signOut.type).toBe("button");
    expect(classes(signOut.querySelector("i"))).toEqual(cls("bi bi-box-arrow-right"));
    expect(errorBox()).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["one character", "a"],
    ["seven characters", "1234567"],
  ])("rejects a new password that is too short (%s) without calling the server", async (_name, pw) => {
    const { api, container } = await setup();
    fill("old-pass", pw, pw);
    fireEvent.submit(container.querySelector("form")!);
    const box = errorBox()!;
    expect(box.textContent).toBe("Password must be at least 8 characters.");
    expect(classes(box)).toEqual(cls(ERROR_BOX));
    expect(classes(box.querySelector("i"))).toEqual(cls("bi bi-exclamation-circle"));
    expect(api.mutations()).toEqual([]);
  });

  it("rejects a confirmation that differs, without calling the server", async () => {
    const { api, container } = await setup();
    fill("old-pass", "12345678", "12345679");
    fireEvent.submit(container.querySelector("form")!);
    expect(errorBox()!.textContent).toBe("Passwords do not match.");
    expect(api.mutations()).toEqual([]);
  });

  it("checks the length before the match", async () => {
    const { container } = await setup();
    fill("old-pass", "short", "different");
    fireEvent.submit(container.querySelector("form")!);
    expect(errorBox()!.textContent).toBe("Password must be at least 8 characters.");
  });

  it("accepts exactly eight characters: posts both passwords and adopts the returned user", async () => {
    const { api } = await setup({ "POST /change-password": { user: { ...FRESH, mustChangePassword: false } } });
    fill("old-pass", "12345678", "12345678");
    fireEvent.click(button(SUBMIT));
    await waitFor(() => expect(authState()).toBe("root:admin:ok"));
    expect(api.mutations()).toEqual([
      { method: "POST", path: "/change-password", body: { newPassword: "12345678", currentPassword: "old-pass" }, headers: { "content-type": "application/json" }, credentials: "same-origin" },
    ]);
    expect(errorBox()).toBeNull();
  });

  it("shows the server's message when the change is refused, and stays on the form", async () => {
    await setup({ "POST /change-password": fail(400, { error: "Current password is incorrect" }) });
    fill("wrong", "new-password", "new-password");
    fireEvent.click(button(SUBMIT));
    await waitFor(() => expect(errorBox()?.textContent).toBe("Current password is incorrect"));
    expect(authState()).toBe("root:admin:must-change");
    expect(button(SUBMIT).disabled).toBe(false);
  });

  it("shows the fallback text for a failure that is not an API error", async () => {
    await setup({ "POST /change-password": () => { throw new TypeError("Failed to fetch"); } });
    fill("old-pass", "new-password", "new-password");
    fireEvent.click(button(SUBMIT));
    await waitFor(() => expect(errorBox()?.textContent).toBe("Could not set password"));
  });

  it("disables the submit button with a spinner while saving and clears a previous error", async () => {
    const gate = deferred<unknown>();
    const { container } = await setup({ "POST /change-password": () => gate.promise });
    fill("old-pass", "short", "short");
    fireEvent.submit(container.querySelector("form")!);
    expect(errorBox()).not.toBeNull();

    fill("old-pass", "new-password", "new-password");
    fireEvent.click(button(SUBMIT));
    await waitFor(() => expect(button(SUBMIT).disabled).toBe(true));
    expect(classes(button(SUBMIT).querySelector("i"))).toEqual(cls("bi bi-arrow-repeat animate-spin"));
    expect(errorBox()).toBeNull();

    await act(async () => { gate.resolve({ user: { ...FRESH, mustChangePassword: false } }); });
    await waitFor(() => expect(authState()).toBe("root:admin:ok"));
  });

  it("signs out through POST /logout without submitting the form", async () => {
    const { api } = await setup({ "POST /logout": { ok: true } });
    fireEvent.click(button("Sign out"));
    await waitFor(() => expect(authState()).toBe("anonymous"));
    expect(api.mutations()).toEqual([
      { method: "POST", path: "/logout", body: {}, headers: { "content-type": "application/json" }, credentials: "same-origin" },
    ]);
    expect(errorBox()).toBeNull();
  });
});
