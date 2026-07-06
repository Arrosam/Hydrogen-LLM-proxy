import { describe, expect, it } from "vitest";
import { applyStepOverrides } from "../src/core/proxy/run";
import type { IRRequest } from "../src/core/ir";

describe("applyStepOverrides", () => {
  it("applies a step's thinking override over the client's, and passes through when absent", () => {
    const base: IRRequest = { requestedModel: "svc", messages: [], stream: false, thinking: "low" };

    // Step override wins over whatever the client requested.
    expect(applyStepOverrides(base, { model: "m", provider: "p", thinking: "max" }).thinking).toBe("max");
    // No step override -> keep the client's.
    expect(applyStepOverrides(base, { model: "m", provider: "p" }).thinking).toBe("low");
    // Applies even when the client sent nothing.
    const noThink: IRRequest = { requestedModel: "svc", messages: [], stream: false };
    expect(applyStepOverrides(noThink, { model: "m", provider: "p", thinking: "high" }).thinking).toBe("high");
    // Does not mutate the input IR.
    expect(base.thinking).toBe("low");
  });
});
