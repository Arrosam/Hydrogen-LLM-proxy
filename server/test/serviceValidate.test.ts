import { beforeEach, describe, expect, it, vi } from "vitest";

// validateService consults the live catalog; mock it so these tests stay unit-level.
vi.mock("../src/services/catalog", () => ({ mappingExists: vi.fn(() => true) }));

import { mappingExists } from "../src/services/catalog";
import { ServiceValidationError, validateService } from "../src/services/services";

const step = { model: "m", provider: "p" };
const agentOf = (stages: unknown[]) => ({ kind: "agent", timeoutMs: 60_000, stages });

beforeEach(() => {
  vi.mocked(mappingExists).mockReturnValue(true);
});

describe("validateService", () => {
  it("accepts a valid chain and summarizes it", () => {
    const { summary } = validateService({
      kind: "agent",
      timeoutMs: 60_000,
      stages: [
        { name: "a", steps: [step] },
        { name: "b", steps: [step], input: [{ kind: "stage_output", stage: "a", role: "user" }] },
      ],
    });
    expect(summary).toBe("agent: a -> b");
  });

  it("rejects duplicate stage names", () => {
    expect(() =>
      validateService({ kind: "agent", timeoutMs: 60_000, stages: [{ name: "x", steps: [step] }, { name: "x", steps: [step] }] }),
    ).toThrow(ServiceValidationError);
  });

  it("rejects a forward stage reference", () => {
    expect(() =>
      validateService({
        kind: "agent",
        timeoutMs: 60_000,
        stages: [
          { name: "a", steps: [step], input: [{ kind: "stage_output", stage: "b", role: "user" }] },
          { name: "b", steps: [step] },
        ],
      }),
    ).toThrow(/not an earlier stage/);
  });

  it("rejects an unknown output stage", () => {
    expect(() =>
      validateService({ kind: "agent", timeoutMs: 60_000, output: "z", stages: [{ name: "a", steps: [step] }] }),
    ).toThrow(/output stage/);
  });

  it("rejects unmapped (model, provider) pairs", () => {
    vi.mocked(mappingExists).mockReturnValue(false);
    try {
      validateService({ kind: "agent", timeoutMs: 60_000, stages: [{ name: "a", steps: [step] }] });
      throw new Error("expected validateService to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceValidationError);
      expect((e as ServiceValidationError).invalidPairs).toEqual(["m@p"]);
    }
  });

  it("rejects a backward transition goto (forward-only)", () => {
    expect(() =>
      validateService(agentOf([
        { name: "a", steps: [step] },
        { name: "b", steps: [step], transitions: [{ when: { type: "always" }, goto: "a" }] },
      ])),
    ).toThrow(/forward-only|later stage/);
  });

  it("rejects a transition goto to an unknown stage", () => {
    expect(() =>
      validateService(agentOf([{ name: "a", steps: [step], transitions: [{ when: { type: "always" }, goto: "zzz" }] }])),
    ).toThrow(/not a stage/);
  });

  it("accepts a transition that returns an earlier stage's output", () => {
    const { summary } = validateService(agentOf([
      { name: "a", steps: [step] },
      { name: "b", steps: [step], transitions: [{ when: { type: "always" }, goto: "end", output: "a" }] },
    ]));
    expect(summary).toBe("agent: a -> b (branching)");
  });

  it("rejects a transition that returns a later stage", () => {
    expect(() =>
      validateService(agentOf([
        { name: "a", steps: [step], transitions: [{ when: { type: "always" }, goto: "end", output: "b" }] },
        { name: "b", steps: [step] },
      ])),
    ).toThrow(/returns later stage/);
  });

  it("rejects a transition that returns a router stage", () => {
    expect(() =>
      validateService(agentOf([
        { name: "r", transitions: [{ when: { type: "always" }, goto: "a" }] },
        { name: "a", steps: [step], transitions: [{ when: { type: "always" }, goto: "end", output: "r" }] },
      ])),
    ).toThrow(/router stage/);
  });

  it("rejects an output condition referencing a later stage", () => {
    expect(() =>
      validateService(agentOf([
        { name: "a", steps: [step], transitions: [{ when: { type: "output_contains", value: "x", stage: "b" }, goto: "end" }] },
        { name: "b", steps: [step] },
      ])),
    ).toThrow(/later stage/);
  });

  it("rejects an invalid regex condition", () => {
    expect(() =>
      validateService(agentOf([{ name: "a", steps: [step], transitions: [{ when: { type: "output_matches", value: "(" }, goto: "end" }] }])),
    ).toThrow(/invalid regex/);
  });

  it("rejects a router that tests output (it makes no model call)", () => {
    expect(() =>
      validateService(agentOf([{ name: "a", transitions: [{ when: { type: "output_contains", value: "x" }, goto: "end" }] }])),
    ).toThrow(/router/);
  });

  it("rejects a tool_turn with invalid JSON arguments", () => {
    expect(() =>
      validateService(agentOf([{ name: "a", steps: [step], input: [{ kind: "tool_turn", name: "t", input: "{not json" }] }])),
    ).toThrow(/invalid JSON/);
  });

  it("accepts a chain with an OCR pre-pass and notes it in the summary", () => {
    const { summary } = validateService({
      kind: "agent",
      timeoutMs: 60_000,
      stages: [{ name: "a", steps: [step] }],
      ocr: { steps: [step] },
    });
    expect(summary).toBe("agent: OCR -> a");
  });

  it("rejects an OCR pre-pass with no model", () => {
    expect(() =>
      validateService({ kind: "agent", timeoutMs: 60_000, stages: [{ name: "a", steps: [step] }], ocr: {} }),
    ).toThrow(/OCR.*no model/);
  });

  it("rejects an OCR pre-pass with an unmapped (model, provider) pair", () => {
    vi.mocked(mappingExists).mockReturnValue(false);
    try {
      validateService({ kind: "agent", timeoutMs: 60_000, stages: [{ name: "a", steps: [step] }], ocr: { steps: [step] } });
      throw new Error("expected validateService to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceValidationError);
      expect((e as ServiceValidationError).invalidPairs).toContain("m@p");
    }
  });

  it("still validates and summarizes legacy resilience services", () => {
    const { summary } = validateService({ timeoutMs: 60_000, steps: [step] });
    expect(summary).toBe("try m@p; else fail");
  });
});
