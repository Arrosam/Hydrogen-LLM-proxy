import { describe, expect, it } from "vitest";
import * as responses from "../src/core/formats/openaiResponses";
import { parseUpstreamStream, serializeClientStream } from "../src/core/formats/stream";
import type { IRResponse } from "../src/core/ir";

describe("Responses API request -> IR", () => {
  it("maps string input, instructions and sampling params", () => {
    const ir = responses.requestToIR({
      model: "svc",
      instructions: "be terse",
      input: "hello",
      max_output_tokens: 256,
      temperature: 0.3,
      reasoning: { effort: "xhigh" },
    });
    expect(ir.requestedModel).toBe("svc");
    expect(ir.system).toBe("be terse");
    expect(ir.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
    expect(ir.maxTokens).toBe(256);
    expect(ir.temperature).toBe(0.3);
    expect(ir.thinking).toBe("xhigh");
  });

  it("maps typed input items: messages, function calls and their outputs", () => {
    const ir = responses.requestToIR({
      model: "svc",
      input: [
        { role: "system", content: "sys rules" },
        { role: "user", content: [{ type: "input_text", text: "weather?" }] },
        { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"NYC"}' },
        { type: "function_call_output", call_id: "call_1", output: "sunny" },
      ],
      tools: [{ type: "function", name: "get_weather", parameters: { type: "object" } }],
      tool_choice: "auto",
    });
    expect(ir.system).toBe("sys rules");
    expect(ir.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "weather?" }] });
    expect(ir.messages[1].content[0]).toMatchObject({ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "NYC" } });
    expect(ir.messages[2].content[0]).toMatchObject({ type: "tool_result", toolUseId: "call_1" });
    expect(ir.tools?.[0].name).toBe("get_weather");
    expect(ir.toolChoice).toEqual({ type: "auto" });
  });
});

describe("IR -> Responses API response", () => {
  const ir: IRResponse = {
    id: "x", model: "m", created: 100,
    content: [
      { type: "reasoning", text: "thinking hard" },
      { type: "text", text: "Answer" },
      { type: "tool_use", id: "call_9", name: "t", input: { a: 1 } },
    ],
    stopReason: "stop",
    usage: { promptTokens: 3, completionTokens: 7, totalTokens: 10 },
  };

  it("renders reasoning, message and function_call output items", () => {
    const out = responses.irToResponse(ir, { model: "svc" }) as {
      object: string; status: string; output: Array<Record<string, unknown>>; usage: Record<string, number>;
    };
    expect(out.object).toBe("response");
    expect(out.status).toBe("completed");
    expect(out.output.map((o) => o.type)).toEqual(["reasoning", "message", "function_call"]);
    expect((out.output[0].summary as Array<{ text: string }>)[0].text).toBe("thinking hard");
    expect((out.output[1].content as Array<{ text: string }>)[0].text).toBe("Answer");
    expect(out.output[2]).toMatchObject({ call_id: "call_9", name: "t", arguments: '{"a":1}' });
    expect(out.usage).toEqual({ input_tokens: 3, output_tokens: 7, total_tokens: 10 });
  });

  it("marks a length-stopped response incomplete", () => {
    const out = responses.irToResponse({ ...ir, stopReason: "length" }, { model: "svc" }) as Record<string, unknown>;
    expect(out.status).toBe("incomplete");
    expect(out.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });
});

describe("Responses API streaming", () => {
  async function* chunked(s: string): AsyncGenerator<string> {
    for (let i = 0; i < s.length; i += 7) yield s.slice(i, i + 7);
  }

  const OPENAI_STREAM = [
    `data: {"id":"c1","model":"gpt","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}`,
    `data: {"id":"c1","model":"gpt","choices":[{"index":0,"delta":{"reasoning_content":"Pondering"},"finish_reason":null}]}`,
    `data: {"id":"c1","model":"gpt","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}`,
    `data: {"id":"c1","model":"gpt","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"t","arguments":""}}]},"finish_reason":null}]}`,
    `data: {"id":"c1","model":"gpt","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":1}"}}]},"finish_reason":null}]}`,
    `data: {"id":"c1","model":"gpt","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
    `data: {"id":"c1","model":"gpt","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}`,
    `data: [DONE]`,
    ``,
  ].join("\n\n");

  it("serializes an upstream chat stream as response.* events", async () => {
    const events = parseUpstreamStream("openai", chunked(OPENAI_STREAM));
    let out = "";
    for await (const c of serializeClientStream("openai_responses", events, { model: "svc" })) out += c;

    expect(out).toContain("event: response.created");
    expect(out).toContain("event: response.output_item.added");
    expect(out).toContain('"delta":"Pondering"');
    expect(out).toContain("event: response.reasoning_summary_text.delta");
    expect(out).toContain('"delta":"Hello"');
    expect(out).toContain("event: response.output_text.done");
    expect(out).toContain("event: response.function_call_arguments.done");
    expect(out).toContain('"call_id":"call_1"');
    expect(out).toContain("event: response.completed");
    expect(out).toContain('"total_tokens":5');
    // Items are ordered: reasoning, then message, then function_call.
    const completed = JSON.parse(out.split("event: response.completed\n")[1].replace(/^data: /, "").split("\n")[0]);
    expect(completed.response.output.map((o: { type: string }) => o.type)).toEqual([
      "reasoning",
      "message",
      "function_call",
    ]);
  });
});

describe("IR -> Responses API upstream request (egress)", () => {
  it("renders messages, tool history, tools and reasoning effort", () => {
    const out = responses.irToRequest(
      {
        requestedModel: "svc",
        system: "be terse",
        messages: [
          { role: "user", content: [{ type: "text", text: "weather?" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "NYC" } }] },
          { role: "user", content: [{ type: "tool_result", toolUseId: "call_1", content: [{ type: "text", text: "sunny" }] }] },
        ],
        tools: [{ name: "get_weather", parameters: { type: "object" } }],
        toolChoice: { type: "auto" },
        maxTokens: 128,
        stream: true,
        thinking: "xhigh",
      },
      "gpt-x",
    ) as Record<string, unknown>;

    expect(out.model).toBe("gpt-x");
    expect(out.instructions).toBe("be terse");
    expect(out.store).toBe(false);
    expect(out.stream).toBe(true);
    expect(out.max_output_tokens).toBe(128);
    expect(out.reasoning).toEqual({ effort: "xhigh" });
    const input = out.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ role: "user" });
    expect(input[1]).toMatchObject({ type: "function_call", call_id: "call_1", name: "get_weather" });
    expect(input[2]).toMatchObject({ type: "function_call_output", call_id: "call_1", output: "sunny" });
    expect((out.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ type: "function", name: "get_weather" });
  });
});

