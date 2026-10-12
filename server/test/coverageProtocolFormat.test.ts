/**
 * Format-layer coverage: request parameters, structured output, images, tool
 * definitions and choices, stop reasons and reasoning envelopes, each asserted
 * on what a parse yields and what a render puts on the upstream wire.
 */
import { describe, expect, it } from "vitest";
import {
  AnthropicRequest,
  AnthropicResponse,
  OpenAICompletionRequest,
  OpenAICompletionResponse,
  OpenAIResponsesRequest,
  buildResponse,
} from "../src/core/format";
import { decodeReasoning, encodeReasoning, parseChatReasoningDetails } from "../src/core/format/reasoningBridge";
import type { StopReason } from "../src/core/ir/content";
import type { Request } from "../src/core/ir/request";

type Json = Record<string, any>;
const target = { upstreamModel: "up" };
const user = [{ role: "user", content: "hi" }];
const chat = (extra: Json = {}) => OpenAICompletionRequest.parse({ model: "svc", messages: user, ...extra });
const anth = (extra: Json = {}) => AnthropicRequest.parse({ model: "svc", max_tokens: 100, messages: user, ...extra });
const resp = (extra: Json = {}) => OpenAIResponsesRequest.parse({ model: "svc", input: "hi", ...extra });
const toChat = (req: Request, model = "up"): Json => OpenAICompletionRequest.construct(req).render({ upstreamModel: model });
const toAnth = (req: Request): Json => AnthropicRequest.construct(req).render(target);
const toResp = (req: Request): Json => OpenAIResponsesRequest.construct(req).render(target);

describe("Chat sampling parameters", () => {
  const sampling = {
    top_p: 0.9, top_k: 40, min_p: 0.05, frequency_penalty: 0.1, presence_penalty: 0.2, repetition_penalty: 1.1, seed: 7, n: 1,
    logprobs: true, top_logprobs: 3, logit_bias: { "50256": -100 }, service_tier: "flex", user: "u", verbosity: "low",
  };
  const openAiOnly = ["seed", "frequency_penalty", "presence_penalty", "repetition_penalty", "logit_bias", "logprobs", "top_logprobs", "n", "min_p"];
  const req = chat({ ...sampling, stop: "END" });

  it("survive a Chat-to-Chat hop one by one", () => {
    const body = toChat(req);
    for (const [key, value] of Object.entries(sampling)) expect(body[key], key).toEqual(value);
    expect(body.stop).toEqual(["END"]);
  });

  it("reach a Responses upstream only where that wire has a place for them", () => {
    const body = toResp(req);
    expect(body).toMatchObject({ top_p: 0.9, service_tier: "flex", user: "u", text: { verbosity: "low" } });
    for (const key of [...openAiOnly, "top_k", "stop", "verbosity"]) expect(body, key).not.toHaveProperty(key);
  });

  it("reach an Anthropic upstream under that wire's names", () => {
    const body = toAnth(req);
    expect(body).toMatchObject({ top_k: 40, top_p: 0.9, stop_sequences: ["END"], metadata: { user_id: "u" } });
    for (const key of [...openAiOnly, "stop", "user", "service_tier", "verbosity"]) expect(body, key).not.toHaveProperty(key);
  });

  it("drop a value of the wrong type instead of forwarding it", () => {
    const body = toChat(chat({ verbosity: "extreme", temperature: "0.5", top_p: 0.5 }));
    expect(body).not.toHaveProperty("verbosity");
    expect(body).not.toHaveProperty("temperature");
    expect(body.top_p).toBe(0.5);
  });
});

