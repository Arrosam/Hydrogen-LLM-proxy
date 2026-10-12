/**
 * WB10: the Settings cards. A failed load must show and must not leave a
 * usable Save over a made-up value; a refused change keeps what was typed; the
 * Responses retention card and the prompt-cache TTL validate like their siblings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { button, classes, cls, deferred, fail, field, toastShown, toasts, type } from "./helpers";
import { ALLOWLIST, ENV, ENV_BODY, ERROR_NOTE, RESPONSES, RETENTION, RUNTIME, card, flush, input, loaded, offline, sentJson, setup } from "./settings-harness";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const errorNote = (title: string) => card(title).querySelector(".border-red-900\\/50");
const BAD_DAYS = "Days must be a whole number between 0 and 3650";

describe("Log retention: load", () => {
  const PATH = "/settings/log-retention";

  it("reports a failed load in the card and offers no Save over the empty box", async () => {
    const { api } = await loaded({ [`GET ${PATH}`]: fail(500, { error: "db down" }) });
    expect(errorNote(RETENTION)?.textContent).toBe("db down");
    expect(classes(errorNote(RETENTION))).toEqual(cls(ERROR_NOTE));
    const save = button("Save", card(RETENTION));
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    await flush();
    expect(api.mutations()).toEqual([]);
  });

  it("holds Save until the stored value has arrived", async () => {
    const gate = deferred<unknown>();
    const { api } = await setup({ [`GET ${PATH}`]: () => gate.promise });
    await flush();
    const save = button("Save", card(RETENTION));
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    await flush();
    expect(api.mutations()).toEqual([]);
    await act(async () => { gate.resolve({ days: 7 }); });
    await flush();
    expect([input(RETENTION).value, button("Save", card(RETENTION)).disabled]).toEqual(["7", false]);
    expect(errorNote(RETENTION)).toBeNull();
  });
});

describe("Trusted private upstreams", () => {
  const PATH = "/settings/upstream-allowlist";

  it("reports a failed load instead of claiming the list is empty, and adds nothing to a list it never saw", async () => {
    const { api } = await loaded({ [`GET ${PATH}`]: fail(500, { error: "db down" }), [`PUT ${PATH}`]: {} });
    expect(errorNote(ALLOWLIST)?.textContent).toBe("db down");
    expect(card(ALLOWLIST).textContent).not.toContain("No entries");
    const add = button("Add", card(ALLOWLIST));
    expect(add.disabled).toBe(true);
    type(input(ALLOWLIST), "192.168.1.10");
    fireEvent.click(add);
    fireEvent.keyDown(input(ALLOWLIST), { key: "Enter" });
    await flush();
    expect(api.mutations()).toEqual([]);
    expect(input(ALLOWLIST).value).toBe("192.168.1.10");
  });

  it.each([
    ["refused by the server", fail(400, { error: "not a valid CIDR" }), "not a valid CIDR"],
    ["never answered", offline, "Save failed"],
  ])("keeps the typed entry when the change is %s", async (_name, handler, text) => {
    await loaded({ [`PUT ${PATH}`]: handler });
    type(input(ALLOWLIST), "10.0.0.0/33");
    fireEvent.click(button("Add", card(ALLOWLIST)));
    await toastShown(text);
    await flush();
    expect(input(ALLOWLIST).value).toBe("10.0.0.0/33");
  });
});

describe("Responses retention", () => {
  const PATH = "/settings/response-retention";
  const save = () => { fireEvent.click(button("Save", card(RESPONSES))); };

  it("toasts 'Save failed', not the raw network error, when no answer came", async () => {
    await loaded({ [`PUT ${PATH}`]: offline });
    save();
    await toastShown("Save failed");
    expect(toasts()).toEqual(["Save failed"]);
  });

  it.each([
    ["above the upper bound", "3651"],
    ["a negative number", "-1"],
    ["a fraction", "1.5"],
  ])("refuses %s with the retention message and sends nothing", async (_name, typed) => {
    const { api } = await loaded({ [`PUT ${PATH}`]: {} });
    type(input(RESPONSES), typed);
    save();
    await toastShown(BAD_DAYS);
    await flush();
    expect(api.mutations()).toEqual([]);
  });

  it.each([["0", 0], ["3650", 3650], ["", 0]])("still sends the in-range %j", async (typed, days) => {
    const { api } = await loaded({ [`PUT ${PATH}`]: { days } });
    type(input(RESPONSES), typed);
    save();
    await toastShown("Response retention saved");
    expect(api.mutations()).toEqual([sentJson("PUT", PATH, { days })]);
  });
});

describe("Runtime environment: prompt-cache TTL", () => {
  const PATH = "/settings/env";
  const CACHE_TTL = "Auto cache TTL (minutes, Anthropic breakpoint)";
  const BAD_TTL = "Auto cache TTL must be a whole number between 1 and 1440 minutes";
  const env = () => card(RUNTIME);

  it.each([
    ["zero", "0"],
    ["a negative number", "-3"],
    ["a fraction", "1.5"],
    ["empty", ""],
    ["non-numeric", "abc"],
    ["above the upper bound", "1441"],
  ])("refuses a TTL that is %s with its own toast instead of saving without it", async (_name, typed) => {
    const { api } = await loaded({ [`PUT ${PATH}`]: ENV });
    type(field(CACHE_TTL, env()), typed);
    fireEvent.click(button("Save", env()));
    await toastShown(BAD_TTL);
    await flush();
    expect(toasts()).toEqual([BAD_TTL]);
    expect(api.mutations()).toEqual([]);
    expect(field(CACHE_TTL, env()).value).toBe(typed);
  });

  it.each([["1", 1], ["1440", 1440]])("sends the bound %s", async (typed, sent) => {
    const { api } = await loaded({ [`PUT ${PATH}`]: ENV });
    type(field(CACHE_TTL, env()), typed);
    fireEvent.click(button("Save", env()));
    await toastShown("Runtime settings saved");
    expect(api.mutations()).toEqual([sentJson("PUT", PATH, { ...ENV_BODY, promptCacheTtlMinutes: sent })]);
  });
});
