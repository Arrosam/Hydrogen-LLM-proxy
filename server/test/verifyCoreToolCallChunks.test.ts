/**
 * Independent verification, CORE item C4b (addendum).
 *
 * Chat Completions stream: a tool call whose `id` arrives in one chunk and
 * whose function `name` arrives in a LATER chunk. The spec requires that
 *   - the stream is collected as ONE tool call carrying that id, that name and
 *     the complete arguments in order, wherever the argument fragments sit
 *     (before, between or after the id and name chunks), also for two such
 *     calls interleaved by index;
 *   - a name split across chunks is concatenated;
 *   - relayed to a client on any wire family (Chat, Anthropic, Responses) the
 *     client receives the tool call with its name and complete arguments;
 *   - id and name in the same chunk, and arguments before a chunk carrying
 *     both, behave as before.
 *
 * Written from the spec only. Expected values come from the spec's wording.
 * The relayed wire is read back by small hand-written readers that follow each
 * public client protocol (they do not use the proxy's own parsers), so the
 * assertions describe what a real client of that family would assemble.
 */
import { describe, expect, it } from "vitest";
import { parseStream, serializeStream } from "../src/core/format";
import type { ContentPart } from "../src/core/ir/content";
import { collectStream } from "../src/core/ir/stream";

type Json = Record<string, unknown>;
type Family = "openai_completion" | "anthropic" | "openai_responses";
const FAMILIES: Family[] = ["openai_completion", "anthropic", "openai_responses"];

// ---------------------------------------------------------------------------
// Upstream side: Chat Completions SSE chunks
// ---------------------------------------------------------------------------

