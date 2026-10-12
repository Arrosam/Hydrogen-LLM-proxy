/**
 * WB8: the Tools page reports like its sibling pages -- a success toast after
 * a delete, and the translated fallback rather than the browser's raw
 * "Failed to fetch" when a request never got an answer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Tools } from "../src/pages/Tools";
import type { HostedTool } from "../src/types";
import { ADMIN, button, fail, field, mockApi, openModal, renderPage, toastShown, toasts, type, type Routes } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const TOOL: HostedTool = {
  id: 5, name: "search", description: "Search the docs", parameters: { type: "object" }, url: "https://adapter.example/call",
  bodyTemplate: {}, resultPath: "/data", timeoutMs: 5000, maxResultBytes: 1024, enabled: true, headerNames: [], hasHeaders: false,
};
const offline = () => { throw new TypeError("Failed to fetch"); };
const setup = async (routes: Routes) => {
  const api = mockApi({ "GET /tools": { tools: [TOOL] }, ...routes }, ADMIN);
  await renderPage(<Tools />);
  await screen.findByText("search");
  return api;
};
const inlineError = (m: HTMLElement) => m.querySelector(".border-red-900\\/50")?.textContent;

describe("Tools: delete", () => {
  const confirmDelete = () => {
    fireEvent.click(button("Delete"));
    fireEvent.click(button("Confirm", openModal("Delete tool")));
  };

  it("toasts 'Tool deleted' and reloads", async () => {
    const api = await setup({ "DELETE /tools/5": { ok: true } });
    confirmDelete();
    await toastShown("Tool deleted");
    await waitFor(() => expect(api.sent("GET", "/tools")).toHaveLength(2));
  });

  it("toasts 'Delete failed', not the raw network error, when no answer came", async () => {
    await setup({ "DELETE /tools/5": offline });
    confirmDelete();
    await toastShown("Delete failed");
    expect(toasts()).toEqual(["Delete failed"]);
  });

  it("still toasts the server's own message when it refused", async () => {
    await setup({ "DELETE /tools/5": fail(409, { error: "tool is bound to a service" }) });
    confirmDelete();
    await toastShown("tool is bound to a service");
  });
});

describe("Tools: save and preview", () => {
  const openEdit = () => {
    fireEvent.click(button("Edit"));
    return openModal("Edit search");
  };

  it("a save that got no answer reads 'Save failed' inline", async () => {
    await setup({ "PATCH /tools/5": offline });
    const m = openEdit();
    fireEvent.click(button("Save tool", m));
    await waitFor(() => expect(inlineError(m)).toBe("Save failed"));
    expect(toasts()).toEqual([]);
  });

  it("a preview that got no answer reads 'Preview failed' inline", async () => {
    await setup({ "POST /tools/preview": offline });
    const m = openEdit();
    fireEvent.click(button("Preview", m));
    await waitFor(() => expect(inlineError(m)).toBe("Preview failed"));
  });

  it("the server's message and the form's own complaints still show as they are", async () => {
    const api = await setup({ "PATCH /tools/5": fail(400, { error: "url must be https" }), "POST /tools/preview": fail(400, { error: "bad pointer" }) });
    const m = openEdit();
    fireEvent.click(button("Save tool", m));
    await waitFor(() => expect(inlineError(m)).toBe("url must be https"));
    fireEvent.click(button("Preview", m));
    await waitFor(() => expect(inlineError(m)).toBe("bad pointer"));
    const sent = api.mutations().length;
    type(field<HTMLTextAreaElement>("POST JSON request template", m), "{not json");
    fireEvent.click(button("Save tool", m));
    await waitFor(() => expect(inlineError(m)).toMatch(/JSON/));
    fireEvent.click(button("Preview", m));
    await waitFor(() => expect(inlineError(m)).toMatch(/JSON/));
    expect(api.mutations()).toHaveLength(sent);
  });
});
