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

  it("blocks IPv4-mapped/compatible IPv6 (no dotted-vs-hex bypass)", async () => {
    configure(false);
    for (const u of [
      "http://[::ffff:192.168.1.1]/v1",
      "http://[::ffff:127.0.0.1]/v1",
      "http://[0:0:0:0:0:ffff:c0a8:0101]/v1", // ::ffff:192.168.1.1 spelled long
      "http://[::127.0.0.1]/v1", // v4-compatible
    ]) {
      await expect(assertUpstreamAllowed(u)).rejects.toBeInstanceOf(UpstreamUrlError);
    }
  });

  it("blocks IPv4-mapped cloud metadata even when private is allowed", async () => {
    configure(true);
    await expect(
      assertUpstreamAllowed("http://[::ffff:169.254.169.254]/latest/meta-data/"),
    ).rejects.toBeInstanceOf(UpstreamUrlError);
  });

  it("blocks the whole fe80::/10 link-local range, not just fe80", async () => {
    configure(false);
    for (const u of ["http://[fe80::1]/v1", "http://[fe90::1]/v1", "http://[febf::1]/v1"]) {
      await expect(assertUpstreamAllowed(u)).rejects.toBeInstanceOf(UpstreamUrlError);
    }
  });
});

describe("buildHeaders sanitization", () => {
  const base = { type: "openai" as const, baseUrl: "https://x.test", apiKey: "sk-real" };

  it("does not let extraHeaders override the provider's configured auth", () => {
    const h = buildHeaders({ ...base, extraHeaders: { authorization: "Bearer attacker" } });
    expect(h["authorization"]).toBe("Bearer sk-real");
  });

  it("blocks a case-variant extraHeaders auth from co-existing on the wire", () => {
    const h = buildHeaders({ ...base, extraHeaders: { Authorization: "Bearer attacker" } });
    // Only one, lowercase, provider-owned auth header survives.
    expect(h["authorization"]).toBe("Bearer sk-real");
    expect(h["Authorization"]).toBeUndefined();
    expect(Object.keys(h).filter((k) => k.toLowerCase() === "authorization")).toHaveLength(1);
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
