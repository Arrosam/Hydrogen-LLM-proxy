import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IRContentPart, IRRequest } from "../src/core/ir";
import { textOf } from "../src/core/ir";
import type { AgentCondition, AgentDef, AgentStage, AgentTransition } from "../src/core/services/schema";

// Mock the per-stage runner (stages stream upstream and buffer internally).
// The fake echoes `${model}(${lastUserText})`, unless
// the model name is "OUT:<text>" (returns <text> verbatim, to drive output-based
// routing) or "BOOM" (fails).
vi.mock("../src/core/proxy/run", () => {
  const lastUserText = (ir: IRRequest): string => {
    for (let i = ir.messages.length - 1; i >= 0; i--) {
      const m = ir.messages[i];
      if (m.role === "user") {
        return m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
      }
    }
    return "";
  };
  return {
    runServiceBuffered: vi.fn(
      async (ir: IRRequest, steps: { timeoutMs: number; steps: { model: string; provider: string }[] }) => {
        const { model, provider } = steps.steps[0];
        const rec = { step: 1, attempt: 1, model, provider, status: model === "BOOM" ? 500 : 200, kind: model === "BOOM" ? "http" : "ok", latencyMs: 1 };
        if (model === "BOOM") return { result: { ok: false, status: 500, kind: "http", message: "boom" }, path: [rec] };
        const out = model.startsWith("OUT:") ? model.slice(4) : `${model}(${lastUserText(ir)})`;
        const content = model.startsWith("TOOL:")
          ? [{ type: "tool_use", id: "tu_1", name: model.slice(5), input: { q: lastUserText(ir) } }]
          : [{ type: "text", text: out }];
        const value = {
          ir: { id: "x", model, created: 0, content, stopReason: model.startsWith("TOOL:") ? "tool_use" : "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
          family: "openai", upstreamModel: model, providerName: provider, modelName: model,
        };
        return { result: { ok: true, value }, path: [rec] };
      },
    ),
  };
});

import { runServiceBuffered } from "../src/core/proxy/run";
import { buildStageIR, isStreamPlan, runAgent, type StageResolver } from "../src/core/agents/engine";
import { setConfig } from "../src/context";
import type { AppConfig } from "../src/config";

setConfig({ logPayloadMaxChars: 100000 } as unknown as AppConfig);

const runJsonMock = vi.mocked(runServiceBuffered);
const noResolver: StageResolver = () => ({ ok: false, message: "no resolver" });

const t = (when: AgentCondition, goto: string): AgentTransition => ({ when, goto });
const always: AgentCondition = { type: "always" };
function stage(name: string, model: string, extra: Partial<AgentStage> = {}): AgentStage {
  return { name, steps: [{ model, provider: "p" }], input: [], ...extra };
}
function router(name: string, transitions: AgentTransition[]): AgentStage {
  return { name, input: [], transitions };
}
function agentOf(stages: AgentStage[], output?: string): AgentDef {
  return { kind: "agent", timeoutMs: 60_000, stages, ...(output ? { output } : {}) };
}

const withImage: IRRequest = {
  requestedModel: "m",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image", source: { kind: "url", url: "http://img" } }] }],
  stream: false,
};
const textOnly: IRRequest = {
  requestedModel: "m",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: false,
};

describe("buildStageIR (context blocks)", () => {
  it("original_conversation keeps images; text_conversation strips them", () => {
    const full = buildStageIR(withImage, stage("s", "M", { input: [{ kind: "original_conversation" }] }), {}, {}, false);
    expect(full.messages[0].content.some((p: IRContentPart) => p.type === "image")).toBe(true);
    const textConv = buildStageIR(withImage, stage("s", "M", { input: [{ kind: "text_conversation" }] }), {}, {}, false);
    expect(textConv.messages.every((m) => m.content.every((p: IRContentPart) => p.type !== "image"))).toBe(true);
    expect(textOf(textConv.messages[0].content)).toBe("hi");
  });

  it("last_user picks the last user turn", () => {
    const multi: IRRequest = {
      requestedModel: "m",
      stream: false,
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        { role: "user", content: [{ type: "text", text: "second" }] },
      ],
    };
    const out = buildStageIR(multi, stage("s", "M", { input: [{ kind: "last_user" }] }), {}, {}, false);
    expect(out.messages).toHaveLength(1);
    expect(textOf(out.messages[0].content)).toBe("second");
  });

  it("last_user_text and last_user_images split the last user turn", () => {
    const txt = buildStageIR(withImage, stage("s", "M", { input: [{ kind: "last_user_text" }] }), {}, {}, false);
    expect(txt.messages).toHaveLength(1);
    expect(textOf(txt.messages[0].content)).toBe("hi");
    expect(txt.messages[0].content.some((p: IRContentPart) => p.type === "image")).toBe(false);

    const imgs = buildStageIR(withImage, stage("s", "M", { input: [{ kind: "last_user_images" }] }), {}, {}, false);
    expect(imgs.messages).toHaveLength(1);
    expect(imgs.messages[0].content.every((p: IRContentPart) => p.type === "image")).toBe(true);
    expect(textOf(imgs.messages[0].content)).toBe("");
  });

  it("adjacent same-role message + stage_output merge into one turn", () => {
    const s = stage("s", "M", {
      input: [
        { kind: "message", role: "user", text: "Evaluate: " },
        { kind: "stage_output", stage: "draft", role: "user" },
      ],
    });
    const out = buildStageIR(textOnly, s, { draft: "DRAFT" }, {}, false);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].role).toBe("user");
    expect(textOf(out.messages[0].content)).toBe("Evaluate: DRAFT");
  });

  it("tool_turn emits a linked assistant tool_use + user tool_result", () => {
    const s = stage("s", "M", { input: [{ kind: "tool_turn", name: "get_weather", input: '{"city":"SF"}', result: "72F" }] });
    const out = buildStageIR(textOnly, s, {}, {}, false);
    expect(out.messages.map((m) => m.role)).toEqual(["assistant", "user"]);
    const tu = out.messages[0].content[0] as { type: string; id: string; name: string; input: unknown };
    expect(tu.type).toBe("tool_use");
    expect(tu.name).toBe("get_weather");
    expect(tu.input).toEqual({ city: "SF" });
    const tr = out.messages[1].content[0] as { type: string; toolUseId: string; content: IRContentPart[] };
    expect(tr.type).toBe("tool_result");
    expect(tr.toolUseId).toBe(tu.id);
    expect(textOf(tr.content)).toBe("72F");
  });

  it("empty input passes the original conversation through", () => {
    const out = buildStageIR(textOnly, stage("s", "M"), {}, {}, false);
    expect(textOf(out.messages[0].content)).toBe("hi");
  });

  it("inherits tools by default; tools:'none' lists them in the prompt instead of registering them", () => {
    const irWithTools: IRRequest = {
      ...textOnly,
      system: "Be helpful.",
      tools: [{ name: "get_weather", parameters: { type: "object" } }],
      toolChoice: { type: "auto" },
    };
    const inherit = buildStageIR(irWithTools, stage("s", "M"), {}, {}, false);
    expect(inherit.tools).toHaveLength(1);
    expect(inherit.toolChoice).toEqual({ type: "auto" });

    const noCall = buildStageIR(irWithTools, stage("s", "M", { tools: "none" }), {}, {}, false);
    expect(noCall.tools).toBeUndefined();
    expect(noCall.toolChoice).toBeUndefined();
    expect(noCall.system).toContain("Be helpful.");
    expect(noCall.system).toContain("get_weather");
  });

  it("tools:'none' with no tools in the request leaves the prompt untouched", () => {
    const out = buildStageIR({ ...textOnly, system: "S" }, stage("s", "M", { tools: "none" }), {}, {}, false);
    expect(out.tools).toBeUndefined();
    expect(out.toolChoice).toBeUndefined();
    expect(out.system).toBe("S");
  });

  it("thinking override propagates to the stage IR", () => {
    const s = stage("s", "M", { thinking: { budget: 8192 } });
    const out = buildStageIR(textOnly, s, {}, {}, false);
    expect(out.thinking).toEqual({ budget: 8192 });
  });

  it("inherits thinking from the request when stage has no override", () => {
    const irWithThinking: IRRequest = { ...textOnly, thinking: "enabled" };
    const out = buildStageIR(irWithThinking, stage("s", "M"), {}, {}, false);
    expect(out.thinking).toBe("enabled");
  });
});
describe("runAgent (decision tree)", () => {
  beforeEach(() => {
    runJsonMock.mockClear();
  });

  it("runs linearly via explicit transitions, feeds outputs forward, sums usage", async () => {
    const agent = agentOf([
      stage("draft", "D", { transitions: [t(always, "final")] }),
      stage("final", "F", { input: [{ kind: "stage_output", stage: "draft", role: "user" }] }),
    ]);
    const { result, usage, calls } = await runAgent(textOnly, agent, noResolver);
    expect(result.ok).toBe(true);
    if (result.ok) expect(textOf(result.value.ir.content)).toBe("F(D(hi))");
    expect(usage.totalTokens).toBe(4);
    expect(calls.map((c) => c.stage)).toEqual(["draft", "final"]);
    expect(calls[0].kind).toBe("service");
    expect(calls[0].status).toBe(200);
    expect(calls[0].attempts).toHaveLength(1);
    expect(calls[0].request).toContain("messages");
    expect(calls[0].response).toContain("D(hi)");
    expect(calls[1].response).toContain("F(D(hi))");
  });

  it("stops and returns when a stage has no matching transition (no auto-advance)", async () => {
    const agent = agentOf([stage("a", "A"), stage("b", "B")]);
    const { result, calls } = await runAgent(textOnly, agent, noResolver);
    expect(result.ok).toBe(true);
    if (result.ok) expect(textOf(result.value.ir.content)).toBe("A(hi)");
    expect(calls.map((c) => c.stage)).toEqual(["a"]);
    expect(runJsonMock).toHaveBeenCalledTimes(1);
  });

  it("branches on input_has_image via a router (no model call for the router)", async () => {
    const agent = agentOf([
      router("route", [t({ type: "input_has_image" }, "ocr"), t(always, "text")]),
      stage("ocr", "OCR", { transitions: [t(always, "end")] }),
      stage("text", "TXT"),
    ]);
    const img = await runAgent(withImage, agent, noResolver);
    expect(img.calls.map((c) => c.stage)).toEqual(["route", "ocr"]);
    expect(img.calls[0].kind).toBe("router");
    expect(img.calls[0].attempts).toHaveLength(0);
    if (img.result.ok) expect(textOf(img.result.value.ir.content)).toBe("OCR(hi)");

    const txt = await runAgent(textOnly, agent, noResolver);
    expect(txt.calls.map((c) => c.stage)).toEqual(["route", "text"]);
    if (txt.result.ok) expect(textOf(txt.result.value.ir.content)).toBe("TXT(hi)");
  });

  it("branches on a stage's output text (decision: pass/fail)", async () => {
    const build = (decision: string) =>
      agentOf([
        stage("decide", `OUT:{decision: ${decision}}`, {
          transitions: [t({ type: "output_contains", value: "{decision: pass}" }, "pass"), t(always, "fail")],
        }),
        stage("fail", "FAILC", { transitions: [t(always, "end")] }),
        stage("pass", "PASSC"),
      ]);
    const p = await runAgent(textOnly, build("pass"), noResolver);
    expect(p.calls.map((x) => x.stage)).toEqual(["decide", "pass"]);
    const f = await runAgent(textOnly, build("fail"), noResolver);
    expect(f.calls.map((x) => x.stage)).toEqual(["decide", "fail"]);
  });

  it("resolves a stage's referenced service via the resolver", async () => {
    const resolver: StageResolver = (name) =>
      name === "resmub" ? { ok: true, kind: "resilience", steps: { timeoutMs: 60_000, steps: [{ model: "R", provider: "p" }] } } : { ok: false, message: "unknown" };
    const agent = agentOf([{ name: "s", service: "resmub", input: [] }]);
    const { result, calls } = await runAgent(textOnly, agent, resolver);
    expect(result.ok).toBe(true);
    if (result.ok) expect(textOf(result.value.ir.content)).toBe("R(hi)");
    expect(calls[0].stage).toBe("s");
    expect(calls[0].service).toBe("resmub");
  });

  it("fails the agent when a referenced service can't be resolved", async () => {
    const agent = agentOf([{ name: "s", service: "missing", input: [] }]);
    const { result } = await runAgent(textOnly, agent, () => ({ ok: false, message: "unknown service" }));
    expect(result.ok).toBe(false);
    expect(runJsonMock).not.toHaveBeenCalled();
  });

  it("aborts on a mid-agent stage failure", async () => {
    const agent = agentOf([stage("a", "BOOM"), stage("b", "D")]);
    const { result } = await runAgent(textOnly, agent, noResolver);
    expect(result.ok).toBe(false);
    expect(runJsonMock).toHaveBeenCalledTimes(1);
  });

  it("records the request tools in the per-stage payload", async () => {
    const irWithTools: IRRequest = {
      ...textOnly,
      tools: [{ name: "get_weather", parameters: { type: "object" } }],
      toolChoice: { type: "auto" },
    };
    const { calls } = await runAgent(irWithTools, agentOf([stage("a", "A")]), noResolver);
    expect(calls[0].request).toContain("get_weather");
    expect(calls[0].request).toContain("tool_choice");
  });

  it("never throws -- a resolver error becomes a failure result (so it gets logged)", async () => {
    const throwing: StageResolver = () => {
      throw new Error("boom resolve");
    };
    const { result } = await runAgent(textOnly, agentOf([{ name: "s", service: "x", input: [] }]), throwing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("agent execution error");
  });
});

describe("runAgent (nesting & return output)", () => {
  beforeEach(() => {
    runJsonMock.mockClear();
  });

  it("runs a nested Micro Agent stage (an agent referencing another agent)", async () => {
    const subAgent = agentOf([stage("inner", "SUB")]);
    const resolver: StageResolver = (name) =>
      name === "agent" ? { ok: true, kind: "agent", agent: subAgent } : { ok: false, message: "unknown" };
    const parent = agentOf([{ name: "outer", service: "agent", input: [{ kind: "last_user" }] }]);
    const { result, calls } = await runAgent(textOnly, parent, resolver);
    expect(result.ok).toBe(true);
    if (result.ok) expect(textOf(result.value.ir.content)).toBe("SUB(hi)");
    const outer = calls.find((c) => c.stage === "outer");
    expect(outer?.kind).toBe("agent");
    expect(outer?.service).toBe("agent");
    expect(outer?.status).toBe(200);
    expect(outer?.calls?.map((c) => c.stage)).toEqual(["inner"]);
    expect(outer?.calls?.[0].response).toContain("SUB(hi)");
  });

  it("sums usage across the outer and nested agents", async () => {
    const subAgent = agentOf([stage("inner", "SUB")]);
    const resolver: StageResolver = (name) =>
      name === "agent" ? { ok: true, kind: "agent", agent: subAgent } : { ok: false, message: "unknown" };
    const parent = agentOf([
      stage("pre", "P", { transitions: [t(always, "outer")] }),
      { name: "outer", service: "agent", input: [{ kind: "last_user" }] },
    ]);
    const { result } = await runAgent(textOnly, parent, resolver);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ir.usage.totalTokens).toBe(4);
  });

  it("fails on a Micro Agent cycle (self-reference)", async () => {
    const selfAgent = agentOf([{ name: "s", service: "A", input: [] }]);
    const resolver: StageResolver = (name) =>
      name === "A" ? { ok: true, kind: "agent", agent: selfAgent } : { ok: false, message: "unknown" };
    const { result } = await runAgent(textOnly, selfAgent, resolver, ["A"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("cycle");
    expect(runJsonMock).not.toHaveBeenCalled();
  });

  it("preserves a stage's tool call when its output feeds a later stage", async () => {
    const agent = agentOf([
      stage("call", "TOOL:get_weather", { transitions: [t(always, "eval")] }),
      stage("eval", "E", { input: [{ kind: "stage_output", stage: "call", role: "assistant" }] }),
    ]);
    await runAgent(textOnly, agent, noResolver);
    const evalIR = runJsonMock.mock.calls[1][0] as IRRequest;
    const fed = textOf(evalIR.messages[0].content);
    expect(fed).toContain("tool_call");
    expect(fed).toContain("get_weather");
    expect(fed).toContain('"q":"hi"');
  });

  it("a transition to end can return an earlier stage's output", async () => {
    const agent = agentOf([
      stage("first", "F", { transitions: [t(always, "second")] }),
      stage("second", "S", {
        input: [{ kind: "stage_output", stage: "first", role: "user" }],
        transitions: [{ when: always, goto: "end", output: "first" }],
      }),
    ]);
    const { result, calls } = await runAgent(textOnly, agent, noResolver);
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.stage)).toEqual(["first", "second"]);
    if (result.ok) expect(textOf(result.value.ir.content)).toBe("F(hi)");
  });
});

