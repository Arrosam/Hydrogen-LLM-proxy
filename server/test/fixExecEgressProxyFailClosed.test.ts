/**
 * E2: a provider whose egress proxy row no longer exists must not quietly
 * connect directly. The reference is dangling (nothing an operator did on the
 * proxy screen), so the provider is unusable until it is re-pointed.
 *
 * A DISABLED proxy is a different, documented case (the Proxies page tells the
 * operator that disabling returns its providers to a direct connection) and is
 * pinned here as unchanged.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startAdminHarness, type AdminHarness } from "./coverageAdminHarness";
import { MEDIA_FAMILIES } from "../src/catalog/catalog";
import { EgressProxyMissingError } from "../src/persistence/proxyRepo";
import { ModelService } from "../src/execution/modelService";
import type { ServiceSteps } from "../src/execution/definition";
import { OpenAICompletionRequest } from "../src/core/format";

let h: AdminHarness;
let proxyId: number;

beforeAll(async () => {
  h = await startAdminHarness("fix-exec-egress");
  proxyId = h.c.proxies.create({ name: "gone", scheme: "http", host: "egress.local", port: 3128 }).id;
  const provider = h.c.providers.create({ name: "via-gone", type: "openai_completion", baseUrl: "http://provider.invalid/v1", apiKey: "k", proxyId });
  const model = h.c.models.create({ name: "m-gone" });
  h.c.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "up" });
});

afterAll(async () => {
  await h.close();
});

describe("a disabled proxy (documented: its providers go direct)", () => {
  it("still materializes the provider with proxy null", () => {
    h.c.proxies.update(proxyId, { enabled: false });
    expect(h.c.providers.toUpstream(h.c.providers.getByName("via-gone")!).proxy).toBeNull();
    expect(h.c.catalog.resolve("m-gone", "via-gone").ok).toBe(true);
    h.c.proxies.update(proxyId, { enabled: true });
  });
});

describe("a proxy row that no longer exists", () => {
  beforeAll(() => {
    // The API refuses to delete an attached proxy; a dangling id only arises
    // behind its back (a hand-edited database or backup).
    h.c.sqlite.pragma("foreign_keys = OFF");
    h.c.sqlite.prepare("DELETE FROM proxies WHERE id = ?").run(proxyId);
    h.c.sqlite.pragma("foreign_keys = ON");
  });

  it("forProvider and toUpstream refuse instead of answering 'no proxy'", () => {
    expect(() => h.c.proxies.forProvider(proxyId)).toThrow(EgressProxyMissingError);
    expect(() => h.c.providers.toUpstream(h.c.providers.getByName("via-gone")!)).toThrow(/egress proxy #\d+ .*no longer exists/);
    // No proxy configured is still simply direct.
    expect(h.c.proxies.forProvider(null)).toBeNull();
  });

  it("the catalog reports the mapping as unresolvable", () => {
    expect(h.c.catalog.resolve("m-gone", "via-gone")).toEqual({ ok: false, error: "proxy_not_found" });
    expect(h.c.catalog.resolveWithin("m-gone", "via-gone", MEDIA_FAMILIES)).toEqual({ ok: false, error: "proxy_not_found" });
    expect(h.c.catalog.exists("m-gone", "via-gone")).toBe(false);
  });

  it("a call through the provider fails without any upstream request", async () => {
    const postJson = vi.spyOn(h.c.transport, "postJson");
    const postStream = vi.spyOn(h.c.transport, "postStream");
    const def = { timeoutMs: 1000, steps: [{ model: "m-gone", provider: "via-gone", retry: { maxAttempts: 1 } }] } as ServiceSteps;
    const svc = new ModelService(def, { catalog: h.c.catalog, transport: h.c.transport });
    const request = new OpenAICompletionRequest({ requestedService: "svc", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], params: {}, stream: false });
    const inv = await svc.invoke(request);
    expect(inv.result).toMatchObject({ ok: false, status: 0, kind: "error", message: "mapping m-gone@via-gone: proxy_not_found" });
    expect(postJson).not.toHaveBeenCalled();
    expect(postStream).not.toHaveBeenCalled();
  });
});
