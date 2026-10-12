/**
 * Characterization of the Settings page, part 2: the cards that each load and
 * save one setting (log retention, response retention, OCR image cache), the
 * private-upstream allowlist, and the runtime environment form - with the
 * validation bounds of every numeric field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { button, classes, cls, deferred, fail, field, iconButton, isOn, labelEl, modal, openModal, toastShown, toasts, type, type Handler } from "./helpers";
import { sentJson, sentBare, MIB, SPIN, ERROR_NOTE, SPINNER, offline, ENV, ENV_BODY, CACHE, RETENTION, RESPONSES, IMAGE_CACHE, ALLOWLIST, RUNTIME, flush, setup, loaded, card, input, icon, gets, confirmWith } from "./settings-harness";

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

// ---------------------------------------------------------------------------

describe("Settings: Log retention", () => {
  const PATH = "/settings/log-retention";
  const save = () => { fireEvent.click(button("Save", card(RETENTION))); };
  const INVALID = "Days must be a whole number between 0 and 3650";

  it("shows the stored days in a narrow text box with a unit and a small ghost Save", async () => {
    await loaded();
    const days = input(RETENTION);
    expect([days.type, days.value, days.placeholder, days.inputMode]).toEqual(["text", "30", "0", "numeric"]);
    expect(classes(days)).toEqual(cls("input w-32 font-mono text-xs"));
    expect(classes(days.parentElement)).toEqual(cls("flex items-center gap-2"));
    expect([...days.parentElement!.children].map((e) => e.tagName)).toEqual(["INPUT", "SPAN", "BUTTON"]);
    expect([days.nextElementSibling!.textContent, classes(days.nextElementSibling)]).toEqual(["days", cls("text-xs text-ink-500")]);
    const btn = button("Save", card(RETENTION));
    expect(classes(btn)).toEqual(cls("btn-ghost btn-xs whitespace-nowrap"));
    expect([btn.disabled, icon(btn)]).toEqual([false, cls("bi bi-check-lg")]);
    expect(card(RETENTION).querySelector(".label")).toBeNull();
  });

  it("is empty while loading, Save waiting for the stored value, with no spinner of its own", async () => {
    const gate = deferred<unknown>();
    await setup({ [`GET ${PATH}`]: () => gate.promise });
    await flush();
    expect(input(RETENTION).value).toBe("");
    expect(card(RETENTION).querySelector(".animate-spin")).toBeNull();
    expect(button("Save", card(RETENTION)).disabled).toBe(true);
    await act(async () => { gate.resolve({ days: 7 }); });
    await flush();
    expect(input(RETENTION).value).toBe("7");
  });

  // Valid partition: whole numbers 0..3650; anything Number() reads as one counts, and empty means 0.
  it.each([
    ["the lower bound", "0", 0, "Auto-prune disabled — logs are kept forever"],
    ["empty (read as 0)", "", 0, "Auto-prune disabled — logs are kept forever"],
    ["blank (read as 0)", "   ", 0, "Auto-prune disabled — logs are kept forever"],
    ["one", "1", 1, "Keeping the last 1 days"],
    ["a padded number", " 90 ", 90, "Keeping the last 90 days"],
    ["the upper bound", "3650", 3650, "Keeping the last 3650 days"],
    ["exponent notation", "1e3", 1000, "Keeping the last 1000 days"],
    ["an integral decimal", "7.0", 7, "Keeping the last 7 days"],
  ])("accepts %s and sends PUT /settings/log-retention", async (_name, typed, days, text) => {
    const { api } = await loaded({ [`PUT ${PATH}`]: { days, pruned: 0 } });
    type(input(RETENTION), typed);
    save();
    await toastShown(text);
    expect(api.mutations()).toEqual([sentJson("PUT", PATH, { days })]);
    expect(gets(api, PATH)).toBe(2);
  });

  it.each([
    ["just below the lower bound", "-1"],
    ["just above the upper bound", "3651"],
    ["a fraction", "1.5"],
    ["non-numeric", "abc"],
    ["a number with a unit", "30d"],
  ])("rejects %s with a toast and sends nothing", async (_name, typed) => {
    const { api } = await loaded();
    type(input(RETENTION), typed);
    save();
    await toastShown(INVALID);
    expect(api.mutations()).toEqual([]);
    expect(input(RETENTION).value).toBe(typed);
    expect(gets(api, PATH)).toBe(1);
  });

  it("mentions how many old entries the save removed, and shows the reloaded value", async () => {
    const { api } = await loaded({ [`PUT ${PATH}`]: { days: 7, pruned: 42 } });
    type(input(RETENTION), " 7 ");
    api.on(`GET ${PATH}`, { days: 7 });
    save();
    await toastShown("Keeping the last 7 days — removed 42 old entries");
    await flush();
    expect(input(RETENTION).value).toBe("7");
  });

  it("disables Save with a spinning icon while saving", async () => {
    const gate = deferred<unknown>();
    await loaded({ [`PUT ${PATH}`]: () => gate.promise });
    const btn = button("Save", card(RETENTION));
    fireEvent.click(btn);
    await flush();
    expect([btn.disabled, icon(btn)]).toEqual([true, cls(SPIN)]);
    await act(async () => { gate.resolve({ days: 30, pruned: 0 }); });
    await flush();
    expect([btn.disabled, icon(btn)]).toEqual([false, cls("bi bi-check-lg")]);
  });

  it.each([
    ["the server's message", fail(400, { error: "days out of range" }), "days out of range"],
    ["'Save failed' for a non-API failure", offline, "Save failed"],
  ])("toasts %s when the save is refused and does not reload", async (_name, handler, text) => {
    const { api } = await loaded({ [`PUT ${PATH}`]: handler });
    type(input(RETENTION), "12");
    save();
    await toastShown(text);
    expect(gets(api, PATH)).toBe(1);
    expect(input(RETENTION).value).toBe("12");
    expect(button("Save", card(RETENTION)).disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("Settings: Responses and tool session history", () => {
  const PATH = "/settings/response-retention";
  const save = () => { fireEvent.click(button("Save", card(RESPONSES))); };

  it("is a native number box inside a wrapping label, with a full-size primary Save and no icon", async () => {
    await loaded();
    const days = input(RESPONSES);
    expect([days.type, days.value, days.min, days.max, days.placeholder]).toEqual(["number", "14", "0", "3650", ""]);
    expect(classes(days)).toEqual(cls("input w-28"));
    const label = days.closest("label")!;
    expect(classes(label)).toEqual(cls("flex items-center gap-3"));
    expect([...label.children].map((e) => e.tagName)).toEqual(["SPAN", "INPUT", "BUTTON"]);
    expect([label.querySelector("span")!.textContent, label.querySelector("span")!.className]).toEqual(["Retention days", "text-sm"]);
    const btn = button("Save", card(RESPONSES));
    expect(btn.className).toBe("btn-primary");
    expect([btn.disabled, btn.querySelector("i")]).toEqual([false, null]);
  });

  it("shows 30 and keeps Save disabled until the stored value has loaded", async () => {
    const gate = deferred<unknown>();
    await setup({ [`GET ${PATH}`]: () => gate.promise });
    await flush();
    expect(input(RESPONSES).value).toBe("30");
    expect(button("Save", card(RESPONSES)).disabled).toBe(true);
    expect(card(RESPONSES).querySelector(".animate-spin")).toBeNull();
    await act(async () => { gate.resolve({ days: 0 }); });
    await flush();
    expect(input(RESPONSES).value).toBe("0");
    expect(button("Save", card(RESPONSES)).disabled).toBe(false);
  });

  it("shows a load error under the control and leaves Save disabled", async () => {
    await loaded({ [`GET ${PATH}`]: fail(500, { error: "db down" }) });
    const note = card(RESPONSES).lastElementChild!;
    expect(note.textContent).toBe("db down");
    expect(classes(note)).toEqual(cls(ERROR_NOTE));
    expect(classes(note.querySelector("i"))).toEqual(cls("bi bi-exclamation-octagon-fill"));
    expect(input(RESPONSES).value).toBe("30");
    expect(button("Save", card(RESPONSES)).disabled).toBe(true);
  });

  // Valid partition: whole numbers 0..3650 (the rejected partitions are in fixWebSettings.test.tsx).
  it.each([
    ["the lower bound", "0", 0],
    ["a typical value", "45", 45],
    ["the upper bound", "3650", 3650],
    ["empty (sent as 0)", "", 0],
  ])("sends %s as typed with PUT /settings/response-retention and does not reload", async (_name, typed, days) => {
    const { api } = await loaded({ [`PUT ${PATH}`]: { days } });
    type(input(RESPONSES), typed);
    save();
    await toastShown("Response retention saved");
    expect(api.mutations()).toEqual([sentJson("PUT", PATH, { days })]);
    expect(gets(api, PATH)).toBe(1);
  });

  it("an emptied box snaps back to 0", async () => {
    await loaded();
    type(input(RESPONSES), "");
    expect(input(RESPONSES).value).toBe("0");
  });

  it("disables Save while saving", async () => {
    const gate = deferred<unknown>();
    await loaded({ [`PUT ${PATH}`]: () => gate.promise });
    const btn = button("Save", card(RESPONSES));
    fireEvent.click(btn);
    await flush();
    expect([btn.disabled, btn.querySelector("i")]).toEqual([true, null]);
    await act(async () => { gate.resolve({ days: 14 }); });
    await flush();
    expect(btn.disabled).toBe(false);
  });

  it.each([
    ["the server's message", fail(400, { error: "days out of range" }), "days out of range"],
    ["'Save failed' for a non-API failure", offline, "Save failed"],
  ])("toasts %s when the save is refused", async (_name, handler, text) => {
    await loaded({ [`PUT ${PATH}`]: handler });
    save();
    await toastShown(text);
    expect(button("Save", card(RESPONSES)).disabled).toBe(false);
  });

  it("carries its own Chinese texts, toast included", async () => {
    await loaded({ "GET /settings/ui-language": { language: "zh" }, [`PUT ${PATH}`]: { days: 14 } });
    const c = card("Responses 与工具会话历史");
    expect(c.querySelector("p")!.textContent).toBe("设置闲置历史的保留天数。续接会刷新期限；0 表示永久保留。缩短期限会立即清理已过期的历史，正在运行的任务会保留。");
    expect(c.querySelector("label span")!.textContent).toBe("保留天数");
    fireEvent.click(button("保存", c));
    await toastShown("会话保留期已保存");
  });
});

// ---------------------------------------------------------------------------

describe("Settings: OCR image cache", () => {
  const PATH = "/settings/image-cache";
  const CONFIRM = "Clear the image cache?";
  const INVALID = "Size must be a number between 0 and 65536 MiB";
  const save = () => { fireEvent.click(button("Save", card(IMAGE_CACHE))); };
  const usage = () => card(IMAGE_CACHE).querySelector("p.mt-2")!;

  it("shows a spinner alone while loading", async () => {
    const gate = deferred<unknown>();
    await setup({ [`GET ${PATH}`]: () => gate.promise });
    await flush();
    const c = card(IMAGE_CACHE);
    expect(classes(c.querySelector(".animate-spin")!.parentElement)).toEqual(cls(SPINNER));
    expect(classes(c.querySelector(".animate-spin"))).toEqual(cls(`${SPIN} text-xl`));
    expect(c.querySelector("input")).toBeNull();
    expect(c.querySelector("button")).toBeNull();
    await act(async () => { gate.resolve(CACHE); });
    await flush();
    expect(c.querySelector(".animate-spin")).toBeNull();
    expect(input(IMAGE_CACHE).value).toBe("64");
  });

  it("shows a load error instead of the controls", async () => {
    await loaded({ [`GET ${PATH}`]: fail(500, { error: "db down" }) });
    const c = card(IMAGE_CACHE);
    const note = c.querySelector(".border-red-900\\/50")!;
    expect([note.textContent, classes(note)]).toEqual(["db down", cls(ERROR_NOTE)]);
    expect(c.querySelector("input")).toBeNull();
    expect(c.querySelector("button")).toBeNull();
  });

  it("shows the budget in MiB with Save and Clear, and the usage underneath", async () => {
    await loaded();
    const mib = input(IMAGE_CACHE);
    expect([mib.type, mib.value, mib.placeholder, mib.inputMode]).toEqual(["text", "64", "64", "decimal"]);
    expect(classes(mib)).toEqual(cls("input w-32 font-mono text-xs"));
    // Wraps, unlike the log-retention row.
    expect(classes(mib.parentElement)).toEqual(cls("flex flex-wrap items-center gap-2"));
    expect([...mib.parentElement!.children].map((e) => [e.tagName, e.textContent])).toEqual([["INPUT", ""], ["SPAN", "MiB max"], ["BUTTON", "Save"], ["BUTTON", "Clear now"]]);
    expect(classes(mib.nextElementSibling)).toEqual(cls("text-xs text-ink-500"));
    const [saveBtn, clear] = [button("Save", card(IMAGE_CACHE)), button("Clear now")];
    expect(classes(saveBtn)).toEqual(cls("btn-ghost btn-xs whitespace-nowrap"));
    expect([saveBtn.disabled, icon(saveBtn)]).toEqual([false, cls("bi bi-check-lg")]);
    expect(classes(clear)).toEqual(cls("btn-ghost btn-xs whitespace-nowrap"));
    expect([clear.disabled, icon(clear)]).toEqual([false, cls("bi bi-trash")]);
    expect(classes(usage())).toEqual(cls("mt-2 text-xs text-ink-500"));
    expect(usage().textContent).toBe(`Using 1.50 MiB of 64 MiB across ${(1234).toLocaleString()} images.`);
  });

  // MiB display: whole stays whole, under 10 keeps two decimals, otherwise one.
  it.each([
    [{ maxBytes: 512 * 1024, entries: 1, usedBytes: 0 }, "0.50", "Using 0 MiB of 0.50 MiB across 1 images.", false],
    [{ maxBytes: Math.round(12.34 * MIB), entries: 3, usedBytes: Math.round(9.999 * MIB) }, "12.3", "Using 10.00 MiB of 12.3 MiB across 3 images.", false],
    [{ maxBytes: 65536 * MIB, entries: 0, usedBytes: 0 }, "65536", "Using 0 MiB of 65536 MiB across 0 images.", true],
    [{ maxBytes: 0, entries: 0, usedBytes: 0 }, "0", "Caching is off — every image is sent to the OCR model.", true],
    [{ maxBytes: 0, entries: 2, usedBytes: 10 }, "0", "Caching is off — every image is sent to the OCR model.", false],
  ])("renders %o as %s MiB, and Clear is disabled only with no entries", async (state, shown, text, clearDisabled) => {
    await loaded({ [`GET ${PATH}`]: state });
    expect(input(IMAGE_CACHE).value).toBe(shown);
    expect(usage().textContent).toBe(text);
    expect(button("Clear now").disabled).toBe(clearDisabled);
  });

  // Valid partition: any finite number 0..65536 (fractions allowed), sent as rounded bytes; empty means 0.
  it.each([
    ["the lower bound", "0", 0, "Image caching disabled — the cache has been emptied"],
    ["empty (read as 0)", "", 0, "Image caching disabled — the cache has been emptied"],
    ["a whole number", "128", 128 * MIB, "Image cache limited to 128 MiB"],
    ["a fraction", " 1.5 ", 1.5 * MIB, "Image cache limited to 1.50 MiB"],
    ["a fraction that needs rounding", "0.3", 314573, "Image cache limited to 0.30 MiB"],
    ["the upper bound", "65536", 65536 * MIB, "Image cache limited to 65536 MiB"],
  ])("accepts %s and sends PUT /settings/image-cache in bytes", async (_name, typed, maxBytes, text) => {
    const { api } = await loaded({ [`PUT ${PATH}`]: { maxBytes, entries: 0, usedBytes: 0, evicted: 0 } });
    type(input(IMAGE_CACHE), typed);
    save();
    await toastShown(text);
    expect(api.mutations()).toEqual([sentJson("PUT", PATH, { maxBytes })]);
    expect(gets(api, PATH)).toBe(2);
  });

  it.each([
    ["just below the lower bound", "-0.01"],
    ["just above the upper bound", "65536.01"],
    ["non-numeric", "abc"],
    ["infinite", "Infinity"],
    ["a number with a unit", "64MiB"],
  ])("rejects %s with a toast and sends nothing", async (_name, typed) => {
    const { api } = await loaded();
    type(input(IMAGE_CACHE), typed);
    save();
    await toastShown(INVALID);
    expect(api.mutations()).toEqual([]);
    expect(input(IMAGE_CACHE).value).toBe(typed);
  });

  it("reports the size the server settled on and how many entries it evicted, then shows the reloaded state", async () => {
    const { api } = await loaded({ [`PUT ${PATH}`]: { maxBytes: 16 * MIB, entries: 10, usedBytes: MIB, evicted: 7 } });
    type(input(IMAGE_CACHE), "16.2");
    api.on(`GET ${PATH}`, { maxBytes: 16 * MIB, entries: 10, usedBytes: MIB });
    save();
    await toastShown("Image cache limited to 16 MiB — removed 7 old entries");
    await flush();
    expect(input(IMAGE_CACHE).value).toBe("16");
    expect(usage().textContent).toBe("Using 1 MiB of 16 MiB across 10 images.");
  });

  it("disables only Save, with a spinning icon, while saving", async () => {
    const gate = deferred<unknown>();
    await loaded({ [`PUT ${PATH}`]: () => gate.promise });
    const btn = button("Save", card(IMAGE_CACHE));
    fireEvent.click(btn);
    await flush();
    expect([btn.disabled, icon(btn)]).toEqual([true, cls(SPIN)]);
    expect(button("Clear now").disabled).toBe(false);
    await act(async () => { gate.resolve({ ...CACHE, evicted: 0 }); });
    await flush();
    expect([button("Save", card(IMAGE_CACHE)).disabled, icon(button("Save", card(IMAGE_CACHE)))]).toEqual([false, cls("bi bi-check-lg")]);
  });

  it.each([
    ["the server's message", fail(400, { error: "too large" }), "too large"],
    ["'Save failed' for a non-API failure", offline, "Save failed"],
  ])("toasts %s when the save is refused and does not reload", async (_name, handler, text) => {
    const { api } = await loaded({ [`PUT ${PATH}`]: handler });
    type(input(IMAGE_CACHE), "8");
    save();
    await toastShown(text);
    expect(gets(api, PATH)).toBe(1);
    expect(input(IMAGE_CACHE).value).toBe("8");
  });

  it("asks before clearing; Cancel sends nothing", async () => {
    const { api } = await loaded();
    fireEvent.click(button("Clear now"));
    const m = openModal(CONFIRM);
    expect(screen.getByText("Every cached description is deleted. Nothing breaks — images are simply transcribed again the next time they are seen.")).toBeTruthy();
    await act(async () => { fireEvent.click(button("Cancel", m)); });
    expect(modal(CONFIRM)).toBeNull();
    expect(api.mutations()).toEqual([]);
  });

  it("clears with DELETE /settings/image-cache after confirmation, toasts the count and reloads", async () => {
    const gate = deferred<unknown>();
    const { api } = await loaded({ [`DELETE ${PATH}`]: () => gate.promise });
    const clear = button("Clear now");
    fireEvent.click(clear);
    confirmWith(CONFIRM);
    await flush();
    expect([clear.disabled, icon(clear)]).toEqual([true, cls(SPIN)]);
    expect(button("Save", card(IMAGE_CACHE)).disabled).toBe(false);
    api.on(`GET ${PATH}`, { ...CACHE, entries: 0, usedBytes: 0 });
    await act(async () => { gate.resolve({ cleared: 1234 }); });
    await toastShown("Image cache cleared — removed 1234 entries");
    await flush();
    expect(api.mutations()).toEqual([sentBare("DELETE", PATH)]);
    expect(gets(api, PATH)).toBe(2);
    expect(usage().textContent).toBe("Using 0 MiB of 64 MiB across 0 images.");
    expect([button("Clear now").disabled, icon(button("Clear now"))]).toEqual([true, cls("bi bi-trash")]);
  });

  it.each([
    ["the server's message", fail(500, { error: "busy" }), "busy"],
    ["'Save failed' for a non-API failure", offline, "Save failed"],
  ])("toasts %s when clearing is refused and does not reload", async (_name, handler, text) => {
    const { api } = await loaded({ [`DELETE ${PATH}`]: handler });
    fireEvent.click(button("Clear now"));
    confirmWith(CONFIRM);
    await toastShown(text);
    expect(gets(api, PATH)).toBe(1);
    expect(button("Clear now").disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("Settings: Trusted private upstreams", () => {
  const PATH = "/settings/upstream-allowlist";
  const CHIP = "inline-flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1 font-mono text-xs text-ink-200";
  const chips = () => [...card(ALLOWLIST).querySelectorAll(".font-mono.inline-flex")];
  const add = (value: string) => {
    type(input(ALLOWLIST), value);
    fireEvent.click(button("Add", card(ALLOWLIST)));
  };

  it("lists entries as removable chips above an entry box with a small ghost Add", async () => {
    await loaded();
    expect(chips().map((c) => c.textContent)).toEqual(["10.0.0.0/8", "nas.local"]);
    expect(classes(chips()[0])).toEqual(cls(CHIP));
    expect(classes(chips()[0].parentElement)).toEqual(cls("mb-3 flex flex-wrap gap-2"));
    const remove = iconButton("bi-x-lg", chips()[0]);
    expect(classes(remove)).toEqual(cls("text-ink-500 hover:text-red-400"));
    expect([remove.title, remove.disabled, icon(remove)]).toEqual(["Remove", false, cls("bi bi-x-lg")]);
    const entry = input(ALLOWLIST);
    expect([entry.type, entry.value, entry.placeholder]).toEqual(["text", "", "IP, CIDR, or hostname"]);
    expect(classes(entry)).toEqual(cls("input font-mono text-xs"));
    expect(classes(entry.parentElement)).toEqual(cls("flex gap-2"));
    const btn = button("Add", card(ALLOWLIST));
    expect(classes(btn)).toEqual(cls("btn-ghost btn-xs whitespace-nowrap"));
    expect([btn.disabled, icon(btn)]).toEqual([false, cls("bi bi-plus-lg")]);
    expect(screen.queryByText("No entries — all private hosts blocked.")).toBeNull();
  });

  it("says so when the list is empty", async () => {
    await loaded({ [`GET ${PATH}`]: { entries: [] } });
    const empty = screen.getByText("No entries — all private hosts blocked.");
    expect(classes(empty)).toEqual(cls("text-xs text-ink-600"));
    expect(classes(empty.parentElement)).toEqual(cls("mb-3 flex flex-wrap gap-2"));
    expect(chips()).toEqual([]);
  });

  it.each([
    ["the Add button", (el: HTMLInputElement) => { fireEvent.click(button("Add", card(ALLOWLIST))); return el; }],
    ["Enter in the box", (el: HTMLInputElement) => { fireEvent.keyDown(el, { key: "Enter" }); return el; }],
  ])("%s appends the trimmed entry with PUT /settings/upstream-allowlist (the whole list), toasts, reloads and empties the box", async (_name, submit) => {
    const { api } = await loaded({ [`PUT ${PATH}`]: { entries: [] } });
    type(input(ALLOWLIST), "  192.168.1.10 ");
    api.on(`GET ${PATH}`, { entries: ["10.0.0.0/8", "nas.local", "192.168.1.10"] });
    submit(input(ALLOWLIST));
    await toastShown("Allowlist updated");
    await flush();
    expect(api.mutations()).toEqual([sentJson("PUT", PATH, { entries: ["10.0.0.0/8", "nas.local", "192.168.1.10"] })]);
    expect(gets(api, PATH)).toBe(2);
    expect(input(ALLOWLIST).value).toBe("");
    expect(chips().map((c) => c.textContent)).toEqual(["10.0.0.0/8", "nas.local", "192.168.1.10"]);
  });

  it("other keys do not submit", async () => {
    const { api } = await loaded();
    type(input(ALLOWLIST), "192.168.1.10");
    fireEvent.keyDown(input(ALLOWLIST), { key: "Tab" });
    await flush();
    expect(api.mutations()).toEqual([]);
    expect(input(ALLOWLIST).value).toBe("192.168.1.10");
  });

  it.each([
    ["nothing", ""],
    ["only spaces", "   "],
    ["an entry already listed", "nas.local"],
    ["a padded duplicate", " nas.local "],
  ])("adding %s just empties the box and sends nothing", async (_name, value) => {
    const { api } = await loaded();
    add(value);
    await flush();
    expect(input(ALLOWLIST).value).toBe("");
    expect(api.mutations()).toEqual([]);
    expect(toasts()).toEqual([]);
  });

  it("duplicates are matched exactly: a different case is a new entry", async () => {
    const { api } = await loaded({ [`PUT ${PATH}`]: {} });
    add("NAS.local");
    await toastShown("Allowlist updated");
    expect(api.mutations()[0].body).toEqual({ entries: ["10.0.0.0/8", "nas.local", "NAS.local"] });
  });

  it("the chip's x removes that entry by sending the rest", async () => {
    const { api } = await loaded({ [`PUT ${PATH}`]: {} });
    type(input(ALLOWLIST), "typed but not added");
    api.on(`GET ${PATH}`, { entries: ["nas.local"] });
    fireEvent.click(iconButton("bi-x-lg", chips()[0]));
    await toastShown("Allowlist updated");
    await flush();
    expect(api.mutations()).toEqual([sentJson("PUT", PATH, { entries: ["nas.local"] })]);
    expect(chips().map((c) => c.textContent)).toEqual(["nas.local"]);
    // Removing does not touch a half-typed entry.
    expect(input(ALLOWLIST).value).toBe("typed but not added");
  });

  it("disables Add and every chip's x while a change is being saved; the Add icon does not spin", async () => {
    const gate = deferred<unknown>();
    await loaded({ [`PUT ${PATH}`]: () => gate.promise });
    add("192.168.1.10");
    await flush();
    const btn = button("Add", card(ALLOWLIST));
    expect([btn.disabled, icon(btn)]).toEqual([true, cls("bi bi-plus-lg")]);
    expect(chips().map((c) => c.querySelector("button")!.disabled)).toEqual([true, true]);
    expect(input(ALLOWLIST).disabled).toBe(false);
    await act(async () => { gate.resolve({}); });
    await flush();
    expect(button("Add", card(ALLOWLIST)).disabled).toBe(false);
    expect(chips().map((c) => c.querySelector("button")!.disabled)).toEqual([false, false]);
  });

  it.each([
    ["the server's message", fail(400, { error: "not a valid CIDR" }), "not a valid CIDR"],
    ["'Save failed' for a non-API failure", offline, "Save failed"],
  ])("toasts %s when the change is refused and does not reload", async (_name, handler, text) => {
    const { api } = await loaded({ [`PUT ${PATH}`]: handler });
    fireEvent.click(iconButton("bi-x-lg", chips()[1]));
    await toastShown(text);
    expect(gets(api, PATH)).toBe(1);
    expect(chips().map((c) => c.textContent)).toEqual(["10.0.0.0/8", "nas.local"]);
    expect(button("Add", card(ALLOWLIST)).disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("Settings: Runtime environment", () => {
  const PATH = "/settings/env";
  const LPMC = "Log payload max chars";
  const RATE = "Simulated streaming token rate (tok/s)";
  const CACHE_TTL = "Auto cache TTL (minutes, Anthropic breakpoint)";
  const SESSION = "Session TTL (ms)";
  const BAD_LPMC = "Log payload max chars must be a whole number between 0 and 10000000";
  const BAD_RATE = "Simulated streaming token rate must be a positive integer";
  const BAD_SESSION = "Session TTL must be at least 60000 ms";
  const env = () => card(RUNTIME);
  const allow = () => env().querySelector<HTMLButtonElement>("button.rounded-full")!;
  const save = () => { fireEvent.click(button("Save", env())); };
  const KEYS = { [LPMC]: "logPayloadMaxChars", [RATE]: "simulatedStreamingTokenRate", [CACHE_TTL]: "promptCacheTtlMinutes", [SESSION]: "sessionTtlMs" };

  it("shows a spinner alone while loading", async () => {
    const gate = deferred<unknown>();
    await setup({ [`GET ${PATH}`]: () => gate.promise });
    await flush();
    expect(classes(env().querySelector(".animate-spin")!.parentElement)).toEqual(cls(SPINNER));
    expect(env().querySelector("input")).toBeNull();
    expect(env().querySelector("button")).toBeNull();
    await act(async () => { gate.resolve(ENV); });
    await flush();
    expect(env().querySelector(".animate-spin")).toBeNull();
    expect(field(LPMC, env()).value).toBe("20000");
  });

  it("shows a load error instead of the form", async () => {
    await loaded({ [`GET ${PATH}`]: fail(500, { error: "db down" }) });
    const note = env().querySelector(".border-red-900\\/50")!;
    expect([note.textContent, classes(note)]).toEqual(["db down", cls(ERROR_NOTE)]);
    expect(env().querySelector("input")).toBeNull();
    expect(env().querySelector("button")).toBeNull();
  });

  it("lays out a switch row, four text boxes in a grid, and a right-aligned small primary Save", async () => {
    await loaded();
    const body = env().children[2];
    expect(classes(body)).toEqual(["space-y-4"]);
    expect([...body.children].map((e) => e.className)).toEqual([
      "flex items-start justify-between gap-4", "grid grid-cols-1 gap-4 sm:grid-cols-2", "flex justify-end", "rounded-lg border border-ink-800 bg-ink-950/40 p-3",
    ]);
    const label = labelEl("Allow private upstreams", env());
    expect([label.tagName, classes(label)]).toEqual(["LABEL", ["label"]]);
    const hint = label.nextElementSibling!;
    expect([hint.textContent, classes(hint)]).toEqual(["Permit upstream URLs that resolve to private/loopback/LAN addresses (link-local stays blocked).", cls("text-xs text-ink-500")]);
    expect(isOn(allow())).toBe(false);
    expect(allow().closest("label")!.textContent).toBe("");

    expect([...body.children[1].querySelectorAll(".label")].map((l) => l.textContent)).toEqual([LPMC, RATE, CACHE_TTL, SESSION]);
    expect([LPMC, RATE, CACHE_TTL, SESSION].map((l) => field(l, env()).value)).toEqual(["20000", "50", "5", "86400000"]);
    for (const l of [LPMC, RATE, CACHE_TTL, SESSION]) {
      const f = field(l, env());
      expect([f.type, f.inputMode, f.placeholder, classes(f), classes(labelEl(l, env()))]).toEqual(["text", "numeric", "", cls("input font-mono text-xs"), ["label"]]);
    }
    const btn = button("Save", env());
    expect(classes(btn)).toEqual(cls("btn-primary btn-xs"));
    expect([btn.disabled, icon(btn)]).toEqual([false, cls("bi bi-check-lg")]);
  });

  it("lists the boot-time values read-only, each truncating with its full value as a tooltip", async () => {
    await loaded();
    const boot = env().querySelector(".space-y-4 > .rounded-lg")!;
    const head = boot.firstElementChild!;
    expect(classes(head)).toEqual(cls("mb-2 flex items-center gap-2"));
    expect(classes(head.querySelector("i"))).toEqual(cls("bi bi-lock text-ink-500"));
    expect([head.querySelector("span")!.textContent, classes(head.querySelector("span"))]).toEqual(["Boot-time only (read-only)", cls("text-xs font-medium text-ink-300")]);
    const grid = boot.children[1];
    expect(classes(grid)).toEqual(cls("grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2"));
    expect([...grid.children].map((row) => [row.querySelector("span")!.textContent, row.querySelector("code")!.textContent, row.querySelector("code")!.title])).toEqual([
      ["Node env", "production", "production"], ["Port", "3000", "3000"], ["Host", "0.0.0.0", "0.0.0.0"],
      ["Data directory", "/var/lib/hydrogen/data", "/var/lib/hydrogen/data"], ["Admin username", "root", "root"], ["Cookie secure", "auto", "auto"],
    ]);
    for (const row of grid.children) {
      expect(classes(row)).toEqual(cls("flex items-center justify-between gap-3"));
      expect([...row.children].map((e) => e.tagName)).toEqual(["SPAN", "CODE"]);
      expect(classes(row.querySelector("span"))).toEqual(cls("shrink-0 text-ink-500"));
      expect(classes(row.querySelector("code"))).toEqual(cls("min-w-0 truncate font-mono text-ink-300"));
    }
    const foot = boot.lastElementChild!;
    expect([foot.textContent, classes(foot)]).toEqual(["Changing these requires editing the environment and restarting the proxy.", cls("mt-2 text-[11px] text-ink-600")]);
    expect(boot.querySelector("input, button")).toBeNull();
  });

  it("saves all five values with PUT /settings/env, toasts and reloads", async () => {
    const { api } = await loaded({ [`PUT ${PATH}`]: ENV });
    fireEvent.click(allow());
    expect(isOn(allow())).toBe(true);
    type(field(LPMC, env()), " 4096 ");
    type(field(RATE, env()), "120");
    type(field(CACHE_TTL, env()), "60");
    type(field(SESSION, env()), "3600000");
    save();
    await toastShown("Runtime settings saved");
    expect(api.mutations()).toEqual([sentJson("PUT", PATH, {
      allowPrivateUpstreams: true, logPayloadMaxChars: 4096, simulatedStreamingTokenRate: 120, sessionTtlMs: 3_600_000, promptCacheTtlMinutes: 60,
    })]);
    expect(gets(api, PATH)).toBe(2);
  });

  it("the form follows the reloaded values after a save", async () => {
    const { api } = await loaded({ [`PUT ${PATH}`]: ENV });
    type(field(LPMC, env()), "4096");
    api.on(`GET ${PATH}`, { ...ENV, allowPrivateUpstreams: true, logPayloadMaxChars: 4000 });
    save();
    await toastShown("Runtime settings saved");
    await flush();
    expect(field(LPMC, env()).value).toBe("4000");
    expect(isOn(allow())).toBe(true);
  });

  // Valid partitions and their boundaries, one field at a time.
  it.each([
    [LPMC, "the lower bound", "0", 0],
    [LPMC, "empty (read as 0)", "", 0],
    [LPMC, "the upper bound", "10000000", 10_000_000],
    [LPMC, "exponent notation", "1e3", 1000],
    [RATE, "the lower bound", "1", 1],
    [RATE, "a huge value (no upper bound)", "1000000000", 1_000_000_000],
    [SESSION, "the lower bound", "60000", 60_000],
    [SESSION, "a padded value", " 120000 ", 120_000],
    [SESSION, "a huge value (no upper bound)", "9000000000000", 9_000_000_000_000],
    [CACHE_TTL, "the lower bound", "1", 1],
    [CACHE_TTL, "a large value", "1440", 1440],
  ])("%s accepts %s", async (label, _name, typed, sent) => {
    const { api } = await loaded({ [`PUT ${PATH}`]: ENV });
    type(field(label, env()), typed);
    save();
    await toastShown("Runtime settings saved");
    expect(api.mutations()).toEqual([sentJson("PUT", PATH, { ...ENV_BODY, [KEYS[label as keyof typeof KEYS]]: sent })]);
  });

  it.each([
    [LPMC, "just below the lower bound", "-1", BAD_LPMC],
    [LPMC, "just above the upper bound", "10000001", BAD_LPMC],
    [LPMC, "a fraction", "1.5", BAD_LPMC],
    [LPMC, "non-numeric", "abc", BAD_LPMC],
    [RATE, "just below the lower bound", "0", BAD_RATE],
    [RATE, "empty (read as 0)", "", BAD_RATE],
    [RATE, "a negative number", "-5", BAD_RATE],
    [RATE, "a fraction", "1.5", BAD_RATE],
    [RATE, "non-numeric", "fast", BAD_RATE],
    [SESSION, "just below the lower bound", "59999", BAD_SESSION],
    [SESSION, "empty (read as 0)", "", BAD_SESSION],
    [SESSION, "a fraction", "60000.5", BAD_SESSION],
    [SESSION, "non-numeric", "1h", BAD_SESSION],
  ])("%s rejects %s with its own toast and sends nothing", async (label, _name, typed, text) => {
    const { api } = await loaded();
    type(field(label, env()), typed);
    save();
    await toastShown(text);
    expect(toasts()).toEqual([text]);
    expect(api.mutations()).toEqual([]);
    expect(field(label, env()).value).toBe(typed);
  });

  it("reports only the first invalid field, in the order payload chars, token rate, session TTL", async () => {
    const { api } = await loaded();
    type(field(SESSION, env()), "1");
    type(field(RATE, env()), "0");
    save();
    await toastShown(BAD_RATE);
    type(field(LPMC, env()), "-1");
    save();
    await toastShown(BAD_LPMC);
    expect(toasts()).toEqual([BAD_RATE, BAD_LPMC]);
    expect(api.mutations()).toEqual([]);
  });

  // The cache TTL is validated like its neighbours: anything below 1 or unreadable is refused, not left out.
  it.each([
    ["zero", "0"],
    ["just below 1", "0.99"],
    ["a negative number", "-3"],
    ["empty", ""],
    ["non-numeric", "abc"],
  ])("a cache TTL that is %s is rejected with its own toast and nothing is sent", async (_name, typed) => {
    const { api } = await loaded({ [`PUT ${PATH}`]: ENV });
    type(field(CACHE_TTL, env()), typed);
    save();
    await toastShown("Auto cache TTL must be a whole number between 1 and 1440 minutes");
    expect(api.mutations()).toEqual([]);
  });

  it("disables Save with a spinning icon while saving", async () => {
    const gate = deferred<unknown>();
    await loaded({ [`PUT ${PATH}`]: () => gate.promise });
    const btn = button("Save", env());
    fireEvent.click(btn);
    await flush();
    expect([btn.disabled, icon(btn)]).toEqual([true, cls(SPIN)]);
    await act(async () => { gate.resolve(ENV); });
    await flush();
    expect([button("Save", env()).disabled, icon(button("Save", env()))]).toEqual([false, cls("bi bi-check-lg")]);
  });

  it.each([
    ["the server's message", fail(400, { error: "sessionTtlMs too small" }), "sessionTtlMs too small"],
    ["'Save failed' for a non-API failure", offline, "Save failed"],
  ])("toasts %s when the save is refused, keeps the edits and does not reload", async (_name, handler: Handler, text) => {
    const { api } = await loaded({ [`PUT ${PATH}`]: handler });
    type(field(RATE, env()), "75");
    fireEvent.click(allow());
    save();
    await toastShown(text);
    expect(gets(api, PATH)).toBe(1);
    expect(field(RATE, env()).value).toBe("75");
    expect(isOn(allow())).toBe(true);
    expect(button("Save", env()).disabled).toBe(false);
  });
});