describe("Responses API upstream response -> IR (egress)", () => {
  it("parses reasoning, text and function_call output items", () => {
    const ir = responses.responseToIR({
      id: "resp_1",
      model: "gpt-x",
      created_at: 42,
      status: "completed",
      output: [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "hmm" }] },
        { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Hi" }] },
        { type: "function_call", id: "fc_1", call_id: "call_7", name: "t", arguments: '{"a":1}' },
      ],
      usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 },
    });
    expect(ir.content).toEqual([
      { type: "reasoning", text: "hmm" },
      { type: "text", text: "Hi" },
      { type: "tool_use", id: "call_7", name: "t", input: { a: 1 } },
    ]);
    expect(ir.stopReason).toBe("tool_use");
    expect(ir.usage).toEqual({ promptTokens: 4, completionTokens: 6, totalTokens: 10 });
  });

  it("maps incomplete (max_output_tokens) to a length stop", () => {
    const ir = responses.responseToIR({
      id: "r", model: "m", status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "cut" }] }],
    });
    expect(ir.stopReason).toBe("length");
  });
});

describe("Responses API upstream stream parsing (egress)", () => {
  const UPSTREAM_RESPONSES_STREAM = [
    `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_9","model":"gpt-x","created_at":7,"status":"in_progress"}}`,
    `event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[]}}`,
    `event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","output_index":0,"delta":"hmm"}`,
    `event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}`,
    `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":1,"delta":"Hi"}`,
    `event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":2,"item":{"id":"fc_1","type":"function_call","call_id":"call_7","name":"t","arguments":""}}`,
    `event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":2,"delta":"{\\"a\\":1}"}`,
    `event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":2,"item":{"id":"fc_1","type":"function_call","call_id":"call_7","name":"t","arguments":"{\\"a\\":1}"}}`,
    `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_9","status":"completed","usage":{"input_tokens":4,"output_tokens":6,"total_tokens":10}}}`,
    ``,
  ].join("\n\n");

  async function* chunked2(s: string): AsyncGenerator<string> {
    for (let i = 0; i < s.length; i += 7) yield s.slice(i, i + 7);
  }

  it("translates an upstream Responses stream to an OpenAI chat client", async () => {
    const events = parseUpstreamStream("openai_responses", chunked2(UPSTREAM_RESPONSES_STREAM));
    let out = "";
    for await (const c of serializeClientStream("openai", events, { model: "svc" })) out += c;
    expect(out).toContain('"reasoning":"hmm"');
    expect(out).toContain('"content":"Hi"');
    expect(out).toContain('"name":"t"');
    expect(out).toContain('"finish_reason":"tool_calls"');
    expect(out).toContain('"total_tokens":10');
  });

  it("collectStream buffers an upstream Responses stream into IR", async () => {
    const { collectStream } = await import("../src/core/formats/stream");
    const { ir, incomplete } = await collectStream(parseUpstreamStream("openai_responses", chunked2(UPSTREAM_RESPONSES_STREAM)));
    expect(incomplete).toBe(false);
    expect(ir.content).toEqual([
      { type: "reasoning", text: "hmm" },
      { type: "text", text: "Hi" },
      { type: "tool_use", id: "call_7", name: "t", input: { a: 1 } },
    ]);
    expect(ir.stopReason).toBe("tool_use");
    expect(ir.usage.totalTokens).toBe(10);
  });
});
