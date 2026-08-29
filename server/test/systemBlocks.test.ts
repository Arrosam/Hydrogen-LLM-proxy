/**
 * Anthropic `system` as a block array.
 *
 * The system prompt is usually the largest, most stable part of a request, so a
 * `cache_control` breakpoint on it is worth the most. Flattening the blocks to
 * one string to carry them canonically threw that breakpoint away on every
 * Anthropic -> Anthropic hop, silently turning a cached prefix into a full-price
 * one.
 *
 * The blocks are replayed only while they still describe the prompt actually
 * being sent. Anything that rewrites `system` -- a step override, a Micro Agent
 * stage, an appended tool reference -- must therefore drop them, or the upstream
 * would receive the prompt the client originally sent instead of the one the
 * service asked for.
 */
import { describe, expect, it } from "vitest";
import { AnthropicRequest, OpenAICompletionRequest, OpenAIResponsesRequest } from "../src/core/format";
import { buildStageRequest } from "../src/execution/agentContext";
import { parseService, type AgentDef } from "../src/execution/definition";

const target = { upstreamModel: "up" };

const CACHED_BLOCK = {
  type: "text",
  text: "You are a careful assistant with a very long standing brief.",
  cache_control: { type: "ephemeral" },
};

const blockRequest = (system: unknown) =>
  AnthropicRequest.parse({
    model: "svc",
    system,
    messages: [{ role: "user", content: "hello" }],
  });

describe("same-family replay", () => {
  it("keeps cache_control on a system block through an Anthropic -> Anthropic hop", () => {
    const req = blockRequest([CACHED_BLOCK]);
    const body = AnthropicRequest.construct(req).render(target);
    expect(body.system).toEqual([CACHED_BLOCK]);
    expect(JSON.stringify(body.system)).toContain('"cache_control":{"type":"ephemeral"}');
  });

  it("preserves the order and content of several system blocks", () => {
    const blocks = [
      { type: "text", text: "first" },
      { type: "text", text: "second", cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: "third" },
    ];
    const body = AnthropicRequest.construct(blockRequest(blocks)).render(target);
    expect(body.system).toEqual(blocks);
  });

  it("leaves a plain string system exactly as it was", () => {
    const body = AnthropicRequest.construct(blockRequest("just a string")).render(target);
    expect(body.system).toBe("just a string");
  });
});

describe("cross-family", () => {
  it("sends the merged plain text to Chat Completions", () => {
    const req = blockRequest([{ type: "text", text: "alpha" }, { type: "text", text: "beta", cache_control: { type: "ephemeral" } }]);
    const body = OpenAICompletionRequest.construct(req).render(target);
    const system = (body.messages as Array<{ role: string; content: unknown }>)[0];
    expect(system.role).toBe("system");
    expect(system.content).toBe("alpha\n\nbeta");
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });

  it("sends the merged plain text to Responses instructions", () => {
    const req = blockRequest([{ type: "text", text: "alpha" }, { type: "text", text: "beta", cache_control: { type: "ephemeral" } }]);
    const body = OpenAIResponsesRequest.construct(req).render(target);
    expect(body.instructions).toBe("alpha\n\nbeta");
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });
});

describe("an override replaces the prompt completely", () => {
  it("a step/stage system override drops the stale blocks", () => {
    const req = blockRequest([CACHED_BLOCK]).withOverrides({ system: "You are a terse assistant." });
    const body = AnthropicRequest.construct(req).render(target);
    expect(body.system).toBe("You are a terse assistant.");
    expect(JSON.stringify(body.system)).not.toContain("cache_control");
    expect(JSON.stringify(body.system)).not.toContain("standing brief");
  });

  it("an override to the identical text may still replay the blocks", () => {
    // Same prompt, so the breakpoints still describe what is being sent.
    const req = blockRequest([CACHED_BLOCK]).withOverrides({ system: CACHED_BLOCK.text });
    const body = AnthropicRequest.construct(req).render(target);
    expect(body.system).toEqual([CACHED_BLOCK]);
  });

  it("a JSON response_format contract, which rewrites the prompt, drops them too", () => {
    const req = blockRequest([CACHED_BLOCK]).withOverrides({
      responseFormat: { type: "json_object" },
    });
    const body = AnthropicRequest.construct(req).render(target);
    expect(typeof body.system).toBe("string");
    expect(String(body.system)).toContain("valid JSON object");
    expect(JSON.stringify(body.system)).not.toContain("cache_control");
  });
});

