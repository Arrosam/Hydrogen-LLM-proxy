/**
 * The service-kind registry: a step chain is native, anything else is
 * delegated to whoever registered the kind, and a kind nobody registered is
 * rejected by name rather than silently treated as something else.
 */
import { describe, expect, it } from "vitest";
import {
  ModelService,
  ServiceValidator,
  UnknownServiceKindError,
  canonicalKind,
  isStepChain,
  parseService,
  registerServiceKind,
  registeredKinds,
  serviceCategory,
  serviceKind,
  summarizeService,
  type Catalog,
  type ServiceKindHandler,
  type ServiceLookup,
} from "@areelai/model-services";

const STEPS = { steps: [{ model: "m", provider: "p" }] };

describe("unknown kinds", () => {
  it("rejects a definition whose kind nobody has registered, naming the kind", () => {
    expect(() => parseService({ kind: "not_installed", timeoutMs: 60_000 })).toThrow(UnknownServiceKindError);
    expect(() => parseService({ kind: "not_installed", timeoutMs: 60_000 })).toThrow('unknown service kind "not_installed"');
  });

  it("rejects it at validation time too, before the catalog is consulted", () => {
    const catalog = { exists: () => true, resolveWithin: () => ({ ok: true }) } as unknown as Catalog;
    const services: ServiceLookup = { getByName: () => undefined, def: () => { throw new Error("unused"); } };
    const validator = new ServiceValidator(catalog, services);
    expect(() => validator.validate({ kind: "not_installed", timeoutMs: 60_000 })).toThrow(UnknownServiceKindError);
  });

  it("summarizes a stored definition of an uninstalled kind without throwing", () => {
    expect(summarizeService({ kind: "not_installed", timeoutMs: 60_000 })).toContain("not installed");
  });
});

describe("step chains", () => {
  it("parse without a kind, or with the step-chain kind, and are stored under it", () => {
    const bare = parseService(STEPS);
    const explicit = parseService({ kind: "model_service", ...STEPS });
    expect(isStepChain(bare)).toBe(true);
    expect(isStepChain(explicit)).toBe(true);
    expect(canonicalKind(bare)).toBe("model_service");
    expect(serviceCategory(bare)).toBe("chat");
    expect(summarizeService(bare)).toContain("m@p");
  });
});

describe("a registered kind", () => {
  const handler: ServiceKindHandler<{ kind: string; timeoutMs: number; label: string }> = {
    kind: "echo",
    aliases: ["echo_legacy"],
    parse: (raw) => {
      const r = raw as { kind: string; timeoutMs?: number; label?: string };
      if (typeof r.label !== "string") throw new Error("label required");
      return { kind: r.kind, timeoutMs: r.timeoutMs ?? 60_000, label: r.label };
    },
    category: () => "chat",
    summarize: (def) => `echo: ${def.label}`,
    references: () => ["child"],
    validate: (def, ctx) => {
      if (def.label === "bad") ctx.fail("label may not be bad");
    },
    build: (def, ctx) => new ModelService({ timeoutMs: def.timeoutMs, steps: [{ model: "m", provider: "p" }] }, ctx.deps),
  };

  it("is parsed, summarized and stored under its canonical kind, aliases included", () => {
    registerServiceKind(handler);
    expect(registeredKinds()).toContain("echo");
    expect(serviceKind("echo_legacy")?.kind).toBe("echo");
    const def = parseService({ kind: "echo_legacy", label: "hi" });
    expect(isStepChain(def)).toBe(false);
    expect(canonicalKind(def)).toBe("echo");
    expect(summarizeService(def)).toBe("echo: hi");
    expect(serviceCategory(def)).toBe("chat");
  });

  it("runs its own validation through the validator's context", () => {
    registerServiceKind(handler);
    const catalog = { exists: () => true, resolveWithin: () => ({ ok: true }) } as unknown as Catalog;
    const services: ServiceLookup = { getByName: () => undefined, def: () => { throw new Error("unused"); } };
    const validator = new ServiceValidator(catalog, services);
    expect(validator.validate({ kind: "echo", label: "fine" }).summary).toBe("echo: fine");
    expect(() => validator.validate({ kind: "echo", label: "bad" })).toThrow("label may not be bad");
  });

  it("micro_agent is available here only because the suite registered it", () => {
    // test/setup.ts registers @areelai/micro-agent; without that an agent row
    // would be an unknown kind, which is what an adopter of this package alone sees.
    expect(serviceKind("micro_agent")).toBeDefined();
    expect(serviceKind("agent")?.kind).toBe("micro_agent");
  });
});
