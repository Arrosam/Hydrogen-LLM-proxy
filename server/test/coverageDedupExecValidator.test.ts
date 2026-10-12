import { describe, expect, it } from "vitest";
import { ServiceValidationError, ServiceValidator } from "../src/execution/serviceValidator";
import { ServiceFactory } from "../src/execution/serviceFactory";
import { parseService } from "../src/execution/definition";
import type { Catalog } from "../src/catalog/catalog";
import type { ServiceRepo } from "../src/persistence/serviceRepo";
import type { Transport } from "../src/core/upstream/transport";
import { transcribeAudio } from "../src/execution/asr";

// Characterization of how a definition's references to saved services and to
// (model, provider) pairs are checked: at save time by the validator, at run
// time by the factory. The two word the same faults differently, and the
// factory alone requires the referenced service to be enabled.

const step = (model = "m") => ({ model, provider: "p" });
const SAVED: Record<string, { definition: unknown; enabled?: boolean }> = {
  chat: { definition: { steps: [step()] } },
  ocr: { definition: { category: "ocr", steps: [step()] } },
  stt: { definition: { category: "stt", steps: [step()] } },
  image: { definition: { category: "image", steps: [step()] } },
  sub: { definition: { kind: "micro_agent", stages: [{ name: "s", steps: [step()] }] } },
  off: { definition: { steps: [step()] }, enabled: false },
  offStt: { definition: { category: "stt", steps: [step()] }, enabled: false },
  broken: { definition: { steps: [] } },
};
let nextId = 1;
const rows = new Map(Object.entries(SAVED).map(([name, v]) => [name, { id: nextId++, name, enabled: v.enabled ?? true, definition: v.definition }]));
const services = {
  getByName: (name: string) => rows.get(name),
  def: (row: { definition: unknown }) => parseService(row.definition),
} as unknown as ServiceRepo;

const catalog = (mapped: (model: string) => boolean = () => true, media: "ok" | "none" | "unmapped" = "ok") =>
  ({
    exists: (model: string) => mapped(model),
    resolveWithin: () => (media === "ok" ? { ok: true, target: {} } : { ok: false, error: media === "none" ? "no_endpoint_in_family" : "mapping_not_found" }),
  }) as unknown as Catalog;

const agent = (extra: Record<string, unknown>, stages: unknown[] = [{ name: "main", steps: [step()] }]) => ({ kind: "micro_agent", stages, ...extra });
function failure(raw: unknown, cat: Catalog = catalog()): { message: string; invalidPairs: string[] } | string {
  try {
    new ServiceValidator(cat, services).validate(raw);
    return "valid";
  } catch (e) {
    if (e instanceof ServiceValidationError) return { message: e.message, invalidPairs: e.invalidPairs };
    return `threw ${(e as Error).name}`;
  }
}