describe("Micro Agent stages", () => {
  const agentDef = (stage: Record<string, unknown>): AgentDef =>
    parseService({
      kind: "micro_agent",
      timeoutMs: 10_000,
      stages: [{ name: "s1", input: [], ...stage }],
    }) as AgentDef;

  it("a stage that runs the prompt unchanged keeps the breakpoints", () => {
    const req = blockRequest([CACHED_BLOCK]);
    const def = agentDef({ steps: [{ model: "m", provider: "p" }] });
    const stageReq = buildStageRequest(req, def.stages[0], new Map(), new Map(), false);
    const body = AnthropicRequest.construct(stageReq).render(target);
    expect(body.system).toEqual([CACHED_BLOCK]);
  });

  it("a stage that overrides the system prompt does not replay the old blocks", () => {
    const req = blockRequest([CACHED_BLOCK]);
    const def = agentDef({ steps: [{ model: "m", provider: "p" }] });
    const stageReq = buildStageRequest(req, def.stages[0], new Map(), new Map(), false, "Stage prompt.");
    const body = AnthropicRequest.construct(stageReq).render(target);
    expect(body.system).toBe("Stage prompt.");
    expect(JSON.stringify(body.system)).not.toContain("standing brief");
  });

  it("a stage that appends the tool reference does not replay them either", () => {
    // tools:"none" folds the tool list into the system prompt, so the prompt is
    // no longer the one the blocks describe.
    const req = AnthropicRequest.parse({
      model: "svc",
      system: [CACHED_BLOCK],
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "get_weather", description: "weather", input_schema: { type: "object", properties: {} } }],
    });
    const def = agentDef({ steps: [{ model: "m", provider: "p" }], tools: "none" });
    const stageReq = buildStageRequest(req, def.stages[0], new Map(), new Map(), false);
    const body = AnthropicRequest.construct(stageReq).render(target);
    expect(typeof body.system).toBe("string");
    expect(String(body.system)).toContain("Tools the assistant had available");
    expect(String(body.system)).toContain("standing brief"); // the text survives...
    expect(JSON.stringify(body.system)).not.toContain("cache_control"); // ...the stale breakpoint does not
  });
});

describe("existing cache_control behavior is unchanged", () => {
  it("message and tool breakpoints still round-trip", () => {
    const req = AnthropicRequest.parse({
      model: "svc",
      system: "plain",
      messages: [{
        role: "user",
        content: [{ type: "text", text: "cached turn", cache_control: { type: "ephemeral" } }],
      }],
      tools: [{
        name: "get_weather",
        description: "weather",
        input_schema: { type: "object", properties: {} },
        cache_control: { type: "ephemeral" },
      }],
    });
    const body = AnthropicRequest.construct(req).render(target);
    expect(JSON.stringify(body.messages)).toContain('"cache_control":{"type":"ephemeral"}');
    expect(JSON.stringify(body.tools)).toContain('"cache_control":{"type":"ephemeral"}');
  });

  it("the auto breakpoint for a caching OpenAI client is untouched", () => {
    // An OpenAI-family client that signalled caching intent still gets one
    // planted on the last message block; no system blocks are involved.
    const req = OpenAICompletionRequest.parse({
      model: "svc",
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
      prompt_cache_key: "session-1",
    });
    const body = AnthropicRequest.construct(req).render(target);
    expect(body.system).toBe("sys");
    expect(JSON.stringify(body.messages)).toContain("cache_control");
  });
});