describe("structured output", () => {
  const S = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
  const note = `Respond ONLY with a valid JSON object matching this JSON Schema: ${JSON.stringify(S)}. No prose, no markdown fences.`;
  const strictChat = { type: "json_schema", json_schema: { name: "person", schema: S, strict: true } };

  it("carries a Chat json_schema to every family", () => {
    const req = chat({ response_format: strictChat });
    expect(req.params.responseFormat).toEqual({ type: "json_schema", name: "person", schema: S, strict: true });
    expect(toChat(req).response_format).toEqual(strictChat);
    expect(toResp(req).text).toEqual({ format: { type: "json_schema", name: "person", schema: S, strict: true } });
    expect(toAnth(req).system).toBe(note);
  });

  it("appends the Anthropic schema instruction after an existing system prompt", () => {
    const req = chat({ response_format: strictChat, messages: [{ role: "system", content: "be terse" }, ...user] });
    expect(toAnth(req).system).toBe(`be terse\n\n${note}`);
  });

  it("fills in a default name and schema and omits strict when the client did", () => {
    const req = chat({ response_format: { type: "json_schema", json_schema: {} } });
    expect(toChat(req).response_format).toEqual({ type: "json_schema", json_schema: { name: "schema", schema: {} } });
    expect(toResp(req).text).toEqual({ format: { type: "json_schema", name: "schema", schema: {} } });
  });

  it("carries a Responses text.format json_schema to Chat", () => {
    const req = resp({ text: { format: { type: "json_schema", name: "person", schema: S, strict: true } } });
    expect(toChat(req).response_format).toEqual(strictChat);
    expect(toResp(req).text).toEqual({ format: { type: "json_schema", name: "person", schema: S, strict: true } });
  });

  it("carries json_object as a format on both OpenAI wires", () => {
    const req = chat({ response_format: { type: "json_object" } });
    expect(toChat(req).response_format).toEqual({ type: "json_object" });
    expect(toResp(req).text).toEqual({ format: { type: "json_object" } });
  });

  it("leaves the Anthropic system prompt alone for a text format", () => {
    const req = chat({ response_format: { type: "text" }, messages: [{ role: "system", content: "be terse" }, ...user] });
    expect(toAnth(req).system).toBe("be terse");
    expect(toAnth(chat({ response_format: { type: "text" } }))).not.toHaveProperty("system");
  });

  it("forwards a response_format type it does not model verbatim on a same-family hop, and nowhere else", () => {
    const req = chat({ response_format: { type: "grammar", grammar: "root ::= x" } });
    expect(req.params.responseFormat).toBeUndefined();
    expect(toChat(req).response_format).toEqual({ type: "grammar", grammar: "root ::= x" });
    expect(JSON.stringify(toAnth(req))).not.toContain("grammar");
  });
});

describe("user images across families", () => {
  const chatImage = (image_url: unknown) => chat({ messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url }] }] });
  const lastContent = (body: Json): Json[] => body.messages.at(-1).content;
  const inputContent = (body: Json): Json[] => (body.input as Json[]).at(-1)!.content;

  it("turns a Chat data URL into an Anthropic base64 source and a Responses input_image", () => {
    const req = chatImage({ url: "data:image/jpeg;base64,QUJD" });
    expect(req.messages[0].content[1]).toEqual({ type: "image", source: { kind: "base64", mediaType: "image/jpeg", data: "QUJD" } });
    expect(lastContent(toAnth(req))).toEqual([
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
    ]);
    expect(inputContent(toResp(req))).toEqual([
      { type: "input_text", text: "look" },
      { type: "input_image", image_url: "data:image/jpeg;base64,QUJD" },
    ]);
    expect(lastContent(toChat(req))).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
    ]);
  });

  it("turns a Chat https URL into an Anthropic url source, in object and bare-string form", () => {
    for (const form of [{ url: "https://x/y.png" }, "https://x/y.png"]) {
      const req = chatImage(form);
      expect(lastContent(toAnth(req))[1]).toEqual({ type: "image", source: { type: "url", url: "https://x/y.png" } });
      expect(inputContent(toResp(req))[1]).toEqual({ type: "input_image", image_url: "https://x/y.png" });
    }
  });

  it("renders an Anthropic image as a Chat content array and text alone as a string", () => {
    const withImage = anth({ messages: [{ role: "user", content: [
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
    ] }] });
    expect(lastContent(toChat(withImage))).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
    ]);
    const textOnly = anth({ messages: [{ role: "user", content: [{ type: "text", text: "look" }] }] });
    expect(toChat(textOnly).messages.at(-1).content).toBe("look");
  });

  it("carries an Anthropic url image to both OpenAI wires", () => {
    const req = anth({ messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://x/y.png" } }] }] });
    expect(lastContent(toChat(req))).toEqual([{ type: "image_url", image_url: { url: "https://x/y.png" } }]);
    expect(inputContent(toResp(req))).toEqual([{ type: "input_image", image_url: "https://x/y.png" }]);
  });

  it("assumes image/png for an Anthropic base64 image with no media type", () => {
    const req = anth({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: "QUJD" } }] }] });
    expect(req.messages[0].content[0]).toEqual({ type: "image", source: { kind: "base64", mediaType: "image/png", data: "QUJD" } });
    expect(lastContent(toChat(req))).toEqual([{ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }]);
  });

  it("reads a Responses input_image in string and object form and drops an empty one", () => {
    const image = (image_url: unknown) => resp({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url }] }] });
    for (const form of ["https://x/y.png", { url: "https://x/y.png" }]) {
      expect(image(form).messages[0].content).toEqual([{ type: "text", text: "look" }, { type: "image", source: { kind: "url", url: "https://x/y.png" } }]);
    }
    expect(image("data:image/jpeg;base64,QUJD").messages[0].content[1]).toEqual({ type: "image", source: { kind: "base64", mediaType: "image/jpeg", data: "QUJD" } });
    expect(image("").messages[0].content).toEqual([{ type: "text", text: "look" }]);
    expect(lastContent(toAnth(image("https://x/y.png")))[1]).toEqual({ type: "image", source: { type: "url", url: "https://x/y.png" } });
  });
});

