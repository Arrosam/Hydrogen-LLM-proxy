/**
 * Independent verification (spec WEB-A, item WA10): the Model Bench page,
 * driven only through its rendered controls and a recording fetch. Expected
 * values come from the verification spec.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { button, hasButton, toastShown, toasts, toggle } from "./helpers";
import {
  TARGETS, block, bodyPanel, jsonResponse, liveSse, loaded, options, resultCard, sel, send, sendTo, sse, sseOf,
  type RawHandler,
} from "./modelbench-harness";

const doc = document as unknown as { execCommand?: unknown };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(window, "isSecureContext");
  delete doc.execCommand;
});

const COPIED = "Copied to clipboard";
const COPY_FAILED = "Copy failed - select the text and copy it manually";
const STOPPED = "Stopped before the answer arrived.";
const STREAM_URL = "POST /admin/api/bench/chat";
const BUFFERED_URL = "POST /admin/api/bench/chat";
const delta = (content: string) => `data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}`;
const badgeRow = () => resultCard()!.firstElementChild!;
const firstBadge = () => badgeRow().children[0];
const greenBadges = () => [...resultCard()!.querySelectorAll(".badge-green")];
const assembled = () => screen.getByText("Assembled text").nextElementSibling as HTMLElement;
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(100); });
const pageText = () => document.body.textContent ?? "";

// ---------------------------------------------------------------------------

describe("WA10a: copy buttons report whether the clipboard write worked", () => {
  type Mode = () => void;
  const setClipboard = (writeText: ((t: string) => Promise<void>) | undefined, secure: boolean) => {
    Object.defineProperty(navigator, "clipboard", { value: writeText ? { writeText } : undefined, configurable: true });
    Object.defineProperty(window, "isSecureContext", { value: secure, configurable: true });
  };
  const FAILING: Array<[string, Mode]> = [
    ["no async clipboard and execCommand reports false", () => { setClipboard(undefined, false); doc.execCommand = () => false; }],
    ["the async clipboard rejects and execCommand reports false", () => { setClipboard(async () => { throw new Error("denied"); }, true); doc.execCommand = () => false; }],
    ["the async clipboard rejects and execCommand throws", () => { setClipboard(async () => { throw new Error("denied"); }, true); doc.execCommand = () => { throw new Error("blocked"); }; }],
    ["no async clipboard and execCommand throws", () => { setClipboard(undefined, false); doc.execCommand = () => { throw new Error("blocked"); }; }],
  ];
  const WORKING: Array<[string, Mode]> = [
    ["the async clipboard resolves", () => { setClipboard(async () => {}, true); doc.execCommand = () => false; }],
    ["execCommand reports true", () => { setClipboard(undefined, false); doc.execCommand = () => true; }],
    ["the async clipboard rejects but execCommand reports true", () => { setClipboard(async () => { throw new Error("denied"); }, true); doc.execCommand = () => true; }],
  ];
  const bodyCopy = () => bodyPanel().querySelector("button i.bi-clipboard")!.closest("button")!;
  const blockCopy = (title: string) => block(title).querySelectorAll("button")[1];

  it.each(FAILING)("the request-body copy button toasts failure when %s", async (_name, mode) => {
    await loaded();
    mode();
    fireEvent.click(bodyCopy());
    await toastShown(COPY_FAILED);
    await settle();
    expect(toasts()).not.toContain(COPIED);
  });

  it.each(WORKING)("the request-body copy button toasts success when %s", async (_name, mode) => {
    await loaded();
    mode();
    fireEvent.click(bodyCopy());
    await toastShown(COPIED);
    await settle();
    expect(toasts()).not.toContain(COPY_FAILED);
  });

  it.each(FAILING)("a result block's copy button toasts failure when %s", async (_name, mode) => {
    await loaded({ "POST /bench/chat": { ok: true, status: 200, latencyMs: 1, response: { id: "r1" } } });
    await send();
    mode();
    fireEvent.click(blockCopy("Response"));
    await toastShown(COPY_FAILED);
    await settle();
    expect(toasts()).not.toContain(COPIED);
  });

  it.each(WORKING)("a result block's copy button toasts success when %s", async (_name, mode) => {
    await loaded({ "POST /bench/chat": { ok: true, status: 200, latencyMs: 1, response: { id: "r1" } } });
    await send();
    mode();
    fireEvent.click(blockCopy("Response"));
    await toastShown(COPIED);
    await settle();
    expect(toasts()).not.toContain(COPY_FAILED);
  });

  it("the raw-frames copy button of a streamed result toasts failure when the write fails", async () => {
    await loaded({}, { [STREAM_URL]: () => sseOf([delta("pong")]) });
    fireEvent.click(toggle("Stream"));
    await send();
    FAILING[0][1]();
    fireEvent.click(blockCopy("Raw SSE frames (1)"));
    await toastShown(COPY_FAILED);
    expect(toasts()).not.toContain(COPIED);
  });

  it("the async clipboard is offered exactly the text when it works", async () => {
    await loaded({ "POST /bench/chat": { ok: true, status: 200, latencyMs: 1, response: "plain answer" } });
    await send();
    const writeText = vi.fn(async (_text: string) => {});
    setClipboard(writeText, true);
    fireEvent.click(blockCopy("Response"));
    await toastShown(COPIED);
    expect(writeText.mock.calls).toEqual([["plain answer"]]);
  });
});

// ---------------------------------------------------------------------------

describe("WA10b: Stop during a buffered run", () => {
  const LATE = { ok: true, status: 200, latencyMs: 1, response: { id: "late-answer" } };
  /** A buffered answer the test releases by hand; records the request's abort signal. */
  const held = () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    let release!: (r: Response) => void;
    const pending = new Promise<Response>((res) => { release = res; });
    const handler: RawHandler = (_call, init) => { signals.push(init.signal); return pending; };
    return { handler, signals, release };
  };

  it("aborts the request", async () => {
    const h = held();
    const { rawCalls } = await loaded({}, { [BUFFERED_URL]: h.handler });
    fireEvent.click(button("Send"));
    await waitFor(() => expect(rawCalls).toHaveLength(1));
    expect(h.signals[0]?.aborted).toBe(false);
    fireEvent.click(button("Stop"));
    expect(h.signals[0]?.aborted).toBe(true);
    await act(async () => { h.release(jsonResponse(LATE)); });
  });

  it("shows the stopped state and gives the buttons back", async () => {
    const h = held();
    const { rawCalls } = await loaded({}, { [BUFFERED_URL]: h.handler });
    fireEvent.click(button("Send"));
    await waitFor(() => expect(rawCalls).toHaveLength(1));
    fireEvent.click(button("Stop"));
    await screen.findByText(STOPPED);
    expect([button("Send").disabled, hasButton("Stop"), hasButton("Running…")]).toEqual([false, false, false]);
    expect(greenBadges()).toEqual([]);
    await act(async () => { h.release(jsonResponse(LATE)); });
  });

  it("a response arriving after Stop is not rendered", async () => {
    const h = held();
    const { rawCalls } = await loaded({}, { [BUFFERED_URL]: h.handler });
    fireEvent.click(button("Send"));
    await waitFor(() => expect(rawCalls).toHaveLength(1));
    fireEvent.click(button("Stop"));
    await screen.findByText(STOPPED);
    await act(async () => { h.release(jsonResponse(LATE)); });
    await settle();
    expect(pageText()).not.toContain("late-answer");
    expect(screen.getByText(STOPPED)).toBeTruthy();
    expect(greenBadges()).toEqual([]);
    expect([button("Send").disabled, hasButton("Stop")]).toEqual([false, false]);
  });

  it("a fetch that rejects on abort, as a browser does, shows the stopped state and not a raw abort error", async () => {
    const handler: RawHandler = (_call, init) => new Promise<Response>((_res, rej) => {
      init.signal?.addEventListener("abort", () => rej(new DOMException("The operation was aborted.", "AbortError")));
    });
    const { rawCalls } = await loaded({}, { [BUFFERED_URL]: handler });
    fireEvent.click(button("Send"));
    await waitFor(() => expect(rawCalls).toHaveLength(1));
    fireEvent.click(button("Stop"));
    await screen.findByText(STOPPED);
    await settle();
    expect(screen.getByText(STOPPED)).toBeTruthy();
    expect(pageText()).not.toContain("The operation was aborted.");
    expect([button("Send").disabled, hasButton("Stop")]).toEqual([false, false]);
  });

  it("a new run after Stop shows its own answer, and the stopped run's late answer never replaces it", async () => {
    const h = held();
    let runs = 0;
    const handler: RawHandler = (call, init) =>
      (runs++ === 0 ? h.handler(call, init) : jsonResponse({ ok: true, status: 200, latencyMs: 1, response: { id: "second-answer" } }));
    const { rawCalls } = await loaded({}, { [BUFFERED_URL]: handler });
    fireEvent.click(button("Send"));
    await waitFor(() => expect(rawCalls).toHaveLength(1));
    fireEvent.click(button("Stop"));
    await screen.findByText(STOPPED);
    fireEvent.click(button("Send"));
    await waitFor(() => expect(pageText()).toContain("second-answer"));
    await act(async () => { h.release(jsonResponse(LATE)); });
    await settle();
    expect(pageText()).toContain("second-answer");
    expect(pageText()).not.toContain("late-answer");
    expect(screen.queryByText(STOPPED)).toBeNull();
  });

  it("without Stop the buffered answer is rendered (unchanged neighbour)", async () => {
    const h = held();
    const { rawCalls } = await loaded({}, { [BUFFERED_URL]: h.handler });
    fireEvent.click(button("Send"));
    await waitFor(() => expect(rawCalls).toHaveLength(1));
    await act(async () => { h.release(jsonResponse(LATE)); });
    await waitFor(() => expect(pageText()).toContain("late-answer"));
    expect(h.signals[0]?.aborted).toBe(false);
    expect(screen.queryByText(STOPPED)).toBeNull();
    expect(firstBadge().classList.contains("badge-green")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("WA10c: switching to a target kind that has no entries", () => {
  const ONLY_SERVICES = { services: TARGETS.services.filter((s) => s.kind !== "micro_agent"), mappings: [] };
  const ONLY_AGENTS = { services: TARGETS.services.filter((s) => s.kind === "micro_agent"), mappings: TARGETS.mappings };
  const NAMES = TARGETS.services.map((s) => s.name);
  const expectEmptyPicker = (label: string) => {
    const picker = sel(label);
    expect(picker.value).toBe("");
    for (const text of options(picker)) for (const name of NAMES) expect(text).not.toContain(name);
  };

  it("Model Service -> Micro Agent with no agents: the picker is empty and Send is disabled", async () => {
    const { api } = await loaded({ "GET /bench/targets": ONLY_SERVICES });
    expect([sel("Model Service").value, button("Send").disabled]).toEqual(["1", false]);
    fireEvent.click(button("Micro Agent"));
    await settle();
    expectEmptyPicker("Micro Agent");
    expect(button("Send").disabled).toBe(true);
    fireEvent.click(button("Send"));
    await settle();
    expect(api.mutations()).toEqual([]);
  });

  it("Micro Agent -> Model Service with no services: the picker is empty and Send is disabled", async () => {
    const { api } = await loaded({ "GET /bench/targets": ONLY_AGENTS });
    fireEvent.click(button("Micro Agent"));
    await waitFor(() => expect(sel("Micro Agent").value).toBe("3"));
    expect(button("Send").disabled).toBe(false);
    fireEvent.click(button("Model Service"));
    await settle();
    expectEmptyPicker("Model Service");
    expect(button("Send").disabled).toBe(true);
    fireEvent.click(button("Send"));
    await settle();
    expect(api.mutations()).toEqual([]);
  });

  it("Model Service -> Raw model with no mappings: nothing to pick and Send is disabled", async () => {
    const { api } = await loaded({ "GET /bench/targets": ONLY_SERVICES });
    fireEvent.click(button("Raw model"));
    await settle();
    expect(sel("Model").value).toBe("");
    expect(button("Send").disabled).toBe(true);
    fireEvent.click(button("Send"));
    await settle();
    expect(api.mutations()).toEqual([]);
  });

  it("switching back to a kind that has entries selects one and can send again", async () => {
    const { api } = await loaded({ "GET /bench/targets": ONLY_SERVICES });
    fireEvent.click(button("Micro Agent"));
    await settle();
    expect(button("Send").disabled).toBe(true);
    fireEvent.click(button("Model Service"));
    await waitFor(() => expect(button("Send").disabled).toBe(false));
    expect(sel("Model Service").value).toBe("1");
    const call = await sendTo(api);
    expect((call.body as { target: unknown }).target).toEqual({ kind: "service", serviceId: 1 });
  });

  it("switching between two kinds that both have entries keeps Send enabled (unchanged neighbour)", async () => {
    const { api } = await loaded();
    fireEvent.click(button("Micro Agent"));
    await waitFor(() => expect(sel("Micro Agent").value).toBe("3"));
    expect(button("Send").disabled).toBe(false);
    const call = await sendTo(api);
    expect((call.body as { target: unknown }).target).toEqual({ kind: "service", serviceId: 3 });
  });
});

// ---------------------------------------------------------------------------

describe("WA10d: a streamed run that failed although HTTP was 200 is not badged green", () => {
  const streaming = async (handler: RawHandler) => {
    const r = await loaded({}, { [STREAM_URL]: handler });
    fireEvent.click(toggle("Stream"));
    return r;
  };
  const bench = (meta: unknown) => `event: bench\ndata: ${JSON.stringify(meta)}`;

  it.each([
    ["ok:false with status 200", { ok: false, status: 200, message: "upstream died", latencyMs: 9 }],
    ["ok:false with no status", { ok: false, message: "upstream died", latencyMs: 9 }],
    ["ok:false with status 0", { ok: false, status: 0, message: "upstream died", latencyMs: 9 }],
    ["ok:false with no status and no message", { ok: false, latencyMs: 9 }],
  ])("bench frame %s", async (_name, meta) => {
    await streaming(() => sseOf([delta("par"), bench(meta)]));
    await send();
    expect(firstBadge().classList.contains("badge-green")).toBe(false);
    expect(greenBadges()).toEqual([]);
  });

  it("a failing bench frame with a message still shows the message", async () => {
    await streaming(() => sseOf([delta("par"), bench({ ok: false, status: 200, message: "upstream died", latencyMs: 9 })]));
    await send();
    expect(resultCard()!.textContent).toContain("upstream died");
    expect(greenBadges()).toEqual([]);
  });

  it("a stream that breaks in the middle after a 200 answer", async () => {
    const enc = new TextEncoder();
    await streaming(() => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode(`${delta("par")}\n\n`)); },
      pull(c) { c.error(new TypeError("network lost")); },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    await send();
    expect(firstBadge().classList.contains("badge-green")).toBe(false);
    expect(greenBadges()).toEqual([]);
  });

  it("a stream that succeeded is still badged green 200 (unchanged neighbour)", async () => {
    await streaming(() => sseOf([delta("pong"), bench({ ok: true, status: 200, latencyMs: 9 })]));
    await send();
    expect([firstBadge().textContent, firstBadge().classList.contains("badge-green")]).toEqual(["200", true]);
    expect(assembled().textContent).toBe("pong");
  });

  it("a stream refused with a real HTTP error is not green either (unchanged neighbour)", async () => {
    await streaming(() => jsonResponse({ error: "bad target" }, 400));
    await send();
    expect(firstBadge().classList.contains("badge-green")).toBe(false);
    expect(greenBadges()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("WA10e: a final bench frame whose JSON is null does not crash the page", () => {
  const streaming = async (handler: RawHandler) => {
    const r = await loaded({}, { [STREAM_URL]: handler });
    fireEvent.click(toggle("Stream"));
    return r;
  };

  it("after text frames, delivered in one piece", async () => {
    const { container } = await streaming(() => sseOf([delta("pong"), "event: bench\ndata: null"]));
    await send();
    expect(container.querySelector("h1")!.textContent).toBe("Model Bench");
    expect(assembled().textContent).toBe("pong");
    expect(button("Send").disabled).toBe(false);
  });

  it("as the only frame", async () => {
    const { container } = await streaming(() => sseOf(["event: bench\ndata: null"]));
    await send();
    expect(container.querySelector("h1")!.textContent).toBe("Model Bench");
    expect(resultCard()).not.toBeNull();
    expect(button("Send").disabled).toBe(false);
  });

  it("without a trailing blank line", async () => {
    const { container } = await streaming(() => sse([`${delta("pong")}\n\nevent: bench\ndata: null`]));
    await send();
    expect(container.querySelector("h1")!.textContent).toBe("Model Bench");
    expect(assembled().textContent).toBe("pong");
  });

  it("arriving while the stream is shown live", async () => {
    const live = liveSse();
    const { container } = await streaming(live.handler);
    fireEvent.click(button("Send"));
    await act(async () => { live.push(`${delta("pong")}\n\n`); });
    await screen.findByText("Streaming…");
    await act(async () => { live.push("event: bench\ndata: null\n\n"); });
    await act(async () => { live.close(); });
    await waitFor(() => expect(resultCard()).not.toBeNull());
    expect(container.querySelector("h1")!.textContent).toBe("Model Bench");
    expect(assembled().textContent).toBe("pong");
  });

  it("the page can run again afterwards", async () => {
    let runs = 0;
    await streaming(() => (runs++ === 0 ? sseOf([delta("one"), "event: bench\ndata: null"]) : sseOf([delta("two")])));
    await send();
    expect(assembled().textContent).toBe("one");
    await send();
    await waitFor(() => expect(assembled().textContent).toBe("two"));
  });

  it("a well-formed bench frame is still read (unchanged neighbour)", async () => {
    await streaming(() => sseOf([delta("pong"), 'event: bench\ndata: {"ok":true,"status":200,"latencyMs":42}']));
    await send();
    expect([...badgeRow().children].map((b) => b.textContent).slice(0, 2)).toEqual(["200", "42 ms"]);
  });
});
