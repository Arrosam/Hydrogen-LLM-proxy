import { describe, expect, it } from "vitest";
import { usageWithFallback, withUsageFallback } from "../src/core/usage";
import type { IRRequest, IRResponse } from "../src/core/ir";

const ir = (text: string): IRRequest => ({
  requestedModel: "svc",
  messages: [{ role: "user", content: [{ type: "text", text }] }],
  stream: true,
});

describe("usageWithFallback", () => {
  it("passes real usage through untouched", () => {
    const real = { promptTokens: 100, completionTokens: 20, totalTokens: 120 };
    const { usage, estimated } = usageWithFallback(real, ir("hi"), "some output");
    expect(estimated).toBe(false);
    expect(usage).toBe(real);
  });

  it("estimates prompt + completion when usage is zero but output was produced", () => {
    const prompt = "x".repeat(4000); // ~1000 tokens
    const output = "y".repeat(400); // ~100 tokens
    const { usage, estimated } = usageWithFallback(
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      ir(prompt),
      output,
    );
    expect(estimated).toBe(true);
    expect(usage.promptTokens).toBe(1000);
    expect(usage.completionTokens).toBe(100);
    expect(usage.totalTokens).toBe(1100);
  });

  it("does not estimate when there was no output (a genuinely empty response)", () => {
    const { usage, estimated } = usageWithFallback(
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      ir("prompt"),
      "",
    );
    expect(estimated).toBe(false);
    expect(usage.totalTokens).toBe(0);
  });
});

describe("withUsageFallback", () => {
  const resp = (usage: IRResponse["usage"], text: string): IRResponse => ({
    id: "x", model: "m", created: 0,
    content: [{ type: "text", text }],
    stopReason: "stop", usage,
  });

  it("fills in an estimate for a zero-usage buffered response", () => {
    const out = withUsageFallback(ir("z".repeat(800)), resp({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }, "hello"));
    expect(out.usage.totalTokens).toBeGreaterThan(0);
    expect(out.usage.promptTokens).toBe(200);
  });

  it("leaves a response with real usage unchanged (same object)", () => {
    const r = resp({ promptTokens: 5, completionTokens: 5, totalTokens: 10 }, "hi");
    expect(withUsageFallback(ir("p"), r)).toBe(r);
  });
});
