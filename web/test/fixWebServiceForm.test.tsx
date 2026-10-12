/**
 * Regression tests for defects fixed in the pure halves of the service editors
 * (lib/serviceForm, lib/agentStage, lib/sse). One describe per defect.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_RETRY_ON } from "../src/lib/serviceDef";
import { EMPTY_SERVICE_FORM, blankStep, defToForm, formToDef, newServiceForm, serviceToForm, withRetry, type ServiceForm } from "../src/lib/serviceForm";
import type { ModelService, ServiceDef, ServiceStep } from "../src/types";

const form = (over: Partial<ServiceForm> = {}): ServiceForm => ({ ...EMPTY_SERVICE_FORM, ...over });
const svc = (id: number, name: string, steps: ServiceDef, extra: Partial<ModelService> = {}): ModelService => ({
  id, name, description: null, steps, enabled: true, summary: "", createdAt: id, ...extra,
});

describe("WA1: opening the editor resets the ASR pre-pass", () => {
  const dirty = form({ kind: "chain", asr: { service: "whisper" }, ocr: { service: "vision" } });

  it("a stored Model Service clears a previous agent's ASR pre-pass", () => {
    const next = { ...dirty, ...serviceToForm(svc(1, "svc", { timeoutMs: 1, steps: [] })) };
    expect(next.asr).toBeUndefined();
  });

  it.each([["resilience"], ["chain"]] as const)("a new %s service starts without an ASR pre-pass", (kind) => {
    const next = { ...dirty, ...newServiceForm(kind, kind === "resilience" ? blankStep("m", "p") : null) };
    expect(next.asr).toBeUndefined();
    expect(next.ocr).toBeUndefined();
  });

  it("a stored agent without an ASR pre-pass clears the previous one, one with it keeps its own", () => {
    expect({ ...dirty, ...serviceToForm(svc(2, "a", { kind: "micro_agent", timeoutMs: 1, stages: [] })) }.asr).toBeUndefined();
    const own = { service: "ears", timeoutMs: 5000 };
    expect({ ...dirty, ...serviceToForm(svc(3, "b", { kind: "micro_agent", timeoutMs: 1, stages: [], asr: own })) }.asr).toEqual(own);
  });
});

describe("WA2: a retry policy started from a bare step keeps the default trigger set", () => {
  const bare: ServiceStep = { model: "m", provider: "p" };

  it("mirrors the server's default trigger set", () => {
    expect(DEFAULT_RETRY_ON).toEqual([429, 499, 502, 503, "timeout", "network"]);
  });

  it.each([[{ maxAttempts: 5 }], [{ intervalMs: 250 }]])("changing only %j saves the default triggers, not 'retry on nothing'", (patch) => {
    expect(withRetry(bare, patch).retry).toEqual({ on: DEFAULT_RETRY_ON, maxAttempts: 3, intervalMs: 0, ...patch });
  });

  it("the policy is dropped again once it equals the server default, whatever the order of its triggers", () => {
    const step = withRetry(bare, { maxAttempts: 5 });
    expect("retry" in withRetry(step, { maxAttempts: 3 })).toBe(false);
    expect("retry" in withRetry({ ...bare, retry: { on: [...DEFAULT_RETRY_ON].reverse(), maxAttempts: 3, intervalMs: 0 } }, {})).toBe(false);
  });

  it("an explicit empty trigger set is 'retry on nothing' and is kept, not replaced by the defaults", () => {
    const none = { ...bare, retry: { on: [], maxAttempts: 4, intervalMs: 0 } };
    expect(withRetry(none, { maxAttempts: 3 }).retry).toEqual({ on: [], maxAttempts: 3, intervalMs: 0 });
  });

  it("does not hand out the shared default array", () => {
    expect(withRetry(bare, { maxAttempts: 5 }).retry!.on).not.toBe(DEFAULT_RETRY_ON);
  });
});

describe("WA4: the attachment budget keeps its stored byte value until the field is edited", () => {
  const MIB = 1024 * 1024;
  const roundTrip = (bytes: number) => formToDef(form(defToForm({ timeoutMs: 1, steps: [], maxAttachmentBytes: bytes }))).maxAttachmentBytes;

  it.each([[1], [300 * 1024], [MIB / 2 - 1], [MIB / 2], [MIB + 1], [1_500_000], [5 * MIB + 7]])("%d bytes survive an untouched load and save", (bytes) => {
    expect(roundTrip(bytes)).toBe(bytes);
  });

  it.each([[MIB], [8 * MIB]])("a whole number of MiB (%d bytes) is unchanged too", (bytes) => {
    expect(roundTrip(bytes)).toBe(bytes);
  });

  it("an absent or zero budget stays absent", () => {
    expect("maxAttachmentBytes" in formToDef(form(defToForm({ timeoutMs: 1, steps: [] })))).toBe(false);
    expect("maxAttachmentBytes" in formToDef(form(defToForm({ timeoutMs: 1, steps: [], maxAttachmentBytes: 0 })))).toBe(false);
  });

  it("still shows the budget in whole MiB", () => {
    expect(defToForm({ timeoutMs: 1, steps: [], maxAttachmentBytes: 1_500_000 }).maxAttachmentMiB).toBe(1);
  });

  it("opening another service does not inherit the previous one's exact budget", () => {
    const before = form(defToForm({ timeoutMs: 1, steps: [], maxAttachmentBytes: 1_500_000 }));
    const next = { ...before, ...serviceToForm(svc(1, "svc", { timeoutMs: 1, steps: [], maxAttachmentBytes: 2 * MIB })) };
    expect(formToDef(next).maxAttachmentBytes).toBe(2 * MIB);
    expect("maxAttachmentBytes" in formToDef({ ...before, ...newServiceForm("resilience", null) })).toBe(false);
  });
});

describe("WA8: a stored agent keeps its reliableStreaming flag", () => {
  const AGENT: ServiceDef = { kind: "micro_agent", timeoutMs: 1, stages: [], reliableStreaming: true };

  it("survives the round trip through the form, written after the pre-passes", () => {
    const def = formToDef(form(defToForm({ ...AGENT, output: "a", asr: { service: "w" }, maxAttachmentBytes: 1024 * 1024 } as ServiceDef)));
    expect(def.reliableStreaming).toBe(true);
    expect(Object.keys(def)).toEqual(["kind", "timeoutMs", "stages", "output", "asr", "reliableStreaming", "maxAttachmentBytes", "hostedTools"]);
  });

  it.each([[false], [undefined]])("a flag of %s is still not written", (reliableStreaming) => {
    expect("reliableStreaming" in formToDef(form(defToForm({ ...AGENT, reliableStreaming } as ServiceDef)))).toBe(false);
  });

  it("an agent opened after a reliable Model Service does not inherit the flag", () => {
    const before = form(defToForm({ timeoutMs: 1, steps: [], reliableStreaming: true }));
    const next = { ...before, ...serviceToForm(svc(2, "a", { kind: "micro_agent", timeoutMs: 1, stages: [] })) };
    expect("reliableStreaming" in formToDef(next)).toBe(false);
  });
});