describe("output-ceiling key by upstream model", () => {
  const req = chat({ max_tokens: 100 });
  it.each(["gpt-5", "gpt-5.1", "gpt-5-mini", "o1", "o4-mini", "O3", "openai/gpt-5"])("sends max_completion_tokens to %s", model => {
    const body = toChat(req, model);
    expect(body.max_completion_tokens).toBe(100); expect(body).not.toHaveProperty("max_tokens");
  });
  it.each(["gpt-50", "gpt-4o", "o10", "omni-x", "openai/gpt-4o"])("sends max_tokens to %s", model => {
    const body = toChat(req, model);
    expect(body.max_tokens).toBe(100); expect(body).not.toHaveProperty("max_completion_tokens");
  });
});

describe("stop reasons", () => {
  const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
  const anthStop = (stop_reason: unknown) => AnthropicResponse.parse({ id: "m", model: "up", content: [{ type: "text", text: "x" }], stop_reason, usage: {} }).stopReason;
  const chatStop = (finish_reason: unknown) => OpenAICompletionResponse.parse({ id: "c", model: "up", choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason }] }).stopReason;
  const rendered = (stopReason: StopReason | null) => {
    const data = { id: "r", model: "up", created: 1, content: [{ type: "text" as const, text: "x" }], stopReason, usage };
    const chatBody = buildResponse("openai_completion", data).renderSelf("svc") as Json;
    return { anthropic: (buildResponse("anthropic", data).renderSelf("svc") as Json).stop_reason, chat: chatBody.choices[0].finish_reason };
  };

  it.each([
    ["end_turn", "stop"], ["stop_sequence", "stop"], ["max_tokens", "length"], ["tool_use", "tool_use"],
    ["refusal", "content_filter"], ["pause_turn", "pause_turn"], ["weird", "stop"], [null, null],
  ])("parses Anthropic stop_reason %s as %s", (wire, canonical) => expect(anthStop(wire)).toBe(canonical));

  it.each([
    ["stop", "stop"], ["length", "length"], ["tool_calls", "tool_use"], ["function_call", "tool_use"],
    ["content_filter", "content_filter"], ["weird", "stop"], [null, null],
  ])("parses Chat finish_reason %s as %s", (wire, canonical) => expect(chatStop(wire)).toBe(canonical));

  it.each<[StopReason | null, string, string]>([
    ["stop", "end_turn", "stop"], ["length", "max_tokens", "length"], ["tool_use", "tool_use", "tool_calls"],
    ["content_filter", "refusal", "content_filter"], ["pause_turn", "pause_turn", "stop"], [null, "end_turn", "stop"],
  ])("renders %s as Anthropic %s and Chat %s", (canonical, anthropicWire, chatWire) => {
    expect(rendered(canonical)).toEqual({ anthropic: anthropicWire, chat: chatWire });
  });
});

describe("Chat reasoning_effort parsing", () => {
  it("reads `disabled` as thinking off", () => {
    expect(chat({ reasoning_effort: "disabled" }).params.thinking).toBe("disabled");
  });
  it("ignores an unrecognised effort that comes with no output ceiling", () => {
    const req = chat({ reasoning_effort: "auto" });
    expect(req.params.thinking).toBeUndefined();
    expect(toChat(req)).not.toHaveProperty("reasoning_effort");
  });
});

