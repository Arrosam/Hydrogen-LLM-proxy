/**
 * Log payload serialization.
 *
 * The load-bearing property is that size is decided by WALKING the payload, not
 * by building it: pretty-printing a 1.5 MB body only to discover it exceeded the
 * budget was the largest transient allocation on the serving path, and a Micro
 * Agent repeated it once per stage. These tests pin the observable half of that —
 * a payload that fits is still stored byte for byte, and one that doesn't is
 * still valid, bounded JSON.
 */
import { describe, expect, it } from "vitest";
import { serializeForLog } from "../src/util/logPayload";

const conversation = (turns: number, chars: number): Array<{ role: string; content: string }> =>
  Array.from({ length: turns }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(chars) }));

describe("serializeForLog", () => {
  it("stores a payload that fits exactly as pretty-printed JSON", () => {
    const value = { model: "m", temperature: 0.2, messages: [{ role: "user", content: "hi" }] };
    // Byte-for-byte identical to the naive implementation: skipping the build
    // must not change what a fitting payload looks like in the log.
    expect(serializeForLog(value, 100_000)).toBe(JSON.stringify(value, null, 2));
  });

  it("treats maxChars <= 0 as unlimited", () => {
    const value = { messages: [{ role: "user", content: "q".repeat(50_000) }] };
    expect(serializeForLog(value, 0)).toBe(JSON.stringify(value, null, 2));
  });

  it("redacts credential-named keys at any depth", () => {
    const out = serializeForLog(
      { authorization: "Bearer sk-live-secret", nested: { api_key: "sk-2", password: "pw" } },
      100_000,
    );
    expect(out).not.toContain("sk-live-secret");
    expect(out).not.toContain("sk-2");
    expect(JSON.parse(out)).toEqual({
      authorization: "[redacted]",
      nested: { api_key: "[redacted]", password: "[redacted]" },
    });
  });

  it("keeps an oversized payload inside the budget and still parseable", () => {
    const out = serializeForLog({ model: "m", messages: conversation(200, 5_000) }, 20_000);
    expect(out.length).toBeLessThanOrEqual(20_000);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("shortens long strings before it gives up on structure", () => {
    // One enormous turn: truncating strings is enough, so every turn survives.
    const out = serializeForLog({ messages: [{ role: "user", content: "y".repeat(500_000) }] }, 20_000);
    const parsed = JSON.parse(out);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].content).toContain("chars]"); // the truncation marker
    expect(out.length).toBeLessThanOrEqual(20_000);
  });

  it("keeps the small config fields visible when the conversation is the bulk", () => {
    const out = serializeForLog({ model: "gpt-9", temperature: 0.4, messages: conversation(500, 2_000) }, 5_000);
    const parsed = JSON.parse(out);
    expect(parsed.model).toBe("gpt-9");
    expect(parsed.temperature).toBe(0.4);
    expect(parsed._truncated).toBe(true);
    expect(String(parsed.messages)).toContain("500 item(s) omitted");
  });

  it("reports the original size as approximate, never as an exact count", () => {
    // An exact count would require building the string this avoids building.
    const parsed = JSON.parse(serializeForLog({ messages: conversation(500, 2_000) }, 5_000));
    expect(parsed._approxOriginalChars).toBeGreaterThan(900_000);
    expect(parsed).not.toHaveProperty("_originalChars");
  });

  it("honours an absurdly small budget without leaking payload content", () => {
    const out = serializeForLog({ note: "w".repeat(10_000) }, 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).not.toContain("wwww");
  });

  it("does not mistake a payload that merely looks big for one that is", () => {
    // Lots of tiny fields: the walk must not overcount and truncate something
    // that would have fitted.
    const value: Record<string, number> = {};
    for (let i = 0; i < 200; i++) value[`k${i}`] = i;
    expect(serializeForLog(value, 100_000)).toBe(JSON.stringify(value, null, 2));
  });
});
