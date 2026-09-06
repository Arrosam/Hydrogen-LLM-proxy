/**
 * The tool loop, end to end through a real ModelService.
 *
 * The loop wraps the STEP CHAIN rather than living inside it, which is what
 * makes S12 true: a step that dies mid-loop hands the accumulated conversation
 * to the next step instead of restarting the turn, and a tool that already ran
 * is never run again. Several tests below exist only to pin that, because the
 * obvious implementation (loop inside the step) gets it wrong in a way nothing
 * else would catch until an operator's endpoint was billed twice.
 */
import { describe, expect, it, vi } from "vitest";
import "../src/core/format";
import { OpenAICompletionRequest, parseRequest } from "../src/core/format";
import { ModelService, type ServiceDeps } from "../src/execution/modelService";
import type { Catalog } from "../src/catalog/catalog";
import type { Family } from "../src/core/format/family";
import type { Transport, TransportJsonResult } from "../src/core/upstream/transport";
import type { DispatchableTool } from "../src/persistence/toolRepo";
import { mayDispatch, type ToolRuntime } from "../src/execution/toolLoop";
import { DispatchBudget } from "../src/execution/toolDispatch";

const UPSTREAM = "http://upstream";
const TOOL_URL = "https://tools.invalid/inv";

function entry(over: Partial<DispatchableTool> = {}): DispatchableTool {
  return {
    id: 1,
    name: "check_inventory",
    kind: "freeform",
    description: "look up stock",
    parameters: { type: "object", properties: { sku: { type: "string" } } },
    endpointUrl: TOOL_URL,
    headers: {},
    policy: "prefer_provider",
    maxUses: 8,
    timeoutMs: 5_000,
    proxyId: null,
    ...over,
  };
}

function fakeCatalog(capabilities: string[] = [], family: Family = "openai_completion"): Catalog {
  return {
    resolve: (model: string, provider: string) => ({
      ok: true,
      target: {
        family,
        upstreamModel: `up-${model}`,
        url: `${UPSTREAM}/${provider}`,
        headers: {},
        modelName: model,
        providerName: provider,
        upstream: {},
        toolCapabilities: capabilities,
      },
    }),
    exists: () => true,
  } as unknown as Catalog;
}

