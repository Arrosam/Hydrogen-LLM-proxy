/**
 * Unit tests for the shared hooks and pure helpers: action/attempt, copy,
 * form state, save, confirm-then-delete, resource fetchers, and the constants
 * modules whose values are part of the wire or the URL space.
 */
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { ApiError } from "../src/api";
import { ToastProvider } from "../src/components/Toast";
import { useConfirm } from "../src/components/common";
import { moveItem, nameById, patchAt, removeAt, setMember, toggleMember } from "../src/lib/collections";
import { MIB, MIN_PASSWORD_LENGTH, MS_PER_MINUTE, MS_PER_SECOND } from "../src/lib/constants";
import { useDeleteAction, useFields, useFormState, useSave } from "../src/lib/crud";
import { API, API_PREFIX, apiUrl } from "../src/lib/endpoints";
import { apiErrorMessage, errorMessage } from "../src/lib/errors";
import { useAction, useAttempt, useCopy } from "../src/lib/hooks";
import { HTTP_CLIENT_CLOSED, HTTP_STATUS_RANGE, isSuccessStatus } from "../src/lib/http";
import { formatJson } from "../src/lib/json";
import { newPasswordProblem } from "../src/lib/password";
import { fetchMappings, fetchModels, fetchProviderModels, fetchProviders, fetchProxies, fetchServices, fetchTokens, fetchTools, fetchUsers, loadAll } from "../src/lib/resources";
import { CHECK_PATH, HOME_PATH, MODELS_PATH, ROUTES, routeSegment, routeVisible } from "../src/lib/routes";
import { CHAT_ENDPOINTS, DEFAULT_HOSTED_TOOL_OPTIONS, MEDIA_ENDPOINTS, SERVICE_CATEGORIES } from "../src/lib/serviceDef";
import { BRAND, INK } from "../src/lib/theme";
import { button, deferred, fail, mockApi, renderApp, toasts } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrapper = ({ children }: { children: ReactNode }) => <ToastProvider>{children}</ToastProvider>;

describe("errors", () => {
  it("apiErrorMessage: the server's message for an ApiError, the fallback for anything else", () => {
    expect(apiErrorMessage(new ApiError(409, "name taken"), "Save failed")).toBe("name taken");
    expect(apiErrorMessage(new TypeError("Failed to fetch"), "Save failed")).toBe("Save failed");
    expect(apiErrorMessage("boom", "Save failed")).toBe("Save failed");
  });

  it("errorMessage: any Error's message, else the fallback, else the value as text", () => {
    expect(errorMessage(new TypeError("Failed to fetch"), "Failed")).toBe("Failed to fetch");
    expect(errorMessage(new ApiError(500, "down"))).toBe("down");
    expect(errorMessage("boom", "Failed")).toBe("Failed");
    expect(errorMessage("boom")).toBe("boom");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});

describe("useAttempt / useAction", () => {
  it("attempt resolves true on success and toasts nothing", async () => {
    const { result } = renderHook(() => useAttempt(), { wrapper });
    let ok = false;
    await act(async () => { ok = await result.current(async () => {}, "Failed"); });
    expect([ok, toasts()]).toEqual([true, []]);
  });

  it("attempt toasts the server message for an ApiError and the fallback otherwise", async () => {
    const { result } = renderHook(() => useAttempt(), { wrapper });
    let ok = true;
    await act(async () => { ok = await result.current(async () => { throw new ApiError(400, "bad name"); }, "Failed"); });
    await act(async () => { await result.current(async () => { throw new Error("socket"); }, "Failed"); });
    expect([ok, toasts()]).toEqual([false, ["bad name", "Failed"]]);
  });

  it("a hook-level onError and describe replace the toast and the message rule", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useAttempt({ onError, describe: errorMessage }), { wrapper });
    await act(async () => { await result.current(async () => { throw new Error("raw text"); }, "Failed"); });
    expect([onError.mock.calls, toasts()]).toEqual([[["raw text"]], []]);
  });

  it("a per-call onError wins over the hook-level one", async () => {
    const hookLevel = vi.fn();
    const perCall = vi.fn();
    const { result } = renderHook(() => useAttempt({ onError: hookLevel }), { wrapper });
    await act(async () => { await result.current(async () => { throw new ApiError(500, "x"); }, "F", perCall); });
    expect([hookLevel.mock.calls.length, perCall.mock.calls]).toEqual([0, [["x"]]]);
  });

  it("useAction raises busy for the duration of run, on success and on failure", async () => {
    const gate = deferred<void>();
    const { result } = renderHook(() => useAction(), { wrapper });
    expect(result.current.busy).toBe(false);
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.run(() => gate.promise, "Failed"); });
    expect(result.current.busy).toBe(true);
    await act(async () => { gate.resolve(); await pending; });
    expect(result.current.busy).toBe(false);
    await act(async () => { expect(await result.current.run(async () => { throw new Error("x"); }, "Failed")).toBe(false); });
    expect([result.current.busy, toasts()]).toEqual([false, ["Failed"]]);
  });
});

