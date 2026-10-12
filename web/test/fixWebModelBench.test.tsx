/**
 * Regression tests for defects fixed on the Model Bench page (WA10): the copy
 * toast, Stop on a buffered run, a target kind with no entries, the badge of a
 * failed run answered with HTTP 200, and a bench trailer that is not an object.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { button, classes, deferred, hasButton, toasts, toastShown, toggle } from "./helpers";
import { TARGETS, block, bodyPanel, jsonResponse, loaded, options, resultCard, sel, send, sseOf, type RawCall } from "./modelbench-harness";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete (document as unknown as { execCommand?: unknown }).execCommand;
});

const CHAT_URL = "POST /admin/api/bench/chat";
const ABORTED = "Stopped before the answer arrived.";
const delta = (content: string) => `data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}`;
const badges = () => [...resultCard()!.firstElementChild!.children].map((b) => [b.textContent, classes(b)]);
const note = () => resultCard()!.querySelector(".border-red-900\\/50");

// ---------------------------------------------------------------------------

describe("WA10: a copy button tells the truth", () => {
  const COPY_FAILED = "Copy failed - select the text and copy it manually";
  /** jsdom has no clipboard: the copy goes through execCommand, which answers `works`. */
  const stubCopy = (works: boolean) => { (document as unknown as { execCommand: unknown }).execCommand = vi.fn(() => works); };
  const copyBody = () => fireEvent.click(bodyPanel().querySelector("button i.bi-clipboard")!.closest("button")!);

  it("a failed copy of the request body toasts the failure, not 'Copied'", async () => {
    await loaded();
    stubCopy(false);
    copyBody();
    await toastShown(COPY_FAILED);
    expect(toasts()).not.toContain("Copied to clipboard");
  });

  it("a failed copy of a result block toasts the failure too", async () => {
    await loaded({ "POST /bench/chat": { ok: true, status: 200, latencyMs: 1, usage: { total: 2 } } });
    await send();
    stubCopy(false);
    fireEvent.click(block("Usage").querySelectorAll("button")[1]);
    await toastShown(COPY_FAILED);
    expect(toasts()).not.toContain("Copied to clipboard");
  });

  it("a copy that worked still says so", async () => {
    await loaded();
    stubCopy(true);
    copyBody();
    await toastShown("Copied to clipboard");
    expect(toasts()).not.toContain(COPY_FAILED);
  });
});

// ---------------------------------------------------------------------------

describe("WA10: Stop cancels a buffered run", () => {
  /** A buffered answer the test settles by hand; it rejects like a real fetch when the request is aborted. */
  const held = () => {
    const gate = deferred<Response>();
    const calls: RawCall[] = [];
    let aborted = 0;
    const handler = (call: RawCall, init: RequestInit) => {
      calls.push(call);
      init.signal?.addEventListener("abort", () => {
        aborted++;
        gate.reject(new DOMException("The operation was aborted.", "AbortError"));
      });
      return gate.promise;
    };
    return { gate, calls, handler, aborted: () => aborted };
  };

  it("sends the buffered request with an abort signal, in the shape the admin API expects", async () => {
    const h = held();
    await loaded({}, { [CHAT_URL]: h.handler });
    fireEvent.click(button("Send"));
    await waitFor(() => expect(h.calls).toHaveLength(1));
    expect([h.calls[0].signal, h.calls[0].credentials, h.calls[0].headers]).toEqual([true, "same-origin", { "content-type": "application/json" }]);
    await act(async () => { h.gate.resolve(jsonResponse({ ok: true, status: 200, latencyMs: 3 })); });
    await waitFor(() => expect(badges()[0]).toEqual(["200", ["badge-green"]]));
  });

  it("Stop aborts the request and reports the run as stopped", async () => {
    const h = held();
    await loaded({}, { [CHAT_URL]: h.handler });
    fireEvent.click(button("Send"));
    await waitFor(() => expect(h.calls).toHaveLength(1));
    fireEvent.click(button("Stop"));
    expect(h.aborted()).toBe(1);
    await waitFor(() => expect(resultCard()).not.toBeNull());
    expect([badges()[0], note()!.textContent]).toEqual([["error", ["badge-red"]], ABORTED]);
    expect([button("Send").disabled, hasButton("Stop")]).toEqual([false, false]);
  });

  it("an answer that arrives after Stop is not rendered", async () => {
    const gate = deferred<unknown>();
    // The admin-API mock ignores the abort signal, so its answer comes late.
    await loaded({ "POST /bench/chat": () => gate.promise });
    fireEvent.click(button("Send"));
    fireEvent.click(button("Stop"));
    await waitFor(() => expect(resultCard()).not.toBeNull());
    await act(async () => { gate.resolve({ ok: true, status: 200, latencyMs: 1, response: { late: true } }); });
    await act(async () => {});
    expect([badges()[0], note()!.textContent]).toEqual([["error", ["badge-red"]], ABORTED]);
    expect(resultCard()!.textContent).not.toContain("late");
  });

  it("a stopped run that fails late does not replace the next run's result or re-enable Send under it", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let n = 0;
    await loaded({ "POST /bench/chat": () => (n++ === 0 ? first.promise : second.promise) });
    fireEvent.click(button("Send"));
    fireEvent.click(button("Stop"));
    fireEvent.click(button("Send"));
    await waitFor(() => expect(hasButton("Running…")).toBe(true));
    await act(async () => { first.reject(new TypeError("late failure")); });
    await act(async () => {});
    // The second run is still in flight and still owns the page.
    expect([hasButton("Running…"), hasButton("Stop"), resultCard()]).toEqual([true, true, null]);
    await act(async () => { second.resolve({ ok: true, status: 200, latencyMs: 2 }); });
    await waitFor(() => expect(badges()[0]).toEqual(["200", ["badge-green"]]));
    expect(hasButton("Stop")).toBe(false);
  });

  it("Stop cancels a buffered media run as well", async () => {
    const h = held();
    await loaded({}, { "POST /admin/api/bench/media": h.handler });
    fireEvent.change(sel("Model Service"), { target: { value: "6" } });
    fireEvent.click(button("Send"));
    await waitFor(() => expect(h.calls).toHaveLength(1));
    fireEvent.click(button("Stop"));
    expect(h.aborted()).toBe(1);
    await waitFor(() => expect(note()!.textContent).toBe(ABORTED));
  });
});

