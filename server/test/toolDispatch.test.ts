/**
 * Dispatching a tool call to the operator's endpoint.
 *
 * The contract is deliberately small — POST {tool, arguments, call_id}, read
 * back {output} or {error} — so most of what matters here is the failure
 * behaviour: nothing this function does may fail the client's turn, because by
 * the time a tool runs the answer has usually already started streaming.
 */
import { describe, expect, it, vi } from "vitest";
import { DispatchBudget, dispatchTool } from "../src/execution/toolDispatch";
import type { DispatchableTool } from "../src/persistence/toolRepo";
import type { Transport, TransportJsonResult } from "../src/core/upstream/transport";

function entry(over: Partial<DispatchableTool> = {}): DispatchableTool {
  return {
    id: 1,
    name: "check_inventory",
    kind: "freeform",
    endpointUrl: "https://tools.invalid/inv",
    headers: { Authorization: "Bearer sekrit" },
    policy: "prefer_provider",
    maxUses: 2,
    timeoutMs: 5_000,
    proxyId: null,
    ...over,
  };
}

/** A transport that records what it was asked to send. */
function transportOf(reply: Partial<TransportJsonResult> | (() => never)): {
  transport: Transport;
  calls: Array<{ url: string; headers: Record<string, string>; body: unknown; opts: unknown }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown; opts: unknown }> = [];
  const postJson = vi.fn(async (url: string, headers: Record<string, string>, body: unknown, opts: unknown) => {
    calls.push({ url, headers, body, opts });
    if (typeof reply === "function") reply();
    return { status: 200, headers: {}, json: {}, text: "", ...reply } as TransportJsonResult;
  });
  return { transport: { postJson } as unknown as Transport, calls };
}

const CALL = { tool: "check_inventory", arguments: { sku: "A1" }, call_id: "call_1" };

describe("dispatchTool — the envelope", () => {
  it("POSTs the fixed envelope with the operator's headers", async () => {
    const { transport, calls } = transportOf({ json: { output: "12 in stock" } });
    const r = await dispatchTool(entry(), CALL, { transport });

    expect(r).toEqual({ ok: true, output: "12 in stock" });
    expect(calls[0]!.url).toBe("https://tools.invalid/inv");
    expect(calls[0]!.body).toEqual({ tool: "check_inventory", arguments: { sku: "A1" }, call_id: "call_1" });
    expect(calls[0]!.headers).toMatchObject({ "content-type": "application/json", Authorization: "Bearer sekrit" });
    expect(calls[0]!.opts).toMatchObject({ timeoutMs: 5_000 });
  });

  it("serialises a structured output for the model to read", async () => {
    const { transport } = transportOf({ json: { output: { count: 12, sku: "A1" } } });
    const r = await dispatchTool(entry(), CALL, { transport });
    expect(r).toEqual({ ok: true, output: '{"count":12,"sku":"A1"}' });
  });

  it("routes through a proxy when the entry names one", async () => {
    const { transport, calls } = transportOf({ json: { output: "ok" } });
    const proxy = { id: 3, name: "p", scheme: "http" as const, host: "h", port: 1, username: null, password: null };
    await dispatchTool(entry({ proxyId: 3 }), CALL, { transport, resolveProxy: () => proxy });
    expect(calls[0]!.opts).toMatchObject({ proxy });
  });

  it("stays direct when the entry names no proxy", async () => {
    const { transport, calls } = transportOf({ json: { output: "ok" } });
    await dispatchTool(entry(), CALL, { transport, resolveProxy: () => null });
    expect((calls[0]!.opts as Record<string, unknown>).proxy).toBeUndefined();
  });
});

describe("dispatchTool — nothing fails the turn", () => {
  const failures: Array<[string, Partial<TransportJsonResult> | (() => never), string]> = [
    ["the endpoint reports an error", { json: { error: "inventory service down" } }, "inventory service down"],
    ["the endpoint returns a 500", { status: 500, text: "boom" }, "HTTP 500"],
    ["the endpoint returns neither field", { json: { something_else: 1 } }, "neither"],
    ["the connection throws", () => { throw new Error("ECONNREFUSED"); }, "ECONNREFUSED"],
  ];

  for (const [label, reply, expected] of failures) {
    it(`reports an errored result when ${label}`, async () => {
      const { transport } = transportOf(reply);
      const r = await dispatchTool(entry(), CALL, { transport });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toContain(expected);
    });
  }

  it("never throws, whatever the transport does", async () => {
    const transport = {
      postJson: () => Promise.reject(new Error("timeout of 5000ms exceeded")),
    } as unknown as Transport;
    await expect(dispatchTool(entry(), CALL, { transport })).resolves.toMatchObject({ ok: false });
  });

  it("names the tool in the error, so the log says which endpoint misbehaved", async () => {
    const { transport } = transportOf({ status: 502, text: "bad gateway" });
    const r = await dispatchTool(entry({ name: "check_inventory" }), CALL, { transport });
    expect(r.ok === false && r.error).toContain('"check_inventory"');
  });
});

describe("DispatchBudget", () => {
  it("allows a tool up to its own max_uses", () => {
    const b = new DispatchBudget();
    const e = entry({ maxUses: 2 });
    expect(b.take(e).ok).toBe(true);
    expect(b.take(e).ok).toBe(true);
    const third = b.take(e);
    expect(third.ok).toBe(false);
    expect(third.ok === false && third.error).toContain("2 uses");
  });

  it("counts each tool separately", () => {
    const b = new DispatchBudget();
    expect(b.take(entry({ id: 1, maxUses: 1 })).ok).toBe(true);
    expect(b.take(entry({ id: 2, name: "other", maxUses: 1 })).ok).toBe(true);
    expect(b.take(entry({ id: 1, maxUses: 1 })).ok).toBe(false);
  });

  it("reports the dispatch count, for billing alongside tokens", () => {
    const b = new DispatchBudget();
    b.take(entry({ maxUses: 5 }));
    b.take(entry({ maxUses: 5 }));
    expect(b.dispatches).toBe(2);
  });

  it("stops a loop that would otherwise run forever", () => {
    // A per-tool cap alone does not bound a request with many tools.
    const b = new DispatchBudget(3);
    for (let i = 0; i < 3; i++) expect(b.take(entry({ id: i, maxUses: 99 })).ok).toBe(true);
    const over = b.take(entry({ id: 99, maxUses: 99 }));
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.error).toContain("overall limit");
  });
});