describe("useCopy", () => {
  it("toasts the ok text when the copy works and the fail text when it does not", async () => {
    // jsdom is not a secure context, so copyToClipboard takes its execCommand path.
    const exec = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    document.execCommand = exec;
    const { result } = renderHook(() => useCopy({ ok: "Copied", fail: "Copy failed" }), { wrapper });
    let ok = false;
    await act(async () => { ok = await result.current("secret"); });
    expect([ok, exec.mock.calls, toasts()]).toEqual([true, [["copy"]], ["Copied"]]);
    await act(async () => { ok = await result.current("secret"); });
    expect([ok, toasts()]).toEqual([false, ["Copied", "Copy failed"]]);
  });
});

interface Thing { id?: number; name: string; port: string; on: boolean }
const BLANK: Thing = { name: "", port: "80", on: true };

describe("useFormState / useFields", () => {
  it("opens, edits, patches and closes", () => {
    const { result } = renderHook(() => useFormState<Thing>());
    expect(result.current.form).toBeNull();
    act(() => result.current.open({ ...BLANK }));
    act(() => result.current.set("name", "a"));
    act(() => result.current.patch({ port: "81", on: false }));
    expect(result.current.form).toEqual({ name: "a", port: "81", on: false });
    act(() => result.current.close());
    expect(result.current.form).toBeNull();
  });

  it("set and patch on a closed form do nothing", () => {
    const { result } = renderHook(() => useFormState<Thing>());
    act(() => { result.current.set("name", "a"); result.current.patch({ on: false }); });
    expect(result.current.form).toBeNull();
  });

  it("two sets in one tick both land (updates are functional)", () => {
    const { result } = renderHook(() => useFormState<Thing>());
    act(() => result.current.open({ ...BLANK }));
    act(() => { result.current.set("name", "a"); result.current.set("port", "82"); });
    expect(result.current.form).toEqual({ name: "a", port: "82", on: true });
  });

  it("bind gives a text control its value and change handler", () => {
    function Probe() {
      const fc = useFormState<Thing>();
      return fc.form ? <input placeholder="name" {...fc.bind("name")} /> : <button onClick={() => fc.open({ ...BLANK, name: "x" })}>open</button>;
    }
    render(<Probe />);
    fireEvent.click(screen.getByText("open"));
    const input = screen.getByPlaceholderText("name") as HTMLInputElement;
    expect(input.value).toBe("x");
    fireEvent.change(input, { target: { value: "xy" } });
    expect(input.value).toBe("xy");
  });

  it("useFields holds an always-present form, from a value or an initialiser", () => {
    const init = vi.fn(() => ({ ...BLANK }));
    const { result } = renderHook(() => useFields<Thing>(init));
    expect(result.current.values).toEqual(BLANK);
    act(() => result.current.set("on", false));
    act(() => result.current.patch({ name: "n" }));
    expect([result.current.values, init.mock.calls.length]).toEqual([{ name: "n", port: "80", on: false }, 1]);
    expect(result.current.bind("port").value).toBe("80");
  });
});

