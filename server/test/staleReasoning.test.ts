import { describe, expect, it } from "vitest";
import { stripStaleReasoning, type Message } from "../src/core/ir/content";

const hasReasoning = (m: Message | undefined): boolean => !!m && m.content.some((p) => p.type === "reasoning");

describe("stripStaleReasoning", () => {
  it("removes reasoning from assistant turns before the latest user turn", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "q1" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "secret" }, { type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "q2" }] },
    ];
    const out = stripStaleReasoning(msgs);
    const assistant = out.find((m) => m.role === "assistant");
    expect(hasReasoning(assistant)).toBe(false);
    expect(assistant?.content.some((p) => p.type === "text")).toBe(true);
  });

  it("keeps reasoning when there is no later user turn (current turn)", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "q1" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "keep" }, { type: "text", text: "a1" }] },
    ];
    const out = stripStaleReasoning(msgs);
    expect(hasReasoning(out.find((m) => m.role === "assistant"))).toBe(true);
  });
});