const chunk = (delta: Json, finish: string | null = null): string =>
  `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "up", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const call = (index: number, fields: Json): string => chunk({ tool_calls: [{ index, ...fields }] });

/** A chunk that carries only the call id (and the `type`), no function name. */
const idOnly = (index: number, id: string): string => call(index, { id, type: "function" });
/** A chunk that carries only a function name (or a fragment of one). */
const nameOnly = (index: number, name: string): string => call(index, { function: { name } });
/** A chunk that carries only an argument fragment. */
const argsOnly = (index: number, fragment: string): string => call(index, { function: { arguments: fragment } });
/** A chunk that carries id and name together (the ordinary shape). */
const idAndName = (index: number, id: string, name: string, fragment?: string): string =>
  call(index, { id, type: "function", function: { name, ...(fragment === undefined ? {} : { arguments: fragment }) } });

const ROLE = chunk({ role: "assistant" });
const FINISH = chunk({}, "tool_calls");
const DONE = "data: [DONE]\n\n";
const stream = (...body: string[]): string[] => [ROLE, ...body, FINISH, DONE];

async function* frames(list: string[]): AsyncGenerator<string> {
  for (const f of list) yield f;
}

// Call 1: {"city":"Beijing","unit":"celsius"} in three fragments.
const WEATHER_INPUT = { city: "Beijing", unit: "celsius" };
const WEATHER_ARGS = JSON.stringify(WEATHER_INPUT);
const A = WEATHER_ARGS.slice(0, 9);
const B = WEATHER_ARGS.slice(9, 21);
const C = WEATHER_ARGS.slice(21);
// Call 2: {"q":"green tea"} in two fragments.
const SEARCH_INPUT = { q: "green tea" };
const SEARCH_ARGS = JSON.stringify(SEARCH_INPUT);
const S1 = SEARCH_ARGS.slice(0, 6);
const S2 = SEARCH_ARGS.slice(6);

interface ToolCall { id: string; name: string; input: unknown }
const WEATHER: ToolCall = { id: "call_1", name: "get_weather", input: WEATHER_INPUT };
const SEARCH: ToolCall = { id: "call_2", name: "search", input: SEARCH_INPUT };

interface Scenario { title: string; chunks: string[]; expected: ToolCall[] }

/** The corrected behaviour: the id chunk comes first, the name in a later chunk. */
const SPLIT: Scenario[] = [
  {
    title: "id, then name, then the arguments",
    chunks: stream(idOnly(0, "call_1"), nameOnly(0, "get_weather"), argsOnly(0, A), argsOnly(0, B), argsOnly(0, C)),
    expected: [WEATHER],
  },
  {
    title: "id, then name, with every argument fragment riding the name chunk",
    chunks: stream(idOnly(0, "call_1"), call(0, { function: { name: "get_weather", arguments: WEATHER_ARGS } })),
    expected: [WEATHER],
  },
  {
    title: "id, then the arguments, then name",
    chunks: stream(idOnly(0, "call_1"), argsOnly(0, A), argsOnly(0, B), argsOnly(0, C), nameOnly(0, "get_weather")),
    expected: [WEATHER],
  },
  {
    title: "the arguments, then id, then name",
    chunks: stream(argsOnly(0, A), argsOnly(0, B), argsOnly(0, C), idOnly(0, "call_1"), nameOnly(0, "get_weather")),
    expected: [WEATHER],
  },
  {
    title: "argument fragments before, between and after the id and name chunks",
    chunks: stream(argsOnly(0, A), idOnly(0, "call_1"), argsOnly(0, B), nameOnly(0, "get_weather"), argsOnly(0, C)),
    expected: [WEATHER],
  },
  {
    title: "id, then a name split over two chunks, then the arguments",
    chunks: stream(idOnly(0, "call_1"), nameOnly(0, "get_"), nameOnly(0, "weather"), argsOnly(0, A), argsOnly(0, B), argsOnly(0, C)),
    expected: [WEATHER],
  },
  {
    title: "the arguments, then id, then a name split over two chunks at the very end",
    chunks: stream(argsOnly(0, A), argsOnly(0, B), argsOnly(0, C), idOnly(0, "call_1"), nameOnly(0, "get_"), nameOnly(0, "weather")),
    expected: [WEATHER],
  },
  {
    title: "id, then a name split over two chunks with an argument fragment between the halves",
    chunks: stream(idOnly(0, "call_1"), nameOnly(0, "get_"), argsOnly(0, A), nameOnly(0, "weather"), argsOnly(0, B), argsOnly(0, C)),
    expected: [WEATHER],
  },
  {
    title: "two calls interleaved by index, each with its id before its name",
    chunks: stream(
      idOnly(0, "call_1"), idOnly(1, "call_2"),
      argsOnly(0, A), argsOnly(1, S1),
      nameOnly(0, "get_weather"), nameOnly(1, "search"),
      argsOnly(0, B), argsOnly(1, S2), argsOnly(0, C),
    ),
    expected: [WEATHER, SEARCH],
  },
  {
    title: "two calls interleaved by index, arguments first, the second call's name split",
    chunks: stream(
      argsOnly(0, A), argsOnly(1, S1),
      idOnly(0, "call_1"), argsOnly(0, B), idOnly(1, "call_2"),
      nameOnly(1, "sea"), nameOnly(0, "get_weather"), nameOnly(1, "rch"),
      argsOnly(1, S2), argsOnly(0, C),
    ),
    expected: [WEATHER, SEARCH],
  },
  {
    title: "two calls, the first with id and name split, the second arriving whole",
    chunks: stream(
      idOnly(0, "call_1"), argsOnly(0, A),
      idAndName(1, "call_2", "search", S1),
      nameOnly(0, "get_weather"), argsOnly(1, S2), argsOnly(0, B), argsOnly(0, C),
    ),
    expected: [WEATHER, SEARCH],
  },
];

/** Neighbours the spec names as unchanged (plus the plain whole-call shape). */
const UNCHANGED: Scenario[] = [
  {
    title: "id and name in the same chunk, then the arguments",
    chunks: stream(idAndName(0, "call_1", "get_weather", ""), argsOnly(0, A), argsOnly(0, B), argsOnly(0, C)),
    expected: [WEATHER],
  },
  {
    title: "id and name in the same chunk with no arguments field, then the arguments",
    chunks: stream(idAndName(0, "call_1", "get_weather"), argsOnly(0, A), argsOnly(0, B), argsOnly(0, C)),
    expected: [WEATHER],
  },
  {
    title: "the arguments before a chunk carrying both id and name",
    chunks: stream(argsOnly(0, A), argsOnly(0, B), argsOnly(0, C), idAndName(0, "call_1", "get_weather")),
    expected: [WEATHER],
  },
  {
    title: "arguments before and after a chunk carrying both id and name",
    chunks: stream(argsOnly(0, A), idAndName(0, "call_1", "get_weather", B), argsOnly(0, C)),
    expected: [WEATHER],
  },
  {
    title: "a whole call in one chunk",
    chunks: stream(idAndName(0, "call_1", "get_weather", WEATHER_ARGS)),
    expected: [WEATHER],
  },
  {
    title: "two calls interleaved by index, each with id and name in the same chunk",
    chunks: stream(
      idAndName(0, "call_1", "get_weather", ""), idAndName(1, "call_2", "search", ""),
      argsOnly(0, A), argsOnly(1, S1), argsOnly(0, B), argsOnly(1, S2), argsOnly(0, C),
    ),
    expected: [WEATHER, SEARCH],
  },
];

// ---------------------------------------------------------------------------
// Collecting
// ---------------------------------------------------------------------------

async function collectTools(list: string[]): Promise<{ tools: ToolCall[]; incomplete: boolean; stopReason: unknown }> {
  const { data, incomplete } = await collectStream(parseStream("openai_completion", frames(list)));
  const tools = data.content
    .filter((p): p is Extract<ContentPart, { type: "tool_use" }> => p.type === "tool_use")
    .map((p) => ({ id: p.id, name: p.name, input: p.input }));
  return { tools, incomplete, stopReason: data.stopReason };
}

describe("C4b: a Chat stream tool call whose id and name arrive in different chunks is collected as one call", () => {
  it.each(SPLIT)("collects $title", async ({ chunks, expected }) => {
    const got = await collectTools(chunks);
    expect(got).toEqual({ tools: expected, incomplete: false, stopReason: "tool_use" });
  });

  it("keeps text that precedes a call whose id and name are split", async () => {
    const { data } = await collectStream(parseStream("openai_completion", frames(stream(
      chunk({ content: "checking" }),
      idOnly(0, "call_1"), argsOnly(0, A), nameOnly(0, "get_weather"), argsOnly(0, B), argsOnly(0, C),
    ))));
    const text = data.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
    expect(text).toBe("checking");
    expect(data.content.filter((p) => p.type === "tool_use")).toEqual([{ type: "tool_use", ...WEATHER }]);
  });
});

describe("C4b unchanged: id and name in the same chunk are collected as before", () => {
  it.each(UNCHANGED)("collects $title", async ({ chunks, expected }) => {
    const got = await collectTools(chunks);
    expect(got).toEqual({ tools: expected, incomplete: false, stopReason: "tool_use" });
  });
});

// ---------------------------------------------------------------------------
// Client side: what a client of each wire family assembles from the relay
// ---------------------------------------------------------------------------

interface WireFrame { event?: string; data: string }

/** Plain SSE framing: blank-line separated frames, `event:` and `data:` lines. */
function sseFrames(wire: string): WireFrame[] {
  const out: WireFrame[] = [];
  for (const block of wire.split(/\r?\n\r?\n/)) {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length > 0) out.push({ event, data: data.join("\n") });
  }
  return out;
}

const obj = (v: unknown): Json => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown, fallback: number): number => (typeof v === "number" ? v : fallback);

function jsonFrames(wire: string): Json[] {
  return sseFrames(wire).filter((f) => f.data !== "[DONE]").map((f) => obj(JSON.parse(f.data)));
}

/** Arguments text -> the value a client hands to its tool; unparsable text stays visible as text. */
function parseArgs(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

interface ClientCall { name: string; input: unknown }

/**
 * A Chat Completions client: tool-call deltas are merged per `index`, the
 * function name and arguments by string concatenation (how the OpenAI SDKs
 * accumulate a streamed message).
 */
function chatClientCalls(wire: string): ClientCall[] {
  const byIndex = new Map<number, { name: string; args: string }>();
  for (const frame of jsonFrames(wire)) {
    for (const choice of arr(frame.choices)) {
      for (const raw of arr(obj(obj(choice).delta).tool_calls)) {
        const delta = obj(raw);
        const index = num(delta.index, 0);
        const slot = byIndex.get(index) ?? { name: "", args: "" };
        const fn = obj(delta.function);
        slot.name += str(fn.name);
        slot.args += str(fn.arguments);
        byIndex.set(index, slot);
      }
    }
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({ name: c.name, input: parseArgs(c.args) }));
}

/**
 * An Anthropic Messages client: a tool call is the `tool_use` block announced
 * by `content_block_start` (which is the only place its name appears), its
 * input the concatenation of that block's `input_json_delta.partial_json`.
 */
function anthropicClientCalls(wire: string): ClientCall[] {
  const byIndex = new Map<number, { name: string; args: string }>();
  for (const frame of jsonFrames(wire)) {
    const index = num(frame.index, -1);
    if (frame.type === "content_block_start") {
      const block = obj(frame.content_block);
      if (block.type === "tool_use") byIndex.set(index, { name: str(block.name), args: "" });
    } else if (frame.type === "content_block_delta") {
      const delta = obj(frame.delta);
      const slot = byIndex.get(index);
      if (delta.type === "input_json_delta" && slot) slot.args += str(delta.partial_json);
    }
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({ name: c.name, input: parseArgs(c.args) }));
}

/**
 * A Responses client reading finished items: every `function_call` item
 * delivered by `response.output_item.done`, in output order.
 */
function responsesDoneCalls(wire: string): ClientCall[] {
  const items: Array<{ at: number; call: ClientCall }> = [];
  for (const frame of jsonFrames(wire)) {
    if (frame.type !== "response.output_item.done") continue;
    const item = obj(frame.item);
    if (item.type !== "function_call") continue;
    items.push({ at: num(frame.output_index, items.length), call: { name: str(item.name), input: parseArgs(str(item.arguments)) } });
  }
  return items.sort((a, b) => a.at - b.at).map((i) => i.call);
}

/** A Responses client reading the final `response.completed` snapshot's output. */
function responsesCompletedCalls(wire: string): ClientCall[] {
  const completed = jsonFrames(wire).filter((f) => f.type === "response.completed");
  const last = completed[completed.length - 1];
  return arr(obj(last?.response).output)
    .map(obj)
    .filter((item) => item.type === "function_call")
    .map((item) => ({ name: str(item.name), input: parseArgs(str(item.arguments)) }));
}

async function relay(family: Family, list: string[]): Promise<string> {
  let wire = "";
  for await (const part of serializeStream(family, parseStream("openai_completion", frames(list)), { model: "svc" })) wire += part;
  return wire;
}

const clientView = (expected: ToolCall[]): ClientCall[] => expected.map((c) => ({ name: c.name, input: c.input }));

/** The tool calls a client of `family` ends up with, by each way that client can read them. */
function clientCalls(family: Family, wire: string): Record<string, ClientCall[]> {
  if (family === "openai_completion") return { "accumulated tool_calls deltas": chatClientCalls(wire) };
  if (family === "anthropic") return { "tool_use blocks": anthropicClientCalls(wire) };
  return { "output_item.done items": responsesDoneCalls(wire), "response.completed output": responsesCompletedCalls(wire) };
}

function expectedViews(family: Family, expected: ToolCall[]): Record<string, ClientCall[]> {
  const view = clientView(expected);
  if (family === "openai_completion") return { "accumulated tool_calls deltas": view };
  if (family === "anthropic") return { "tool_use blocks": view };
  return { "output_item.done items": view, "response.completed output": view };
}

describe.each(FAMILIES)("C4b: relayed to a %s client, the tool call has its name and complete arguments", (family) => {
  it.each(SPLIT)("relays $title", async ({ chunks, expected }) => {
    const wire = await relay(family, chunks);
    expect(clientCalls(family, wire)).toEqual(expectedViews(family, expected));
  });
});

describe.each(FAMILIES)("C4b unchanged: relayed to a %s client, id and name in the same chunk", (family) => {
  it.each(UNCHANGED)("relays $title", async ({ chunks, expected }) => {
    const wire = await relay(family, chunks);
    expect(clientCalls(family, wire)).toEqual(expectedViews(family, expected));
  });
});