describe("tool choice", () => {
  const fn = { type: "function", function: { name: "f", parameters: { type: "object" } } };
  const withChoice = (extra: Json) => chat({ tools: [fn], ...extra });

  it("carries a named tool across all three families and back", () => {
    const fromChat = withChoice({ tool_choice: { type: "function", function: { name: "f" } } });
    expect(fromChat.toolChoice).toEqual({ type: "tool", name: "f" });
    expect(toAnth(fromChat).tool_choice).toEqual({ type: "tool", name: "f" });
    expect(toResp(fromChat).tool_choice).toEqual({ type: "function", name: "f" });
    expect(toChat(fromChat).tool_choice).toEqual({ type: "function", function: { name: "f" } });

    const fromAnth = anth({ tools: [{ name: "f", input_schema: { type: "object" } }], tool_choice: { type: "tool", name: "f" } });
    expect(toChat(fromAnth).tool_choice).toEqual({ type: "function", function: { name: "f" } });
    expect(toResp(fromAnth).tool_choice).toEqual({ type: "function", name: "f" });

    const fromResp = resp({ tools: [{ type: "function", name: "f", parameters: { type: "object" } }], tool_choice: { type: "function", name: "f" } });
    expect(toAnth(fromResp).tool_choice).toEqual({ type: "tool", name: "f" });
    expect(toChat(fromResp).tool_choice).toEqual({ type: "function", function: { name: "f" } });
  });

  it("carries none and required", () => {
    expect(toAnth(withChoice({ tool_choice: "none" })).tool_choice).toEqual({ type: "none" });
    expect(toResp(withChoice({ tool_choice: "none" })).tool_choice).toBe("none");
    expect(toAnth(withChoice({ tool_choice: "required" })).tool_choice).toEqual({ type: "any" });
    expect(toResp(withChoice({ tool_choice: "required" })).tool_choice).toBe("required");
  });

  it("reads an Anthropic tool choice with no name as required", () => {
    const req = anth({ tools: [{ name: "f", input_schema: { type: "object" } }], tool_choice: { type: "tool" } });
    expect(req.toolChoice).toEqual({ type: "required" });
    expect(toChat(req).tool_choice).toBe("required");
  });

  it("folds parallel_tool_calls:false into the Anthropic tool choice", () => {
    expect(toAnth(withChoice({ parallel_tool_calls: false, tool_choice: "none" })).tool_choice).toEqual({ type: "none" });
    expect(toAnth(withChoice({ parallel_tool_calls: false })).tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(toAnth(withChoice({ parallel_tool_calls: false, tool_choice: { type: "function", function: { name: "f" } } })).tool_choice)
      .toEqual({ type: "tool", name: "f", disable_parallel_tool_use: true });
    expect(toAnth(withChoice({ parallel_tool_calls: false, tool_choice: "required" })).tool_choice).toEqual({ type: "any", disable_parallel_tool_use: true });
    expect(toAnth(withChoice({ parallel_tool_calls: true })).tool_choice).toBeUndefined();
    expect(toChat(withChoice({ parallel_tool_calls: false })).parallel_tool_calls).toBe(false);
  });
});

describe("tool definitions", () => {
  it("keeps strict and description on the OpenAI wires and drops strict for Anthropic", () => {
    const req = chat({ tools: [{ type: "function", function: { name: "f", description: "does f", strict: true, parameters: { type: "object", properties: { a: { type: "string" } } } } }] });
    const parameters = { type: "object", properties: { a: { type: "string" } } };
    expect(toChat(req).tools).toEqual([{ type: "function", function: { name: "f", description: "does f", strict: true, parameters } }]);
    expect(toResp(req).tools).toEqual([{ type: "function", name: "f", description: "does f", strict: true, parameters }]);
    expect(toAnth(req).tools).toEqual([{ name: "f", description: "does f", input_schema: parameters }]);
  });

  it("gives a function with no parameters an empty object schema", () => {
    const req = chat({ tools: [{ type: "function", function: { name: "f" } }] });
    const empty = { type: "object", properties: {} };
    expect(toChat(req).tools[0].function.parameters).toEqual(empty);
    expect(toResp(req).tools[0].parameters).toEqual(empty);
    expect(toAnth(req).tools[0].input_schema).toEqual(empty);
    expect(toChat(req).tools[0].function).not.toHaveProperty("strict");
  });

  it("skips an Anthropic tool entry that has neither a name nor a type", () => {
    const req = anth({ tools: [{ description: "nameless", input_schema: { type: "object" } }, { name: "f", description: "does f", input_schema: { type: "object" } }] });
    expect(req.tools?.map(tool => tool.name)).toEqual(["f"]);
    expect(toAnth(req).tools).toEqual([{ name: "f", description: "does f", input_schema: { type: "object" } }]);
  });
});

describe("Anthropic tool_result is_error", () => {
  const turn = (is_error?: boolean) => anth({ messages: [
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", ...(is_error === undefined ? {} : { is_error }) }] },
  ] });
  const resultBlock = (body: Json): Json => (body.messages.at(-1).content as Json[]).find(block => block.type === "tool_result")!;

  it("survives an Anthropic-to-Anthropic hop when true and is not emitted when false", () => {
    expect(resultBlock(toAnth(turn(true)))).toMatchObject({ tool_use_id: "t1", is_error: true });
    expect(resultBlock(toAnth(turn(false)))).not.toHaveProperty("is_error");
    expect(resultBlock(toAnth(turn()))).not.toHaveProperty("is_error");
  });

  it("reaches a Chat upstream as a plain tool message", () => {
    const tool = (toChat(turn(true)).messages as Json[]).find(m => m.role === "tool")!;
    expect(tool).toEqual({ role: "tool", tool_call_id: "t1", content: "boom" });
  });
});

describe("system prompt assembly", () => {
  it("joins Chat system and developer messages with a blank line", () => {
    const req = chat({ messages: [{ role: "system", content: "a" }, { role: "developer", content: "b" }, ...user] });
    expect(req.system).toBe("a\n\nb"); expect(req.messages).toHaveLength(1);
  });
  it("joins the text parts of a Chat system message given as an array", () => {
    const req = chat({ messages: [{ role: "system", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }, ...user] });
    expect(req.system).toBe("ab");
  });
  it("joins Responses instructions with a developer input message", () => {
    const req = resp({ instructions: "i", input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "s" }] }, { type: "message", role: "user", content: "hi" }] });
    expect(req.system).toBe("i\n\ns"); expect(req.messages).toHaveLength(1);
  });
  it("treats a Responses input item with no type as a message and skips an empty one", () => {
    const req = resp({ input: [{ role: "user", content: "typeless" }, { type: "message", role: "user", content: [] }, { type: "message", role: "assistant", content: "" }] });
    expect(req.messages).toEqual([{ role: "user", content: [{ type: "text", text: "typeless" }] }]);
  });
});