// ---------------------------------------------------------------------------

describe("WA10: a target kind with no entries has no target", () => {
  const NO_AGENTS = { ...TARGETS, services: TARGETS.services.filter((s) => s.kind !== "micro_agent") };

  it("switching to it empties the picker, disables Send and sends nothing", async () => {
    const { api } = await loaded({ "GET /bench/targets": NO_AGENTS });
    await waitFor(() => expect(sel("Model Service").value).toBe("1"));
    expect(button("Send").disabled).toBe(false);
    fireEvent.click(button("Micro Agent"));
    expect(options(sel("Micro Agent"))).toEqual(["nothing of this kind is defined"]);
    expect(sel("Micro Agent").value).toBe("");
    expect(button("Send").disabled).toBe(true);
    fireEvent.click(button("Send"));
    await act(async () => {});
    expect(api.sent("POST", "/bench/chat")).toEqual([]);
  });

  it("switching back picks the first service of that kind again", async () => {
    await loaded({ "GET /bench/targets": NO_AGENTS });
    fireEvent.click(button("Micro Agent"));
    fireEvent.click(button("Model Service"));
    await waitFor(() => expect(sel("Model Service").value).toBe("1"));
    expect(button("Send").disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("WA10: a failed run is never badged green", () => {
  const streaming = async (frames: string[]) => {
    await loaded({}, { [CHAT_URL]: () => sseOf(frames) });
    fireEvent.click(toggle("Stream"));
    await send();
  };

  it("a stream that failed after its 200 keeps the status as the label, in red, with the message", async () => {
    await streaming([delta("par"), 'event: bench\ndata: {"ok":false,"status":200,"message":"upstream died mid-stream","latencyMs":9}']);
    expect(badges()[0]).toEqual(["200", ["badge-red"]]);
    expect(note()!.textContent).toBe("upstream died mid-stream");
  });

  it("a failed stream whose report carries no status of its own is red as well", async () => {
    await streaming([delta("par"), 'event: bench\ndata: {"ok":false,"message":"gave up"}']);
    expect(badges()[0]).toEqual(["200", ["badge-red"]]);
  });

  it("so is a buffered failure reported with status 200", async () => {
    await loaded({ "POST /bench/chat": { ok: false, status: 200, latencyMs: 1, message: "refused" } });
    await send();
    expect(badges()[0]).toEqual(["200", ["badge-red"]]);
  });

  it("a client-closed failure stays grey and a success stays green", async () => {
    await streaming([delta("x"), 'event: bench\ndata: {"ok":false,"status":499,"message":"gone"}']);
    expect(badges()[0]).toEqual(["499", ["badge-gray"]]);
    cleanup();
    await streaming([delta("x"), 'event: bench\ndata: {"ok":true,"status":200}']);
    expect(badges()[0]).toEqual(["200", ["badge-green"]]);
  });
});

// ---------------------------------------------------------------------------

describe("WA10: a bench trailer that is not an object is no report", () => {
  it.each([["null"], ["5"], ['"text"'], ["[1]"], ["true"]])("a trailer of %s is read like a missing one: the HTTP status, no message, the frames kept", async (json) => {
    await loaded({}, { [CHAT_URL]: () => sseOf([delta("pong"), `event: bench\ndata: ${json}`]) });
    fireEvent.click(toggle("Stream"));
    await send();
    expect(badges()[0]).toEqual(["200", ["badge-green"]]);
    expect(note()).toBeNull();
    expect(resultCard()!.textContent).toContain("pong");
  });
});
