import { describe, expect, it } from "vitest";
import * as openai from "../src/core/formats/openai";
import * as anthropic from "../src/core/formats/anthropic";
import type { IRResponse } from "../src/core/ir";

describe("OpenAI request -> IR", () => {
  it("captures system, messages, tools and sampling params", () => {
    const ir = openai.requestToIR({
      model: "sonnet-any",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hello" },
      ],
      temperature: 0.5,
      max_tokens: 256,
      tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
      tool_choice: "auto",
    });
    expect(ir.system).toBe("be terse");
    expect(ir.requestedModel).toBe("sonnet-any");
    expect(ir.messages).toHaveLength(1);
    expect(ir.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "hello" }] });
    expect(ir.temperature).toBe(0.5);
    expect(ir.maxTokens).toBe(256);
    expect(ir.tools?.[0].name).toBe("get_weather");
    expect(ir.toolChoice).toEqual({ type: "auto" });
  });

  it("maps assistant tool_calls and tool results", () => {
    const ir = openai.requestToIR({
      model: "m",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"NYC"}' } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
      ],
    });
    const assistant = ir.messages[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content[0]).toMatchObject({ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "NYC" } });
    const toolResult = ir.messages[2];
    expect(toolResult.role).toBe("user");
    expect(toolResult.content[0]).toMatchObject({ type: "tool_result", toolUseId: "call_1" });
  });
});

describe("IR -> Anthropic request", () => {
  it("lifts system, sets default max_tokens, maps tools", () => {
    const ir = openai.requestToIR({
      model: "m",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      tools: [{ type: "function", function: { name: "t", parameters: { type: "object" } } }],
    });
    const body = anthropic.irToRequest(ir, "claude-x");
    expect(body.model).toBe("claude-x");
    expect(body.system).toBe("sys");
    expect(body.max_tokens).toBe(anthropic.DEFAULT_ANTHROPIC_MAX_TOKENS);
    expect((body.tools as unknown[]).length).toBe(1);
    expect((body.messages as { role: string }[])[0].role).toBe("user");
  });

  it("emits tool_use / tool_result blocks", () => {
    const ir = openai.requestToIR({
      model: "m",
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "result" },
      ],
    });
    const body = anthropic.irToRequest(ir, "claude-x");
    const messages = body.messages as { role: string; content: { type: string }[] }[];
    expect(messages[0].content[0].type).toBe("tool_use");
    expect(messages[1].content[0].type).toBe("tool_result");
  });
});

describe("Anthropic request round-trips through IR", () => {
  it("parses system/messages/tools", () => {
    const ir = anthropic.requestToIR({
      model: "sonnet-persist",
      system: "sys",
      max_tokens: 100,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [{ name: "f", input_schema: { type: "object" } }],
      tool_choice: { type: "any" },
    });
    expect(ir.system).toBe("sys");
    expect(ir.maxTokens).toBe(100);
    expect(ir.toolChoice).toEqual({ type: "required" });
    const back = openai.irToRequest(ir, "gpt-x");
    expect((back.messages as { role: string }[])[0].role).toBe("system");
    expect(back.tool_choice).toBe("required");
  });
});

describe("Response translation", () => {
  const irResp: IRResponse = {
    id: "resp_1",
    model: "upstream",
    created: 100,
    content: [
      { type: "text", text: "hello" },
      { type: "tool_use", id: "tu_1", name: "f", input: { a: 1 } },
    ],
    stopReason: "tool_use",
    usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
  };

  it("IR -> OpenAI client response maps tool_calls + finish_reason", () => {
    const out = openai.irToResponse(irResp, { model: "sonnet-any" });
    expect(out.object).toBe("chat.completion");
    expect(out.model).toBe("sonnet-any");
    const choice = (out.choices as { message: { tool_calls: unknown[] }; finish_reason: string }[])[0];
    expect(choice.finish_reason).toBe("tool_calls");
    expect(choice.message.tool_calls).toHaveLength(1);
  });

  it("IR -> Anthropic client response maps tool_use + stop_reason", () => {
    const out = anthropic.irToResponse(irResp, { model: "sonnet-any" });
    expect(out.type).toBe("message");
    expect(out.stop_reason).toBe("tool_use");
    const content = out.content as { type: string }[];
    expect(content.some((c) => c.type === "tool_use")).toBe(true);
    expect((out.usage as { input_tokens: number }).input_tokens).toBe(3);
  });

  it("OpenAI upstream response -> IR", () => {
    const ir = openai.responseToIR({
      id: "chatcmpl-x",
      model: "gpt",
      created: 1,
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    expect(ir.stopReason).toBe("stop");
    expect(ir.usage.totalTokens).toBe(3);
    expect(ir.content[0]).toEqual({ type: "text", text: "hi" });
  });

  it("Anthropic upstream response -> IR", () => {
    const ir = anthropic.responseToIR({
      id: "msg_x",
      model: "claude",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 5, output_tokens: 6 },
    });
    expect(ir.stopReason).toBe("length");
    expect(ir.usage).toEqual({ promptTokens: 5, completionTokens: 6, totalTokens: 11 });
  });
});

describe("thinking levels", () => {
  const ir = (thinking: unknown) =>
    ({
      requestedModel: "svc",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      stream: false,
      thinking,
    }) as Parameters<typeof openai.irToRequest>[0];

  it("named effort levels pass through as OpenAI reasoning_effort", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      const out = openai.irToRequest(ir(level), "m");
      expect(out.reasoning_effort).toBe(level);
    }
    expect(openai.irToRequest(ir("disabled"), "m").reasoning_effort).toBe("none");
    expect(openai.irToRequest(ir("enabled"), "m").reasoning_effort).toBe("medium");
  });

  it("OpenAI reasoning_effort parses to the matching IR level", () => {
    const parse = (reasoning_effort: string) =>
      openai.requestToIR({ model: "m", messages: [{ role: "user", content: "hi" }], reasoning_effort }).thinking;
    expect(parse("low")).toBe("low");
    expect(parse("xhigh")).toBe("xhigh");
    expect(parse("max")).toBe("max");
    expect(parse("minimal")).toBe("low");
    expect(parse("none")).toBe("disabled");
  });

  it("named effort levels map to Anthropic thinking budgets", () => {
    const low = anthropic.irToRequest(ir("low"), "m");
    expect(low.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    const max = anthropic.irToRequest(ir("max"), "m");
    expect(max.thinking).toEqual({ type: "enabled", budget_tokens: 128000 });
    // max_tokens must exceed the budget.
    expect(max.max_tokens as number).toBeGreaterThan(128000);
    const explicit = anthropic.irToRequest(ir({ budget: 2048 }), "m");
    expect(explicit.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
  });

  it("disabled turns Anthropic thinking off", () => {
    const out = anthropic.irToRequest(ir("disabled"), "m");
    expect(out.thinking).toEqual({ type: "disabled" });
  });
});
