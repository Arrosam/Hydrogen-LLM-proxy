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