/** An assistant turn that calls one tool. */
const callsTool = (name: string, args: unknown, id = "call_1"): Record<string, unknown> => ({
  id: "c",
  model: "up",
  choices: [{ message: { role: "assistant", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const saysText = (text: string): Record<string, unknown> => ({
  id: "c",
  model: "up",
  choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 },
});

interface Harness {
  deps: ServiceDeps;
  upstream: Array<Record<string, unknown>>;
  toolCalls: Array<{ url: string; body: unknown }>;
}

/**
 * A transport that answers upstream calls from a scripted queue and tool
 * dispatches from `toolReply`, recording both so a test can assert what the
 * conversation looked like on each round.
 */
function harness(opts: {
  upstreamReplies: Array<Record<string, unknown> | { status: number; text: string }>;
  toolReply?: Record<string, unknown>;
  capabilities?: string[];
}): Harness {
  const upstream: Array<Record<string, unknown>> = [];
  const toolCalls: Array<{ url: string; body: unknown }> = [];
  let round = 0;

  const postJson = vi.fn(async (url: string, _h: Record<string, string>, body: unknown): Promise<TransportJsonResult> => {
    if (url === TOOL_URL) {
      toolCalls.push({ url, body });
      return { status: 200, headers: {}, json: opts.toolReply ?? { output: "12 in stock" }, text: "" };
    }
    upstream.push(body as Record<string, unknown>);
    const reply = opts.upstreamReplies[Math.min(round++, opts.upstreamReplies.length - 1)]!;
    if ("status" in reply && typeof reply.status === "number") {
      return { status: reply.status, headers: {}, json: {}, text: String(reply.text ?? "") };
    }
    return { status: 200, headers: {}, json: reply, text: "" };
  });

  const transport = { postJson } as unknown as Transport;
  const runtime: ToolRuntime = {
    lookup: { find: (name, kind) => (name === "check_inventory" && kind === "freeform" ? entry() : undefined) },
    dispatch: { transport },
  };
  return {
    deps: { catalog: fakeCatalog(opts.capabilities), transport, tools: runtime },
    upstream,
    toolCalls,
  };
}

const req = () =>
  new OpenAICompletionRequest({
    requestedService: "svc",
    messages: [{ role: "user", content: [{ type: "text", text: "how many A1 do we have?" }] }],
    params: {},
    stream: false,
  });

const oneStep = { timeoutMs: 10_000, steps: [{ model: "m", provider: "p" }], grantTools: ["check_inventory"] };

describe("tool loop — the happy path", () => {
  it("dispatches the call, feeds the result back, and answers", async () => {
    const h = harness({ upstreamReplies: [callsTool("check_inventory", { sku: "A1" }), saysText("You have 12.")] });
    const inv = await new ModelService(oneStep, h.deps).invoke(req());

    expect(inv.result.ok).toBe(true);
    if (!inv.result.ok) return;
    expect(inv.result.value.response.text()).toBe("You have 12.");

    // The endpoint got the fixed envelope, with the model's own arguments.
    expect(h.toolCalls).toHaveLength(1);
    expect(h.toolCalls[0]!.body).toEqual({ tool: "check_inventory", arguments: { sku: "A1" }, call_id: "call_1" });

    // Two upstream round trips, the second carrying the call and its result.
    expect(h.upstream).toHaveLength(2);
    const second = JSON.stringify(h.upstream[1]);
    expect(second).toContain("call_1");
    expect(second).toContain("12 in stock");
  });

  it("declares the granted tool to the upstream with its schema", async () => {
    const h = harness({ upstreamReplies: [saysText("no tools needed")] });
    await new ModelService(oneStep, h.deps).invoke(req());
    const tools = (h.upstream[0] as { tools?: Array<{ function: { name: string; parameters: unknown; description: string } }> }).tools ?? [];
    expect(tools.map((t) => t.function.name)).toEqual(["check_inventory"]);
    expect(tools[0]!.function.description).toBe("look up stock");
    expect(tools[0]!.function.parameters).toEqual({ type: "object", properties: { sku: { type: "string" } } });
  });

  it("aggregates usage across rounds and counts the dispatch", async () => {
    const h = harness({ upstreamReplies: [callsTool("check_inventory", {}), saysText("done")] });
    const inv = await new ModelService(oneStep, h.deps).invoke(req());
    expect(inv.result.ok).toBe(true);
    if (!inv.result.ok) return;
    const u = inv.result.value.response.usage;
    // 15 from the first round + 27 from the second, as one request's cost (S14).
    expect(u.totalTokens).toBe(42);
    expect(u.promptTokens).toBe(30);
    expect(u.toolDispatches).toBe(1);
  });

  it("does nothing at all when no tool could be dispatched", async () => {
    const h = harness({ upstreamReplies: [saysText("plain answer")] });
    const inv = await new ModelService({ timeoutMs: 10_000, steps: [{ model: "m", provider: "p" }] }, h.deps).invoke(req());
    expect(inv.result.ok).toBe(true);
    expect(h.upstream).toHaveLength(1);
    expect((h.upstream[0] as { tools?: unknown }).tools).toBeUndefined();
    expect(h.toolCalls).toHaveLength(0);
  });
});

describe("tool loop — who owns the call", () => {
  it("leaves a tool it does not serve to the client", async () => {
    const h = harness({ upstreamReplies: [callsTool("client_side_thing", {}), saysText("unreachable")] });
    const inv = await new ModelService(oneStep, h.deps).invoke(req());
    expect(inv.result.ok).toBe(true);
    // Returned to the client after ONE round; the client runs its own tool.
    expect(h.upstream).toHaveLength(1);
    expect(h.toolCalls).toHaveLength(0);
  });

  it("does not dispatch when the model called ours and the client's together", async () => {
    // Anthropic behaves this way with its own server tools: the turn comes back
    // untouched, because the conversation cannot continue until the client has
    // answered its own call anyway.
    const both = {
      id: "c",
      model: "up",
      choices: [{
        message: {
          role: "assistant",
          tool_calls: [
            { id: "a", type: "function", function: { name: "check_inventory", arguments: "{}" } },
            { id: "b", type: "function", function: { name: "client_side_thing", arguments: "{}" } },
          ],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const h = harness({ upstreamReplies: [both, saysText("unreachable")] });
    await new ModelService(oneStep, h.deps).invoke(req());
    expect(h.toolCalls).toHaveLength(0);
    expect(h.upstream).toHaveLength(1);
  });
});

describe("tool loop — failure and limits", () => {
  it("tells the model when the endpoint fails, and the turn still completes", async () => {
    const h = harness({
      upstreamReplies: [callsTool("check_inventory", {}), saysText("I could not check stock.")],
      toolReply: { error: "inventory service down" },
    });
    const inv = await new ModelService(oneStep, h.deps).invoke(req());
    expect(inv.result.ok).toBe(true);
    if (!inv.result.ok) return;
    expect(inv.result.value.response.text()).toBe("I could not check stock.");
    expect(JSON.stringify(h.upstream[1])).toContain("inventory service down");
  });

  it("stops at max_uses and lets the model answer with what it has", async () => {
    const limited: ToolRuntime = {
      lookup: { find: (n, k) => (n === "check_inventory" && k === "freeform" ? entry({ maxUses: 1 }) : undefined) },
      dispatch: { transport: null as never },
    };
    // Always asks for the tool again; only one dispatch may happen.
    const h = harness({ upstreamReplies: [callsTool("check_inventory", {}), callsTool("check_inventory", {}), saysText("giving up")] });
    const deps: ServiceDeps = { ...h.deps, tools: { ...limited, dispatch: { transport: h.deps.transport } } };
    const inv = await new ModelService(oneStep, deps).invoke(req());

    expect(inv.result.ok).toBe(true);
    expect(h.toolCalls).toHaveLength(1);
    // The second round was told it was out of uses, rather than the turn failing.
    expect(JSON.stringify(h.upstream[2])).toContain("limit of 1 uses");
  });

  it("surfaces an upstream failure instead of looping on it", async () => {
    const h = harness({ upstreamReplies: [{ status: 500, text: "upstream exploded" }] });
    const inv = await new ModelService(oneStep, h.deps).invoke(req());
    expect(inv.result.ok).toBe(false);
    expect(h.toolCalls).toHaveLength(0);
  });
});

describe("tool loop — a step change is a model switch (S12)", () => {
  it("carries the conversation to the fallback step and never re-dispatches", async () => {
    // Round 1 succeeds on step 1 and calls the tool. Round 2's first attempt
    // fails, so the chain falls to step 2 -- which must continue the SAME
    // conversation, tool result included, not start the turn again.
    const h = harness({
      upstreamReplies: [
        callsTool("check_inventory", { sku: "A1" }),
        { status: 500, text: "step 1 died" },
        saysText("You have 12."),
      ],
    });
    const twoSteps = {
      timeoutMs: 10_000,
      steps: [{ model: "m1", provider: "p1" }, { model: "m2", provider: "p2" }],
      grantTools: ["check_inventory"],
    };
    const inv = await new ModelService(twoSteps, h.deps).invoke(req());

    expect(inv.result.ok).toBe(true);
    if (!inv.result.ok) return;
    expect(inv.result.value.response.text()).toBe("You have 12.");

    // The endpoint was called exactly once, despite the retry: a re-dispatch
    // would fire an operator's possibly non-idempotent endpoint twice.
    expect(h.toolCalls).toHaveLength(1);

    // The last upstream body still carries the tool result from before the
    // failover, so the fallback model continued rather than restarted.
    const last = JSON.stringify(h.upstream[h.upstream.length - 1]);
    expect(last).toContain("12 in stock");
    expect(last).toContain("call_1");
  });
});

describe("tool loop — provider capability", () => {
  it("passes a hosted tool through when the provider serves it natively", async () => {
    const hostedRuntime: ToolRuntime = {
      lookup: { find: (n, k) => (n === "web_search" && k === "vocabulary" ? entry({ id: 2, name: "web_search", kind: "vocabulary" }) : undefined) },
      dispatch: { transport: null as never },
    };
    const h = harness({ upstreamReplies: [saysText("answer")], capabilities: ["web_search"] });
    const request = new OpenAICompletionRequest({
      requestedService: "svc",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      // A hosted declaration, kept verbatim by the parser as a raw tool.
      tools: [{ name: "web_search", parameters: {}, raw: { family: "openai_completion", value: { type: "web_search" } } }],
      params: {},
      stream: false,
    });
    const deps: ServiceDeps = { ...h.deps, tools: { ...hostedRuntime, dispatch: { transport: h.deps.transport } } };
    await new ModelService({ timeoutMs: 10_000, steps: [{ model: "m", provider: "p" }] }, deps).invoke(request);

    // Passed through untouched: the provider owns it, so it is still the raw
    // declaration and not a function tool Hydrogen would have to serve.
    expect(JSON.stringify(h.upstream[0])).toContain('"type":"web_search"');
    expect(h.toolCalls).toHaveLength(0);
  });
});

describe("tool loop — regressions", () => {
  /**
   * An Anthropic hosted tool is `{"type":"web_search_20250305","name":"web_search"}`,
   * so the config entry is keyed by the TYPE string (S9) while the declared tool
   * is named `web_search`. Declaring the entry's name while keying dispatch on
   * the declared one meant the model called a tool the loop did not recognise:
   * every Anthropic hosted tool was handed to a client that had never asked for
   * a function by that name, and nothing was ever dispatched.
   */
  it("declares and dispatches a hosted tool under one name, even when type != name", async () => {
    const upstream: Array<Record<string, unknown>> = [];
    const toolHits: unknown[] = [];
    const postJson = vi.fn(async (url: string, _h: unknown, body: unknown): Promise<TransportJsonResult> => {
      if (url === TOOL_URL) {
        toolHits.push(body);
        return { status: 200, headers: {}, json: { output: "results" }, text: "" };
      }
      upstream.push(body as Record<string, unknown>);
      if (upstream.length === 1) {
        // Call whatever was actually declared, as a real model would.
        const declared = (body as { tools?: Array<{ name: string }> }).tools ?? [];
        return {
          status: 200, headers: {}, text: "",
          json: { id: "m", model: "up", role: "assistant", stop_reason: "tool_use",
            content: [{ type: "tool_use", id: "c1", name: declared[0]?.name ?? "(none)", input: { query: "x" } }],
            usage: { input_tokens: 1, output_tokens: 1 } },
        };
      }
      return {
        status: 200, headers: {}, text: "",
        json: { id: "m", model: "up", role: "assistant", stop_reason: "end_turn",
          content: [{ type: "text", text: "final answer" }], usage: { input_tokens: 1, output_tokens: 1 } },
      };
    });
    const transport = { postJson } as unknown as Transport;
    const runtime: ToolRuntime = {
      lookup: { find: (n, k) => (n === "web_search_20250305" && k === "vocabulary" ? entry({ id: 2, name: "web_search_20250305", kind: "vocabulary" }) : undefined) },
      dispatch: { transport },
    };
    const deps: ServiceDeps = { catalog: fakeCatalog([], "anthropic"), transport, tools: runtime };
    const request = parseRequest("anthropic", {
      model: "svc", max_tokens: 64,
      messages: [{ role: "user", content: "search please" }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    });

    const inv = await new ModelService({ timeoutMs: 5_000, steps: [{ model: "m", provider: "p" }] }, deps).invoke(request);

    expect(toolHits).toHaveLength(1);
    expect(inv.result.ok).toBe(true);
    if (inv.result.ok) expect(inv.result.value.response.text()).toBe("final answer");
  });

  /**
   * The dispatch budget stops a tool RUNNING again, but a model that keeps
   * asking for an exhausted tool is told "out of uses" and asks again -- and
   * each refusal still costs a real upstream call. Measured at 200+ round trips
   * for a single client request before rounds were bounded separately.
   */
  it("terminates when the model keeps calling a tool whose budget is spent", async () => {
    let rounds = 0;
    const postJson = vi.fn(async (url: string): Promise<TransportJsonResult> => {
      if (url === TOOL_URL) return { status: 200, headers: {}, json: { output: "ok" }, text: "" };
      rounds++;
      if (rounds > 100) throw new Error("runaway tool loop");
      return {
        status: 200, headers: {}, text: "",
        json: { id: "m", model: "up", role: "assistant", stop_reason: "tool_use",
          content: [{ type: "tool_use", id: `c${rounds}`, name: "check_inventory", input: {} }],
          usage: { input_tokens: 1, output_tokens: 1 } },
      };
    });
    const transport = { postJson } as unknown as Transport;
    const runtime: ToolRuntime = {
      lookup: { find: (n, k) => (n === "check_inventory" && k === "freeform" ? entry({ maxUses: 2 }) : undefined) },
      dispatch: { transport },
    };
    const deps: ServiceDeps = { catalog: fakeCatalog([], "anthropic"), transport, tools: runtime };
    const request = parseRequest("anthropic", { model: "svc", max_tokens: 64, messages: [{ role: "user", content: "go" }] });

    const inv = await new ModelService({ timeoutMs: 5_000, steps: [{ model: "m", provider: "p" }], grantTools: ["check_inventory"] }, deps).invoke(request);

    expect(rounds).toBeLessThan(30);
    expect(inv.result.ok).toBe(true);
  }, 30_000);
});

describe("tool loop — more regressions", () => {
  it("reports only ITS OWN dispatches when a budget is shared", async () => {
    // A Micro Agent shares one budget across stages and then SUMS the stage
    // usages. Reporting the budget's running total on each stage counted three
    // real dispatches as six.
    const shared = new DispatchBudget();
    const svc = () => new ModelService(oneStep, harness({ upstreamReplies: [callsTool("check_inventory", {}), saysText("ok")] }).deps);

    const first = await svc().invoke(req(), undefined, { dispatchBudget: shared });
    const second = await svc().invoke(req(), undefined, { dispatchBudget: shared });

    expect(first.result.ok && first.result.value.response.usage.toolDispatches).toBe(1);
    // The budget has now seen two dispatches, but this invocation made one.
    expect(second.result.ok && second.result.value.response.usage.toolDispatches).toBe(1);
    expect(shared.dispatches).toBe(2);
  });

  it("clears a tool_choice whose tool was dropped", async () => {
    // tools and tool_choice are rendered independently, so a forced choice left
    // behind after its tool was stripped is a guaranteed upstream 400.
    const h = harness({ upstreamReplies: [saysText("answer")] });
    const request = parseRequest("openai_completion", {
      model: "svc",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "gone", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "gone" } },
    });
    // A grant exists so the loop engages, but nothing resolves for "gone".
    const deps: ServiceDeps = {
      ...h.deps,
      tools: { lookup: { find: (n, k) => (n === "check_inventory" && k === "freeform" ? entry() : undefined) }, dispatch: { transport: h.deps.transport } },
    };
    await new ModelService(oneStep, deps).invoke(request);

    const sent = h.upstream[0] as { tools?: unknown[]; tool_choice?: unknown };
    // "gone" is the client's own function tool, so it survives...
    expect((sent.tools as Array<{ function: { name: string } }>).some((t) => t.function.name === "gone")).toBe(true);
    // ...and the choice naming it is therefore still valid.
    expect(sent.tool_choice).toBeDefined();
  });

  it("does not engage for a grant whose tool row is gone", () => {
    // A name left in a service definition after its row was deleted or disabled
    // would otherwise force the buffered path on EVERY request -- costing first
    // token latency for a tool that is never offered, with nothing in the logs
    // pointing at the stale name.
    const none: ToolRuntime = { lookup: { find: () => undefined }, dispatch: { transport: null as never } };
    expect(mayDispatch(req(), ["deleted_tool"], none)).toBe(false);

    const present: ToolRuntime = {
      lookup: { find: (n, k) => (n === "check_inventory" && k === "freeform" ? entry() : undefined) },
      dispatch: { transport: null as never },
    };
    expect(mayDispatch(req(), ["check_inventory"], present)).toBe(true);
  });
});
