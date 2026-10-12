/**
 * Characterization of the Model Bench page, part two: a run in flight and
 * stopping it, and everything the result side shows - status and timing
 * badges, errors, assembled stream text per wire dialect, the collapsible JSON
 * blocks, media previews - plus what each copy button copies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { formatNumber } from "../src/lib/format";
import { button, classes, cls, deferred, fail, field, hasButton, toastShown, toggle, type } from "./helpers";
import {
  SERVED, USER_TEXT, XS,
  block, blockTitles, bodyPanel, errorNote, jsonResponse, liveSse, loaded, pick, pretty, resultCard, send, spinner, sse, sseOf, viaProxy,
  type RawRoutes,
} from "./modelbench-harness";

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

const IDLE = "Pick a target and send a request. Nothing is sent until you press Send.";
const PRE = "overflow-auto whitespace-pre-wrap break-words rounded-lg border border-ink-800 bg-ink-950 p-3 font-mono text-xs";
const JSON_PRE = `mt-1 max-h-96 ${PRE} leading-relaxed text-ink-300`;
const SENT_CHAT = "Sent by the bench → /admin/api/bench/chat";
const STREAM_URL = "POST /admin/api/bench/chat";
const NO_TEXT = "(the stream carried no text — check the raw frames)";
const delta = (content: string) => `data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}`;
const badges = () => [...resultCard()!.firstElementChild!.children].map((b) => [b.textContent, classes(b)]);
const note = () => resultCard()!.querySelector(".border-red-900\\/50");
const preOf = (title: string) => block(title).querySelector("pre");
const assembled = () => screen.getByText("Assembled text").nextElementSibling as HTMLElement;
/** Mount with Stream on and the streamed admin route answered by `handler`. */
const streaming = async (handler: RawRoutes[string]) => {
  const r = await loaded({}, { [STREAM_URL]: handler });
  fireEvent.click(toggle("Stream"));
  return r;
};
/** Time as the page sees it: frozen, and moved on only by the test. */
const clock = () => {
  const state = { now: 1_700_000_000_000 };
  vi.spyOn(Date, "now").mockImplementation(() => state.now);
  return state;
};
/** jsdom has no clipboard: route copies through the legacy path and record what was offered to it. */
const stubCopy = () => {
  const copied: string[] = [];
  (document as unknown as { execCommand: unknown }).execCommand = vi.fn(() => {
    copied.push(document.querySelector<HTMLTextAreaElement>("textarea[readonly]")!.value);
    return true;
  });
  return copied;
};

// ---------------------------------------------------------------------------

