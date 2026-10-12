/**
 * Characterization of the Settings page, part 1: the stack of cards, the
 * update check and supervised restart, the language choice, and backup export
 * / restore. The page is admin-only (the route is not registered for a
 * manager, see layout-app.test.tsx), so it has no read-only variant to pin.
 * The single-setting cards and the runtime environment are in
 * pages-settings-cards.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { button, classes, cls, deferred, fail, field, hasButton, isOn, labelEl, modal, openModal, toastShown, toasts, type, type Routes } from "./helpers";
import { sentJson, sentBare, SPIN, offline, STATUS, NEWER, UPGRADABLE, UPDATE, LANGUAGE, BACKUP, RETENTION, RESPONSES, IMAGE_CACHE, ALLOWLIST, RUNTIME, flush, advance, setup, loaded, card, box, icon, gets, confirmWith } from "./settings-harness";

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

describe("Settings page shell", () => {
  it("loads each card's own endpoint once, plus the server version", async () => {
    const { api } = await loaded();
    expect(api.calls.filter((c) => c.path !== "/me" && c.path !== "/settings/ui-language").map((c) => `${c.method} ${c.path}`).sort()).toEqual([
      "GET /settings/env", "GET /settings/image-cache", "GET /settings/log-retention", "GET /settings/response-retention",
      "GET /settings/upstream-allowlist", "GET /settings/version", "GET /update/check",
    ]);
    expect(api.mutations()).toEqual([]);
  });

  it("shows the header and stacks the cards in a fixed order", async () => {
    const { container } = await loaded();
    const h1 = container.querySelector("h1")!;
    expect(h1.textContent).toBe("Settings");
    expect(classes(h1)).toEqual(cls("flex items-center gap-2.5 text-2xl font-semibold text-ink-100"));
    expect(classes(h1.querySelector("i"))).toEqual(cls("bi bi-gear text-brand-400"));
    expect(classes(h1.parentElement!.parentElement)).toEqual(cls("mb-6 flex items-end justify-between gap-4"));
    const subtitle = screen.getByText("Runtime configuration — log retention, trusted upstreams, language, and runtime env params.");
    expect(classes(subtitle)).toEqual(cls("mt-1 text-sm text-ink-400"));
    expect([...container.querySelectorAll("h1, h2, h3")].map((h) => h.textContent)).toEqual(["Settings", UPDATE, LANGUAGE, BACKUP, RETENTION, RESPONSES, IMAGE_CACHE, ALLOWLIST, RUNTIME]);
    expect([...container.querySelectorAll("h4")].map((h) => h.textContent)).toEqual(["Export a backup", "Restore from a backup"]);
  });

  // Backup and Runtime environment leave a wider gap under their hint than the other five.
  it.each([
    [UPDATE, "bi-cloud-arrow-down", "mb-3", "Check GitHub for a newer Hydrogen release and see the safe update path for this deployment."],
    [LANGUAGE, "bi-translate", "mb-3", "Choose the dashboard language. Applies immediately to everyone."],
    [BACKUP, "bi-archive", "mb-4", "Export this entire instance to one file, and put it back later — providers, models, services, API keys, users and settings, exactly as they are now."],
    [RETENTION, "bi-clock-history", "mb-3", "Automatically delete request logs older than this many days (checked daily). Set to 0 to keep logs forever."],
    [IMAGE_CACHE, "bi-images", "mb-3", null],
    [ALLOWLIST, "bi-shield-lock", "mb-3", "Provider URLs resolving to private/loopback/LAN addresses are blocked by default. Add a trusted IP, CIDR, or hostname to permit it."],
    [RUNTIME, "bi-sliders", "mb-4", "These values override the boot-time env vars at runtime (no restart needed). Boot-only values (port, host, data dir) are shown read-only."],
  ])("%s is a padded card: icon and h3 on one line, then a hint", async (title, glyph, gap, hint) => {
    await loaded();
    const c = card(title);
    expect(c.tagName).toBe("DIV");
    expect(classes(c)).toEqual(cls("card card-pad mt-6"));
    const head = c.firstElementChild!;
    expect(classes(head)).toEqual(cls("mb-1 flex items-center gap-2"));
    expect([...head.children].map((e) => e.tagName)).toEqual(["I", "H3"]);
    expect(classes(head.querySelector("i"))).toEqual(cls(`bi ${glyph} text-brand-400`));
    expect(classes(head.querySelector("h3"))).toEqual(cls("font-medium text-ink-100"));
    const p = head.nextElementSibling!;
    expect(p.tagName).toBe("P");
    expect(classes(p)).toEqual(cls(`${gap} text-xs text-ink-500`));
    if (hint) expect(p.textContent).toBe(hint);
    else expect(p.textContent).toMatch(/^A Micro Agent's image translation \(OCR\) pre-pass remembers/);
  });

  it("the Responses card is the odd one out: a section with an h2, no icon, larger hint and its own spacing", async () => {
    await loaded();
    const c = card(RESPONSES);
    expect(c.tagName).toBe("SECTION");
    expect(classes(c)).toEqual(cls("card mb-5 space-y-3 p-5"));
    expect([...c.children].map((e) => e.tagName)).toEqual(["H2", "P", "LABEL"]);
    expect(classes(c.querySelector("h2"))).toEqual(["font-semibold"]);
    expect(c.querySelector("i")).toBeNull();
    const p = c.querySelector("p")!;
    expect(classes(p)).toEqual(cls("text-sm text-ink-400"));
    expect(p.textContent).toBe("Retain idle history for this many days. Continuation refreshes expiry; 0 keeps history indefinitely. Reducing retention immediately clears expired history while preserving active jobs.");
  });

  it("ends with a footer naming the running server's version", async () => {
    const { container } = await loaded();
    const footer = container.querySelector(".mt-10")!;
    expect(classes(footer)).toEqual(cls("mt-10 flex items-center justify-center gap-2 pb-2 text-xs text-ink-500"));
    expect(footer).toBe(container.firstElementChild!.lastElementChild);
    expect([...footer.children].map((e) => [e.tagName.toLowerCase(), e.textContent, e.getAttribute("class")])).toEqual([
      ["svg", "", "h-4 w-4"], ["span", "Hydrogen", "font-medium text-ink-400"], ["span", "v2.1.6", "font-mono"], ["span", "·", "text-ink-600"], ["span", "LLM Proxy", null],
    ]);
  });

  it("the footer simply omits the version when it cannot be read", async () => {
    const { container } = await loaded({ "GET /settings/version": fail(500, { error: "boom" }) });
    expect(container.querySelector(".mt-10")!.textContent).toBe("Hydrogen·LLM Proxy");
    expect(screen.queryByText("boom")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("Settings: About & updates", () => {
  const VERSION = "rounded-md border border-ink-700 bg-ink-900 px-2 py-0.5 font-mono text-xs text-ink-200";
  const AVAILABLE = "inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300";
  const MANUAL = "mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-ink-300";
  const CHECK = "Check for updates";
  const UPGRADE = "Upgrade & restart";
  const CONFIRM = "Restart to upgrade to v2.2.0?";
  const RESTARTING = "Restarting — waiting for the server to come back…";
  const DISABLED_NOTE = "Automatic restart is disabled for this deployment. Update it through the deployment tool that owns the process:";
  const MISMATCH_NOTE = "The supervisor did not start the requested release. Update the deployment explicitly:";
  const code = () => card(UPDATE).querySelector("code")!;
  const manual = () => card(UPDATE).querySelector(".bg-amber-500\\/5");
  /** Strict fake time (no drift with the wall clock) once the page is up, so the poll schedule is exact. */
  const startUpgrade = async (routes: Routes = {}) => {
    const r = await loaded({ "GET /update/check": UPGRADABLE, ...routes });
    vi.useFakeTimers();
    fireEvent.click(button(UPGRADE, card(UPDATE)));
    confirmWith(CONFIRM);
    await flush();
    return r;
  };

  it("shows an ellipsis and a busy Check button until the first check answers, then the version and 'up to date'", async () => {
    const gate = deferred<unknown>();
    const { api } = await setup({ "GET /update/check": () => gate.promise });
    await flush();
    const c = card(UPDATE);
    expect(code().textContent).toBe("…");
    expect(classes(code())).toEqual(cls(VERSION));
    expect(classes(code().parentElement)).toEqual(cls("flex flex-wrap items-center gap-3"));
    expect(classes(screen.getByText("Current version"))).toEqual(cls("text-xs text-ink-500"));
    expect(code().parentElement!.children).toHaveLength(2);
    const check = button(CHECK, c);
    expect(classes(check)).toEqual(cls("btn-ghost btn-xs"));
    expect(classes(check.parentElement)).toEqual(cls("mt-3 flex flex-wrap items-center gap-2"));
    expect([check.disabled, icon(check)]).toEqual([true, cls(SPIN)]);
    expect(check.parentElement!.children).toHaveLength(1);

    await act(async () => { gate.resolve(STATUS); });
    await flush();
    expect(code().textContent).toBe("v2.1.6");
    expect([check.disabled, icon(check)]).toEqual([false, cls("bi bi-arrow-clockwise")]);
    const ok = screen.getByText("You are running the latest version.");
    expect(classes(ok)).toEqual(cls("inline-flex items-center gap-1.5 text-xs text-emerald-400"));
    expect(icon(ok)).toEqual(cls("bi bi-check-circle"));
    expect(check.parentElement!.children).toHaveLength(1);
    expect(manual()).toBeNull();
    expect(api.sent("GET", "/update/check")).toEqual([sentBare("GET", "/update/check")]);
  });

  it("announces a newer release in an amber chip with a link to its notes", async () => {
    await loaded({ "GET /update/check": NEWER });
    const chip = screen.getByText(/^New version available/);
    expect(chip.textContent).toBe("New version available: v2.2.0");
    expect(classes(chip)).toEqual(cls(AVAILABLE));
    expect(icon(chip)).toEqual(cls("bi bi-arrow-up-circle"));
    expect(chip.querySelector("span")).toBeNull();
    expect(screen.queryByText("You are running the latest version.")).toBeNull();
    const notes = screen.getByText("Release notes") as HTMLAnchorElement;
    expect(notes.tagName).toBe("A");
    expect(classes(notes)).toEqual(cls("btn-ghost btn-xs"));
    expect(icon(notes)).toEqual(cls("bi bi-box-arrow-up-right"));
    expect([notes.getAttribute("href"), notes.target, notes.rel]).toEqual([NEWER.releaseUrl, "_blank", "noreferrer"]);
  });

  it("marks a pre-release and dates the release in the viewer's locale; an unknown latest shows as v?", async () => {
    const publishedAt = "2026-07-17T10:00:00Z";
    await loaded({ "GET /update/check": { ...NEWER, latest: null, prerelease: true, publishedAt } });
    const chip = screen.getByText(/^New version available/);
    const date = `· published ${new Date(publishedAt).toLocaleDateString()}`;
    expect(chip.textContent).toBe(`New version available: v?pre-release${date}`);
    expect([...chip.querySelectorAll("span")].map((s) => [s.textContent, classes(s)])).toEqual([
      ["pre-release", cls("rounded border border-amber-500/40 px-1 text-amber-400/90")], [date, ["text-amber-400/70"]],
    ]);
  });

  // The decision table of the action row and the manual-deployment note.
  it.each([
    ["up to date", STATUS, [CHECK], false],
    ["newer, no release URL, no restart", { ...NEWER, releaseUrl: null }, [CHECK], true],
    ["newer, restart unsupported", NEWER, [CHECK, "Release notes"], true],
    ["newer, restart supported", UPGRADABLE, [CHECK, "Release notes", UPGRADE], false],
    ["newer, restart supported, no release URL", { ...UPGRADABLE, releaseUrl: null }, [CHECK, UPGRADE], false],
    ["not newer but restart supported", { ...STATUS, restartSupported: true, releaseUrl: "https://x.test/r" }, [CHECK], false],
  ])("%s: offers exactly the right actions", async (_name, status, actions, note) => {
    await loaded({ "GET /update/check": status });
    expect([...button(CHECK, card(UPDATE)).parentElement!.children].map((e) => e.textContent)).toEqual(actions);
    expect(manual() !== null).toBe(note);
  });

  it("the upgrade button is the primary action", async () => {
    await loaded({ "GET /update/check": UPGRADABLE });
    const upgrade = button(UPGRADE, card(UPDATE));
    expect(classes(upgrade)).toEqual(cls("btn-primary btn-xs"));
    expect([upgrade.disabled, icon(upgrade)]).toEqual([false, cls("bi bi-cloud-arrow-down")]);
  });

  it("docker without restart support: explains and shows both Compose commands", async () => {
    await loaded({ "GET /update/check": NEWER });
    const note = manual()!;
    expect(classes(note)).toEqual(cls(MANUAL));
    expect(note).toBe(button(CHECK, card(UPDATE)).parentElement!.nextElementSibling);
    expect([...note.children].map((e) => e.tagName)).toEqual(["P", "DIV", "P"]);
    expect(note.firstElementChild!.textContent).toBe(DISABLED_NOTE);
    expect(classes(note.firstElementChild)).toEqual(["mb-2"]);
    expect(classes(note.children[1])).toEqual(["space-y-2"]);
    expect([...note.querySelectorAll(".space-y-2 > div")].map((d) => [d.querySelector("p")!.textContent, d.querySelector("code")!.textContent])).toEqual([
      ["Prebuilt-image Compose deployment", "docker compose pull && docker compose up -d"],
      ["Hydrogen source checkout (the repository's default Compose setup)", "git pull && docker compose up -d --build"],
    ]);
    expect(classes(note.querySelector(".space-y-2 p"))).toEqual(cls("mb-1 text-ink-500"));
    expect(classes(note.querySelector("code"))).toEqual(cls("block rounded bg-ink-950 px-2 py-1 font-mono text-[11px] text-ink-200"));
    expect(note.lastElementChild!.textContent).toBe("For production, prefer a pinned release tag and explicitly roll out that tag.");
    expect(classes(note.lastElementChild)).toEqual(cls("mt-2 text-ink-500"));
  });

  it.each([
    ["kubernetes", "Set the Deployment's image to v2.2.0 (or update its floating tag), then start a new rollout."],
    ["node", "Install v2.2.0, then restart Hydrogen with the process supervisor that normally runs it."],
  ])("%s without restart support: one line of guidance naming the release, no commands", async (runtime, text) => {
    await loaded({ "GET /update/check": { ...NEWER, runtime } });
    const note = manual()!;
    expect([...note.children].map((e) => [e.tagName, e.textContent, e.className])).toEqual([
      ["P", DISABLED_NOTE, "mb-2"], ["P", text, ""], ["P", "For production, prefer a pinned release tag and explicitly roll out that tag.", "mt-2 text-ink-500"],
    ]);
    expect(note.querySelector("code")).toBeNull();
  });

  it("a check that reports an error shows it in red and hides the verdict, but keeps the version and the actions", async () => {
    await loaded({ "GET /update/check": { ...UPGRADABLE, error: "GitHub rate limit" } });
    const err = screen.getByText("GitHub rate limit");
    expect(err.tagName).toBe("P");
    expect(classes(err)).toEqual(cls("mt-2 text-xs text-red-400"));
    expect(err.previousElementSibling).toBe(code().parentElement);
    expect(code().textContent).toBe("v2.1.6");
    expect(code().parentElement!.children).toHaveLength(2);
    expect(hasButton(UPGRADE, card(UPDATE))).toBe(true);
  });

  it.each([
    ["the server's message", fail(502, { error: "upstream unreachable" }), "upstream unreachable"],
    ["'Update check failed' for a non-API failure", offline, "Update check failed"],
  ])("shows %s inline (no toast) when the check itself fails, and the version stays unknown", async (_name, handler, text) => {
    await loaded({ "GET /update/check": handler });
    expect(classes(screen.getByText(text))).toEqual(cls("mt-2 text-xs text-red-400"));
    expect(code().textContent).toBe("…");
    expect(toasts()).toEqual([]);
    expect(button(CHECK, card(UPDATE)).disabled).toBe(false);
  });

  it("Check for updates asks again with ?refresh=1, is busy meanwhile, and a good answer clears the error", async () => {
    const gate = deferred<unknown>();
    const { api } = await loaded({ "GET /update/check": fail(502, { error: "upstream unreachable" }), "GET /update/check?refresh=1": () => gate.promise });
    const check = button(CHECK, card(UPDATE));
    fireEvent.click(check);
    await flush();
    expect([check.disabled, icon(check)]).toEqual([true, cls(SPIN)]);
    // The stale error stays up until the new answer is in.
    expect(screen.getByText("upstream unreachable")).toBeTruthy();
    await act(async () => { gate.resolve(NEWER); });
    await flush();
    expect(api.sent("GET", "/update/check?refresh=1")).toEqual([sentBare("GET", "/update/check?refresh=1")]);
    expect(gets(api, "/update/check")).toBe(1);
    expect(screen.queryByText("upstream unreachable")).toBeNull();
    expect(code().textContent).toBe("v2.1.6");
    expect(screen.getByText("New version available: v2.2.0")).toBeTruthy();
    expect([check.disabled, icon(check)]).toEqual([false, cls("bi bi-arrow-clockwise")]);
  });

  it("a failed re-check keeps the last known status on screen beside the error", async () => {
    await loaded({ "GET /update/check": NEWER, "GET /update/check?refresh=1": fail(500, { error: "boom" }) });
    fireEvent.click(button(CHECK, card(UPDATE)));
    await flush();
    expect(screen.getByText("boom")).toBeTruthy();
    expect(screen.getByText("New version available: v2.2.0")).toBeTruthy();
    expect(manual()).not.toBeNull();
  });

  it("asks before restarting (the shared danger dialog); Cancel sends nothing", async () => {
    const { api } = await loaded({ "GET /update/check": UPGRADABLE });
    fireEvent.click(button(UPGRADE, card(UPDATE)));
    const m = openModal(CONFIRM);
    expect(classes(m)).toEqual(cls("card flex max-h-[92vh] w-full flex-col max-w-lg"));
    expect(classes(m.querySelector("h2 i"))).toEqual(cls("bi bi-exclamation-triangle-fill text-brand-400"));
    const body = screen.getByText(/^Hydrogen will stop accepting new requests and give active requests up to 30 seconds to finish\./);
    expect(classes(body)).toEqual(cls("text-sm text-ink-300"));
    expect([...button("Confirm", m).parentElement!.querySelectorAll("button")].map((b) => [b.textContent, b.className])).toEqual([["Cancel", "btn-ghost"], ["Confirm", "btn-danger"]]);
    expect(icon(button("Confirm", m))).toEqual(cls("bi bi-trash3"));
    await act(async () => { fireEvent.click(button("Cancel", m)); });
    expect(modal(CONFIRM)).toBeNull();
    expect(api.mutations()).toEqual([]);
    expect(screen.queryByText(RESTARTING)).toBeNull();
  });

  it("restarts with POST /update/restart, shows a restarting line, waits 3 s and then polls /update/check", async () => {
    const { api } = await startUpgrade({ "POST /update/restart": { ok: true } });
    expect(api.mutations()).toEqual([sentJson("POST", "/update/restart", {})]);
    const c = card(UPDATE);
    const line = screen.getByText(RESTARTING);
    expect(classes(line)).toEqual(cls("inline-flex items-center gap-1.5 text-xs text-ink-300"));
    expect(icon(line)).toEqual(cls(SPIN));
    // The verdict chip gives way to the restarting line; the version stays.
    expect(screen.queryByText(/^New version available/)).toBeNull();
    expect(code().textContent).toBe("v2.1.6");
    expect(button(CHECK, c).disabled).toBe(true);
    expect(icon(button(CHECK, c))).toEqual(cls("bi bi-arrow-clockwise"));
    expect([button(UPGRADE, c).disabled, icon(button(UPGRADE, c))]).toEqual([true, cls(SPIN)]);

    api.on("GET /update/check", { ...STATUS, current: "2.2.0", latest: "2.2.0" });
    await advance(2999);
    expect(gets(api, "/update/check")).toBe(1);
    await advance(1);
    expect(gets(api, "/update/check")).toBe(2);
    expect(api.sent("GET", "/update/check?refresh=1")).toEqual([]);
    expect(toasts()).toEqual(["Upgrade complete — now running v2.2.0"]);
    expect(screen.queryByText(RESTARTING)).toBeNull();
    expect(code().textContent).toBe("v2.2.0");
    expect(screen.getByText("You are running the latest version.")).toBeTruthy();
    expect(hasButton(UPGRADE, c)).toBe(false);
    expect(button(CHECK, c).disabled).toBe(false);
    await advance(60_000);
    expect(gets(api, "/update/check")).toBe(2);
  });

  it("keeps polling every 2.5 s while the server is down and adopts the first answer", async () => {
    const { api } = await startUpgrade({ "POST /update/restart": {} });
    api.on("GET /update/check", offline);
    await advance(3000);
    expect(gets(api, "/update/check")).toBe(2);
    await advance(2499);
    expect(gets(api, "/update/check")).toBe(2);
    await advance(1);
    expect(gets(api, "/update/check")).toBe(3);
    expect(screen.getByText(RESTARTING)).toBeTruthy();
    expect(toasts()).toEqual([]);
    api.on("GET /update/check", { ...STATUS, current: "2.2.0", latest: "2.2.0" });
    await advance(2500);
    expect(gets(api, "/update/check")).toBe(4);
    expect(toasts()).toEqual(["Upgrade complete — now running v2.2.0"]);
  });

  it.each([
    ["the same version", "2.1.6", "Server restarted but is still v2.1.6 — the deployment served a cached or pinned image"],
    ["some other version", "2.1.9", "Server came back on v2.1.9, not the requested v2.2.0"],
  ])("a restart that comes back on %s is reported and falls back to manual guidance", async (_name, current, text) => {
    const { api } = await startUpgrade({ "POST /update/restart": {} });
    api.on("GET /update/check", { ...UPGRADABLE, current });
    await advance(3000);
    expect(toasts()).toEqual([text]);
    expect(screen.queryByText(RESTARTING)).toBeNull();
    expect(code().textContent).toBe(`v${current}`);
    expect(classes(manual())).toEqual(cls(MANUAL));
    expect(manual()!.firstElementChild!.textContent).toBe(MISMATCH_NOTE);
    expect(manual()!.querySelectorAll("code")).toHaveLength(2);
    // Still offered, so the operator can try again.
    expect(button(UPGRADE, card(UPDATE)).disabled).toBe(false);
  });

  it("a later check that finds nothing newer drops the mismatch note", async () => {
    const { api } = await startUpgrade({ "POST /update/restart": {}, "GET /update/check?refresh=1": UPGRADABLE });
    api.on("GET /update/check", UPGRADABLE);
    await advance(3000);
    expect(manual()).not.toBeNull();
    // Still newer: the note survives a re-check.
    fireEvent.click(button(CHECK, card(UPDATE)));
    await flush();
    expect(manual()).not.toBeNull();
    api.on("GET /update/check?refresh=1", STATUS);
    fireEvent.click(button(CHECK, card(UPDATE)));
    await flush();
    expect(manual()).toBeNull();
    api.on("GET /update/check?refresh=1", UPGRADABLE);
    fireEvent.click(button(CHECK, card(UPDATE)));
    await flush();
    expect(hasButton(UPGRADE, card(UPDATE))).toBe(true);
    expect(manual()).toBeNull();
  });

  it("gives up 120 s after the first poll: 48 attempts, then a timeout toast and manual guidance", async () => {
    const { api } = await startUpgrade({ "POST /update/restart": {} });
    api.on("GET /update/check", fail(502, { error: "bad gateway" }));
    await advance(3000 + 119_999);
    expect(gets(api, "/update/check")).toBe(1 + 48);
    expect(screen.getByText(RESTARTING)).toBeTruthy();
    expect(toasts()).toEqual([]);
    await advance(1);
    expect(gets(api, "/update/check")).toBe(1 + 48);
    expect(toasts()).toEqual(["The server did not come back in time — check the deployment"]);
    expect(screen.queryByText(RESTARTING)).toBeNull();
    expect(manual()!.firstElementChild!.textContent).toBe(MISMATCH_NOTE);
    expect(button(UPGRADE, card(UPDATE)).disabled).toBe(false);
    // Poll failures are never surfaced inline.
    expect(screen.queryByText("bad gateway")).toBeNull();
  });

  it.each([
    ["the server's message", fail(409, { error: "restart is not enabled" }), "restart is not enabled"],
    ["'Save failed' for a non-API failure", offline, "Save failed"],
  ])("toasts %s when the restart is refused, and never starts polling", async (_name, handler, text) => {
    const { api } = await startUpgrade({ "POST /update/restart": handler });
    expect(toasts()).toEqual([text]);
    expect(screen.queryByText(RESTARTING)).toBeNull();
    expect(button(UPGRADE, card(UPDATE)).disabled).toBe(false);
    expect(screen.getByText("New version available: v2.2.0")).toBeTruthy();
    await advance(10_000);
    expect(gets(api, "/update/check")).toBe(1);
    expect(manual()).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("Settings: UI language", () => {
  const ON = "rounded-md px-3 py-1 text-xs font-medium transition-colors bg-brand-600 text-white";
  const OFF = "rounded-md px-3 py-1 text-xs font-medium transition-colors border border-ink-700 bg-ink-900 text-ink-300 hover:text-ink-100";
  /** Found by their own captions, which are the same in both languages. */
  const pair = () => [button("English"), button("中文")];

  it("offers English and 中文 as a two-button choice with the current one filled", async () => {
    await loaded();
    const [en, zh] = pair();
    expect(pair().map((b) => [b.textContent, b.type, b.disabled])).toEqual([["English", "button", false], ["中文", "button", false]]);
    expect(classes(en)).toEqual(cls(ON));
    expect(classes(zh)).toEqual(cls(OFF));
    expect(classes(en.parentElement)).toEqual(cls("flex items-center gap-2"));
  });

  it("starts from the server's language", async () => {
    await loaded({ "GET /settings/ui-language": { language: "zh" } });
    const [en, zh] = pair();
    expect(classes(en)).toEqual(cls(OFF));
    expect(classes(zh)).toEqual(cls(ON));
    expect(document.querySelector("h1")!.textContent).toBe("设置");
  });

  it("switching saves with PUT /settings/ui-language, retranslates at once, remembers locally and reloads nothing", async () => {
    const gate = deferred<unknown>();
    const { api } = await loaded({ "PUT /settings/ui-language": () => gate.promise });
    const before = api.calls.length;
    fireEvent.click(pair()[1]);
    await flush();
    // Applied before the server has answered; both buttons wait.
    expect(document.querySelector("h1")!.textContent).toBe("设置");
    expect(document.querySelectorAll("h3")[1].textContent).toBe("界面语言");
    expect(pair().map((b) => [b.disabled, b.classList.contains("bg-brand-600")])).toEqual([[true, false], [true, true]]);
    expect(localStorage.getItem("hydrogen.ui_language")).toBe("zh");
    await act(async () => { gate.resolve({ language: "zh" }); });
    await flush();
    expect(pair().map((b) => b.disabled)).toEqual([false, false]);
    expect(api.calls.slice(before)).toEqual([sentJson("PUT", "/settings/ui-language", { language: "zh" })]);
    expect(toasts()).toEqual([]);

    api.on("PUT /settings/ui-language", { language: "en" });
    fireEvent.click(pair()[0]);
    await flush();
    expect(document.querySelector("h1")!.textContent).toBe("Settings");
    expect(api.mutations().map((c) => c.body)).toEqual([{ language: "zh" }, { language: "en" }]);
    expect(localStorage.getItem("hydrogen.ui_language")).toBe("en");
  });

  it("clicking the current language sends nothing", async () => {
    const { api } = await loaded();
    fireEvent.click(pair()[0]);
    await flush();
    expect(api.mutations()).toEqual([]);
    expect(pair().map((b) => b.disabled)).toEqual([false, false]);
  });

  it.each([
    ["refused by the server", fail(403, { error: "forbidden" })],
    ["a network failure", offline],
  ])("still switches, silently, when the save is %s", async (_name, handler) => {
    await loaded({ "PUT /settings/ui-language": handler });
    fireEvent.click(pair()[1]);
    await flush();
    expect(document.querySelector("h1")!.textContent).toBe("设置");
    expect(toasts()).toEqual([]);
    expect(pair().map((b) => b.disabled)).toEqual([false, false]);
  });
});

// ---------------------------------------------------------------------------

describe("Settings: Backup & restore", () => {
  const EXPORT = "Export a backup";
  const RESTORE = "Restore from a backup";
  const EXPORT_ACTION = "Export & download";
  const CONFIRM = "Restore and replace everything?";
  const SUB = "rounded-lg border border-ink-800 bg-ink-950/40 p-4";
  const WARNING = "mt-2 flex items-start gap-1.5 text-xs text-amber-400/90";
  const switchOf = (label: string) => screen.getByText(label).parentElement!.querySelector("button")!;
  const fillExport = (passphrase: string, confirmation = passphrase) => {
    type(field("Passphrase", box(EXPORT)), passphrase);
    type(field("Confirm passphrase", box(EXPORT)), confirmation);
  };
  /** jsdom cannot download: capture what the page hands to the browser instead. */
  const stubDownload = () => {
    const saved: { name: string; href: string; attached: boolean }[] = [];
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:backup");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.push({ name: this.download, href: this.getAttribute("href") ?? "", attached: this.parentElement === document.body });
    });
    return { saved, create, revoke };
  };
  const choose = (content: string, name = "hydrogen-backup-2026-07-17.json") => {
    fireEvent.change(field("Backup file", box(RESTORE)), { target: { files: [new File([content], name, { type: "application/json" })] } });
  };
  const startRestore = (content: string, passphrase = "pw") => {
    choose(content);
    type(field("Passphrase", box(RESTORE)), passphrase);
    fireEvent.click(button("Restore", box(RESTORE)));
  };
  const REPORT = { ok: true, restored: { providers: 3, models: 4, request_logs: 120 }, includedLogs: true, includedImageCache: false, providerKeysRestored: 3 };

  it("lays out an export box and a restore box", async () => {
    await loaded();
    const [exp, res] = [box(EXPORT), box(RESTORE)];
    expect(classes(exp)).toEqual(cls(SUB));
    expect(classes(res)).toEqual(cls(`mt-4 ${SUB}`));
    for (const [b, glyph, hint] of [
      [exp, "bi-download", "Downloads one file containing everything. Provider API keys are re-encrypted under the passphrase you choose, so the file is safe to store and restores onto any Hydrogen instance."],
      [res, "bi-upload", "Replaces everything in this instance with the contents of the file."],
    ] as const) {
      expect(classes(b.firstElementChild)).toEqual(cls("mb-1 flex items-center gap-2"));
      expect(classes(b.firstElementChild!.querySelector("i"))).toEqual(cls(`bi ${glyph} text-ink-400`));
      expect(classes(b.querySelector("h4"))).toEqual(cls("text-sm font-medium text-ink-200"));
      expect([b.children[1].textContent, classes(b.children[1])]).toEqual([hint, cls("mb-3 text-xs text-ink-500")]);
      expect(classes(b.children[2])).toEqual(cls("grid max-w-xl gap-2 sm:grid-cols-2"));
      expect(classes(b.children[3])).toEqual(cls(WARNING));
      expect(classes(b.children[3].querySelector("i"))).toEqual(cls("bi bi-exclamation-triangle mt-0.5"));
    }
    expect(exp.children[3].textContent).toBe("Store this passphrase somewhere safe. It is not kept on the server, and without it the backup cannot be restored.");
    expect(res.children[3].textContent).toBe("This replaces ALL current data and cannot be undone. You will be signed out and must log in with an account from the backup.");
  });

  it("export: two password fields, two switches (logs on, image cache off) and a small primary button", async () => {
    await loaded();
    const exp = box(EXPORT);
    expect([...exp.querySelectorAll(".label")].map((l) => [l.tagName, l.textContent])).toEqual([["LABEL", "Passphrase"], ["LABEL", "Confirm passphrase"]]);
    expect(classes(labelEl("Passphrase", exp))).toEqual(["label"]);
    for (const f of [field("Passphrase", exp), field("Confirm passphrase", exp)]) {
      expect([f.type, f.value, f.placeholder, f.autocomplete, classes(f)]).toEqual(["password", "", "at least 8 characters", "new-password", cls("input text-xs")]);
    }
    const logs = switchOf("Include request logs and response history");
    const cache = switchOf("Include the image description cache");
    expect([isOn(logs), isOn(cache)]).toEqual([true, false]);
    expect(classes(logs.closest("div"))).toEqual(cls("mt-3 flex items-center gap-2"));
    expect(classes(cache.closest("div"))).toEqual(cls("mt-2 flex items-center gap-2"));
    expect([...logs.closest("div")!.querySelectorAll(":scope > span")].map((s) => [s.textContent, s.className])).toEqual([
      ["Include request logs and response history", "text-xs text-ink-300"], ["Off makes a much smaller, config-only package.", "text-xs text-ink-500"],
    ]);
    expect([...cache.closest("div")!.querySelectorAll(":scope > span")].map((s) => [s.textContent, s.className])).toEqual([
      ["Include the image description cache", "text-xs text-ink-300"], ["Saves the target re-running OCR, but can add up to the cache's whole budget to the file.", "text-xs text-ink-500"],
    ]);
    const go = button(EXPORT_ACTION, exp);
    expect(classes(go)).toEqual(cls("btn-primary btn-xs mt-4"));
    expect([go.disabled, icon(go)]).toEqual([false, cls("bi bi-download")]);
    expect(go).toBe(exp.lastElementChild);
  });

  it.each([
    ["empty", "", "", "Passphrase must be at least 8 characters"],
    ["seven characters", "1234567", "1234567", "Passphrase must be at least 8 characters"],
    ["too short and mismatched (length is checked first)", "1234567", "other", "Passphrase must be at least 8 characters"],
    ["long enough but mismatched", "12345678", "12345679", "The two passphrases do not match"],
    ["confirmation left empty", "12345678", "", "The two passphrases do not match"],
  ])("export refuses a passphrase that is %s, without calling the server", async (_name, passphrase, confirmation, text) => {
    const { api } = await loaded();
    fillExport(passphrase, confirmation);
    fireEvent.click(button(EXPORT_ACTION));
    await toastShown(text);
    expect(api.mutations()).toEqual([]);
    expect(field("Passphrase", box(EXPORT)).value).toBe(passphrase);
  });

  it("exports with POST /backup/export and saves the answer as a dated JSON file, then clears the passphrases", async () => {
    vi.setSystemTime(new Date(2026, 6, 7, 10, 0, 0));
    const backup = { format: "hydrogen-backup", version: 3, tables: { providers: [{ id: 1 }] } };
    const { api } = await loaded({ "POST /backup/export": { backup } });
    const { saved, create, revoke } = stubDownload();
    // Exactly eight characters is enough; the passphrase is sent untrimmed.
    fillExport(" 2345678");
    fireEvent.click(button(EXPORT_ACTION));
    await toastShown("Backup exported");
    expect(api.mutations()).toEqual([sentJson("POST", "/backup/export", { passphrase: " 2345678", includeLogs: true, includeImageCache: false })]);
    expect(saved).toEqual([{ name: "hydrogen-backup-2026-07-07.json", href: "blob:backup", attached: true }]);
    const blob = create.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("application/json");
    expect(await blob.text()).toBe(JSON.stringify(backup));
    expect(revoke).toHaveBeenCalledWith("blob:backup");
    expect(document.body.querySelector("a[download]")).toBeNull();
    expect([field("Passphrase", box(EXPORT)).value, field("Confirm passphrase", box(EXPORT)).value]).toEqual(["", ""]);
  });

  it("sends the two switches as set", async () => {
    const { api } = await loaded({ "POST /backup/export": { backup: {} } });
    stubDownload();
    fireEvent.click(switchOf("Include request logs and response history"));
    fireEvent.click(switchOf("Include the image description cache"));
    fillExport("correct horse");
    fireEvent.click(button(EXPORT_ACTION));
    await toastShown("Backup exported");
    expect(api.mutations()[0].body).toEqual({ passphrase: "correct horse", includeLogs: false, includeImageCache: true });
  });

  it("disables Export with a spinning icon while the request is in flight", async () => {
    const gate = deferred<unknown>();
    await loaded({ "POST /backup/export": () => gate.promise });
    stubDownload();
    fillExport("correct horse");
    const go = button(EXPORT_ACTION);
    fireEvent.click(go);
    await flush();
    expect([go.disabled, icon(go)]).toEqual([true, cls(SPIN)]);
    await act(async () => { gate.resolve({ backup: {} }); });
    await flush();
    expect([go.disabled, icon(go)]).toEqual([false, cls("bi bi-download")]);
  });

  it.each([
    ["the server's message", fail(500, { error: "master key unavailable" }), "master key unavailable"],
    ["'Export failed' for a non-API failure", offline, "Export failed"],
  ])("toasts %s when the export fails, saves no file and keeps the passphrases", async (_name, handler, text) => {
    await loaded({ "POST /backup/export": handler });
    const { saved } = stubDownload();
    fillExport("correct horse");
    fireEvent.click(button(EXPORT_ACTION));
    await toastShown(text);
    expect(saved).toEqual([]);
    expect([field("Passphrase", box(EXPORT)).value, field("Confirm passphrase", box(EXPORT)).value]).toEqual(["correct horse", "correct horse"]);
    expect(button(EXPORT_ACTION).disabled).toBe(false);
  });

  it("restore: a JSON file picker, a passphrase and a ghost button that needs a file", async () => {
    await loaded();
    const res = box(RESTORE);
    expect([...res.querySelectorAll(".label")].map((l) => l.textContent)).toEqual(["Backup file", "Passphrase"]);
    const file = field("Backup file", res);
    expect([file.type, file.accept]).toEqual(["file", "application/json,.json"]);
    expect(classes(file)).toEqual(cls("input text-xs file:mr-2 file:rounded file:border-0 file:bg-ink-800 file:px-2 file:py-0.5 file:text-xs file:text-ink-200"));
    const pass = field("Passphrase", res);
    expect([pass.type, pass.value, pass.placeholder, pass.autocomplete, classes(pass)]).toEqual(["password", "", "the passphrase used at export", "off", cls("input text-xs")]);
    const go = button("Restore", res);
    expect(classes(go)).toEqual(cls("btn-ghost btn-xs mt-4"));
    expect([go.disabled, icon(go)]).toEqual([true, cls("bi bi-upload")]);
    choose("{}");
    expect(go.disabled).toBe(false);
    // Emptying the picker disables it again.
    fireEvent.change(file, { target: { files: [] } });
    expect(go.disabled).toBe(true);
  });

  it("restore wants a passphrase before it even asks for confirmation", async () => {
    const { api } = await loaded();
    choose("{}");
    fireEvent.click(button("Restore", box(RESTORE)));
    await toastShown("Enter the backup's passphrase");
    expect(modal(CONFIRM)).toBeNull();
    expect(api.mutations()).toEqual([]);
  });

  it("asks before restoring, naming the file; Cancel sends nothing", async () => {
    const { api } = await loaded();
    startRestore("{}");
    const m = openModal(CONFIRM);
    expect(screen.getByText('Everything currently in this instance — providers, models, services, API keys, users and logs — will be permanently replaced by the contents of "hydrogen-backup-2026-07-17.json". This cannot be undone.')).toBeTruthy();
    expect(button("Confirm", m).className).toBe("btn-danger");
    await act(async () => { fireEvent.click(button("Cancel", m)); });
    expect(modal(CONFIRM)).toBeNull();
    expect(api.mutations()).toEqual([]);
    expect(button("Restore", box(RESTORE)).disabled).toBe(false);
  });

  it("restores with POST /backup/restore (the parsed file plus the passphrase), totals the rows and reloads to / after 1.2 s", async () => {
    const assign = vi.fn();
    const backup = { format: "hydrogen-backup", tables: { providers: [] } };
    const { api } = await loaded({ "POST /backup/restore": REPORT });
    vi.stubGlobal("location", { assign });
    vi.useFakeTimers();
    // No minimum length on this side: the passphrase is whatever the export used.
    startRestore(JSON.stringify(backup), "pw");
    confirmWith(CONFIRM);
    await flush();
    expect(api.mutations()).toEqual([sentJson("POST", "/backup/restore", { passphrase: "pw", backup })]);
    expect(toasts()).toEqual(["Restored 127 rows — signing you out"]);
    expect(button("Restore", box(RESTORE)).disabled).toBe(false);
    await advance(1199);
    expect(assign).not.toHaveBeenCalled();
    await advance(1);
    expect(assign.mock.calls).toEqual([["/"]]);
  });

  it("disables Restore with a spinning icon while the request is in flight", async () => {
    const gate = deferred<unknown>();
    await loaded({ "POST /backup/restore": () => gate.promise });
    vi.stubGlobal("location", { assign: vi.fn() });
    startRestore("{}");
    confirmWith(CONFIRM);
    const go = button("Restore", box(RESTORE));
    await waitFor(() => expect(go.disabled).toBe(true));
    expect(icon(go)).toEqual(cls(SPIN));
    await act(async () => { gate.resolve({ ...REPORT, restored: {} }); });
    await toastShown("Restored 0 rows — signing you out");
    expect([go.disabled, icon(go)]).toEqual([false, cls("bi bi-upload")]);
  });

  it("refuses a file that is not JSON without calling the server", async () => {
    const assign = vi.fn();
    const { api } = await loaded();
    vi.stubGlobal("location", { assign });
    startRestore("PK\u0003\u0004 not json");
    confirmWith(CONFIRM);
    await toastShown("That file is not a Hydrogen backup");
    expect(api.mutations()).toEqual([]);
    expect(button("Restore", box(RESTORE)).disabled).toBe(false);
    await advance(5000);
    expect(assign).not.toHaveBeenCalled();
  });

  it.each([
    ["the server's message", fail(400, { error: "wrong passphrase" }), "wrong passphrase"],
    ["'Restore failed' for a non-API failure", offline, "Restore failed"],
  ])("toasts %s when the restore fails, and does not reload", async (_name, handler, text) => {
    const assign = vi.fn();
    await loaded({ "POST /backup/restore": handler });
    vi.stubGlobal("location", { assign });
    startRestore("{}");
    confirmWith(CONFIRM);
    await toastShown(text);
    expect(button("Restore", box(RESTORE)).disabled).toBe(false);
    expect(field("Passphrase", box(RESTORE)).value).toBe("pw");
    await advance(5000);
    expect(assign).not.toHaveBeenCalled();
  });
});
