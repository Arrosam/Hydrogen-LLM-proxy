import { describe, expect, it } from "vitest";
import {
  AnthropicRequest,
  AnthropicResponse,
  OpenAICompletionRequest,
  OpenAICompletionResponse,
  OpenAIResponsesRequest,
  buildResponse,
} from "../src/core/format";
import type { ResponseData } from "../src/core/ir/stream";

const target = (upstreamModel: string) => ({ upstreamModel });

describe("OpenAI Chat Completions request -> canonical", () => {
  it("captures system, messages, tools and sampling params", () => {
    const req = OpenAICompletionRequest.parse({
      model: "my-svc",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hello" },
      ],
      temperature: 0.5,
      max_tokens: 256,
      tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
      tool_choice: "auto",
    });
    expect(req.system).toBe("be terse");
    expect(req.requestedService).toBe("my-svc");
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "hello" }] });
    expect(req.params.temperature).toBe(0.5);
    expect(req.params.maxTokens).toBe(256);
    expect(req.tools?.[0].name).toBe("get_weather");
    expect(req.toolChoice).toEqual({ type: "auto" });
  });

  it("maps assistant tool_calls and tool results", () => {
    const req = OpenAICompletionRequest.parse({
      model: "m",
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"NYC"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
      ],
    });
    expect(req.messages[1]).toMatchObject({ role: "assistant" });
    expect(req.messages[1].content[0]).toMatchObject({ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "NYC" } });
    expect(req.messages[2]).toMatchObject({ role: "user" });
    expect(req.messages[2].content[0]).toMatchObject({ type: "tool_result", toolUseId: "call_1" });
  });
});

describe("canonical -> Anthropic request (cross-family construct + render)", () => {
  it("lifts system, sets a default max_tokens, maps tools", () => {
    const req = OpenAICompletionRequest.parse({
      model: "m",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      tools: [{ type: "function", function: { name: "t", parameters: { type: "object" } } }],
    });
    const body = AnthropicRequest.construct(req).render(target("claude-x"));
    expect(body.model).toBe("claude-x");
    expect(body.system).toBe("sys");
    expect(body.max_tokens).toBe(4096);
    expect((body.tools as unknown[]).length).toBe(1);
    expect((body.messages as { role: string }[])[0].role).toBe("user");
  });

  it("emits tool_use / tool_result blocks", () => {
    const req = OpenAICompletionRequest.parse({
      model: "m",
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "result" },
      ],
    });
    const body = AnthropicRequest.construct(req).render(target("claude-x"));
    const messages = body.messages as { role: string; content: { type: string }[] }[];
    expect(messages[0].content[0].type).toBe("tool_use");
    expect(messages[1].content[0].type).toBe("tool_result");
  });
});

describe("Anthropic request -> canonical -> OpenAI render", () => {
  it("parses system/messages/tools and renders back to OpenAI", () => {
    const req = AnthropicRequest.parse({
      model: "sonnet-persist",
      system: "sys",
      max_tokens: 100,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [{ name: "f", input_schema: { type: "object" } }],
      tool_choice: { type: "any" },
    });
    expect(req.system).toBe("sys");
    expect(req.params.maxTokens).toBe(100);
    expect(req.toolChoice).toEqual({ type: "required" });
    const back = OpenAICompletionRequest.construct(req).render(target("gpt-x"));
    expect((back.messages as { role: string }[])[0].role).toBe("system");
    expect(back.tool_choice).toBe("required");
  });
});

describe("Response translation (canonical -> client family)", () => {
  const data: ResponseData = {
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
  const resp = buildResponse("openai_completion", data);

  it("renders an OpenAI client response with tool_calls + finish_reason", () => {
    const out = resp.render("openai_completion", "my-svc");
    expect(out.object).toBe("chat.completion");
    expect(out.model).toBe("my-svc");
    const choice = (out.choices as { message: { tool_calls: unknown[] }; finish_reason: string }[])[0];
    expect(choice.finish_reason).toBe("tool_calls");
    expect(choice.message.tool_calls).toHaveLength(1);
  });

  it("renders an Anthropic client response with tool_use + stop_reason", () => {
    const out = resp.render("anthropic", "my-svc");
    expect(out.type).toBe("message");
    expect(out.stop_reason).toBe("tool_use");
    expect((out.content as { type: string }[]).some((c) => c.type === "tool_use")).toBe(true);
    expect((out.usage as { input_tokens: number }).input_tokens).toBe(3);
  });
});

describe("Upstream response -> canonical", () => {
  it("parses an OpenAI Chat Completions response", () => {
    const resp = OpenAICompletionResponse.parse({
      id: "chatcmpl-x",
      model: "gpt",
      created: 1,
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    expect(resp.stopReason).toBe("stop");
    expect(resp.usage.totalTokens).toBe(3);
    expect(resp.text()).toBe("hi");
  });

  it("parses an Anthropic response", () => {
    const resp = AnthropicResponse.parse({
      id: "msg_x",
      model: "claude",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 5, output_tokens: 6 },
    });
    expect(resp.stopReason).toBe("length");
    expect(resp.usage).toEqual({ promptTokens: 5, completionTokens: 6, totalTokens: 11 });
  });
});

describe("OpenAI Responses API round-trip", () => {
  it("parses instructions + input into canonical, renders back", () => {
    const req = OpenAIResponsesRequest.parse({
      model: "svc",
      instructions: "be brief",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      max_output_tokens: 512,
    });
    expect(req.system).toBe("be brief");
    expect(req.params.maxTokens).toBe(512);
    const body = OpenAIResponsesRequest.construct(req).render(target("gpt-5"));
    expect(body.model).toBe("gpt-5");
    expect(body.instructions).toBe("be brief");
    expect(body.max_output_tokens).toBe(512);
    expect(body.store).toBe(false);
  });
});
