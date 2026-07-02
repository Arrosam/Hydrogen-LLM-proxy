import { describe, expect, it } from "vitest";
import { serializeForLog } from "../src/util/logPayload";

function bigAnthropicRequest(fill: number): Record<string, unknown> {
  return {
    model: "glm5.2",
    max_tokens: 32000,
    stream: true,
    system: "S".repeat(fill),
    messages: [
      { role: "user", content: [{ type: "text", text: "U".repeat(fill) }] },
      { role: "assistant", content: [{ type: "text", text: "A".repeat(fill) }] },
    ],
    tools: [{ name: "get_weather", description: "D".repeat(fill), input_schema: { type: "object" } }],
  };
}

describe("serializeForLog", () => {
  it("passes small payloads through unchanged (valid JSON)", () => {
    const payload = { model: "m", messages: [{ role: "user", content: "hi" }] };
    const out = serializeForLog(payload, 100000);
    expect(JSON.parse(out)).toEqual(payload);
  });

  it("does not truncate when maxChars is 0 (unlimited)", () => {
    const payload = bigAnthropicRequest(50000);
    const out = serializeForLog(payload, 0);
    expect(JSON.parse(out)).toEqual(payload);
  });

  it("keeps oversized payloads as VALID, parseable JSON within budget", () => {
    const max = 5000;
    const out = serializeForLog(bigAnthropicRequest(20000), max);
    expect(out.length).toBeLessThanOrEqual(max);
    // The whole point: it must still parse (so the viewer can format it).
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.model).toBe("glm5.2");
    // Structure preserved: every turn is still present, just shortened.
    expect(Array.isArray(parsed.messages)).toBe(true);
    expect((parsed.messages as unknown[]).length).toBe(2);
  });

  it("marks truncated string fields", () => {
    const out = serializeForLog(bigAnthropicRequest(20000), 5000);
    expect(out).toContain("chars]");
  });

  it("demonstrates the old naive string-cut produced invalid JSON", () => {
    const pretty = JSON.stringify(bigAnthropicRequest(20000), null, 2);
    const naiveCut = pretty.slice(0, 5000);
    expect(() => JSON.parse(naiveCut)).toThrow(); // regression guard
  });

  it("redacts credential-named fields (case-insensitive) at any depth", () => {
    const out = serializeForLog(
      {
        model: "m",
        api_key: "sk-secret-123",
        headers: { Authorization: "Bearer sk-secret-456" },
        messages: [{ role: "user", content: "hello" }],
      },
      100000,
    );
    expect(out).not.toContain("sk-secret-123");
    expect(out).not.toContain("sk-secret-456");
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.api_key).toBe("[redacted]");
    expect((parsed.headers as Record<string, unknown>).Authorization).toBe("[redacted]");
    expect(parsed.model).toBe("m"); // non-sensitive content preserved
  });
});