describe("useSave", () => {
  function setup(opts: { toPayload?: (f: Thing) => unknown | null; noSuccessOnCreate?: boolean; shared?: boolean } = {}) {
    const onSaved = vi.fn();
    const hook = renderHook(
      () => {
        const fc = useFormState<Thing>();
        const shared = useAction();
        const save = useSave<Thing, { id: number }>(fc, {
          collection: "/things",
          member: (id) => `/things/${id}`,
          toPayload: opts.toPayload ?? ((f) => ({ name: f.name, port: Number(f.port) })),
          messages: (editing) => (editing ? { success: "Updated", failed: "Update failed" } : opts.noSuccessOnCreate ? { failed: "Create failed" } : { success: "Created", failed: "Create failed" }),
          onSaved,
          action: opts.shared ? shared : undefined,
        });
        return { fc, shared, ...save };
      },
      { wrapper },
    );
    return { ...hook, onSaved };
  }

  it("POSTs a new record to the collection, toasts, closes, and hands over the response", async () => {
    const api = mockApi({ "POST /things": { id: 9 } });
    const { result, onSaved } = setup();
    act(() => result.current.fc.open({ ...BLANK, name: "n" }));
    await act(async () => { await result.current.save(); });
    expect(api.mutations().map((c) => [c.method, c.path, c.body])).toEqual([["POST", "/things", { name: "n", port: 80 }]]);
    expect([toasts(), result.current.fc.form, onSaved.mock.calls]).toEqual([["Created"], null, [[{ id: 9 }, { name: "n", port: "80", on: true }]]]);
  });

  it("PATCHes the member path when the form has an id", async () => {
    const api = mockApi({ "PATCH /things/4": { id: 4 } });
    const { result } = setup();
    act(() => result.current.fc.open({ ...BLANK, id: 4, name: "n" }));
    await act(async () => { await result.current.save(); });
    expect(api.mutations().map((c) => [c.method, c.path])).toEqual([["PATCH", "/things/4"]]);
    expect(toasts()).toEqual(["Updated"]);
  });

  it("no success text means no success toast", async () => {
    mockApi({ "POST /things": { id: 1 } });
    const { result, onSaved } = setup({ noSuccessOnCreate: true });
    act(() => result.current.fc.open({ ...BLANK }));
    await act(async () => { await result.current.save(); });
    expect([toasts(), onSaved.mock.calls.length]).toEqual([[], 1]);
  });

  it("a null payload sends nothing, never raises busy, and leaves the form open", async () => {
    const api = mockApi();
    const { result, onSaved } = setup({ toPayload: () => null });
    act(() => result.current.fc.open({ ...BLANK }));
    await act(async () => { await result.current.save(); });
    expect([api.mutations().length, result.current.saving, result.current.fc.form !== null, onSaved.mock.calls.length]).toEqual([0, false, true, 0]);
  });

  it("a failure toasts the server message (or the fallback), keeps the form open, and skips onSaved", async () => {
    const api = mockApi({ "POST /things": fail(409, { error: "name taken" }) });
    const { result, onSaved } = setup();
    act(() => result.current.fc.open({ ...BLANK }));
    await act(async () => { await result.current.save(); });
    api.on("POST /things", () => { throw new TypeError("offline"); });
    await act(async () => { await result.current.save(); });
    expect([toasts(), result.current.fc.form !== null, onSaved.mock.calls.length, result.current.saving]).toEqual([["name taken", "Create failed"], true, 0, false]);
  });

  it("saving is true while the request is in flight", async () => {
    const gate = deferred<unknown>();
    mockApi({ "POST /things": () => gate.promise });
    const { result } = setup();
    act(() => result.current.fc.open({ ...BLANK }));
    let pending!: Promise<void>;
    act(() => { pending = result.current.save(); });
    await waitFor(() => expect(result.current.saving).toBe(true));
    await act(async () => { gate.resolve({ id: 1 }); await pending; });
    expect(result.current.saving).toBe(false);
  });

  it("a shared action's flag is the save's flag", async () => {
    const gate = deferred<void>();
    mockApi();
    const { result } = setup({ shared: true });
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.shared.run(() => gate.promise); });
    expect(result.current.saving).toBe(true);
    await act(async () => { gate.resolve(); await pending; });
    expect(result.current.saving).toBe(false);
  });

  it("save with no open form does nothing", async () => {
    const api = mockApi();
    const { result } = setup();
    await act(async () => { await result.current.save(); });
    expect(api.mutations().length).toBe(0);
  });
});

