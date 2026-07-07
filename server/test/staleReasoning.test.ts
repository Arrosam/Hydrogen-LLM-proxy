import { describe, expect, it } from "vitest";
import { stripStaleReasoning, type IRMessage } from "../src/core/ir";
import * as anthropic from "../src/core/formats/anthropic";

const hasReasoning = (m: IRMessage | undefined) => !!m?.content.some((p) => p.type === "reasoning");

describe("stripStaleReasoning", () => {
  it("drops reasoning from a prior assistant chat turn", () => {
    const msgs: IRMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "prior thought" }, { type: "text", text: "answer" }] },
      { role: "user", content: [{ type: "text", text: "again" }] },
    ];
    const out = stripStaleReasoning(msgs);
    expect(hasReasoning(out[1])).toBe(false);
    expect(out[1].content.some((p) => p.type === "text")).toBe(true); // text kept
  });

  it("keeps reasoning on an unresolved tool-use turn (Anthropic requires it)", () => {
    const msgs: IRMessage[] = [
      { role: "user", content: [{ type: "text", text: "weather?" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "I'll call the tool" },
          { type: "tool_use", id: "t1", name: "get_weather", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: [{ type: "text", text: "sunny" }] }] },
    ];
    const out = stripStaleReasoning(msgs);
    expect(hasReasoning(out[1])).toBe(true);
  });

  it("strips an old resolved tool-use turn but keeps the current tool-use loop", () => {
    const msgs: IRMessage[] = [
      { role: "user", content: [{ type: "text", text: "q1" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "old" }, { type: "tool_use", id: "a", name: "f", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "a", content: [{ type: "text", text: "r" }] }] },
      { role: "user", content: [{ type: "text", text: "q2 (new turn)" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "current" }, { type: "tool_use", id: "b", name: "g", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "b", content: [{ type: "text", text: "r2" }] }] },
    ];
    const out = stripStaleReasoning(msgs);
    expect(hasReasoning(out[1])).toBe(false); // old tool-use turn: stripped
    expect(hasReasoning(out[4])).toBe(true); // current tool-use loop: kept
  });

  it("is wired into requestToIR so history reasoning is stripped", () => {
    const ir = anthropic.requestToIR({
      model: "svc",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "thinking", thinking: "prior" }, { type: "text", text: "answer" }] },
        { role: "user", content: "next" },
      ],
    });
    const asst = ir.messages.find((m) => m.role === "assistant");
    expect(hasReasoning(asst)).toBe(false);
  });
});