describe("ServiceValidator: references", () => {
  it("accepts good references", () => {
    expect(failure(agent({ ocr: { service: "ocr" }, asr: { service: "stt" } }, [{ name: "a", service: "chat" }, { name: "b", service: "sub" }, { name: "c", service: "ocr" }]))).toBe("valid");
    expect(failure(agent({ ocr: { service: "chat" } }))).toBe("valid");
    // Save-time validation does not require the referenced service to be enabled.
    expect(failure(agent({ ocr: { service: "off" }, asr: { service: "offStt" } }, [{ name: "a", service: "off" }]))).toBe("valid");
  });

  it("stage references", () => {
    expect(failure(agent({}, [{ name: "a", service: "gone" }]))).toEqual({ message: 'stage "a": references unknown Model Service or Micro Agent "gone"', invalidPairs: [] });
    expect(failure(agent({}, [{ name: "a", service: "image" }]))).toEqual({ message: 'stage "a": references "image", a image service — only chat/OCR services can run inside a Micro Agent', invalidPairs: [] });
    // A referenced service whose definition cannot be read is not a save-time fault.
    expect(failure(agent({}, [{ name: "a", service: "broken" }]))).toBe("valid");
  });

  it("OCR references", () => {
    expect(failure(agent({ ocr: { service: "gone" } }))).toEqual({ message: 'image translation (OCR) references unknown Model Service "gone"', invalidPairs: [] });
    expect(failure(agent({ ocr: { service: "sub" } }))).toEqual({ message: 'image translation (OCR) references a Micro Agent "sub" (must be a Model Service)', invalidPairs: [] });
    expect(failure(agent({ ocr: { service: "stt" } }))).toEqual({ message: 'image translation (OCR) references "stt", a stt service — it must be a chat or OCR Model Service', invalidPairs: [] });
    expect(failure(agent({ ocr: {} }))).toEqual({ message: "image translation (OCR) is enabled but has no model (pick a Model Service)", invalidPairs: [] });
    expect(failure(agent({ ocr: { service: "broken" } }))).toEqual({ message: 'image translation (OCR) references "broken", whose saved definition is no longer valid (open and re-save it)', invalidPairs: [] });
  });

  it("ASR references", () => {
    expect(failure(agent({ asr: { service: "gone" } }))).toEqual({ message: 'audio transcription (ASR) references unknown Model Service "gone"', invalidPairs: [] });
    expect(failure(agent({ asr: { service: "sub" } }))).toEqual({ message: 'audio transcription (ASR) references a Micro Agent "sub" (must be an stt Model Service)', invalidPairs: [] });
    expect(failure(agent({ asr: { service: "chat" } }))).toEqual({ message: 'audio transcription (ASR) references "chat", a chat service — it must be an stt (speech-to-text) Model Service', invalidPairs: [] });
    expect(failure(agent({ asr: { service: "ocr" } }))).toEqual({ message: 'audio transcription (ASR) references "ocr", a ocr service — it must be an stt (speech-to-text) Model Service', invalidPairs: [] });
    expect(failure(agent({ asr: {} }))).toEqual({ message: "audio transcription (ASR) is enabled but has no model (pick an stt Model Service)", invalidPairs: [] });
    expect(failure(agent({ asr: { service: "broken" } }))).toEqual({ message: 'audio transcription (ASR) references "broken", whose saved definition is no longer valid (open and re-save it)', invalidPairs: [] });
  });

  it("unmapped pairs are collected across stages, OCR and ASR, in that order", () => {
    const unmapped = catalog((model) => !model.startsWith("x"), "unmapped");
    const def = agent({ ocr: { steps: [step("x3"), step("ok")] }, asr: { steps: [step("x4")] } }, [{ name: "a", steps: [step("x1"), step("ok")] }, { name: "b", steps: [step("x2")] }]);
    expect(failure(def, unmapped)).toEqual({
      message: "These (model, provider) pairs are not mapped in the catalog: x1@p, x2@p, x3@p, x4@p",
      invalidPairs: ["x1@p", "x2@p", "x3@p", "x4@p"],
    });
    expect(failure({ steps: [step("x1"), step("ok"), step("x2")] }, unmapped)).toEqual({
      message: "These (model, provider) pairs are not mapped in the catalog: x1@p, x2@p",
      invalidPairs: ["x1@p", "x2@p"],
    });
    expect(failure({ category: "image", steps: [step("x1")] }, unmapped)).toMatchObject({ invalidPairs: ["x1@p"] });
  });

  it("a mapped pair with no OpenAI-compatible endpoint is its own fault", () => {
    const none = catalog(() => true, "none");
    expect(failure(agent({ asr: { steps: [step()] } }), none)).toEqual({
      message: "step m@p: audio transcription (ASR) steps require an OpenAI-compatible endpoint, and this mapping enables none (add an OpenAI alternate endpoint to the provider and enable it on the mapping)",
      invalidPairs: [],
    });
    expect(failure({ category: "tts", steps: [step()] }, none)).toEqual({
      message: "step m@p: tts services require an OpenAI-compatible endpoint, and this mapping enables none (add an OpenAI alternate endpoint to the provider and enable it on the mapping)",
      invalidPairs: [],
    });
  });

  it("router stages: no output to test or return", () => {
    const routed = (transition: unknown) => agent({}, [{ name: "a", steps: [step()] }, { name: "r", transitions: [transition] }, { name: "z", steps: [step()] }]);
    expect(failure(routed({ when: { type: "output_contains", value: "x" }, goto: "z" }))).toEqual({ message: 'stage "r": cannot test output -- a router makes no model call', invalidPairs: [] });
    expect(failure(routed({ when: { type: "always" }, goto: "end", output: "r" }))).toEqual({ message: 'stage "r": transition returns router stage "r", which produces no output', invalidPairs: [] });
    expect(failure(routed({ when: { type: "always" }, goto: "end", output: "a" }))).toBe("valid");
    // An empty inline chain is a router too.
    expect(failure(agent({}, [{ name: "a", steps: [step()] }, { name: "r", steps: [], transitions: [{ when: { type: "always" }, goto: "end", output: "r" }] }]))).not.toBe("valid");
  });
});

