import { describe, expect, it } from "vitest";
import { setConfig } from "../src/context";
import type { AppConfig } from "../src/config";
import { assertUpstreamAllowed, UpstreamUrlError } from "../src/core/ssrf";
import { buildHeaders } from "../src/core/upstream";

function configure(allowPrivateUpstreams: boolean): void {
  setConfig({ allowPrivateUpstreams } as unknown as AppConfig);
}

describe("SSRF guard (assertUpstreamAllowed)", () => {
  it("allows public addresses", async () => {
    configure(false);
    await expect(assertUpstreamAllowed("http://8.8.8.8/v1")).resolves.toBeUndefined();
    await expect(assertUpstreamAllowed("https://1.1.1.1/v1/models")).resolves.toBeUndefined();
  });

  it("always blocks link-local / cloud metadata, even with private allowed", async () => {
    configure(true);
    await expect(
      assertUpstreamAllowed("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toBeInstanceOf(UpstreamUrlError);
  });

  it("blocks loopback and RFC1918 ranges by default", async () => {
    configure(false);
    for (const u of [
      "http://127.0.0.1:8080/v1/models",
      "http://10.0.0.5/v1",
      "http://192.168.1.10/v1",
      "http://172.16.5.4/v1",
      "http://[::1]:8080/v1",
    ]) {
      await expect(assertUpstreamAllowed(u)).rejects.toBeInstanceOf(UpstreamUrlError);
    }
  });

  it("blocks a hostname that resolves to loopback (localhost)", async () => {
    configure(false);
    await expect(assertUpstreamAllowed("http://localhost:8080/v1")).rejects.toBeInstanceOf(
      UpstreamUrlError,
    );
  });

  it("permits loopback/private when ALLOW_PRIVATE_UPSTREAMS is set", async () => {
    configure(true);
    await expect(assertUpstreamAllowed("http://127.0.0.1:11434/v1")).resolves.toBeUndefined();
    await expect(assertUpstreamAllowed("http://192.168.1.10/v1")).resolves.toBeUndefined();
  });

  it("rejects non-http(s) schemes", async () => {
    configure(true);
    await expect(assertUpstreamAllowed("file:///etc/passwd")).rejects.toBeInstanceOf(UpstreamUrlError);
    await expect(assertUpstreamAllowed("gopher://127.0.0.1/")).rejects.toBeInstanceOf(UpstreamUrlError);
  });
});

describe("buildHeaders sanitization", () => {
  const base = { type: "openai" as const, baseUrl: "https://x.test", apiKey: "sk-real" };

  it("does not let extraHeaders override the provider's configured auth", () => {
    const h = buildHeaders({ ...base, extraHeaders: { authorization: "Bearer attacker" } });
    expect(h["authorization"]).toBe("Bearer sk-real");
  });

  it("strips hop-by-hop and host headers", () => {
    const h = buildHeaders({
      ...base,
      extraHeaders: { host: "evil.test", connection: "keep-alive", "x-ok": "1" },
    });
    expect(h["host"]).toBeUndefined();
    expect(h["connection"]).toBeUndefined();
    expect(h["x-ok"]).toBe("1");
  });

  it("uses extraHeaders auth only when the provider has no key of its own", () => {
    const h = buildHeaders({
      type: "openai",
      baseUrl: "https://x.test",
      apiKey: null,
      extraHeaders: { authorization: "Bearer custom" },
    });
    expect(h["authorization"]).toBe("Bearer custom");
  });
});
