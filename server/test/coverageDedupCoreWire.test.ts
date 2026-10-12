/**
 * Characterization of the three wire adapters, taken before the de-duplication
 * of core/format: every body, frame and canonical value below is snapshotted as
 * a JSON string, so key order and the edge-case differences between sibling
 * adapters (how 0, a missing field, a non-string or an empty value is treated)
 * are pinned exactly as they were.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildRequest, buildResponse, parseRequest, parseResponse, parseStream, serializeStream } from "../src/core/format";
import { FAMILIES, type Family } from "../src/core/ir/params";
import type { StreamEvent } from "../src/core/ir/stream";
import type { ContentPart } from "../src/core/ir/content";
import { encodeReasoning, encodeRedacted } from "../src/core/format/reasoningBridge";
import type { ThinkingFormat } from "../src/core/ir/thinkingFormat";

type Json = Record<string, unknown>;

const FIXED_NOW_MS = 1_700_000_000_000;
beforeAll(() => { vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW_MS); });
afterAll(() => { vi.restoreAllMocks(); });

/** Minted ids are random; everything else is deterministic. */
const stable = (value: unknown): string =>
  (JSON.stringify(value, null, 1) ?? "undefined").replace(/\b([a-z]+)-[0-9a-f]{32}\b/g, "$1-ID");

const attempt = (fn: () => unknown): unknown => {
  try { return fn(); } catch (e) { return { threw: (e as Error).name, message: (e as Error).message }; }
};