describe("ServiceFactory: run-time references", () => {
  const factory = new ServiceFactory(services, { catalog: catalog(), transport: {} as Transport }, 1000);

  it("resolve", () => {
    expect(factory.resolve("gone")).toEqual({ ok: false, message: 'references unknown or disabled Model Service or Micro Agent "gone"' });
    expect(factory.resolve("off")).toEqual({ ok: false, message: 'references unknown or disabled Model Service or Micro Agent "off"' });
    expect(factory.resolve("image")).toEqual({ ok: false, message: '"image" is a image service and cannot run inside a Micro Agent' });
    expect(factory.resolve("stt")).toEqual({ ok: false, message: '"stt" is a stt service and cannot run inside a Micro Agent' });
    expect(factory.resolve("broken")).toEqual({ ok: false, message: '"broken" has an invalid definition' });
    expect(factory.resolve("chat")).toMatchObject({ ok: true, isAgent: false });
    expect(factory.resolve("ocr")).toMatchObject({ ok: true, isAgent: false });
    expect(factory.resolve("sub")).toMatchObject({ ok: true, isAgent: true });
  });

  it("sttDef", () => {
    expect(factory.sttDef("gone")).toEqual({ ok: false, message: 'audio transcription (ASR) references unknown or disabled Model Service "gone"' });
    expect(factory.sttDef("offStt")).toEqual({ ok: false, message: 'audio transcription (ASR) references unknown or disabled Model Service "offStt"' });
    expect(factory.sttDef("sub")).toEqual({ ok: false, message: 'audio transcription (ASR) references a Micro Agent "sub" (must be an stt Model Service)' });
    expect(factory.sttDef("chat")).toEqual({ ok: false, message: 'audio transcription (ASR) references "chat", a chat service — it must be an stt (speech-to-text) Model Service' });
    expect(factory.sttDef("broken")).toEqual({ ok: false, message: '"broken" has an invalid definition' });
    const ok = factory.sttDef("stt");
    expect(ok).toMatchObject({ ok: true, def: { category: "stt" } });
  });
});

describe("ASR step resolution diagnostics", () => {
  const def = parseService({ category: "stt", steps: [{ model: "m", provider: "p", retry: { maxAttempts: 1 } }] }) as never;
  const run = (media: "none" | "unmapped") => transcribeAudio(def, { data: "", format: "wav" }, { catalog: catalog(() => true, media), transport: {} as Transport });

  it("names the missing OpenAI-compatible endpoint and its remedy", async () => {
    expect((await run("none")).result).toEqual({
      ok: false, status: 0, kind: "error",
      message: "audio transcription (ASR) requires an OpenAI-compatible endpoint: m@p has none enabled (add an OpenAI alternate endpoint to the provider and enable it on the mapping)",
    });
  });

  it("reports any other resolution failure as a mapping error", async () => {
    expect((await run("unmapped")).result).toEqual({ ok: false, status: 0, kind: "error", message: "mapping m@p: mapping_not_found" });
  });
});
