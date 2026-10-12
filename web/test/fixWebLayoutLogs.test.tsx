/**
 * WB11: failures that used to vanish as unhandled promise rejections (sign
 * out, a log's detail), and the clear-all reload that asked for a stale page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { Layout } from "../src/components/Layout";
import { ADMIN, authState, button, fail, mockApi, modal, openModal, renderPage, toastShown, toasts } from "./helpers";
import { FIRST, R1, R2, ROWS, errorNote, logsPath, setup as setupLogs, tick } from "./logs-harness";

const offline = () => { throw new TypeError("Failed to fetch"); };

describe("Layout: sign out", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });
  const setup = async (logout: unknown) => {
    const api = mockApi({ "POST /logout": logout }, ADMIN);
    await renderPage(
      <Routes>
        <Route element={<Layout />}>
          <Route path="*" element={<p>page body</p>} />
        </Route>
      </Routes>,
    );
    return api;
  };

  it.each([
    ["the server's message when it refused", fail(500, { error: "session store down" }), "session store down"],
    ["'Sign out failed' when no answer came", offline, "Sign out failed"],
  ])("toasts %s and stays signed in", async (_name, handler, text) => {
    await setup(handler);
    fireEvent.click(button("Sign out"));
    await toastShown(text);
    expect(toasts()).toEqual([text]);
    expect(authState()).toBe("root:admin:ok");
  });

  it("still signs out without a toast when it works", async () => {
    await setup({ ok: true });
    fireEvent.click(button("Sign out"));
    await waitFor(() => expect(authState()).toBe("anonymous"));
    expect(toasts()).toEqual([]);
  });
});

describe("Logs", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it.each([
    ["the server's message", fail(404, { error: "log entry not found" }), "log entry not found"],
    ["the failure's own message", offline, "Failed to fetch"],
    ["'Failed to load detail' for a failure that is not an Error", () => Promise.reject("boom"), "Failed to load detail"],
  ])("a detail that cannot be loaded shows %s on the page and opens nothing", async (_name, handler, text) => {
    const { pageRow } = await setupLogs({ rows: [R1, R2], total: 2 }, { "GET /logs/1": handler });
    fireEvent.click(pageRow(0));
    await tick();
    expect(errorNote()?.textContent).toBe(text);
    expect(modal("Request #1")).toBeNull();
  });

  it("clear all from a later page asks for the first page once, and never again for the page it left", async () => {
    const { listed } = await setupLogs({ rows: ROWS, total: 120 }, { "DELETE /logs": { deleted: 120 } });
    fireEvent.click(button("Next"));
    await tick();
    expect(listed()).toEqual([FIRST, logsPath({ offset: 50 })]);
    fireEvent.click(button("Clear all"));
    fireEvent.click(button("Confirm", openModal("Delete all logs")));
    await toastShown("Deleted 120 log entries");
    await tick();
    expect(listed()).toEqual([FIRST, logsPath({ offset: 50 }), FIRST]);
  });

  it("clear all on the first page still reloads it once", async () => {
    const { listed } = await setupLogs({ rows: ROWS, total: 4 }, { "DELETE /logs": { deleted: 4 } });
    fireEvent.click(button("Clear all"));
    fireEvent.click(button("Confirm", openModal("Delete all logs")));
    await toastShown("Deleted 4 log entries");
    await tick();
    expect(listed()).toEqual([FIRST, FIRST]);
  });
});