describe("runAgent (streaming terminal)", () => {
  beforeEach(() => {
    runJsonMock.mockClear();
  });

  it("returns a stream plan for a single-stage agent (nothing buffered)", async () => {
    const plan = await runAgent(textOnly, agentOf([stage("s", "M")]), noResolver, [], { streamTerminal: true });
    expect(isStreamPlan(plan)).toBe(true);
    if (isStreamPlan(plan)) {
      expect(plan.stageName).toBe("s");
      expect(plan.steps.steps[0].model).toBe("M");
      expect(plan.stageIR.stream).toBe(true);
      expect(plan.container).toBe(plan.calls);
      expect(plan.pending).toHaveLength(0);
    }
    expect(runJsonMock).not.toHaveBeenCalled();
  });

  it("streams the terminal stage of a linear agent, buffering the earlier ones", async () => {
    const agent = agentOf([stage("a", "A", { transitions: [t(always, "b")] }), stage("b", "B")]);
    const plan = await runAgent(textOnly, agent, noResolver, [], { streamTerminal: true });
    expect(isStreamPlan(plan)).toBe(true);
    if (isStreamPlan(plan)) {
      expect(plan.stageName).toBe("b");
      expect(plan.calls.map((c) => c.stage)).toEqual(["a"]);
    }
    expect(runJsonMock).toHaveBeenCalledTimes(1);
  });

  it("does not stream when routing follows (router stage) -- buffers instead", async () => {
    const agent = agentOf([
      router("route", [t(always, "s")]),
      stage("s", "M"),
    ]);
    const plan = await runAgent(textOnly, agent, noResolver, [], { streamTerminal: true });
    expect(isStreamPlan(plan)).toBe(true);
    if (isStreamPlan(plan)) expect(plan.stageName).toBe("s");
  });

  it("does not stream when agent.output points to an earlier stage", async () => {
    const agent = agentOf([stage("a", "A", { transitions: [t(always, "b")] }), stage("b", "B")], "a");
    const plan = await runAgent(textOnly, agent, noResolver, [], { streamTerminal: true });
    expect(isStreamPlan(plan)).toBe(false);
  });

  it("streams through a nested Micro Agent at the terminal stage", async () => {
    const subAgent = agentOf([stage("inner", "I")]);
    const resolver: StageResolver = (name) =>
      name === "sub" ? { ok: true, kind: "agent", agent: subAgent } : { ok: false, message: "unknown" };
    const parent = agentOf([{ name: "outer", service: "sub", input: [] }]);
    const plan = await runAgent(textOnly, parent, resolver, [], { streamTerminal: true });
    expect(isStreamPlan(plan)).toBe(true);
    if (isStreamPlan(plan)) {
      expect(plan.stageName).toBe("inner");
      expect(plan.steps.steps[0].model).toBe("I");
      // The nested agent is one call entry; the terminal call lands inside it.
      expect(plan.calls).toHaveLength(1);
      expect(plan.calls[0].stage).toBe("outer");
      expect(plan.calls[0].kind).toBe("agent");
      expect(plan.container).toBe(plan.calls[0].calls);
      expect(plan.pending.map((p) => p.call)).toContain(plan.calls[0]);
    }
    expect(runJsonMock).not.toHaveBeenCalled();
  });

  it("buffers a terminal nested agent that returns an earlier stage's output", async () => {
    const subAgent = agentOf([stage("a", "A", { transitions: [t(always, "b")] }), stage("b", "B")], "a");
    const resolver: StageResolver = (name) =>
      name === "sub" ? { ok: true, kind: "agent", agent: subAgent } : { ok: false, message: "unknown" };
    const parent = agentOf([{ name: "outer", service: "sub", input: [] }]);
    const outcome = await runAgent(textOnly, parent, resolver, [], { streamTerminal: true });
    expect(isStreamPlan(outcome)).toBe(false);
    if (!isStreamPlan(outcome)) {
      expect(outcome.result.ok).toBe(true);
      if (outcome.result.ok) expect(textOf(outcome.result.value.ir.content)).toBe("A(hi)");
      expect(outcome.calls[0].calls?.map((c) => c.stage)).toEqual(["a", "b"]);
    }
  });
});

