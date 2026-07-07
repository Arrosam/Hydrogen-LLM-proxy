import { describe, expect, it } from "vitest";
import { SsrfGuard } from "../src/core/upstream/ssrf";

const guard = (allowPrivate: boolean, allowlist: string[] = []) =>
  new SsrfGuard({ allowPrivate, allowlist: () => allowlist });

describe("SsrfGuard", () => {
  it("blocks loopback, private, and link-local IP literals by default", async () => {
    const g = guard(false);
    await expect(g.assertAllowed("http://127.0.0.1")).rejects.toThrow();
    await expect(g.assertAllowed("http://10.0.0.5")).rejects.toThrow();
    await expect(g.assertAllowed("http://192.168.1.1")).rejects.toThrow();
    await expect(g.assertAllowed("http://169.254.169.254")).rejects.toThrow(); // cloud metadata
  });

  it("allows public IP literals", async () => {
    await expect(guard(false).assertAllowed("http://8.8.8.8")).resolves.toBeUndefined();
  });

  it("rejects non-http(s) schemes", async () => {
    await expect(guard(false).assertAllowed("file:///etc/passwd")).rejects.toThrow();
    await expect(guard(false).assertAllowed("gopher://x")).rejects.toThrow();
  });

  it("allowPrivate permits loopback/private but NOT link-local metadata", async () => {
    const g = guard(true);
    await expect(g.assertAllowed("http://127.0.0.1")).resolves.toBeUndefined();
    await expect(g.assertAllowed("http://10.0.0.5")).resolves.toBeUndefined();
    await expect(g.assertAllowed("http://169.254.169.254")).rejects.toThrow();
  });

  it("an explicit allowlist entry overrides the private block", async () => {
    const g = guard(false, ["10.0.0.5"]);
    await expect(g.assertAllowed("http://10.0.0.5")).resolves.toBeUndefined();
    await expect(g.assertAllowed("http://10.0.0.6")).rejects.toThrow();
  });

  it("blocks IPv4-mapped IPv6 loopback", async () => {
    await expect(guard(false).assertAllowed("http://[::ffff:127.0.0.1]")).rejects.toThrow();
  });
});