describe("ModelBench page: a run in flight", () => {
  it("swaps Send for a disabled spinner, offers Stop, and clears the result side", async () => {
    const gate = deferred<unknown>();
    let runs = 0;
    const { api } = await loaded({ "POST /bench/chat": () => (runs++ === 0 ? { ok: true, status: 200, latencyMs: 1 } : gate.promise) });
    await send();
    fireEvent.click(button("Send"));
    const busy = button("Running…");
    expect([busy.disabled, classes(busy)]).toEqual([true, ["btn-primary"]]);
    expect(classes(busy.querySelector("i"))).toEqual(cls("bi bi-arrow-repeat animate-spin"));
    const stop = button("Stop");
    expect(classes(stop)).toEqual(["btn-ghost"]);
    expect(classes(stop.querySelector("i"))).toEqual(cls("bi bi-stop-circle"));
    expect([...busy.parentElement!.children]).toEqual([stop, busy]);
    expect(hasButton("Send")).toBe(false);
    // Neither the previous result nor the idle note; a buffered run shows nothing until it ends.
    expect(resultCard()).toBeNull();
    expect(screen.queryByText(IDLE)).toBeNull();
    expect(screen.queryByText("Streaming…")).toBeNull();
    fireEvent.click(busy);
    await act(async () => { gate.resolve({ ok: true, status: 200, latencyMs: 2 }); });
    await waitFor(() => expect(resultCard()).not.toBeNull());
    expect(api.sent("POST", "/bench/chat")).toHaveLength(2);
    expect([button("Send").disabled, hasButton("Stop"), spinner()]).toEqual([false, false, null]);
  });

  it("Stop on a buffered run gives the buttons back at once", async () => {
    const gate = deferred<unknown>();
    await loaded({ "POST /bench/chat": () => gate.promise });
    fireEvent.click(button("Send"));
    fireEvent.click(button("Stop"));
    expect([button("Send").disabled, hasButton("Stop")]).toEqual([false, false]);
    await act(async () => { gate.resolve({ ok: true, status: 200 }); });
  });

  it("shows the text so far while a stream is arriving, and Stop aborts it", async () => {
    const live = liveSse();
    const { rawCalls } = await streaming(live.handler);
    fireEvent.click(button("Send"));
    await waitFor(() => expect(rawCalls).toHaveLength(1));
    // Nothing on the result side before the first frame.
    expect(screen.queryByText("Streaming…")).toBeNull();
    await act(async () => { live.push('event: message_start\ndata: {"type":"message_start","message":{}}\n\n'); });
    const heading = await screen.findByText("Streaming…");
    expect([heading.tagName, classes(heading)]).toEqual(["H3", ["label"]]);
    expect(classes(heading.parentElement)).toEqual(cls("card card-pad"));
    const pre = heading.nextElementSibling!;
    expect(classes(pre)).toEqual(cls(`max-h-64 ${PRE} text-ink-300`));
    expect(pre.textContent).toBe("waiting for the first token…");
    await act(async () => { live.push(`${delta("Hel")}\n\n${delta("lo")}\n\n`); });
    await waitFor(() => expect(pre.textContent).toBe("Hello"));
    // The server's trailing bench frame is not part of the live text's frames.
    await act(async () => { live.push('event: bench\ndata: {"choices":[{"delta":{"content":"META"}}]}\n\n'); });
    expect(pre.textContent).toBe("Hello");
    expect([hasButton("Running…"), resultCard()]).toEqual([true, null]);

    fireEvent.click(button("Stop"));
    await waitFor(() => expect(resultCard()).not.toBeNull());
    expect(screen.queryByText("Streaming…")).toBeNull();
    expect(badges()[0]).toEqual(["error", ["badge-red"]]);
    expect(note()!.textContent).toBe("Stopped before the answer arrived.");
    expect(blockTitles()).toEqual([]);
    expect([button("Send").disabled, hasButton("Stop")]).toEqual([false, false]);
  });

  it("a stream that ends normally replaces the live text with the result", async () => {
    const live = liveSse();
    await streaming(live.handler);
    fireEvent.click(button("Send"));
    await act(async () => { live.push(`${delta("pong")}\n\n`); });
    await screen.findByText("Streaming…");
    await act(async () => { live.close(); });
    await waitFor(() => expect(resultCard()).not.toBeNull());
    expect(screen.queryByText("Streaming…")).toBeNull();
    expect(assembled().textContent).toBe("pong");
  });
});

// ---------------------------------------------------------------------------