describe("Responses function_call_output", () => {
  const output = (value: unknown) => resp({ input: [
    { type: "message", role: "user", content: "go" },
    { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: value },
  ] }).messages.flatMap(m => m.content).find(part => part.type === "tool_result");

  it("joins the text of an array output", () => {
    expect(output([{ type: "output_text", text: "a" }, { type: "input_text", text: "b" }])).toMatchObject({ toolUseId: "c1", content: [{ type: "text", text: "ab" }] });
  });
  it("keeps a string output", () => {
    expect(output("plain")).toMatchObject({ toolUseId: "c1", content: [{ type: "text", text: "plain" }] });
  });
  it("reads an object output as empty text", () => {
    expect(output({ a: 1 })).toMatchObject({ toolUseId: "c1", content: [{ type: "text", text: "" }] });
  });
});

describe("Anthropic documents", () => {
  const doc = (document: Json) => anth({ messages: [{ role: "user", content: [{ type: "document", ...document }] }] });

  it("reads a text source as a text part", () => {
    expect(doc({ source: { type: "text", data: "body" } }).messages[0].content).toEqual([{ type: "text", text: "body" }]);
  });
  it("rejects a base64 source with no data", () => {
    expect(() => doc({ source: { type: "base64", media_type: "application/pdf" } })).toThrow("Anthropic base64 document source is missing data");
  });
  it("assumes application/pdf for a base64 source with no media type", () => {
    expect(doc({ source: { type: "base64", data: "QUJD" } }).messages[0].content[0]).toMatchObject({ type: "file", source: { kind: "base64", mediaType: "application/pdf", data: "QUJD" } });
  });
  it("carries the title as the file name on both OpenAI wires", () => {
    const req = doc({ title: "T", source: { type: "base64", media_type: "application/pdf", data: "QUJD" } });
    expect(req.messages[0].content[0]).toMatchObject({ type: "file", name: "T" });
    expect(((toResp(req).input as Json[]).at(-1)!.content as Json[])[0]).toMatchObject({ type: "input_file", filename: "T" });
    expect((toChat(req).messages.at(-1).content as Json[])[0]).toMatchObject({ type: "file", file: { filename: "T" } });
  });
});

