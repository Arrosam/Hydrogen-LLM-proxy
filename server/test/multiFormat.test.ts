/**
 * Multi-format providers: a provider may serve several wire formats; the
 * mapping picks which are enabled, and resolution prefers the client's own
 * format so a same-format request skips translation entirely.
 */
import { describe, expect, it } from "vitest";
import { Catalog } from "../src/catalog/catalog";
import type { ModelRepo } from "../src/persistence/modelRepo";
import type { ProviderRepo } from "../src/persistence/providerRepo";
import type { MappingRepo } from "../src/persistence/mappingRepo";

function catalog(opts: { families?: string[] | null; altEndpoints?: Array<{ type: string; baseUrl: string }> | null }) {
  const models = { getByName: () => ({ id: 1, name: "m", enabled: true }) } as unknown as ModelRepo;
  const providers = {
    getByName: () => ({
      id: 2, name: "p", enabled: true, type: "openai_completion", baseUrl: "http://p.test/v1",
      maxOutputTokens: null, altEndpoints: opts.altEndpoints ?? null,
    }),
    toUpstream: () => ({ type: "openai_completion", baseUrl: "http://p.test/v1", apiKey: "k", extraHeaders: null }),
  } as unknown as ProviderRepo;
  const mappings = {
    getPair: () => ({ id: 3, modelId: 1, providerId: 2, upstreamModel: "up", enabled: true, families: opts.families ?? null }),
  } as unknown as MappingRepo;
  return new Catalog(models, providers, mappings);
}

const ALT = [{ type: "openai_responses", baseUrl: "http://p.test/go/v1" }];

describe("multi-format endpoint resolution", () => {
  it("defaults to the primary endpoint when the mapping enables nothing", () => {
    const r = catalog({ altEndpoints: ALT }).resolve("m", "p", "openai_responses");
    expect(r.ok && r.target.family).toBe("openai_completion"); // families unset = primary only
  });

  it("prefers the client's own format when the mapping enables it", () => {
    const r = catalog({ altEndpoints: ALT, families: ["openai_completion", "openai_responses"] }).resolve("m", "p", "openai_responses");
    expect(r.ok && r.target.family).toBe("openai_responses");
    expect(r.ok && r.target.url).toContain("/go/v1/responses");
  });

  it("falls back to the primary when the preferred format is not served", () => {
    const r = catalog({ altEndpoints: ALT, families: ["openai_completion", "openai_responses"] }).resolve("m", "p", "anthropic");
    expect(r.ok && r.target.family).toBe("openai_completion");
    expect(r.ok && r.target.url).toContain("http://p.test/v1/chat/completions");
  });

  it("a mapping restricted to the alternate format always uses it", () => {
    const r = catalog({ altEndpoints: ALT, families: ["openai_responses"] }).resolve("m", "p", "openai_completion");
    expect(r.ok && r.target.family).toBe("openai_responses");
  });

  it("no preferred family keeps the old behavior exactly", () => {
    const r = catalog({ altEndpoints: ALT, families: ["openai_completion", "openai_responses"] }).resolve("m", "p");
    expect(r.ok && r.target.family).toBe("openai_completion");
  });
});
