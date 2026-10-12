/**
 * Pure logic in src/lib: equivalence partitions and boundary values.
 * (intInput basics, useAsync staleness and useListKeys move/reset already live
 * in primitives.test.tsx; this file covers the rest.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { formatCompact, formatDate, formatNumber, relativeTime } from "../src/lib/format";
import { parsePayload } from "../src/lib/payload";
import { CHARS_PER_TOKEN, estimateTokens, loremOfTokens } from "../src/lib/lorem";
import { copyToClipboard } from "../src/lib/clipboard";
import { intInput, selectAll } from "../src/lib/input";
import { editedExpiry, msToLocalInput } from "../src/lib/tokenForm";
import { useListKeys } from "../src/lib/useListKeys";
import { useAsync } from "../src/lib/hooks";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("format.formatDate", () => {
  it.each([[null], [undefined], [0]])("renders a dash for the empty value %s", (v) => {
    expect(formatDate(v)).toBe("-");
  });

  it("renders a date with year, short month, day, hour and minute (no seconds)", () => {
    const ms = new Date(2026, 2, 5, 14, 7, 33).getTime();
    const expected = new Date(ms).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const out = formatDate(ms);
    expect(out).toBe(expected);
    expect(out).toContain("2026");
    expect(out).toContain("07");
    expect(out).not.toContain("33");
  });
});

describe("format.relativeTime", () => {
  const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
  const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it.each([[null], [undefined], [0]])("renders a dash for the empty value %s", (v) => {
    expect(relativeTime(v)).toBe("-");
  });

  it.each([
    // seconds bucket: [0, 59.5s)
    [0, "0s ago"],
    [1 * S, "1s ago"],
    [59 * S, "59s ago"],
    [59 * S + 499, "59s ago"],
    // minutes bucket starts where seconds round to 60
    [59 * S + 500, "1m ago"],
    [60 * S, "1m ago"],
    [89 * S, "1m ago"],
    [90 * S, "2m ago"],
    [59 * M, "59m ago"],
    // hours bucket starts where minutes round to 60
    [59 * M + 30 * S, "1h ago"],
    [60 * M, "1h ago"],
    [23 * H, "23h ago"],
    // days bucket starts where hours round to 24
    [23 * H + 30 * M, "1d ago"],
    [24 * H, "1d ago"],
    [30 * D, "30d ago"],
    [400 * D, "400d ago"],
  ])("%i ms in the past reads %s", (age, expected) => {
    expect(relativeTime(NOW - age)).toBe(expected);
  });
});

describe("format.formatNumber / formatCompact", () => {
  it.each([[null], [undefined]])("formatNumber(%s) is 0", (v) => expect(formatNumber(v)).toBe("0"));
  it("formatNumber keeps small numbers and groups large ones in the runtime locale", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(999)).toBe("999");
    expect(formatNumber(1234567)).toBe((1234567).toLocaleString());
  });

  it.each([
    [null, "0"],
    [undefined, "0"],
    [0, "0"],
    [1, "1"],
    [999, "999"],
    [-999, "-999"],
    [999.5, "999.5"],
    [1000, "1K"],
    [-1000, "-1K"],
    [1500, "1.5K"],
    [12345, "12.3K"],
    [999_999, "1M"],
    [1_000_000, "1M"],
    [2_500_000, "2.5M"],
    [1_000_000_000, "1B"],
  ])("formatCompact(%s) is %s", (n, expected) => {
    expect(formatCompact(n)).toBe(expected);
  });

  it("formatCompact pins the English suffixes regardless of the browser locale", () => {
    const spy = vi.spyOn(Intl, "NumberFormat");
    formatCompact(5000);
    expect(spy).toHaveBeenCalledWith("en", { notation: "compact", maximumFractionDigits: 1 });
  });
});

describe("payload.parsePayload", () => {
  const parse = (v: unknown) => parsePayload(JSON.stringify(v));

  it.each([
    ["null input", null],
    ["empty string", ""],
    ["invalid JSON", "{bad"],
    ["a JSON number", "5"],
    ["a JSON string", '"text"'],
    ["JSON null", "null"],
    ["JSON true", "true"],
    ["an empty object", "{}"],
    ["an empty array", "[]"],
    ["an object with only unknown keys", '{"foo":1,"bar":"x"}'],
    ["content alongside an empty message list", '{"content":"x","messages":[]}'],
  ])("returns null for %s", (_name, json) => {
    expect(parsePayload(json)).toBeNull();
  });

  it("extracts the scalar meta keys in a fixed order, stringified", () => {
    const out = parse({ streamed: true, finish_reason: "stop", stop_reason: "end_turn", top_p: 0.9, temperature: 0, stream: false, max_output_tokens: 20, max_tokens: 10, model: "m" });
    expect(out).toEqual({
      meta: [
        { label: "model", value: "m" },
        { label: "max_tokens", value: "10" },
        { label: "max_output_tokens", value: "20" },
        { label: "stream", value: "false" },
        { label: "temperature", value: "0" },
        { label: "top_p", value: "0.9" },
        { label: "stop_reason", value: "end_turn" },
        { label: "finish_reason", value: "stop" },
        { label: "streamed", value: "true" },
      ],
      tools: [],
      turns: [],
    });
  });

  it("skips meta keys that are null", () => {
    expect(parse({ model: "m", max_tokens: null })?.meta).toEqual([{ label: "model", value: "m" }]);
  });

  it("renders thinking, reasoning_effort, an object reasoning and usage as meta", () => {
    const out = parse({ thinking: { type: "enabled", budget_tokens: 5 }, reasoning_effort: "high", reasoning: { effort: "low" }, usage: { prompt_tokens: 3 } });
    expect(out?.meta).toEqual([
      { label: "thinking", value: '{"type":"enabled","budget_tokens":5}' },
      { label: "reasoning_effort", value: "high" },
      { label: "reasoning", value: '{"effort":"low"}' },
      { label: "usage", value: '{"prompt_tokens":3}' },
    ]);
  });

  it("does not list a string reasoning or a non-object usage as meta", () => {
    expect(parse({ model: "m", reasoning: "because", usage: 5 })?.meta).toEqual([{ label: "model", value: "m" }]);
  });

  it.each([
    [true, [{ label: "incomplete", value: "stream truncated upstream" }]],
    [false, []],
    ["true", []],
    [1, []],
  ])("incomplete=%s adds the truncation row only for boolean true", (incomplete, expectedMeta) => {
    expect(parse({ incomplete, tools: [{ name: "t" }] })?.meta).toEqual(expectedMeta);
  });

  it("collects tool names from function.name and name, skipping junk entries", () => {
    const out = parse({ tools: [{ type: "function", function: { name: "a" } }, { name: "b" }, { function: { name: "c" }, name: "ignored" }, {}, null, "x", 3] });
    expect(out).toEqual({ meta: [], tools: ["a", "b", "c"], turns: [] });
  });

  it("ignores a non-array tools value", () => {
    expect(parse({ model: "m", tools: { name: "a" } })?.tools).toEqual([]);
  });

  it("puts a top-level system prompt first (string or text parts) and drops an empty one", () => {
    expect(parse({ system: "be brief", messages: [{ role: "user", content: "hi" }] })?.turns).toEqual([
      { role: "system", text: "be brief" },
      { role: "user", text: "hi" },
    ]);
    expect(parse({ system: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })?.turns).toEqual([{ role: "system", text: "a\nb" }]);
    expect(parse({ system: "", model: "m" })?.turns).toEqual([]);
  });

  it("defaults a missing role to user and skips non-object messages", () => {
    expect(parse({ messages: [{ content: "a" }, null, "str", 4, { role: "assistant", content: "b" }] })?.turns).toEqual([
      { role: "user", text: "a" },
      { role: "assistant", text: "b" },
    ]);
  });

  it("keeps a turn with empty text when a message has no usable content", () => {
    expect(parse({ messages: [{ role: "user" }, { role: "user", content: null }, { role: "user", content: 5 }, { role: "user", content: { type: "text", text: "x" } }] })?.turns).toEqual([
      { role: "user", text: "" },
      { role: "user", text: "" },
      { role: "user", text: "" },
      { role: "user", text: "" },
    ]);
  });

  it.each([
    ["text", { type: "text", text: "t" }, "t"],
    ["input_text", { type: "input_text", text: "t" }, "t"],
    ["output_text", { type: "output_text", text: "t" }, "t"],
    ["text without a text field", { type: "text" }, ""],
    ["image", { type: "image", source: {} }, "[image]"],
    ["image_url", { type: "image_url", image_url: { url: "u" } }, "[image]"],
    ["tool_use", { type: "tool_use", name: "search", input: { q: 1 } }, '[tool_use search({"q":1})]'],
    ["tool_use without name/input", { type: "tool_use" }, "[tool_use ({})]"],
    ["tool_result (string)", { type: "tool_result", content: "ok" }, "[tool_result] ok"],
    ["tool_result (parts)", { type: "tool_result", content: [{ type: "text", text: "ok" }] }, "[tool_result] ok"],
    ["tool_result (error)", { type: "tool_result", is_error: true, content: "bad" }, "[tool_result error] bad"],
    ["unknown type with text", { type: "custom", text: "t" }, "t"],
    ["unknown type without text", { type: "custom", data: 1 }, ""],
    ["unknown type with non-string text", { type: "custom", text: 5 }, ""],
    ["a bare string part", "plain", "plain"],
    ["a null part", null, ""],
    ["a numeric part", 7, ""],
  ])("renders a %s content part", (_name, part, expected) => {
    expect(parse({ messages: [{ role: "user", content: [part] }] })?.turns).toEqual([{ role: "user", text: expected }]);
  });

  it("joins parts with newlines and drops the empty ones", () => {
    expect(parse({ messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "custom" }, "", { type: "image" }, "b"] }] })?.turns).toEqual([
      { role: "user", text: "a\n[image]\nb" },
    ]);
  });

  it.each(["reasoning", "reasoning_content", "reasoning_text", "thinking"])("lifts a message's %s field into a preceding thinking turn", (fieldName) => {
    expect(parse({ messages: [{ role: "assistant", content: "answer", [fieldName]: "trace" }] })?.turns).toEqual([
      { role: "thinking", text: "trace" },
      { role: "assistant", text: "answer" },
    ]);
  });

  it("takes the first NON-EMPTY reasoning field, in the server's order", () => {
    expect(parse({ messages: [{ role: "assistant", content: "a", reasoning: "", reasoning_content: "rc", thinking: "th" }] })?.turns[0]).toEqual({ role: "thinking", text: "rc" });
    expect(parse({ messages: [{ role: "assistant", content: "a", reasoning: "r", thinking: "th" }] })?.turns[0]).toEqual({ role: "thinking", text: "r" });
    expect(parse({ messages: [{ role: "assistant", content: "a", reasoning: { effort: "x" }, reasoning_text: "rt" }] })?.turns[0]).toEqual({ role: "thinking", text: "rt" });
  });

  it("extracts thinking parts into a thinking turn and keeps them out of the answer text", () => {
    const content = [
      { type: "thinking", thinking: "t1" },
      { type: "reasoning", text: "t2" },
      { type: "reasoning_text", summary: "t3" },
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "answer" },
    ];
    expect(parse({ messages: [{ role: "assistant", content }] })?.turns).toEqual([
      { role: "thinking", text: "t1\nt2\nt3" },
      { role: "assistant", text: "answer" },
    ]);
  });

  it("prefers a reasoning field over thinking parts", () => {
    expect(parse({ messages: [{ role: "assistant", reasoning: "field", content: [{ type: "thinking", thinking: "part" }, { type: "text", text: "a" }] }] })?.turns).toEqual([
      { role: "thinking", text: "field" },
      { role: "assistant", text: "a" },
    ]);
  });

  it("emits no thinking turn when there is no trace", () => {
    expect(parse({ messages: [{ role: "assistant", content: [{ type: "redacted_thinking" }, { type: "text", text: "a" }] }] })?.turns).toEqual([{ role: "assistant", text: "a" }]);
  });

  it("renders tool calls (OpenAI function shape and flat shape) after the text", () => {
    const tool_calls = [
      { function: { name: "f", arguments: '{"a":1}' } },
      { name: "g", args: "x" },
      { function: { name: "h" } },
      { function: {} },
      null,
      "junk",
    ];
    expect(parse({ messages: [{ role: "assistant", content: "text", tool_calls }] })?.turns).toEqual([
      { role: "assistant", text: 'text\n[tool_call f({"a":1})]\n[tool_call g(x)]\n[tool_call h()]' },
    ]);
  });

  it("uses the tool calls alone when the message has no text, and ignores a non-array tool_calls", () => {
    expect(parse({ messages: [{ role: "assistant", content: null, tool_calls: [{ function: { name: "f", arguments: "{}" } }] }] })?.turns).toEqual([
      { role: "assistant", text: "[tool_call f({})]" },
    ]);
    expect(parse({ messages: [{ role: "assistant", content: "t", tool_calls: { name: "f" } }] })?.turns).toEqual([{ role: "assistant", text: "t" }]);
  });

  it("reads OpenAI response choices as assistant turns with thinking and tool calls", () => {
    const out = parse({
      model: "gpt",
      choices: [
        { message: { role: "ignored", content: "hi", reasoning_content: "th", tool_calls: [{ function: { name: "f", arguments: "1" } }] } },
        null,
        { message: { content: [{ type: "text", text: "second" }] } },
      ],
    });
    expect(out?.turns).toEqual([
      { role: "thinking", text: "th" },
      { role: "assistant", text: "hi\n[tool_call f(1)]" },
      { role: "assistant", text: "" },
      { role: "assistant", text: "second" },
    ]);
    expect(out?.meta).toEqual([{ label: "model", value: "gpt" }]);
  });

  it("reads a bare top-level content response (Anthropic / reconstructed stream)", () => {
    expect(parse({ role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "text", text: "a" }], stop_reason: "end_turn" })).toEqual({
      meta: [{ label: "stop_reason", value: "end_turn" }],
      tools: [],
      turns: [
        { role: "thinking", text: "t" },
        { role: "assistant", text: "a" },
      ],
    });
    expect(parse({ content: "plain", reasoning: "r", tool_calls: [{ name: "f", args: "{}" }] })?.turns).toEqual([
      { role: "thinking", text: "r" },
      { role: "assistant", text: "plain\n[tool_call f({})]" },
    ]);
    expect(parse({ role: "model", content: "x" })?.turns).toEqual([{ role: "model", text: "x" }]);
  });

  it("ignores top-level content when messages or choices are present", () => {
    expect(parse({ content: "top", messages: [{ role: "user", content: "m" }] })?.turns).toEqual([{ role: "user", text: "m" }]);
    expect(parse({ content: "top", choices: [{ message: { content: "c" } }] })?.turns).toEqual([{ role: "assistant", text: "c" }]);
  });

  it("returns a result when only one of meta, tools or turns is populated", () => {
    expect(parse({ model: "m" })).toEqual({ meta: [{ label: "model", value: "m" }], tools: [], turns: [] });
    expect(parse({ tools: [{ name: "t" }] })).toEqual({ meta: [], tools: ["t"], turns: [] });
    expect(parse({ messages: [{ role: "user", content: "x" }] })).toEqual({ meta: [], tools: [], turns: [{ role: "user", text: "x" }] });
  });
});

describe("lorem", () => {
  it("exposes the 3.6 chars-per-token ratio", () => expect(CHARS_PER_TOKEN).toBe(3.6));

  it.each([
    ["", 0],
    ["a", 0],
    ["ab", 1],
    ["a".repeat(36), 10],
    ["a".repeat(3600), 1000],
  ])("estimateTokens of a %s-like string", (text, expected) => {
    expect(estimateTokens(text)).toBe(expected);
  });

  it.each([[0], [-1], [-1000], [0.1], [Number.NaN]])("loremOfTokens(%s) is empty", (n) => {
    expect(loremOfTokens(n)).toBe("");
  });

  it.each([
    [1, 4],
    [10, 36],
    [100, 360],
    [1000, 3600],
    [2.5, 9],
  ])("loremOfTokens(%s) is exactly %i characters", (tokens, chars) => {
    expect(loremOfTokens(tokens)).toHaveLength(chars);
  });

  it("numbers every paragraph so repeats cannot be collapsed", () => {
    const text = loremOfTokens(1000);
    expect(text.startsWith("[1] Lorem ipsum dolor sit amet")).toBe(true);
    expect(text).toContain("laborum. [2] Lorem ipsum");
    expect(text).toContain("[3] Lorem ipsum");
    expect(loremOfTokens(1)).toBe("[1] ");
  });

  it.each([[1], [10], [137], [5000]])("round-trips through estimateTokens for %i tokens", (n) => {
    expect(estimateTokens(loremOfTokens(n))).toBe(n);
  });
});

describe("clipboard.copyToClipboard", () => {
  const doc = document as unknown as { execCommand?: unknown };
  const setClipboard = (writeText: ((t: string) => Promise<void>) | undefined, secure: boolean) => {
    Object.defineProperty(navigator, "clipboard", { value: writeText ? { writeText } : undefined, configurable: true });
    Object.defineProperty(window, "isSecureContext", { value: secure, configurable: true });
  };
  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
    Reflect.deleteProperty(window, "isSecureContext");
    delete doc.execCommand;
    document.body.innerHTML = "";
  });

  it("uses the async clipboard in a secure context and reports success", async () => {
    const writeText = vi.fn(async () => {});
    const exec = vi.fn(() => true);
    setClipboard(writeText, true);
    doc.execCommand = exec;
    await expect(copyToClipboard("secret")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("secret");
    expect(exec).not.toHaveBeenCalled();
  });

  it("falls back to execCommand when the async clipboard rejects", async () => {
    const writeText = vi.fn(async () => { throw new Error("denied"); });
    const exec = vi.fn(() => true);
    setClipboard(writeText, true);
    doc.execCommand = exec;
    await expect(copyToClipboard("secret")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("skips the async clipboard outside a secure context", async () => {
    const writeText = vi.fn(async () => {});
    const exec = vi.fn(() => true);
    setClipboard(writeText, false);
    doc.execCommand = exec;
    await expect(copyToClipboard("x")).resolves.toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("uses execCommand when navigator.clipboard does not exist", async () => {
    const exec = vi.fn(() => true);
    setClipboard(undefined, true);
    doc.execCommand = exec;
    await expect(copyToClipboard("x")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("copies through an off-screen read-only textarea holding the text, removed afterwards", async () => {
    let seen: { value: string; readonly: boolean; left: string; position: string; focused: boolean } | null = null;
    doc.execCommand = vi.fn(() => {
      const ta = document.querySelector("textarea")!;
      seen = { value: ta.value, readonly: ta.hasAttribute("readonly"), left: ta.style.left, position: ta.style.position, focused: document.activeElement === ta };
      return true;
    });
    setClipboard(undefined, false);
    await expect(copyToClipboard("the text")).resolves.toBe(true);
    expect(seen).toEqual({ value: "the text", readonly: true, left: "-9999px", position: "fixed", focused: true });
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("reports failure when execCommand returns false", async () => {
    doc.execCommand = vi.fn(() => false);
    setClipboard(undefined, false);
    await expect(copyToClipboard("x")).resolves.toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("reports failure when execCommand throws or is missing", async () => {
    setClipboard(undefined, false);
    doc.execCommand = vi.fn(() => { throw new Error("blocked"); });
    await expect(copyToClipboard("x")).resolves.toBe(false);
    delete doc.execCommand;
    await expect(copyToClipboard("x")).resolves.toBe(false);
  });

  it("copies an empty string without failing", async () => {
    doc.execCommand = vi.fn(() => true);
    setClipboard(undefined, false);
    await expect(copyToClipboard("")).resolves.toBe(true);
  });
});

describe("input", () => {
  it.each([
    ["   ", 9, 0, 9], // whitespace only -> fallback
    [" 7 ", 9, 0, 7], // surrounding whitespace tolerated
    ["1e3", 9, 0, 1000], // Number() syntax accepted
    ["0x10", 9, 0, 16],
    ["Infinity", 9, 0, 9], // not finite -> fallback
    ["-Infinity", 9, 0, 9],
    ["12abc", 9, 0, 9],
    ["-4", 9, -10, -4], // above a negative minimum
    ["-1.9", 9, -10, -1], // truncates toward zero
    ["-11", 9, -10, -10], // clamps to the minimum
    ["", 5, 10, 10], // fallback below the minimum is clamped too
    ["9", 5, 10, 10],
    ["10", 5, 10, 10],
    ["11", 5, 10, 11],
  ])("intInput(%j, fallback %i, min %i) is %i", (raw, fallback, min, expected) => {
    expect(intInput(raw, fallback, min)).toBe(expected);
  });

  it("selectAll selects the event's own input", () => {
    const select = vi.fn();
    selectAll({ currentTarget: { select } } as unknown as React.SyntheticEvent<HTMLInputElement>);
    expect(select).toHaveBeenCalledTimes(1);
  });
});

describe("tokenForm", () => {
  it.each([[null], [undefined], [0]])("msToLocalInput(%s) is empty", (v) => expect(msToLocalInput(v)).toBe(""));

  it("msToLocalInput renders local wall-clock time to the minute", () => {
    const ms = new Date(2026, 8, 21, 9, 5, 42, 500).getTime();
    expect(msToLocalInput(ms)).toBe("2026-09-21T09:05");
    expect(new Date(msToLocalInput(ms)).getTime()).toBe(new Date(2026, 8, 21, 9, 5, 0, 0).getTime());
  });

  it.each([[null], [undefined]])("editedExpiry('', %s) is null", (original) => {
    expect(editedExpiry("", original)).toBeNull();
    expect(editedExpiry("")).toBeNull();
  });

  it("editedExpiry parses a typed value when there is no original", () => {
    const expected = new Date(2027, 0, 2, 3, 4).getTime();
    expect(editedExpiry("2027-01-02T03:04")).toBe(expected);
    expect(editedExpiry("2027-01-02T03:04", null)).toBe(expected);
  });

  it("editedExpiry returns the original only when the field still shows it", () => {
    const original = new Date(2026, 8, 21, 9, 5, 42, 500).getTime();
    expect(editedExpiry("2026-09-21T09:05", original)).toBe(original);
    expect(editedExpiry("2026-09-21T09:06", original)).toBe(new Date(2026, 8, 21, 9, 6).getTime());
    expect(editedExpiry("2026-09-21T09:04", original)).toBe(new Date(2026, 8, 21, 9, 4).getTime());
  });
});

describe("useListKeys", () => {
  it("starts with one unique key per item, and none for an empty list", () => {
    const { result } = renderHook(() => useListKeys(3));
    expect(result.current.keys).toHaveLength(3);
    expect(new Set(result.current.keys).size).toBe(3);
    expect(renderHook(() => useListKeys(0)).result.current.keys).toEqual([]);
  });

  it("keeps the same keys across re-renders at the same length", () => {
    const { result, rerender } = renderHook(() => useListKeys(2));
    const before = [...result.current.keys];
    rerender();
    expect(result.current.keys).toEqual(before);
  });

  it.each([
    ["at the start", 0, (a: number, b: number, n: number) => [n, a, b]],
    ["in the middle", 1, (a: number, b: number, n: number) => [a, n, b]],
    ["at the end", 2, (a: number, b: number, n: number) => [a, b, n]],
  ])("insert %s adds one fresh key and keeps the others in place", (_name, at, shape) => {
    const { result, rerender } = renderHook(({ n }) => useListKeys(n), { initialProps: { n: 2 } });
    const [a, b] = result.current.keys;
    result.current.insert(at);
    rerender({ n: 3 });
    const fresh = result.current.keys[at];
    expect(result.current.keys).toEqual(shape(a, b, fresh));
    expect([a, b]).not.toContain(fresh);
  });

  it.each([[0], [1], [2]])("remove(%i) drops only that key", (at) => {
    const { result, rerender } = renderHook(({ n }) => useListKeys(n), { initialProps: { n: 3 } });
    const before = [...result.current.keys];
    result.current.remove(at);
    rerender({ n: 2 });
    expect(result.current.keys).toEqual(before.filter((_, i) => i !== at));
  });

  it("remove out of range changes nothing", () => {
    const { result, rerender } = renderHook(() => useListKeys(2));
    const before = [...result.current.keys];
    result.current.remove(5);
    rerender();
    expect(result.current.keys).toEqual(before);
  });

  it("move reorders in both directions without minting keys", () => {
    const { result, rerender } = renderHook(() => useListKeys(3));
    const [a, b, c] = result.current.keys;
    result.current.move(0, 2);
    rerender();
    expect(result.current.keys).toEqual([b, c, a]);
    result.current.move(2, 0);
    rerender();
    expect(result.current.keys).toEqual([a, b, c]);
  });

  it.each([[5], [1], [0]])("regenerates every key when the length changes to %i without a mutator", (next) => {
    const { result, rerender } = renderHook(({ n }) => useListKeys(n), { initialProps: { n: 3 } });
    const before = [...result.current.keys];
    rerender({ n: next });
    expect(result.current.keys).toHaveLength(next);
    expect(result.current.keys.some((k) => before.includes(k))).toBe(false);
  });

  it("never reuses a key after remove + insert", () => {
    const { result, rerender } = renderHook(({ n }) => useListKeys(n), { initialProps: { n: 2 } });
    const before = [...result.current.keys];
    result.current.remove(0);
    rerender({ n: 1 });
    result.current.insert(0);
    rerender({ n: 2 });
    expect(result.current.keys[1]).toBe(before[1]);
    expect(before).not.toContain(result.current.keys[0]);
  });
});

describe("useAsync", () => {
  it("starts loading with no data and no error, then holds the result", async () => {
    const { result } = renderHook(() => useAsync(async () => "value"));
    expect(result.current).toMatchObject({ data: null, loading: true, error: null });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ data: "value", loading: false, error: null });
  });

  it("reports an Error rejection by its message", async () => {
    const { result } = renderHook(() => useAsync<string>(async () => { throw new Error("boom"); }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ data: null, loading: false, error: "boom" });
  });

  it.each([
    ["a string", "plain", "plain"],
    ["a number", 42, "42"],
    ["null", null, "null"],
    ["undefined", undefined, "undefined"],
  ])("stringifies a non-Error rejection (%s)", async (_name, thrown, expected) => {
    const { result } = renderHook(() => useAsync<string>(() => Promise.reject(thrown)));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(expected);
  });

  it("catches a loader that throws synchronously", async () => {
    const { result } = renderHook(() => useAsync<string>(() => { throw new Error("sync"); }));
    await waitFor(() => expect(result.current.error).toBe("sync"));
    expect(result.current.loading).toBe(false);
  });

  it("clears the error on a later successful reload and goes through loading again", async () => {
    let ok = false;
    const { result } = renderHook(() => useAsync(async () => { if (!ok) throw new Error("first"); return "second"; }));
    await waitFor(() => expect(result.current.error).toBe("first"));
    ok = true;
    act(() => result.current.reload());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ data: "second", error: null });
  });

  it("keeps the previous data when a reload fails", async () => {
    let ok = true;
    const { result } = renderHook(() => useAsync(async () => { if (!ok) throw new Error("later"); return "first"; }));
    await waitFor(() => expect(result.current.data).toBe("first"));
    ok = false;
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.error).toBe("later"));
    expect(result.current).toMatchObject({ data: "first", loading: false });
  });

  it("returns a stable reload function and calls the loader once per load", async () => {
    const loader = vi.fn(async () => 1);
    const { result, rerender } = renderHook(() => useAsync(loader));
    const first = result.current.reload;
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender();
    expect(result.current.reload).toBe(first);
    expect(loader).toHaveBeenCalledTimes(1);
    act(() => result.current.reload());
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loading).toBe(false));
  });
});
