import { beforeEach, describe, expect, it, vi } from "vitest";

// validateMub consults the live catalog; mock it so these tests stay unit-level.
vi.mock("../src/services/catalog", () => ({ mappingExists: vi.fn(() => true) }));

import { mappingExists } from "../src/services/catalog";
import { MubValidationError, validateMub } from "../src/services/mubs";

const step = { model: "m", provider: "p" };

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

  it("still validates and summarizes legacy resilience MUBs", () => {
    const { summary } = validateMub({ timeoutMs: 60_000, steps: [step] });
    expect(summary).toBe("try m@p; else fail");
  });
});
