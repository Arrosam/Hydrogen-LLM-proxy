/**
 * WB4 / WB5: the API-key form must not send a scope or an expiry that means
 * something other than what the form shows.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Tokens } from "../src/pages/Tokens";
import type { ModelService, Token } from "../src/types";
import { ADMIN, button, field, mockApi, modal, openModal, renderPage, toastShown, toasts, type } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const service = (id: number, name: string): ModelService => ({
  id, name, description: null, steps: { timeoutMs: 60000, steps: [{ model: "m", provider: "p" }] }, enabled: true, summary: "", createdAt: id,
});
const CI: Token = {
  id: 2, name: "ci", keyPrefix: "hk_xyz", ownerUserId: 1, scopeServices: [10], maxRequests: null, maxTokens: null,
  usedRequests: 0, usedTokens: 0, expiresAt: null, enabled: true, createdAt: 2, hasStoredKey: true,
};
const ISSUE = "Issue API key";
const EDIT = "Edit API key";
const setup = async () => {
  const api = mockApi({ "GET /tokens": { tokens: [CI] }, "GET /services": { services: [service(10, "svc-a"), service(11, "svc-b")] }, "POST /tokens": { secret: "s" }, "PATCH /tokens/2": {} }, ADMIN);
  await renderPage(<Tokens />);
  await screen.findByText("ci");
  return api;
};
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("WB4 an explicit scope with no service", () => {
  const MESSAGE = "Select at least one Model Service, or allow all";

  it("is refused when issuing: a message, no request, the form stays open", async () => {
    const api = await setup();
    fireEvent.click(button(ISSUE));
    const m = openModal(ISSUE);
    type(field("Name", m), "scoped");
    fireEvent.click(field("Allow all Model Services", m));
    fireEvent.click(button("Issue", m));
    await toastShown(MESSAGE);
    await settle();
    expect(api.mutations()).toEqual([]);
    expect(modal(ISSUE)).not.toBeNull();
  });

  it("is refused when an edit unticks the last service", async () => {
    const api = await setup();
    fireEvent.click(button("Edit"));
    const m = openModal(EDIT);
    fireEvent.click(field("svc-a", m));
    fireEvent.click(button("Save", m));
    await toastShown(MESSAGE);
    await settle();
    expect(api.mutations()).toEqual([]);
    expect(modal(EDIT)).not.toBeNull();
  });

  it("goes through once a service is ticked, or once 'allow all' is back on", async () => {
    const api = await setup();
    fireEvent.click(button(ISSUE));
    const m = openModal(ISSUE);
    type(field("Name", m), "scoped");
    fireEvent.click(field("Allow all Model Services", m));
    fireEvent.click(field("svc-b", m));
    fireEvent.click(button("Issue", m));
    await waitFor(() => expect(api.mutations()).toHaveLength(1));
    expect((api.mutations()[0].body as { scopeServices: unknown }).scopeServices).toEqual([11]);
    expect(toasts()).toEqual([]);
  });
});

describe("WB5 an expiry that is not a date", () => {
  it("is refused with a message instead of being saved as 'never expires'", async () => {
    const api = await setup();
    fireEvent.click(button("Edit"));
    const m = openModal(EDIT);
    // A browser without a datetime-local control hands over whatever was typed.
    const expiry = field("Expires at (optional)", m);
    expiry.type = "text";
    type(expiry, "next tuesday");
    fireEvent.click(button("Save", m));
    await toastShown("Expiry is not a valid date and time");
    await settle();
    expect(api.mutations()).toEqual([]);
    expect(modal(EDIT)).not.toBeNull();
  });
});