describe("ModelBench page: buffered internal results", () => {
  const FULL = {
    ok: true, status: 200, latencyMs: 1234, served: SERVED, upstreamRequest: { model: "claude-sonnet", max_tokens: 1 },
    response: { id: "r1", choices: [] }, usage: { prompt_tokens: 3 }, attemptPath: [{ step: 0, ok: true }],
  };

  it("shows status, latency and who served it as badges, then each part as a JSON block", async () => {
    await loaded({ "POST /bench/chat": FULL });
    const card = await send();
    expect(classes(card)).toEqual(cls("card card-pad space-y-4"));
    expect(screen.queryByText(IDLE)).toBeNull();
    expect(classes(card.firstElementChild)).toEqual(cls("flex flex-wrap items-center gap-2"));
    expect(badges()).toEqual([
      ["200", ["badge-green"]], [`${formatNumber(1234)} ms`, ["badge-gray"]],
      ["sonnet @ anthropic-main", ["badge-blue"]], ["anthropic", ["badge-gray"]], ["claude-sonnet", cls("badge-gray font-mono")],
    ]);
    expect([...card.firstElementChild!.querySelectorAll("i")].map((i) => classes(i))).toEqual([cls("bi bi-stopwatch"), cls("bi bi-box")]);
    expect(note()).toBeNull();
    expect(blockTitles()).toEqual(["Usage", "Response", "Body sent upstream", "Attempt path", SENT_CHAT]);
    expect([...card.children].slice(1)).toEqual(blockTitles().map((title) => block(title)));
    expect(preOf("Usage")!.textContent).toBe(pretty(FULL.usage));
    expect(preOf("Response")!.textContent).toBe(pretty(FULL.response));
    expect(preOf("Body sent upstream")!.textContent).toBe(pretty(FULL.upstreamRequest));
    expect(preOf("Attempt path")!.textContent).toBe(pretty(FULL.attemptPath));
    expect(preOf(SENT_CHAT)!.textContent).toBe(pretty({ model: "chat-svc", messages: USER_TEXT() }));
  });

  it("a JSON block is a heading that collapses it, a copy button and a scrolling pre; a new run opens it again", async () => {
    await loaded({ "POST /bench/chat": FULL });
    await send();
    const b = block("Response");
    expect(b.className).toBe("");
    expect(classes(b.firstElementChild)).toEqual(cls("flex items-center justify-between"));
    const [heading, copy] = [...b.querySelectorAll("button")];
    expect([classes(heading), heading.type]).toEqual([cls("flex items-center gap-1.5 text-left"), "button"]);
    expect(classes(heading.querySelector("i"))).toEqual(cls("bi bi-chevron-down text-ink-500"));
    expect([heading.querySelector("h4")!.textContent, classes(heading.querySelector("h4"))]).toEqual(["Response", cls("label m-0 cursor-pointer select-none")]);
    expect([classes(copy), copy.type, copy.textContent]).toEqual([cls(XS), "button", ""]);
    expect(classes(copy.querySelector("i"))).toEqual(cls("bi bi-clipboard"));
    expect(classes(b.querySelector("pre"))).toEqual(cls(JSON_PRE));

    fireEvent.click(heading);
    expect(preOf("Response")).toBeNull();
    expect(classes(heading.querySelector("i"))).toEqual(cls("bi bi-chevron-right text-ink-500"));
    expect(preOf("Usage")).not.toBeNull();
    fireEvent.click(heading);
    expect(preOf("Response")!.textContent).toBe(pretty(FULL.response));
    fireEvent.click(heading);
    await send();
    expect(preOf("Response")).not.toBeNull();
  });

  it.each([
    [{ ok: true, status: 200 }, "200", "badge-green", null],
    [{ ok: true, status: 201, message: "not shown" }, "201", "badge-green", null],
    // A success without a status reads as 200.
    [{ ok: true, status: 0 }, "200", "badge-green", null],
    [{ ok: true }, "200", "badge-green", null],
    [{ ok: false, status: 502, message: "upstream exploded" }, "502", "badge-red", "upstream exploded"],
    [{ ok: false, status: 404 }, "404", "badge-red", null],
    [{ ok: false, status: 499, message: "client went away" }, "499", "badge-gray", "client went away"],
    // A failure without a status reads as "error".
    [{ ok: false, status: 0, message: "no route" }, "error", "badge-red", "no route"],
    [{ status: 500, message: "no ok flag" }, "500", "badge-red", "no ok flag"],
    // Only a literal true is a success, a numeric string is a status, and only a string is a message.
    [{ ok: "yes", status: "503", message: 5 }, "503", "badge-red", null],
  ])("an answer of %j is badged %j in %s with the message %j", async (answer, label, colour, message) => {
    await loaded({ "POST /bench/chat": { latencyMs: 7, ...answer } });
    const card = await send();
    expect(badges()).toEqual([[label, [colour]], ["7 ms", ["badge-gray"]]]);
    expect(note()?.textContent ?? null).toBe(message);
    if (message) {
      expect(note()).toBe(card.children[1]);
      expect(classes(note())).toEqual(cls("flex items-center gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300"));
      expect(classes(note()!.querySelector("i"))).toEqual(cls("bi bi-exclamation-octagon-fill"));
    }
    expect(blockTitles()).toEqual([SENT_CHAT]);
  });

  it.each([
    [{ a: [1, { b: null }] }, pretty({ a: [1, { b: null }] })],
    [[], "[]"],
    [0, "0"],
    [false, "false"],
    // A string that is JSON is re-indented; any other string is shown as it is, even an empty one.
    ['{"a":1,"b":[2]}', pretty({ a: 1, b: [2] })],
    ["plain text\n  kept", "plain text\n  kept"],
    ["", ""],
  ])("a response of %j is shown as %j", async (response, text) => {
    await loaded({ "POST /bench/chat": { ok: true, status: 200, latencyMs: 1, response } });
    await send();
    expect(blockTitles()).toEqual(["Response", SENT_CHAT]);
    expect(preOf("Response")!.textContent).toBe(text);
  });

  it("parts that are null or absent get no block", async () => {
    await loaded({ "POST /bench/chat": { ok: true, status: 200, latencyMs: 1, response: null, usage: null, upstreamRequest: null, attemptPath: null } });
    await send();
    expect(blockTitles()).toEqual([SENT_CHAT]);
  });

  it("falls back to its own stopwatch when the answer carries no latency", async () => {
    const time = clock();
    await loaded({ "POST /bench/chat": () => { time.now += 1234; return { ok: true, status: 200 }; } });
    await send();
    expect(badges()[1]).toEqual([`${formatNumber(1234)} ms`, ["badge-gray"]]);
  });

  it.each([
    ["the server's message", fail(500, { error: "boom" }), "boom"],
    ["a generic message for a non-JSON error body", fail(502, "bad gateway"), "Request failed (502)"],
    ["the error's own message for a network failure", () => { throw new TypeError("offline"); }, "offline"],
  ])("a request that fails outright shows 'error' with %s and nothing else", async (_name, handler, message) => {
    await loaded({ "POST /bench/chat": handler });
    await send();
    expect(badges()[0]).toEqual(["error", ["badge-red"]]);
    expect(badges()).toHaveLength(2);
    expect(note()!.textContent).toBe(message);
    expect(blockTitles()).toEqual([]);
    expect(errorNote()).toBe(note());
    expect(button("Send").disabled).toBe(false);
  });

  it("media answers use the same panel, without usage or an attempt path, and say where they were sent", async () => {
    await loaded({ "POST /bench/media": { ...FULL, response: { data: [{ embedding: [0.1] }] } } });
    pick(6);
    await send();
    expect(badges().map((b) => b[0])).toEqual(["200", `${formatNumber(1234)} ms`, "sonnet @ anthropic-main", "anthropic", "claude-sonnet"]);
    expect(blockTitles()).toEqual(["Response", "Body sent upstream", "Sent by the bench → /admin/api/bench/media"]);
  });
});