async function* chunks(parts: string[]): AsyncGenerator<string> { for (const p of parts) yield p; }
async function* eventsOf(list: StreamEvent[]): AsyncGenerator<StreamEvent> { for (const ev of list) yield ev; }
const sse = (data: unknown, event?: string): string => `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
const parsed = async (family: Family, frames: string[]): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const ev of parseStream(family, chunks(frames))) out.push(ev);
  return out;
};
const serialized = async (family: Family, list: StreamEvent[], thinkingFormat?: ThinkingFormat): Promise<string> => {
  let out = "";
  for await (const frame of serializeStream(family, eventsOf(list), { model: "client-model", thinkingFormat })) out += frame;
  return out;
};

const TARGETS = [
  { upstreamModel: "up-model" },
  { upstreamModel: "gpt-5-mini", providerMaxOutputTokens: 100 },
  { upstreamModel: "claude-opus-4-1", providerMaxOutputTokens: 100 },
];

const PNG = "data:image/png;base64,AAAA";
const PDF = "data:application/pdf;base64,BBBB";
const WRAPPED_FOREIGN = encodeReasoning({ type: "reasoning", text: "wrapped", signature: "sig-a", origin: "anthropic", itemId: "it-1" });
const WRAPPED_REDACTED = encodeRedacted({ type: "reasoning", text: "", redacted: true, signature: "opaque" });

// --- request corpus ---------------------------------------------------------

const COMPLETION_REQUESTS: Record<string, Json> = {
  plain: { model: "svc", messages: [{ role: "system", content: "sys" }, { role: "developer", content: [{ type: "text", text: "dev" }] }, { role: "user", content: "hi", name: "bob" }], stream: true },
  params: {
    model: "svc", messages: [{ role: "user", content: "hi" }], temperature: 1.7, top_p: 0.5, top_k: 4, min_p: 0.1, max_tokens: 500, stop: ["a", "b", "c", "d", "e"],
    frequency_penalty: 0.1, presence_penalty: 0.2, repetition_penalty: 1.1, seed: 7, n: 2, logprobs: true, top_logprobs: 3, logit_bias: { "5": 1 },
    response_format: { type: "json_schema", json_schema: { schema: { type: "object" }, strict: true } }, parallel_tool_calls: false, service_tier: "flex", user: "u-1",
    verbosity: "low", prompt_cache_key: "k", unknown_knob: { a: 1 },
  },
  maxCompletion: { model: "svc", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 300, max_tokens: 9, stop: "x", response_format: { type: "json_object" }, verbosity: "loud", temperature: "hot" },
  zeroMax: { model: "svc", messages: [{ role: "user", content: "hi" }], max_tokens: 0, response_format: { type: "text" } },
  tools: {
    model: "svc", messages: [{ role: "user", content: "hi" }],
    tools: [
      null, "junk",
      { type: "function", function: { name: "f1", description: "d", parameters: { type: "object", properties: { a: {} } }, strict: true } },
      { type: "function", function: { name: "f2" } },
      { type: "web_search_preview", name: "named-native" },
      { function: {} },
      { type: "custom", custom: { name: "c" } },
    ],
    tool_choice: { type: "function", function: { name: "f1" } },
  },
  history: {
    model: "svc",
    messages: [
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: PNG } }, { type: "image_url", image_url: "https://img/x.png" }, { type: "image_url", image_url: {} },
        { type: "input_text", text: "it" }, { type: "output_text", text: "ot" }, { type: "input_audio", input_audio: { data: "x" } }, null, 5] },
      { role: "assistant", content: "thinking done", reasoning_content: "rc", tool_calls: [{ id: "c1", type: "function", function: { name: "f1", arguments: "{\"a\":1}" } }, { function: { name: "f2", arguments: "not json" } }, null] },
      { role: "tool", tool_call_id: "c1", content: "result" },
      { role: "tool", tool_call_id: "c2", content: [{ type: "text", text: "arr" }] },
      { role: "assistant", content: [{ type: "text", text: "a" }, { type: "thinking", thinking: "part-think" }, { type: "reasoning", text: "" }], name: "bot" },
      { role: "user", content: "next" },
    ],
  },
  // SC-D-14: the request parser reads the first PRESENT field of three, not the first non-empty of four.
  reasoningFields: {
    model: "svc",
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: "a1", reasoning: "", reasoning_content: "masked", tool_calls: [{ id: "c1", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "r" },
      { role: "assistant", content: "a2", thinking: "ollama-only", tool_calls: [{ id: "c2", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c2", content: "r" },
      { role: "assistant", content: "a3", reasoning_text: "rt", tool_calls: [{ id: "c3", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c3", content: "r" },
      { role: "assistant", content: "a4", reasoning: "plain", reasoning_details: [{ type: "reasoning.encrypted", data: WRAPPED_FOREIGN }, { type: "reasoning.text", text: "or-text", id: "d1" }, { type: "other", text: "no" }, 3],
        tool_calls: [{ id: "c4", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c4", content: "r" },
    ],
  },
  files: {
    model: "svc",
    messages: [{ role: "user", content: [
      { type: "file", file: { filename: "a.pdf", file_data: PDF } },
      { type: "file", file: { file_data: "QkJCQg==" } },
      { type: "file", file: { file_data: 12345 } },
      { type: "file", file: { file_data: "https://not-a-data-url" } },
      { type: "file", file: {} },
      { type: "file" },
    ] }],
  },
  fileId: { model: "svc", messages: [{ role: "user", content: [{ type: "file", file: { file_id: "file-chat", filename: "n" } }] }] },
  ...Object.fromEntries(["none", "disabled", "minimal", "low", "medium", "high", "xhigh", "max", "bogus"].map(effort =>
    [`effort_${effort}`, { model: "svc", messages: [{ role: "user", content: "hi" }], reasoning_effort: effort, max_completion_tokens: 2000 }])),
  effortNoMax: { model: "svc", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
  ...Object.fromEntries(["auto", "none", "required", "bogus"].map(choice =>
    [`choice_${choice}`, { model: "svc", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "f" } }], tool_choice: choice }])),
  choiceNoType: { model: "svc", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "f" } }], tool_choice: { function: { name: "f" } } },
  choiceFlat: { model: "svc", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "f" } }], tool_choice: { type: "function", name: "f" } },
  junk: { messages: "nope", tools: [], stream: 0 },
};

const ANTHROPIC_REQUESTS: Record<string, Json> = {
  plain: { model: "svc", system: "sys", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream: true },
  systemBlocks: { model: "svc", system: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }, { type: "text", text: "b" }, { type: "image" }], messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }], max_tokens: 100 },
  params: { model: "svc", messages: [{ role: "user", content: "hi" }], temperature: 1.6, top_p: -0.2, top_k: 5, max_tokens: 4000, stop_sequences: ["x", 2], metadata: { user_id: "u-9", trace: "t" },
    tool_choice: { type: "auto", disable_parallel_tool_use: true }, output_config: { format: { type: "json" } }, betas: ["b"] },
  zeroMax: { model: "svc", messages: [{ role: "user", content: "hi" }], max_tokens: 0, top_p: "x" },
  tools: {
    model: "svc", max_tokens: 10, messages: [{ role: "user", content: "hi" }],
    tools: [
      null,
      { name: "t1", description: "d", input_schema: { type: "object", properties: { q: {} } }, cache_control: { type: "ephemeral" } },
      { name: "t2" },
      { type: "web_search_20250305", name: "web_search", max_uses: 2 },
      { type: "bash_20250124" },
      { description: "nameless" },
    ],
    tool_choice: { type: "tool", name: "t1" },
  },
  history: {
    model: "svc", max_tokens: 10,
    messages: [
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "JJ" } }, { type: "image", source: { type: "url", url: "https://img/y.png" } }, { type: "image", source: { data: "ZZ" } }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "th", signature: "sig-1" }, { type: "redacted_thinking", data: "opaque" }, { type: "text", text: "calling" }, { type: "tool_use", id: "tu1", name: "t1", input: { q: 1 }, cache_control: { type: "ephemeral" } }, { type: "tool_use", name: "t2" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "res" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "II" } }], is_error: true }, { type: "tool_result", tool_use_id: "tu2", content: "str" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "wrapped", signature: WRAPPED_FOREIGN }, { type: "thinking", thinking: "unsigned" }, { type: "text", text: "done" }] },
      { role: "user", content: "next" },
    ],
  },
  serverTools: {
    model: "svc", max_tokens: 10,
    messages: [
      { role: "user", content: "search" },
      { role: "assistant", content: [
        { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } },
        { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://a", title: "A" }] },
        { type: "server_tool_use", id: "s2", name: "web_search", input: { query: "q2" } },
        { type: "web_search_tool_result", tool_use_id: "s2", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
        { type: "code_execution_tool_result", tool_use_id: "orphan", content: [1] },
        { type: "web_search_result", tool_use_id: "", content: { error_code: 5 } },
        { type: "server_tool_use", id: "s3", name: "web_search", input: { query: "pending" } },
      ] },
      { role: "user", content: "go on" },
    ],
  },
  documents: {
    model: "svc", max_tokens: 10,
    messages: [{ role: "user", content: [
      { type: "document", source: { type: "url", url: "https://doc/a.pdf" }, title: "A" },
      { type: "document", source: { type: "text", data: "inline text" } },
      { type: "document", source: { type: "base64", data: "DD" }, cache_control: { type: "ephemeral" } },
      { type: "document", source: { type: "base64", media_type: "text/plain", data: "EE" }, title: "E" },
    ] }],
  },
  documentFileId: { model: "svc", max_tokens: 10, messages: [{ role: "user", content: [{ type: "document", source: { type: "file", file_id: "file-anth" }, title: "F" }] }] },
  documentBad: { model: "svc", max_tokens: 10, messages: [{ role: "user", content: [{ type: "document", source: { type: "content" } }] }] },
  documentNoData: { model: "svc", max_tokens: 10, messages: [{ role: "user", content: [{ type: "document", source: { type: "base64" } }] }] },
  thinkingEnabled: { model: "svc", max_tokens: 5000, messages: [{ role: "user", content: "hi" }], thinking: { type: "enabled", budget_tokens: 2000 } },
  thinkingEnabledBare: { model: "svc", max_tokens: 5000, messages: [{ role: "user", content: "hi" }], thinking: { type: "enabled" } },
  thinkingDisabled: { model: "svc", max_tokens: 5000, messages: [{ role: "user", content: "hi" }], thinking: { type: "disabled" } },
  thinkingBogus: { model: "svc", max_tokens: 5000, messages: [{ role: "user", content: "hi" }], thinking: { type: "bogus" } },
  ...Object.fromEntries(["minimal", "low", "medium", "high", "xhigh", "max", "none", "bogus"].map(effort =>
    [`adaptive_${effort}`, { model: "svc", max_tokens: 5000, messages: [{ role: "user", content: "hi" }], thinking: { type: "adaptive" }, output_config: { effort } }])),
  ...Object.fromEntries(["auto", "any", "none", "bogus"].map(type =>
    [`choice_${type}`, { model: "svc", max_tokens: 10, messages: [{ role: "user", content: "hi" }], tools: [{ name: "t" }], tool_choice: { type } }])),
  choiceNamelessTool: { model: "svc", max_tokens: 10, messages: [{ role: "user", content: "hi" }], tools: [{ name: "t" }], tool_choice: { type: "tool", disable_parallel_tool_use: false } },
  choiceString: { model: "svc", max_tokens: 10, messages: [{ role: "user", content: "hi" }], tools: [{ name: "t" }], tool_choice: "auto" },
  junk: { messages: [null, { role: "assistant", content: 5 }], system: 7 },
};

const RESPONSES_REQUESTS: Record<string, Json> = {
  plain: { model: "svc", instructions: "sys", input: "hi", stream: true },
  emptyInput: { model: "svc", input: "" },
  params: { model: "svc", input: "hi", temperature: 0.3, top_p: 0.9, max_output_tokens: 700, reasoning: { effort: "high", summary: "auto" }, text: { verbosity: "high", format: { type: "json_schema", name: "n", schema: { type: "object" }, strict: false } },
    parallel_tool_calls: true, service_tier: "auto", user: "u-2", prompt_cache_options: {}, previous_response_id: "resp_old", background: true, conversation: "c", prompt: { id: "p" }, truncation: "auto", store: true },
  textFormats: { model: "svc", input: "hi", text: { format: { type: "json_object" }, verbosity: "shout" }, max_output_tokens: 0 },
  textPlain: { model: "svc", input: "hi", text: { format: { type: "text" } } },
  textSchemaBare: { model: "svc", input: "hi", text: { format: { type: "json_schema" } } },
  tools: {
    model: "svc", input: "hi",
    tools: [
      null,
      { type: "function", name: "f1", description: "d", parameters: { type: "object", properties: { a: {} } }, strict: false },
      { type: "function", name: "f2" },
      { type: "web_search", search_context_size: "low" },
      { type: "mcp", name: "named-native", server_url: "https://mcp" },
      { type: "function" },
      { name: "typeless" },
    ],
    tool_choice: { type: "function", name: "f1" },
  },
  history: {
    model: "svc",
    input: [
      { role: "system", content: "s1" },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "d1" }] },
      { role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: PNG }, { type: "input_image", image_url: { url: "https://img/z.png" } }, { type: "input_image", image_url: "" }, { type: "input_image" }, { type: "text", text: "t" }, { type: "refusal", refusal: "no" }, { type: "refusal" }] },
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "sum" }, { type: "other", text: "x" }], encrypted_content: "enc-1" },
      { type: "function_call", call_id: "c1", name: "f1", arguments: "{\"a\":1}" },
      { type: "function_call_output", call_id: "c1", output: "out" },
      { type: "reasoning", id: "", content: [{ type: "reasoning_text", text: "raw" }, null], summary: [{ type: "summary_text", text: "ignored" }] },
      { type: "function_call", name: "f2", arguments: { already: "object" } },
      { type: "function_call_output", output: [{ type: "output_text", text: "arr" }, { type: "input_text", text: "ay" }] },
      { type: "reasoning", summary: [], encrypted_content: WRAPPED_FOREIGN },
      { type: "reasoning", summary: [], encrypted_content: WRAPPED_REDACTED },
      { type: "reasoning", summary: [] },
      { role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      { role: "assistant", content: [] },
      { type: "unknown_item" },
      null,
      { role: "user", content: "next" },
    ],
  },
  search: {
    model: "svc",
    input: [
      { role: "user", content: "find" },
      { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "q", sources: [{ type: "url", url: "https://a" }, { title: "no url" }, null] } },
      { type: "web_search_call", id: "ws_2", status: "failed", action: { query: "q2" } },
      { type: "web_search_call", id: "ws_3", status: "in_progress" },
      { type: "web_search_call", status: "searching", action: { query: "q4" } },
      { role: "user", content: "and" },
    ],
  },
  files: {
    model: "svc",
    input: [{ role: "user", content: [
      { type: "input_file", filename: "a.pdf", file_data: PDF },
      { type: "input_file", file_data: "QkJCQg==" },
      { type: "input_file", file_data: 12345 },
      { type: "input_file", file_url: "https://doc/b.pdf", file_data: PDF, filename: "b.pdf" },
      { type: "input_file", file_url: "" },
      { type: "input_file" },
    ] }],
  },
  fileId: { model: "svc", input: [{ role: "user", content: [{ type: "input_file", file_id: "file-resp", filename: "n" }] }] },
  ...Object.fromEntries(["none", "disabled", "minimal", "low", "medium", "high", "xhigh", "max", "bogus"].map(effort =>
    [`effort_${effort}`, { model: "svc", input: "hi", reasoning: { effort }, max_output_tokens: 2000 }])),
  effortNoMax: { model: "svc", input: "hi", reasoning: { effort: "low" } },
  reasoningNotObject: { model: "svc", input: "hi", reasoning: "high", text: "plain" },
  ...Object.fromEntries(["auto", "none", "required", "bogus"].map(choice =>
    [`choice_${choice}`, { model: "svc", input: "hi", tools: [{ type: "function", name: "f" }], tool_choice: choice }])),
  choiceNested: { model: "svc", input: "hi", tools: [{ type: "function", name: "f" }], tool_choice: { type: "function", function: { name: "f" } } },
  choiceWrongType: { model: "svc", input: "hi", tools: [{ type: "function", name: "f" }], tool_choice: { type: "custom", name: "f" } },
  junk: { input: 5, tools: "x" },
};

const REQUESTS: Record<Family, Record<string, Json>> = {
  openai_completion: COMPLETION_REQUESTS,
  anthropic: ANTHROPIC_REQUESTS,
  openai_responses: RESPONSES_REQUESTS,
};

describe("requests: every ingress body parsed, then rendered to every family", () => {
  for (const ingress of FAMILIES) {
    for (const [name, body] of Object.entries(REQUESTS[ingress])) {
      it(`${ingress} / ${name}`, () => {
        const request = attempt(() => parseRequest(ingress, structuredClone(body)));
        if (!request || typeof (request as { data?: unknown }).data !== "function") {
          expect(stable(request)).toMatchSnapshot("parse");
          return;
        }
        const data = (request as ReturnType<typeof parseRequest>).data();
        expect(stable(data)).toMatchSnapshot("canonical");
        for (const egress of FAMILIES) {
          for (const target of TARGETS) {
            expect(stable(attempt(() => buildRequest(egress, structuredClone(data)).render(target)))).toMatchSnapshot(`${egress} @ ${target.upstreamModel}`);
          }
        }
      });
    }
  }

  it("overrides and cache hints reach each renderer", () => {
    const base = parseRequest("openai_completion", { model: "svc", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "a", reasoning_content: "r" }, { role: "user", content: [{ type: "text", text: "u" }] }], prompt_cache_key: "k", user: "u" });
    for (const egress of FAMILIES) {
      for (const overrides of [
        { thinking: "high" as const, maxTokens: 50 }, { thinking: { budget: 3000 }, maxTokens: 9000 }, { thinking: "disabled" as const }, { thinking: "auto" as const, cacheTtlMinutes: 60 },
        { cacheTtlMinutes: 5, extra: { custom: 1 } }, { responseFormat: { type: "json_object" as const }, system: "override" }, { responseFormat: { type: "json_schema" as const, schema: { type: "object" } }, verbosity: "low" as const, stream: true },
        { parallelToolCalls: false }, { maxTokens: -5 }, { maxTokens: 0, thinking: "low" as const },
      ]) {
        for (const target of TARGETS) {
          expect(stable(attempt(() => buildRequest(egress, base.data()).withOverrides(overrides).render(target)))).toMatchSnapshot(`${egress} ${JSON.stringify(overrides)} @ ${target.upstreamModel}`);
        }
      }
    }
  });
});

// --- response corpus --------------------------------------------------------

const RESPONSE_BODIES: Record<Family, Record<string, Json>> = {
  openai_completion: {
    plain: { id: "c1", model: "up", created: 5, choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    usageDetails: { id: "c1", model: "up", choices: [{ message: { content: "x" }, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 0, prompt_tokens_details: { cached_tokens: 6 }, completion_tokens_details: { reasoning_tokens: 0 } } },
    usageNoTotal: { choices: [{ message: { content: "x" }, finish_reason: "content_filter" }], usage: { prompt_tokens: 10, completion_tokens: 4, prompt_cache_hit_tokens: 3 } },
    usageJunk: { choices: [{ message: { content: "x" }, finish_reason: "weird" }], usage: { prompt_tokens: "10", completion_tokens: null, total_tokens: "x", cached_tokens: 2 } },
    noUsage: { choices: [{ message: { content: "x" }, finish_reason: null }] },
    tools: { id: "c2", model: "up", created: 6, choices: [{ message: { content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{\"a\":1}" } }, { function: { arguments: "bad" } }, 4] }, finish_reason: "tool_calls" }] },
    functionCall: { choices: [{ message: { content: "" }, finish_reason: "function_call" }] },
    reasoning: { choices: [{ message: { content: [{ type: "text", text: "part" }, { type: "thinking", thinking: "pt" }], reasoning: "", reasoning_content: "rc", refusal: "nope" }, finish_reason: "stop" }] },
    reasoningDetails: { choices: [{ message: { content: "a", reasoning: "plain", reasoning_details: [{ type: "reasoning.encrypted", data: WRAPPED_FOREIGN }, { type: "reasoning.encrypted", data: WRAPPED_REDACTED }, { text: "bare" }] }, finish_reason: "stop" }] },
    empty: {},
  },
  anthropic: {
    plain: { id: "m1", model: "up", content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } },
    usageCache: { id: "m1", model: "up", content: [{ type: "text", text: "x" }], stop_reason: "max_tokens", usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, output_tokens_details: { thinking_tokens: 1 } } },
    usageJunk: { content: [{ type: "text", text: "x" }], stop_reason: "stop_sequence", usage: { input_tokens: "3", output_tokens: null, cache_read_input_tokens: "x" } },
    noUsage: { content: [], stop_reason: null },
    refusal: { content: [{ type: "text", text: "no" }], stop_reason: "refusal" },
    paused: { content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } }], stop_reason: "pause_turn" },
    weird: { content: [{ type: "text", text: "x" }, { type: "image", source: {} }, { type: "tool_result", tool_use_id: "z" }], stop_reason: "something_new" },
    tools: { id: "m2", model: "up", content: [{ type: "thinking", thinking: "th", signature: "sig" }, { type: "redacted_thinking", data: "opaque" }, { type: "text", text: "calling" }, { type: "tool_use", id: "tu1", name: "t", input: { a: 1 } }, { type: "tool_use" }], stop_reason: "tool_use" },
    serverTools: { id: "m3", model: "up", content: [
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://a", title: "A" }, { type: "web_search_result", title: "no url" }] },
      { type: "server_tool_use", id: "s2", name: "code_execution", input: {} },
      { type: "code_execution_tool_result", tool_use_id: "s2", content: { type: "code_execution_tool_result_error", error_code: "unavailable" } },
      { type: "web_search_result", tool_use_id: "s9", content: { error_code: "too_many_requests" } },
      { type: "text", text: "found" },
    ], stop_reason: "end_turn" },
    wrappedSignature: { content: [{ type: "thinking", thinking: "ignored", signature: WRAPPED_FOREIGN }, { type: "text", text: "a" }], stop_reason: "end_turn" },
  },
  openai_responses: {
    plain: { id: "r1", model: "up", created_at: 9, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } },
    usageDetails: { id: "r1", model: "up", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "x" }] }], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 0, input_tokens_details: { cached_tokens: 6 }, output_tokens_details: { reasoning_tokens: 0 } } },
    usageNoTotal: { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }], usage: { input_tokens: 10, output_tokens: 4, cached_tokens: 1 } },
    usageJunk: { status: "completed", output: [], usage: { input_tokens: "1", output_tokens: null, total_tokens: "t" } },
    incompleteLength: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "message", content: [{ type: "output_text", text: "cut" }] }] },
    incompleteBare: { status: "incomplete", output: [{ type: "function_call", call_id: "c", name: "f", arguments: "{}" }] },
    incompleteFilter: { status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] },
    paused: { status: "incomplete", incomplete_details: { reason: "pause_turn" }, output: [{ type: "web_search_call", id: "ws", status: "in_progress", action: { query: "q" } }] },
    pausedButCompleted: { status: "completed", incomplete_details: { reason: "pause_turn" }, output: [{ type: "message", content: [{ type: "output_text", text: "x" }] }] },
    tools: { id: "r2", model: "up", status: "completed", output: [
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "sum" }], encrypted_content: "enc" },
      { type: "reasoning", id: "", content: [{ type: "reasoning_text", text: "raw" }] },
      { type: "reasoning", summary: [] },
      { type: "reasoning", id: "rs_3", summary: [], encrypted_content: WRAPPED_FOREIGN },
      { type: "reasoning", id: "rs_4", summary: [], encrypted_content: WRAPPED_REDACTED },
      { type: "message", content: [{ type: "output_text", text: "calling" }] },
      { type: "function_call", id: "fc_1", call_id: "c1", name: "f", arguments: "{\"a\":1}" },
      { type: "function_call", id: "fc_2", name: "g", arguments: "bad" },
      { type: "function_call" },
      null,
    ] },
    search: { id: "r3", model: "up", status: "completed", output: [
      { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "q", sources: [{ type: "url", url: "https://a" }, { title: "t" }] } },
      { type: "web_search_call", id: "ws_2", status: "failed" },
      { type: "message", content: [{ type: "output_text", text: "found" }] },
    ] },
    empty: {},
  },
};

const THINKING_FORMATS: Array<ThinkingFormat | undefined> = [undefined, "reasoning", "reasoning_content"];

describe("responses: every upstream body parsed, then rendered to every family", () => {
  for (const egress of FAMILIES) {
    for (const [name, body] of Object.entries(RESPONSE_BODIES[egress])) {
      it(`${egress} / ${name}`, () => {
        const response = parseResponse(egress, structuredClone(body));
        expect(stable(response.data())).toMatchSnapshot("canonical");
        for (const ingress of FAMILIES) {
          for (const thinkingFormat of ingress === "openai_completion" ? THINKING_FORMATS : [undefined]) {
            expect(stable(response.render(ingress, "client-model", { thinkingFormat }))).toMatchSnapshot(`${ingress} ${thinkingFormat ?? ""}`);
          }
        }
      });
    }
  }

  const CANONICAL: Record<string, { content: ContentPart[]; stopReason: "stop" | "length" | "tool_use" | "content_filter" | "pause_turn" | null; usage?: Json }> = {
    empty: { content: [], stopReason: null },
    reasoningOrigins: { stopReason: "stop", content: [
      { type: "reasoning", text: "own-a", signature: "sa", origin: "anthropic" },
      { type: "reasoning", text: "own-r", signature: "sr", origin: "openai_responses", itemId: "rs_keep" },
      { type: "reasoning", text: "own-c", signature: "sc", origin: "openai_completion" },
      { type: "reasoning", text: "no-origin", signature: "sn" },
      { type: "reasoning", text: "unsigned" },
      { type: "reasoning", text: "", signature: "only-sig", origin: "openai_responses" },
      { type: "reasoning", text: "" },
      { type: "reasoning", text: "", redacted: true, signature: "opaque", origin: "anthropic", itemId: "rs_red" },
      { type: "text", text: "answer" },
    ] },
    serverTools: { stopReason: "pause_turn", content: [
      { type: "tool_use", id: "s0", name: "web_search", input: { query: "pending" }, serverTool: true },
      { type: "tool_use", id: "s00", name: "web_search", input: undefined, serverTool: true },
      { type: "server_tool_result", family: "anthropic", id: "s1", name: "web_search", input: { query: "q" }, blockType: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://a" }, { title: "no url" }, null] },
      { type: "server_tool_result", family: "anthropic", id: "s2", name: "web_search", input: { query: "q" }, blockType: "web_search_tool_result", content: [], errorCode: "max_uses_exceeded" },
      { type: "server_tool_result", family: "anthropic", id: "s3", name: "fetch", input: undefined, blockType: "web_fetch_result", content: [], errorCode: "unavailable" },
      { type: "server_tool_result", family: "openai_responses", id: "s4", name: "web_search", input: { query: "q" }, blockType: "web_search_call", content: [], notExecuted: true },
      { type: "tool_use", id: "c1", name: "f", input: undefined },
    ] },
    usage: { stopReason: "content_filter", content: [{ type: "text", text: "x" }], usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25, cachedInputTokens: 0, cacheCreationInputTokens: 30, reasoningTokens: 0 } },
    lengthStop: { stopReason: "length", content: [{ type: "text", text: "x" }], usage: { promptTokens: 20, completionTokens: 5, totalTokens: 0, cachedInputTokens: 4 } },
  };

  for (const [name, c] of Object.entries(CANONICAL)) {
    it(`canonical / ${name}`, () => {
      for (const ingress of FAMILIES) {
        const response = buildResponse(ingress, { id: "fixed-id", model: "up", created: 11, content: c.content, stopReason: c.stopReason, usage: (c.usage ?? { promptTokens: 1, completionTokens: 2, totalTokens: 3 }) as never });
        for (const thinkingFormat of ingress === "openai_completion" ? THINKING_FORMATS : [undefined]) {
          expect(stable(response.renderSelf("client-model", { thinkingFormat }))).toMatchSnapshot(`${ingress} ${thinkingFormat ?? ""}`);
        }
      }
    });
  }
});

// --- stream corpus ----------------------------------------------------------

const UPSTREAM_STREAMS: Record<Family, Record<string, string[]>> = {
  openai_completion: {
    text: [
      sse({ id: "c", model: "up", created: 4, choices: [{ delta: { role: "assistant" } }] }),
      sse({ choices: [{ delta: { content: "he" } }] }), sse({ choices: [{ delta: { content: "" } }] }),
      sse({ choices: [{ delta: { content: [{ type: "text", text: "l" }, { type: "thinking", thinking: "pt" }] } }] }),
      sse({ choices: [{ delta: { refusal: "no" } }] }),
      sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      sse({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }), sse("[DONE]"),
    ],
    usageCumulative: [
      sse({ choices: [{ delta: { content: "a" } }], usage: { prompt_tokens: 7 } }),
      sse({ choices: [{ delta: {} }], usage: {} }),
      sse({ choices: [{ delta: {} }], usage: { completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 1 } } }),
      sse({ choices: [{ delta: {} }], usage: { prompt_tokens_details: { cached_tokens: 4 } } }),
      sse({ choices: [{ delta: {} }], usage: { total_tokens: 0 } }),
      sse({ choices: [{ delta: {}, finish_reason: "length" }] }),
    ],
    reasoning: [
      sse({ id: "c", choices: [{ delta: { reasoning: "", reasoning_content: "rc" } }] }),
      sse({ choices: [{ delta: { thinking: "th" } }] }),
      sse({ choices: [{ delta: { reasoning_details: [{ type: "reasoning.encrypted", data: WRAPPED_FOREIGN }] } }] }),
      sse({ choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "detail" }, { type: "reasoning.encrypted", data: WRAPPED_REDACTED }] } }] }),
      sse({ choices: [{ delta: { content: "a" }, finish_reason: "content_filter" }] }), sse("[DONE]"),
    ],
    tools: [
      sse({ id: "c", choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "f", arguments: "" } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"a\"" } }, { function: { arguments: ":1}" } }, null] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 1, function: { name: "g" } }, { index: 2, function: { arguments: "orphan" } }] } }] }),
      sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }), sse("[DONE]"),
    ],
    truncated: [sse({ id: "c", choices: [{ delta: { content: "cut" } }] })],
    doneOnly: [sse("not json"), sse("[DONE]")],
    nothing: [],
  },
  anthropic: {
    text: [
      sse({ type: "message_start", message: { id: "m", model: "up", usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 2 } } }, "message_start"),
      sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "pre" } }, "content_block_start"),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } }, "content_block_delta"),
      sse({ type: "content_block_stop", index: 0 }, "content_block_stop"),
      sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }, "message_delta"),
      sse({ type: "message_stop" }, "message_stop"),
    ],
    usageGuards: [
      sse({ type: "message_start", message: { usage: { input_tokens: "3", output_tokens: "1", cache_read_input_tokens: "x", output_tokens_details: { thinking_tokens: 2 } } } }),
      sse({ type: "message_delta", delta: {}, usage: { output_tokens: "seven", input_tokens: 40, cache_creation_input_tokens: 0 } }),
      sse({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 9, input_tokens: "x", cache_read_input_tokens: 6, output_tokens_details: { thinking_tokens: 3 } } }),
      sse({ type: "message_delta", delta: { stop_reason: "" }, usage: {} }),
      sse({ type: "message_stop", usage: { output_tokens: "x", input_tokens: 50, cache_read_input_tokens: 7, cache_creation_input_tokens: 1, output_tokens_details: { thinking_tokens: 4 } } }),
    ],
    stopUsageOnly: [
      sse({ type: "message_start", message: { id: "m" } }),
      sse({ type: "message_stop", usage: { output_tokens: 8, input_tokens: "y" } }),
    ],
    thinkingAndTools: [
      sse({ type: "message_start", message: { id: "m", model: "up", usage: { input_tokens: 1, output_tokens: 0 } } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "seed" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "more" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "si" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "g" } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque" } }),
      sse({ type: "content_block_stop", index: 1 }),
      sse({ type: "content_block_start", index: 2, content_block: { type: "thinking", thinking: "", signature: WRAPPED_FOREIGN } }),
      sse({ type: "content_block_stop", index: 2 }),
      sse({ type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "tu", name: "t" } }),
      sse({ type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: "{\"a\":1}" } }),
      sse({ type: "content_block_stop", index: 3 }),
      sse({ type: "content_block_start", index: 4, content_block: { type: "tool_use" } }),
      sse({ type: "content_block_stop", index: 9 }),
      sse({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } }),
      sse({ type: "message_stop" }),
    ],
    serverTools: [
      sse({ type: "message_start", message: { id: "m" } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "s1", name: "web_search", input: {} } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"query\":" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "\"q\"}" } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://a" }] } }),
      sse({ type: "content_block_stop", index: 1 }),
      sse({ type: "content_block_start", index: 2, content_block: { type: "server_tool_use", id: "s2", name: "fetch", input: { url: "u" } } }),
      sse({ type: "content_block_stop", index: 2 }),
      sse({ type: "content_block_start", index: 3, content_block: { type: "web_fetch_tool_result", tool_use_id: "s2", content: { type: "web_fetch_tool_result_error", error_code: "unavailable" } } }),
      sse({ type: "content_block_start", index: 4, content_block: { type: "web_search_result", tool_use_id: "unknown", content: null } }),
      sse({ type: "content_block_start", index: 5, content_block: { type: "server_tool_result", content: ["e"] } }),
      sse({ type: "content_block_start", index: 6, content_block: { type: "web_search_tool_result", tool_use_id: "s3", content: [{ error_code: "in array" }] } }),
      sse({ type: "message_delta", delta: { stop_reason: "pause_turn" } }),
      sse({ type: "message_stop" }),
    ],
    truncated: [sse({ type: "message_start", message: { id: "m", usage: { input_tokens: 2 } } }), sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "cut" } })],
    nothing: [],
  },
  openai_responses: {
    text: [
      sse({ type: "response.created", response: { id: "r", model: "up", created_at: 8 } }, "response.created"),
      sse({ type: "response.output_text.delta", item_id: "m1", output_index: 0, content_index: 0, delta: "hel" }),
      sse({ type: "response.output_text.delta", item_id: "m1", output_index: 0, content_index: 0, delta: "" }),
      sse({ type: "response.output_text.done", item_id: "m1", output_index: 0, content_index: 0, text: "hello" }),
      sse({ type: "response.refusal.delta", item_id: "m1", content_index: 1, delta: "no" }),
      sse({ type: "response.refusal.done", item_id: "m1", content_index: 1, refusal: "nope" }),
      sse({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m1", content: [{ type: "output_text", text: "hello!" }, { type: "refusal", refusal: "nope." }, { type: "text", text: "third" }, null] } }),
      sse({ type: "response.completed", response: { id: "r", output: [{ type: "message", id: "m1", content: [{ type: "output_text", text: "hello!?" }] }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5, input_tokens_details: { cached_tokens: 1 }, output_tokens_details: { reasoning_tokens: 0 } } } }),
    ],
    usageZeroTotal: [
      sse({ type: "response.in_progress", response: {} }),
      sse({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 4, total_tokens: 0 } } }),
    ],
    usageJunk: [sse({ type: "response.completed", response: { usage: { input_tokens: "x", output_tokens: 4, total_tokens: "t", output_tokens_details: { reasoning_tokens: "r" } } } })],
    usageAbsent: [sse({ type: "response.completed", response: { id: "late", model: "late-model", created_at: 3, usage: { total_tokens: 9 } } })],
    reasoningAndTools: [
      sse({ type: "response.created", response: { id: "r" } }),
      sse({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } }),
      sse({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "think" }),
      sse({ type: "response.reasoning_text.delta", delta: "more" }),
      sse({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "think" }], encrypted_content: "enc" } }),
      sse({ type: "response.reasoning_summary_text.delta", item_id: "rs_2", delta: "" }),
      sse({ type: "response.output_item.done", output_index: 1, item: { type: "reasoning", id: "rs_2", summary: [{ type: "summary_text", text: "snapshot-only" }] } }),
      sse({ type: "response.output_item.done", output_index: 2, item: { type: "reasoning", id: "rs_3", summary: [], encrypted_content: WRAPPED_FOREIGN } }),
      sse({ type: "response.output_item.done", output_index: 3, item: { type: "reasoning", summary: [], encrypted_content: WRAPPED_REDACTED } }),
      sse({ type: "response.output_item.added", output_index: 4, item: { type: "function_call", id: "fc_1", call_id: "c1", name: "f" } }),
      sse({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{\"a\"" }),
      sse({ type: "response.function_call_arguments.delta", item_id: "nope", delta: "x" }),
      sse({ type: "response.output_item.done", output_index: 4, item: { type: "function_call", id: "fc_1", call_id: "c1", name: "f", arguments: "{\"a\":1}" } }),
      sse({ type: "response.output_item.done", output_index: 5, item: { type: "function_call", id: "fc_2", name: "g", arguments: "{}" } }),
      sse({ type: "response.output_item.added", output_index: 6, item: { type: "function_call" } }),
      sse({ type: "response.output_item.done", output_index: 4, item: { type: "function_call", id: "fc_1", call_id: "c1", name: "f", arguments: "{\"a\":1}" } }),
      sse({ type: "response.completed", response: { output: [{ type: "function_call", id: "fc_3", call_id: "c3", name: "h", arguments: 5 }], usage: { input_tokens: 1, output_tokens: 1 } } }),
    ],
    search: [
      sse({ type: "response.created", response: { id: "r" } }),
      sse({ type: "response.output_item.done", output_index: 0, item: { type: "web_search_call", id: "ws_1", status: "completed", action: { query: "q", sources: [{ url: "https://a" }] } } }),
      sse({ type: "response.output_item.done", output_index: 1, item: { type: "web_search_call", id: "ws_2", status: "failed" } }),
      sse({ type: "response.output_item.done", output_index: 2, item: { type: "web_search_call", id: "ws_3", status: "searching" } }),
      sse({ type: "response.completed", response: { output: [] } }),
    ],
    incompleteLength: [sse({ type: "response.incomplete", response: { id: "r", incomplete_details: { reason: "max_output_tokens" } } })],
    incompleteBare: [sse({ type: "response.incomplete", response: { id: "r" } })],
    incompleteFilter: [sse({ type: "response.incomplete", response: { id: "r", incomplete_details: { reason: "content_filter" } } })],
    paused: [sse({ type: "response.incomplete", response: { id: "r", incomplete_details: { reason: "pause_turn" } } })],
    failed: [sse({ type: "response.output_item.added", item: { type: "function_call", id: "fc", call_id: "c", name: "f" } }), sse({ type: "response.failed", response: { usage: { input_tokens: 2, output_tokens: 0 } } })],
    truncated: [sse({ type: "response.created", response: { id: "r" } }), sse({ type: "response.output_text.delta", delta: "cut" })],
    nothing: [],
    foreignEvents: [sse({ type: "ping" }), sse({ type: "response.completed", response: {} })],
  },
};

const START: StreamEvent = { type: "start", id: "start-id", model: "up", created: 12, inputTokens: 30, cachedInputTokens: 10, cacheCreationInputTokens: 5 };
const USAGE = { promptTokens: 30, completionTokens: 6, totalTokens: 36, cachedInputTokens: 10, cacheCreationInputTokens: 5, reasoningTokens: 2 };

const CANONICAL_STREAMS: Record<string, StreamEvent[]> = {
  text: [START, { type: "text_delta", text: "he" }, { type: "text_delta", text: "llo" }, { type: "finish", stopReason: "stop", usage: USAGE }],
  bareStart: [{ type: "start", id: "", model: "", created: 0 }, { type: "text_delta", text: "x" }, { type: "finish", stopReason: null }],
  noStart: [{ type: "text_delta", text: "x" }, { type: "finish", stopReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }],
  empty: [START, { type: "finish", stopReason: "stop" }],
  length: [START, { type: "text_delta", text: "x" }, { type: "finish", stopReason: "length", usage: { promptTokens: 4, completionTokens: 1, totalTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 } }],
  contentFilter: [START, { type: "text_delta", text: "x" }, { type: "finish", stopReason: "content_filter" }],
  paused: [START, { type: "server_tool_start", family: "anthropic", id: "s1", name: "web_search", input: { query: "q" } }, { type: "finish", stopReason: "pause_turn", usage: USAGE }],
  incomplete: [START, { type: "text_delta", text: "x" }, { type: "finish", stopReason: "stop", incomplete: true }],
  errored: [START, { type: "text_delta", text: "x" }, { type: "finish", stopReason: "stop", error: "boom" }],
  reasoning: [
    START, { type: "reasoning_start", origin: "anthropic" }, { type: "reasoning_delta", text: "th" }, { type: "reasoning_delta", text: "ink" }, { type: "reasoning_stop", origin: "anthropic", signature: "sig-a" },
    { type: "reasoning_start", origin: "openai_responses", id: "rs_1" }, { type: "reasoning_delta", text: "r2" }, { type: "reasoning_stop", origin: "openai_responses", id: "rs_1", signature: "enc-r" },
    { type: "reasoning_start" }, { type: "reasoning_stop" },
    { type: "reasoning_delta", text: "bare" }, { type: "text_delta", text: "answer" }, { type: "reasoning_delta", text: "late" }, { type: "reasoning_stop", signature: "no-origin" },
    { type: "reasoning_stop", id: "rs_orphan", signature: "orphan", origin: "openai_completion" },
    { type: "finish", stopReason: "stop", usage: USAGE },
  ],
  redacted: [
    START, { type: "text_delta", text: "pre" }, { type: "reasoning_start", origin: "anthropic", redacted: true, signature: "opaque", id: "rs_red" }, { type: "reasoning_delta", text: "ignored" }, { type: "reasoning_stop", origin: "anthropic", redacted: true, signature: "opaque" },
    { type: "reasoning_stop", redacted: true, signature: "stop-only" }, { type: "reasoning_start", redacted: true }, { type: "reasoning_stop" },
    { type: "text_delta", text: "answer" }, { type: "finish", stopReason: "stop" },
  ],
  tools: [
    START, { type: "reasoning_delta", text: "plan" }, { type: "tool_start", index: 0, id: "c1", name: "f" }, { type: "tool_args_delta", index: 0, delta: "{\"a\"" }, { type: "tool_args_delta", index: 0, delta: ":1}" },
    { type: "tool_args_delta", index: 7, delta: "orphan" }, { type: "tool_stop", index: 0 }, { type: "tool_stop", index: 7 },
    { type: "text_delta", text: "between" }, { type: "tool_start", index: 1, id: "c2", name: "g" }, { type: "tool_start", index: 2, id: "c3", name: "h" }, { type: "tool_args_delta", index: 2, delta: "{}" },
    { type: "finish", stopReason: "tool_use", usage: USAGE },
  ],
  serverTools: [
    START, { type: "text_delta", text: "searching" },
    { type: "server_tool_start", family: "anthropic", id: "s1", name: "web_search", input: { query: "q" } },
    { type: "server_tool_result", family: "anthropic", id: "s1", name: "web_search", blockType: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://a" }, { title: "no url" }] },
    { type: "server_tool_start", family: "anthropic", id: "s2", name: "web_search", input: undefined },
    { type: "server_tool_result", family: "anthropic", id: "s2", name: "web_search", blockType: "web_search_tool_result", content: [], errorCode: "max_uses_exceeded" },
    { type: "server_tool_result", family: "anthropic", id: "s3", name: "fetch", blockType: "web_fetch_result", content: [], errorCode: "unavailable" },
    { type: "server_tool_start", family: "openai_responses", id: "s4", name: "web_search", input: { query: "paused" } },
    { type: "server_tool_result", family: "openai_responses", id: "s4", name: "web_search", blockType: "web_search_call", content: [], notExecuted: true },
    { type: "server_tool_result", id: "s5", name: "web_search", blockType: "web_search_call", content: [] } as StreamEvent,
    { type: "server_tool_start", family: "anthropic", id: "s6", name: "web_search", input: { query: "never answered" } },
    { type: "finish", stopReason: "stop", usage: USAGE },
  ],
};

describe("streams", () => {
  for (const egress of FAMILIES) {
    for (const [name, frames] of Object.entries(UPSTREAM_STREAMS[egress])) {
      it(`parse ${egress} / ${name}`, async () => {
        expect(stable(await parsed(egress, frames))).toMatchSnapshot();
      });
    }
  }

  for (const [name, list] of Object.entries(CANONICAL_STREAMS)) {
    it(`serialize / ${name}`, async () => {
      for (const ingress of FAMILIES) {
        for (const thinkingFormat of ingress === "openai_completion" ? THINKING_FORMATS : [undefined]) {
          expect(stable(await serialized(ingress, structuredClone(list), thinkingFormat))).toMatchSnapshot(`${ingress} ${thinkingFormat ?? ""}`);
        }
      }
    });
  }

  it("relays every upstream stream into every client family", async () => {
    for (const egress of FAMILIES) {
      for (const [name, frames] of Object.entries(UPSTREAM_STREAMS[egress])) {
        for (const ingress of FAMILIES) {
          expect(stable(await serialized(ingress, await parsed(egress, frames)))).toMatchSnapshot(`${egress} / ${name} -> ${ingress}`);
        }
      }
    }
  });
});
