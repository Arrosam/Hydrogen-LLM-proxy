import { beforeEach, describe, expect, it, vi } from "vitest";

// validateMub consults the live catalog; mock it so these tests stay unit-level.
vi.mock("../src/services/catalog", () => ({ mappingExists: vi.fn(() => true) }));

import { mappingExists } from "../src/services/catalog";
import { MubValidationError, validateMub } from "../src/services/mubs";

const step = { model: "m", provider: "p" };
const chainOf = (stages: unknown[]) => ({ kind: "chain", timeoutMs: 60_000, stages });

beforeEach(() => {
  vi.mocked(mappingExists).mockReturnValue(true);
});

describe("validateMub", () => {
  it("accepts a valid chain and summarizes it", () => {
    const { summary } = validateMub({
      kind: "chain",
      timeoutMs: 60_000,
      stages: [
        { name: "a", steps: [step] },
        { name: "b", steps: [step], input: [{ role: "user", parts: [{ source: "stage", name: "a" }] }] },
      ],
    });
    expect(summary).toBe("chain: a → b");
  });

  it("rejects duplicate stage names", () => {
    expect(() =>
      validateMub({ kind: "chain", timeoutMs: 60_000, stages: [{ name: "x", steps: [step] }, { name: "x", steps: [step] }] }),
    ).toThrow(MubValidationError);
  });

  it("rejects a forward stage reference", () => {
    expect(() =>
      validateMub({
        kind: "chain",
        timeoutMs: 60_000,
        stages: [
          { name: "a", steps: [step], input: [{ role: "user", parts: [{ source: "stage", name: "b" }] }] },
          { name: "b", steps: [step] },
        ],
      }),
    ).toThrow(/not an earlier stage/);
  });

  it("rejects an unknown output stage", () => {
    expect(() =>
      validateMub({ kind: "chain", timeoutMs: 60_000, output: "z", stages: [{ name: "a", steps: [step] }] }),
    ).toThrow(/output stage/);
  });

  it("rejects unmapped (model, provider) pairs", () => {
    vi.mocked(mappingExists).mockReturnValue(false);
    try {
      validateMub({ kind: "chain", timeoutMs: 60_000, stages: [{ name: "a", steps: [step] }] });
      throw new Error("expected validateMub to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MubValidationError);
      expect((e as MubValidationError).invalidPairs).toEqual(["m@p"]);
    }
  });

  it("rejects a backward transition goto (forward-only)", () => {
    expect(() =>
      validateMub(chainOf([
        { name: "a", steps: [step] },
        { name: "b", steps: [step], transitions: [{ when: { type: "always" }, goto: "a" }] },
      ])),
    ).toThrow(/forward-only|later stage/);
  });

  it("rejects a transition goto to an unknown stage", () => {
    expect(() =>
      validateMub(chainOf([{ name: "a", steps: [step], transitions: [{ when: { type: "always" }, goto: "zzz" }] }])),
    ).toThrow(/not a stage/);
  });

  it("rejects an output condition referencing a later stage", () => {
    expect(() =>
      validateMub(chainOf([
        { name: "a", steps: [step], transitions: [{ when: { type: "output_contains", value: "x", stage: "b" }, goto: "end" }] },
        { name: "b", steps: [step] },
      ])),
    ).toThrow(/later stage/);
  });

  it("rejects an invalid regex condition", () => {
    expect(() =>
      validateMub(chainOf([{ name: "a", steps: [step], transitions: [{ when: { type: "output_matches", value: "(" }, goto: "end" }] }])),
    ).toThrow(/invalid regex/);
  });

  it("rejects a router that tests output (it makes no model call)", () => {
    expect(() =>
      validateMub(chainOf([{ name: "a", transitions: [{ when: { type: "output_contains", value: "x" }, goto: "end" }] }])),
    ).toThrow(/router/);
  });

  it("still validates and summarizes legacy resilience MUBs", () => {
    const { summary } = validateMub({ timeoutMs: 60_000, steps: [step] });
    expect(summary).toBe("try m@p; else fail");
  });
});