describe("useDeleteAction", () => {
  function Probe({ onDeleted, success, describe: describeError }: { onDeleted: () => void; success?: string; describe?: (e: unknown) => string }) {
    const { confirm, confirmEl } = useConfirm();
    const del = useDeleteAction(confirm, onDeleted, describeError ? { describe: describeError } : {});
    return (
      <>
        <button onClick={() => void del({ title: "Delete thing", body: "Really delete it?", path: "/things/3", success, fallback: "Delete failed" })}>remove</button>
        {confirmEl}
      </>
    );
  }
  const setup = (props: Partial<Parameters<typeof Probe>[0]> = {}) => {
    const onDeleted = vi.fn();
    renderApp(<Probe onDeleted={onDeleted} success="Deleted" {...props} />);
    fireEvent.click(screen.getByText("remove"));
    return onDeleted;
  };

  it("asks first, and a cancelled confirm sends nothing", async () => {
    const api = mockApi();
    const onDeleted = setup();
    expect(screen.getByText("Really delete it?")).toBeTruthy();
    await act(async () => { fireEvent.click(button("Cancel")); });
    expect([api.mutations().length, onDeleted.mock.calls.length, toasts()]).toEqual([0, 0, []]);
  });

  it("confirmed: DELETE, success toast, then onDeleted", async () => {
    const api = mockApi({ "DELETE /things/3": {} });
    const onDeleted = setup();
    await act(async () => { fireEvent.click(button("Confirm")); });
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect([api.mutations().map((c) => [c.method, c.path]), toasts()]).toEqual([[["DELETE", "/things/3"]], ["Deleted"]]);
  });

  it("no success text: deletes silently", async () => {
    mockApi({ "DELETE /things/3": {} });
    const onDeleted = setup({ success: undefined });
    await act(async () => { fireEvent.click(button("Confirm")); });
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(toasts()).toEqual([]);
  });

  it("a refused delete toasts the server's reason and does not reload", async () => {
    mockApi({ "DELETE /things/3": fail(409, { error: "still in use by A, B" }) });
    const onDeleted = setup();
    await act(async () => { fireEvent.click(button("Confirm")); });
    await waitFor(() => expect(toasts()).toEqual(["still in use by A, B"]));
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("a network failure toasts the fallback, or the raw message under a custom describe", async () => {
    mockApi({ "DELETE /things/3": () => { throw new TypeError("offline"); } });
    setup();
    await act(async () => { fireEvent.click(button("Confirm")); });
    await waitFor(() => expect(toasts()).toEqual(["Delete failed"]));
    cleanup();
    setup({ describe: (e) => errorMessage(e) });
    await act(async () => { fireEvent.click(button("Confirm")); });
    await waitFor(() => expect(toasts()).toEqual(["offline"]));
  });
});

describe("resources", () => {
  it.each([
    ["services", fetchServices, "/services"],
    ["models", fetchModels, "/models"],
    ["providers", fetchProviders, "/providers"],
    ["mappings", fetchMappings, "/mappings"],
    ["providerModels", fetchProviderModels, "/provider-models"],
    ["tokens", fetchTokens, "/tokens"],
    ["proxies", fetchProxies, "/proxies"],
    ["tools", fetchTools, "/tools"],
    ["users", fetchUsers, "/users"],
  ] as const)("%s: GETs its endpoint and unwraps its envelope", async (key, fetcher, path) => {
    const rows = [{ id: 1 }];
    const api = mockApi({ [`GET ${path}`]: { [key]: rows } });
    expect(await (fetcher as () => Promise<unknown>)()).toEqual(rows);
    expect(api.calls.map((c) => [c.method, c.path])).toEqual([["GET", path]]);
  });

  it("loadAll runs the fetchers in key order and returns results under the same keys", async () => {
    const api = mockApi({ "GET /models": { models: [{ id: 1 }] }, "GET /providers": { providers: [] }, "GET /mappings": { mappings: [{ id: 3 }] } });
    const data = await loadAll({ models: fetchModels, providers: fetchProviders, mappings: fetchMappings });
    expect(data).toEqual({ models: [{ id: 1 }], providers: [], mappings: [{ id: 3 }] });
    expect(api.calls.map((c) => c.path)).toEqual(["/models", "/providers", "/mappings"]);
  });

  it("loadAll rejects when any fetcher fails", async () => {
    mockApi({ "GET /models": { models: [] }, "GET /providers": fail(500, { error: "db down" }) });
    await expect(loadAll({ models: fetchModels, providers: fetchProviders })).rejects.toThrow("db down");
  });

  it("loadAll of nothing is an empty object", async () => {
    expect(await loadAll({})).toEqual({});
  });
});

describe("collections", () => {
  it("setMember adds or removes as a checkbox reports", () => {
    expect(setMember([1, 2], 3, true)).toEqual([1, 2, 3]);
    expect(setMember([1, 2], 2, false)).toEqual([1]);
    expect(setMember([1, 2], 9, false)).toEqual([1, 2]);
  });

  it("toggleMember flips membership and tolerates undefined", () => {
    expect(toggleMember([1, 2], 2)).toEqual([1]);
    expect(toggleMember([1], 2)).toEqual([1, 2]);
    expect(toggleMember(undefined, "x")).toEqual(["x"]);
  });

  it("moveItem, patchAt and removeAt return new lists", () => {
    const list = ["a", "b", "c"];
    expect([moveItem(list, 0, 2), moveItem(list, 2, 0), list]).toEqual([["b", "c", "a"], ["c", "a", "b"], ["a", "b", "c"]]);
    expect(patchAt([{ k: 1, v: "x" }, { k: 2, v: "y" }], 1, { v: "z" })).toEqual([{ k: 1, v: "x" }, { k: 2, v: "z" }]);
    expect(removeAt(list, 1)).toEqual(["a", "c"]);
  });

  it("nameById falls back to #id", () => {
    const list = [{ id: 1, name: "one" }];
    expect([nameById(list, 1), nameById(list, 7), nameById(undefined, 7)]).toEqual(["one", "#7", "#7"]);
  });
});

describe("small helpers and constants", () => {
  it("formatJson indents by two", () => {
    expect(formatJson({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}');
  });

  it.each([
    ["short", "1234567", "1234567", "tooShort"],
    ["exactly the minimum", "12345678", "12345678", null],
    ["mismatch", "12345678", "12345679", "mismatch"],
    ["short wins over mismatch", "123", "456", "tooShort"],
  ] as const)("newPasswordProblem: %s", (_name, a, b, expected) => {
    expect(newPasswordProblem(a, b)).toBe(expected);
  });

  it("newPasswordProblem takes another minimum", () => {
    expect([MIN_PASSWORD_LENGTH, newPasswordProblem("abc", "abc", 3), newPasswordProblem("ab", "ab", 3)]).toEqual([8, null, "tooShort"]);
  });

  it.each([[199, false], [200, true], [204, true], [299, true], [300, false], [0, false], [499, false]])("isSuccessStatus(%i) = %s", (status, expected) => {
    expect(isSuccessStatus(status)).toBe(expected);
  });

  it("unit and status constants", () => {
    expect([MS_PER_SECOND, MS_PER_MINUTE, MIB, HTTP_CLIENT_CLOSED, HTTP_STATUS_RANGE]).toEqual([1000, 60000, 1048576, 499, { min: 100, max: 599 }]);
  });

  it("endpoints: collection, member and derived paths", () => {
    expect(API_PREFIX).toBe("/admin/api");
    expect([API.services, API.service(4), API.servicesValidate, API.servicesTest, API.servicesTestOcr]).toEqual(["/services", "/services/4", "/services/validate", "/services/test", "/services/test-ocr"]);
    expect([API.token(2), API.tokenSecret(2), API.proxiesTest, API.providersTest, API.toolsPreview]).toEqual(["/tokens/2", "/tokens/2/secret", "/proxies/test", "/providers/test", "/tools/preview"]);
    expect([API.activeRequest("abc"), API.log(7), API.updateCheck, API.updateCheckRefresh]).toEqual(["/active-requests/abc", "/logs/7", "/update/check", "/update/check?refresh=1"]);
    expect(apiUrl(API.benchChat)).toBe("/admin/api/bench/chat");
  });

  it("routes: one table, in sidebar order, with the admin-only and external entries marked", () => {
    expect(ROUTES.map((r) => r.path)).toEqual([
      "/", "/services", "/micro-agents", "/tools", "/model", "/providers", "/proxies", "/tokens", "/bench", "/logs", "/active-requests", "/users", "/check", "/settings",
    ]);
    expect(ROUTES.filter((r) => r.adminOnly).map((r) => r.id)).toEqual(["tools", "logs", "users", "settings"]);
    expect(ROUTES.filter((r) => r.external).map((r) => r.path)).toEqual([CHECK_PATH]);
    expect(new Set(ROUTES.map((r) => r.id)).size).toBe(ROUTES.length);
    expect([HOME_PATH, MODELS_PATH]).toEqual(["/", "/model"]);
  });

  it("routeVisible hides admin-only routes from a non-admin; routeSegment strips the slash", () => {
    const users = ROUTES.find((r) => r.id === "users")!;
    const tokens = ROUTES.find((r) => r.id === "tokens")!;
    expect([routeVisible(users, false), routeVisible(users, true), routeVisible(tokens, false)]).toEqual([false, true, true]);
    expect([routeSegment(users), routeSegment(ROUTES[0])]).toEqual(["users", ""]);
  });

  it("service definition tables", () => {
    expect(SERVICE_CATEGORIES).toEqual(["chat", "ocr", "image", "video", "tts", "stt", "embedding", "rerank"]);
    expect(MEDIA_ENDPOINTS).toEqual({
      image: "/v1/images/generations", video: "/v1/videos", tts: "/v1/audio/speech", stt: "/v1/audio/transcriptions", embedding: "/v1/embeddings", rerank: "/v1/rerank",
    });
    expect(CHAT_ENDPOINTS).toEqual({ openai_completion: "/v1/chat/completions", anthropic: "/v1/messages", openai_responses: "/v1/responses" });
    expect(DEFAULT_HOSTED_TOOL_OPTIONS).toEqual({ streamMode: "progress", maxRounds: 8, maxCalls: 16 });
  });

  it("theme mirrors the Tailwind palette the chart draws with", () => {
    expect([INK[800], INK[500], INK[850], INK[700], INK[300], BRAND[500]]).toEqual(["#1b222d", "#5b6b80", "#151b24", "#273140", "#aab6c6", "#22d3ee"]);
  });
});