// ---------------------------------------------------------------------------

describe("ModelBench page: streamed results", () => {
  it.each([
    ["Chat Completions", [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      'data: {"choices":[{"delta":{"content":"Hel"}},{"delta":{"content":"lo"}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
      "data: [DONE]",
    ], "Hello", { prompt_tokens: 3, completion_tokens: 2 }],
    // The input side arrives on message_start and the output side on message_delta; they are merged.
    ["Anthropic", [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7,"cache_read_input_tokens":1,"output_tokens":0}}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
    ], "Hi there", { input_tokens: 7, cache_read_input_tokens: 1, output_tokens: 5 }],
    ["Responses", [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Yo"}',
      'data:{"type":"response.output_text.delta","delta":"!"}',
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2}}}',
    ], "Yo!", { input_tokens: 4, output_tokens: 2 }],
    ["several data lines in one frame", [`${delta("a")}\n${delta("b")}`, `: comment\n${delta("c")}`], "abc", undefined],
    ["frames with nothing readable", [
      ": keep-alive", "data: not json", "data: [DONE]", "data:", 'data: {"type":"content_block_delta","delta":{"text":5}}', 'data: {"type":"response.output_text.delta","delta":{}}',
    ], NO_TEXT, undefined],
  ] as Array<[string, string[], string, unknown]>)("assembles the text and digs out the usage of %s", async (_name, frames, text, usage) => {
    await streaming(() => sseOf(frames));
    await send();
    expect(assembled().textContent).toBe(text);
    const titles = [`Raw SSE frames (${frames.length})`, ...(usage ? ["Usage"] : []), SENT_CHAT];
    expect(blockTitles()).toEqual(["Assembled text", ...titles]);
    expect(preOf(titles[0])!.textContent).toBe(pretty(frames));
    if (usage) expect(preOf("Usage")!.textContent).toBe(pretty(usage));
  });

  it("lays the stream out as assembled text above the collapsible raw frames", async () => {
    await streaming(() => sseOf([delta("pong")]));
    const card = await send();
    const heading = screen.getByText("Assembled text");
    expect([heading.tagName, classes(heading)]).toEqual(["H4", ["label"]]);
    expect(classes(assembled())).toEqual(cls(`max-h-64 ${PRE} text-ink-200`));
    expect([...card.children].slice(1)).toEqual([heading.parentElement, block("Raw SSE frames (1)"), block(SENT_CHAT)]);
    expect(classes(preOf("Raw SSE frames (1)"))).toEqual(cls(JSON_PRE));
    expect(preOf(SENT_CHAT)!.textContent).toBe(pretty({ model: "chat-svc", messages: USER_TEXT(), stream: true }));
  });

  it("splits frames on blank lines of either line ending, across chunk and character boundaries, with or without a final blank line", async () => {
    const bytes = new TextEncoder().encode(`${delta("é")}\r\n\r\n${delta("b")}\n\n\n\n${delta("c")}`);
    const cut = bytes.indexOf(0xc3) + 1;
    await streaming(() => sse([bytes.slice(0, cut), bytes.slice(cut, cut + 20), bytes.slice(cut + 20)]));
    await send();
    expect(assembled().textContent).toBe("ébc");
    expect(preOf("Raw SSE frames (3)")!.textContent).toBe(pretty([delta("é"), delta("b"), delta("c")]));
  });

  it("an empty stream has no frames and no text", async () => {
    await streaming(() => sse([]));
    await send();
    expect(assembled().textContent).toBe(NO_TEXT);
    expect(preOf("Raw SSE frames (0)")!.textContent).toBe("[]");
  });

  it("takes status, timing, who served it and the server-side views from the trailing bench frame, which is not a raw frame", async () => {
    const meta = { ok: true, status: 200, latencyMs: 42, served: SERVED, upstreamRequest: { x: 1 }, usage: { total: 9 }, attemptPath: ["a"] };
    await streaming(() => sseOf([delta("pong"), 'data: {"choices":[],"usage":{"from":"frames"}}', `event: bench\ndata: ${JSON.stringify(meta)}`]));
    await send();
    expect(badges().map((b) => b[0])).toEqual(["200", "42 ms", "sonnet @ anthropic-main", "anthropic", "claude-sonnet"]);
    expect(badges()[0][1]).toEqual(["badge-green"]);
    expect(blockTitles()).toEqual(["Assembled text", "Raw SSE frames (2)", "Usage", "Body sent upstream", "Attempt path", SENT_CHAT]);
    // The bench frame's usage wins over the one in the frames.
    expect(preOf("Usage")!.textContent).toBe(pretty({ total: 9 }));
    expect(preOf("Body sent upstream")!.textContent).toBe(pretty({ x: 1 }));
    expect(preOf("Attempt path")!.textContent).toBe(pretty(["a"]));
    expect(assembled().textContent).toBe("pong");
  });

  it("a failed stream keeps what arrived and shows the bench frame's status and message", async () => {
    await streaming(() => sseOf([delta("par"), 'event: bench\ndata: {"ok":false,"status":502,"message":"upstream died","latencyMs":9}']));
    await send();
    expect(badges()).toEqual([["502", ["badge-red"]], ["9 ms", ["badge-gray"]]]);
    expect(note()!.textContent).toBe("upstream died");
    expect(assembled().textContent).toBe("par");
    expect(blockTitles()).toEqual(["Assembled text", "Raw SSE frames (1)", SENT_CHAT]);
  });

  it.each([
    ["no bench frame", [delta("pong")]],
    ["an unreadable bench frame", [delta("pong"), "event: bench\ndata: {oops"]],
  ])("with %s it reports the HTTP status, its own stopwatch and no message", async (_name, frames) => {
    const time = clock();
    await streaming(() => { time.now += 77; return sseOf(frames); });
    await send();
    expect(badges()).toEqual([["200", ["badge-green"]], ["77 ms", ["badge-gray"]]]);
    expect(note()).toBeNull();
    expect(blockTitles()).toEqual(["Assembled text", "Raw SSE frames (1)", SENT_CHAT]);
  });

  it.each([
    ["a JSON error", { error: "bad target" }, "bad target", pretty({ error: "bad target" })],
    ["plain text", "nope", "nope", "nope"],
    ["nothing readable", {}, "HTTP 400", "{}"],
  ])("an answer that is not a stream (%s) is a failure with the HTTP status; only the response is shown", async (_name, body, message, shown) => {
    const time = clock();
    await streaming(() => { time.now += 5; return jsonResponse(body, 400); });
    await send();
    expect(badges()).toEqual([["400", ["badge-red"]], ["5 ms", ["badge-gray"]]]);
    expect(note()!.textContent).toBe(message);
    expect(blockTitles()).toEqual(["Response"]);
    expect(preOf("Response")!.textContent).toBe(shown);
  });

  it("a streamed request that cannot be made shows 'error' with the failure's message", async () => {
    await streaming(() => { throw new TypeError("Failed to fetch"); });
    await send();
    expect(badges()[0]).toEqual(["error", ["badge-red"]]);
    expect(note()!.textContent).toBe("Failed to fetch");
    expect(blockTitles()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("ModelBench page: proxy results", () => {
  const CHAT = "/v1/chat/completions";
  const SENT = `Sent by the bench → ${CHAT}`;
  const proxied = async (handler: RawRoutes[string], url = CHAT) => {
    const r = await loaded({}, { [`POST ${url}`]: handler });
    viaProxy();
    return r;
  };

  it("shows the client's answer with its usage, timed by the bench, and no server-side views", async () => {
    const time = clock();
    const answer = { id: "r", choices: [{ message: { content: "pong" } }], usage: { total_tokens: 5 } };
    await proxied(() => { time.now += 1234; return jsonResponse(answer); });
    await send();
    expect(badges()).toEqual([["200", ["badge-green"]], [`${formatNumber(1234)} ms`, ["badge-gray"]]]);
    expect(note()).toBeNull();
    expect(blockTitles()).toEqual(["Usage", "Response", SENT]);
    expect(preOf("Usage")!.textContent).toBe(pretty(answer.usage));
    expect(preOf("Response")!.textContent).toBe(pretty(answer));
    expect(preOf(SENT)!.textContent).toBe(pretty({ model: "chat-svc", messages: USER_TEXT() }));
  });

  it.each([
    ["JSON without usage", { id: "r" }, ["Response", SENT], pretty({ id: "r" })],
    ["text", "pong", ["Response", SENT], "pong"],
    ["an empty body", "", [SENT], null],
  ])("a 200 answer of %s is shown as it came", async (_name, body, titles, shown) => {
    await proxied(() => jsonResponse(body));
    await send();
    expect(badges()[0]).toEqual(["200", ["badge-green"]]);
    expect(note()).toBeNull();
    expect(blockTitles()).toEqual(titles);
    if (shown !== null) expect(preOf("Response")!.textContent).toBe(shown);
  });

  it.each([
    [401, { error: { message: "bad key" } }, "bad key"],
    [400, { error: "plain error" }, "plain error"],
    [429, { message: "slow down" }, "slow down"],
    [499, { error: "client closed" }, "client closed"],
    // No recognisable message: the status stands in.
    [500, {}, "HTTP 500"],
    [500, { error: { code: 1 } }, "HTTP 500"],
    [500, [1], "HTTP 500"],
    [503, "", "HTTP 503"],
    // A text body is the message, cut to 500 characters.
    [502, "gateway down", "gateway down"],
    [502, "x".repeat(501), "x".repeat(500)],
  ])("an HTTP %d answer of %j is an error reading %j", async (status, body, message) => {
    await proxied(() => jsonResponse(body, status));
    await send();
    expect(badges()[0]).toEqual([String(status), [status === 499 ? "badge-gray" : "badge-red"]]);
    expect(note()!.textContent).toBe(message);
    expect(blockTitles()).toEqual(body === "" ? [SENT] : ["Response", SENT]);
    if (body !== "") expect(preOf("Response")!.textContent).toBe(typeof body === "string" ? body : pretty(body));
  });

  it("a request the browser cannot make shows 'error' with the failure's message", async () => {
    await proxied(() => { throw new TypeError("Failed to fetch"); });
    await send();
    expect(badges()[0]).toEqual(["error", ["badge-red"]]);
    expect(note()!.textContent).toBe("Failed to fetch");
    expect(blockTitles()).toEqual([]);
  });

  it("a streamed answer is shown live in full and then as text, frames and the usage found in them", async () => {
    const live = liveSse();
    await proxied(live.handler);
    fireEvent.click(toggle("Stream"));
    fireEvent.click(button("Send"));
    await act(async () => { live.push(`${delta("po")}\n\n`); });
    await waitFor(() => expect(screen.getByText("Streaming…").nextElementSibling!.textContent).toBe("po"));
    await act(async () => {
      live.push(`${delta("ng")}\n\ndata: {"choices":[],"usage":{"total_tokens":5}}\n\ndata: [DONE]\n\n`);
      live.close();
    });
    await waitFor(() => expect(resultCard()).not.toBeNull());
    expect(badges()[0]).toEqual(["200", ["badge-green"]]);
    expect(assembled().textContent).toBe("pong");
    expect(blockTitles()).toEqual(["Assembled text", "Raw SSE frames (4)", "Usage", SENT]);
    expect(preOf("Usage")!.textContent).toBe(pretty({ total_tokens: 5 }));
    expect(preOf(SENT)!.textContent).toBe(pretty({ model: "chat-svc", messages: USER_TEXT(), stream: true }));
  });

  it.each([
    ["audio/mpeg", "AUDIO", "bench-output.mpeg"],
    ["audio/wav; codecs=1", "AUDIO", "bench-output.wav"],
    ["video/mp4", "VIDEO", "bench-output.mp4"],
    ["application/octet-stream", "AUDIO", "bench-output.octet-stream"],
  ])("a %s answer becomes a playable, downloadable preview", async (contentType, tag, name) => {
    const { container } = await proxied(() => new Response(new Uint8Array([255, 0, 128]), { headers: { "content-type": contentType } }), "/v1/audio/speech");
    pick(9);
    const card = await send();
    const src = `data:${contentType};base64,/wCA`;
    expect(blockTitles()).toEqual(["Preview", "Sent by the bench → /v1/audio/speech"]);
    const heading = screen.getByText("Preview");
    expect([heading.tagName, classes(heading)]).toEqual(["H4", ["label"]]);
    expect(heading.parentElement).toBe(card.children[1]);
    const list = heading.nextElementSibling!;
    expect(classes(list)).toEqual(cls("flex flex-wrap gap-3"));
    expect(list.children).toHaveLength(1);
    expect(classes(list.firstElementChild)).toEqual(["space-y-1"]);
    const player = list.firstElementChild!.firstElementChild as HTMLMediaElement;
    expect([player.tagName, player.getAttribute("src"), player.controls]).toEqual([tag, src, true]);
    expect(classes(player)).toEqual(cls(tag === "AUDIO" ? "w-72" : "max-h-64 rounded-lg border border-ink-800"));
    const link = container.querySelector("a")!;
    expect([link.textContent, link.getAttribute("href"), link.getAttribute("download"), classes(link)]).toEqual(["Download", src, name, cls(XS)]);
    expect(classes(link.querySelector("i"))).toEqual(cls("bi bi-download"));
  });
});

// ---------------------------------------------------------------------------

describe("ModelBench page: media previews and copying", () => {
  it("previews generated images, inline or by URL, each with a download link, above the response", async () => {
    const response = { data: [{ b64_json: "AAAA" }, { url: "https://cdn.example/y.png" }, { revised_prompt: "neither" }, { b64_json: "BBBB", url: "https://cdn.example/z.png" }] };
    const { container } = await loaded({ "POST /bench/media": { ok: true, status: 200, latencyMs: 1, response } });
    pick(2);
    await send();
    expect(blockTitles()).toEqual(["Preview", "Response", "Sent by the bench → /admin/api/bench/media"]);
    const images = [...container.querySelectorAll("img")];
    // Numbered by position in the answer; inline data wins over a URL and is taken to be PNG.
    expect(images.map((i) => [i.getAttribute("src"), i.alt])).toEqual([
      ["data:image/png;base64,AAAA", "image-1.png"], ["https://cdn.example/y.png", "image-2"], ["data:image/png;base64,BBBB", "image-4.png"],
    ]);
    expect(classes(images[0])).toEqual(cls("max-h-64 max-w-full rounded-lg border border-ink-800"));
    expect([...container.querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.getAttribute("download"), classes(a)])).toEqual([
      ["data:image/png;base64,AAAA", "image-1.png", cls(XS)], ["https://cdn.example/y.png", "image-2", cls(XS)], ["data:image/png;base64,BBBB", "image-4.png", cls(XS)],
    ]);
  });

  it("previews audio returned by the internal route, before any images", async () => {
    const answer = { ok: true, status: 200, latencyMs: 1, audio: { mediaType: "audio/mpeg", base64: "AQID", bytes: 3 }, response: { data: [{ b64_json: "AAAA" }] } };
    const { container } = await loaded({ "POST /bench/media": answer });
    pick(9);
    await send();
    const items = [...screen.getByText("Preview").nextElementSibling!.children].map((c) => c.firstElementChild!);
    expect(items.map((e) => [e.tagName, e.getAttribute("src")])).toEqual([["AUDIO", "data:audio/mpeg;base64,AQID"], ["IMG", "data:image/png;base64,AAAA"]]);
    expect([...container.querySelectorAll("a")].map((a) => a.getAttribute("download"))).toEqual(["bench-output.mpeg", "image-1.png"]);
  });

  it("an answer with nothing to look at has no preview", async () => {
    await loaded({ "POST /bench/media": { ok: true, status: 200, latencyMs: 1, response: { data: [{ embedding: [1] }] } } });
    pick(6);
    await send();
    expect(screen.queryByText("Preview")).toBeNull();
  });

  it("the body panel's copy button copies the generated body without opening the panel", async () => {
    await loaded();
    const copied = stubCopy();
    type(field("Message"), "ping");
    fireEvent.click(bodyPanel().querySelector("button i.bi-clipboard")!.closest("button")!);
    await toastShown("Copied to clipboard");
    expect(copied).toEqual([pretty({ model: "chat-svc", messages: USER_TEXT("ping") })]);
    expect(bodyPanel().querySelector("pre")).toBeNull();
  });

  it("the body panel's copy button copies a hand-edited body exactly as typed, valid or not", async () => {
    await loaded();
    const copied = stubCopy();
    fireEvent.click(button("Edit"));
    type(bodyPanel().querySelector("textarea")!, '{ "half": ');
    fireEvent.click(bodyPanel().querySelector("button i.bi-clipboard")!.closest("button")!);
    await toastShown("Copied to clipboard");
    expect(copied).toEqual(['{ "half": ']);
  });

  it("each result block's copy button copies that block's text as shown, open or collapsed", async () => {
    const answer = { ok: true, status: 200, latencyMs: 1, response: '{"a":1}', usage: { total: 2 }, upstreamRequest: "raw text", attemptPath: [1] };
    await loaded({ "POST /bench/chat": answer });
    await send();
    const copied = stubCopy();
    const SENT = "Sent by the bench → /admin/api/bench/chat";
    fireEvent.click(block("Usage").querySelector("button")!);
    for (const title of ["Usage", "Response", "Body sent upstream", "Attempt path", SENT]) fireEvent.click(block(title).querySelectorAll("button")[1]);
    expect(copied).toEqual([pretty({ total: 2 }), pretty({ a: 1 }), "raw text", pretty([1]), pretty({ model: "chat-svc", messages: USER_TEXT() })]);
    await toastShown("Copied to clipboard");
  });

  it("the raw frames block copies the frames as a JSON array", async () => {
    const frames = ['data: {"choices":[{"delta":{"content":"po"}}]}', 'data: {"choices":[{"delta":{"content":"ng"}}]}'];
    await loaded({}, { "POST /admin/api/bench/chat": () => sseOf(frames) });
    fireEvent.click(toggle("Stream"));
    await send();
    const copied = stubCopy();
    fireEvent.click(block("Raw SSE frames (2)").querySelectorAll("button")[1]);
    await toastShown("Copied to clipboard");
    expect(copied).toEqual([pretty(frames)]);
  });
});