describe("Anthropic cache breakpoint", () => {
  const hinted = (messages: unknown[], ttl?: number) => {
    const req = anth({ messages });
    req.params.cacheHint = true;
    if (ttl !== undefined) req.params.cacheTtlMinutes = ttl;
    return toAnth(req);
  };
  const controls = (body: Json): unknown[] => (body.messages as Json[]).flatMap(m => Array.isArray(m.content) ? m.content : []).map(block => block.cache_control);
  const thinking = { type: "thinking", thinking: "t", signature: "sig" };

  it.each([[5, { type: "ephemeral" }], [6, { type: "ephemeral", ttl: "1h" }], [30, { type: "ephemeral", ttl: "1h" }], [undefined, { type: "ephemeral", ttl: "1h" }]])(
    "marks the last block with a ttl of %s minutes as %o", (ttl, expected) => {
      expect(controls(hinted([{ role: "user", content: "q" }], ttl))).toEqual([expected]);
    });

  it("lands on the block before a trailing thinking block", () => {
    const body = hinted([{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "text", text: "a" }, thinking] }]);
    const last = body.messages.at(-1).content as Json[];
    expect(last.find(block => block.type === "text")!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(last.find(block => block.type === "thinking")).not.toHaveProperty("cache_control");
  });

  it("marks nothing when the last message holds only thinking", () => {
    const body = hinted([{ role: "user", content: "q" }, { role: "assistant", content: [thinking] }]);
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });

  it("does not throw with no messages at all", () => {
    expect(() => hinted([])).not.toThrow();
    expect(JSON.stringify(hinted([]))).not.toContain("cache_control");
  });
});

describe("Anthropic metadata and the user override", () => {
  it("keeps the client's own user_id over an override", () => {
    const req = anth({ metadata: { user_id: "own", trace: "t" } }).withOverrides({ user: "u2" });
    expect(toAnth(req).metadata).toEqual({ user_id: "own", trace: "t" });
  });
  it("adds the override's user_id next to other client metadata", () => {
    const req = anth({ metadata: { trace: "t" } }).withOverrides({ user: "u2" });
    expect(toAnth(req).metadata).toEqual({ trace: "t", user_id: "u2" });
  });
  it("replays client metadata untouched with no override", () => {
    expect(toAnth(anth({ metadata: { user_id: "own", trace: "t" } })).metadata).toEqual({ user_id: "own", trace: "t" });
  });
});

describe("reasoning envelopes", () => {
  const envelope = (value: unknown) => `hydrogen-reasoning-v1:${Buffer.from(JSON.stringify(value), "utf8").toString("base64")}`;
  const bad: Array<[string, string]> = [
    ["an unknown origin", envelope({ type: "reasoning", text: "t", origin: "evil" })],
    ["a numeric signature", envelope({ type: "reasoning", text: "t", signature: 5 })],
    ["a numeric item id", envelope({ type: "reasoning", text: "t", itemId: 5 })],
    ["a non-reasoning type", envelope({ type: "text", text: "t" })],
    ["a missing text", envelope({ type: "reasoning" })],
    ["a payload that is not JSON", "hydrogen-reasoning-v1:!!!not-base64!!!"],
    ["a value with no envelope prefix", "plain signature"],
  ];

  it("round-trips a reasoning part", () => {
    const part = { type: "reasoning" as const, text: "t", origin: "anthropic" as const, signature: "sig" };
    expect(decodeReasoning(encodeReasoning(part))).toEqual(part);
    expect(decodeReasoning(encodeReasoning({ type: "reasoning", text: "", origin: "anthropic", signature: "blob", redacted: true }))).toMatchObject({ redacted: true, signature: "blob" });
  });

  it.each(bad)("refuses an envelope with %s", (_name, value) => {
    expect(decodeReasoning(value)).toBeNull();
    expect(parseChatReasoningDetails([{ type: "reasoning.encrypted", data: value }])).toEqual([]);
  });

  it("reads a details item with no type as plain Chat reasoning", () => {
    expect(parseChatReasoningDetails([{ text: "t" }])).toEqual([{ type: "reasoning", text: "t", origin: "openai_completion" }]);
    expect(parseChatReasoningDetails([{ type: "reasoning.text", text: "t", id: "r1" }])).toEqual([{ type: "reasoning", text: "t", origin: "openai_completion", itemId: "r1" }]);
    expect(parseChatReasoningDetails([{ type: "image", text: "t" }, null, "x", { type: "reasoning.text", text: "" }])).toEqual([]);
    expect(parseChatReasoningDetails("not an array")).toEqual([]);
  });
});