describe("runAgent (OCR pre-pass)", () => {
  beforeEach(() => {
    runJsonMock.mockClear();
  });

  const ocrAgent = (ocrModel: string, extra: Partial<AgentStage> = {}): AgentDef => ({
    kind: "agent",
    timeoutMs: 60_000,
    stages: [stage("s", "M", { input: [{ kind: "original_conversation" }], ...extra })],
    ocr: { steps: [{ model: ocrModel, provider: "p" }] },
  });

  it("transcribes images to text before the stages run", async () => {
    const agent = ocrAgent('OUT:[{"index":1,"image":"A red cat"}]');
    const { result, calls } = await runAgent(withImage, agent, noResolver);
    expect(result.ok).toBe(true);
    if (result.ok) expect(textOf(result.value.ir.content)).toContain("A red cat");

    const ocrIR = runJsonMock.mock.calls[0][0] as IRRequest;
    expect(ocrIR.messages[0].content.some((p: IRContentPart) => p.type === "image")).toBe(true);
    expect(textOf(ocrIR.messages[0].content)).toContain("Image 1:");

    const stageIR = runJsonMock.mock.calls[1][0] as IRRequest;
    expect(stageIR.messages.every((m) => m.content.every((p: IRContentPart) => p.type !== "image"))).toBe(true);
    expect(textOf(stageIR.messages[0].content)).toContain("A red cat");

    expect(calls.some((c) => c.stage === "(ocr)")).toBe(true);
  });

  it("skips the OCR pre-pass when the request has no images", async () => {
    const { result, calls } = await runAgent(textOnly, ocrAgent("OCR"), noResolver);
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.stage === "(ocr)")).toBe(false);
    expect(runJsonMock).toHaveBeenCalledTimes(1);
  });

  it("aborts the agent (logged failure) when the OCR pass fails", async () => {
    const { result, calls } = await runAgent(withImage, ocrAgent("BOOM"), noResolver);
    expect(result.ok).toBe(false);
    expect(calls.some((c) => c.stage === "(ocr)")).toBe(true);
    expect(runJsonMock).toHaveBeenCalledTimes(1);
  });

  it("places each transcription by its returned index, not array order", async () => {
    const twoImages: IRRequest = {
      requestedModel: "m",
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", source: { kind: "url", url: "http://a" } },
            { type: "image", source: { kind: "url", url: "http://b" } },
          ],
        },
      ],
    };
    const agent = ocrAgent('OUT:[{"index":2,"image":"SECOND"},{"index":1,"image":"FIRST"}]');
    const { result } = await runAgent(twoImages, agent, noResolver);
    expect(result.ok).toBe(true);
    const stageIR = runJsonMock.mock.calls[1][0] as IRRequest;
    const text = textOf(stageIR.messages[0].content);
    expect(text).toContain("FIRST");
    expect(text.indexOf("SECOND")).toBeGreaterThan(text.indexOf("FIRST"));
  });

  it("uses a referenced service for the OCR model and records it", async () => {
    const resolver: StageResolver = (name) =>
      name === "vision" ? { ok: true, kind: "resilience", steps: { timeoutMs: 60_000, steps: [{ model: 'OUT:[{"index":1,"image":"TXT"}]', provider: "p" }] } } : { ok: false, message: "unknown" };
    const agent: AgentDef = {
      kind: "agent",
      timeoutMs: 60_000,
      stages: [stage("s", "M", { input: [{ kind: "original_conversation" }] })],
      ocr: { service: "vision" },
    };
    const { result, calls } = await runAgent(withImage, agent, resolver);
    expect(result.ok).toBe(true);
    const ocrCall = calls.find((c) => c.stage === "(ocr)");
    expect(ocrCall?.service).toBe("vision");
  });

  it("fails the agent when the OCR service can't be resolved", async () => {
    const agent: AgentDef = {
      kind: "agent",
      timeoutMs: 60_000,
      stages: [stage("s", "M")],
      ocr: { service: "missing" },
    };
    const { result } = await runAgent(withImage, agent, () => ({ ok: false, message: "unknown service" }));
    expect(result.ok).toBe(false);
    expect(runJsonMock).not.toHaveBeenCalled();
  });
});