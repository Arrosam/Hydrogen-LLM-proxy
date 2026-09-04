/**
 * Egress proxies: routing one provider's upstream traffic through a network hop.
 *
 * The feature is small; the properties worth pinning are the ones that are easy
 * to break silently.
 *
 * 1. A provider with no proxy behaves EXACTLY as it did before proxies existed.
 *    That is most of the codebase, so it is the first thing asserted.
 * 2. A proxy host may be on loopback -- the common case is a local xray/clash --
 *    but the tier SsrfGuard refuses even with private addresses allowed
 *    (169.254.x.x cloud metadata, "this host", broadcast) is still refused.
 * 3. Nothing a CLIENT can write selects a proxy. The file pre-pass takes a URL
 *    straight out of a request body, and it must stay on the direct, DNS-pinned
 *    path -- otherwise a proxy field becomes an SSRF bypass with read-back.
 * 4. Every provider-addressed call site actually passes the proxy through. The
 *    Transport port is a hand-written interface with ~11 fakes in this suite, so
 *    a missed call site compiles and passes; only reading the source catches it.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProxyHost } from "../src/core/upstream/egress/proxyHost";
import { proxyKey, proxyLabel, redactProxy, type EgressProxy } from "../src/core/upstream/egress/types";
import { UpstreamUrlError } from "../src/core/upstream/ssrf";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

const proxy = (over: Partial<EgressProxy> = {}): EgressProxy => ({
  id: 1,
  name: "local",
  scheme: "http",
  host: "127.0.0.1",
  port: 7890,
  username: null,
  password: null,
  ...over,
});

// --- EP: what a proxy host may be -----------------------------------------

describe("EP: a proxy host is operator infrastructure, not an upstream", () => {
  it("loopback is allowed — a local xray/clash is the common case", async () => {
    const addrs = await resolveProxyHost(proxy({ host: "127.0.0.1" }));
    expect(addrs).toEqual([{ address: "127.0.0.1", family: 4 }]);
  });

  it("a private LAN address is allowed too", async () => {
    const addrs = await resolveProxyHost(proxy({ host: "192.168.1.10" }));
    expect(addrs[0].address).toBe("192.168.1.10");
  });

  it("IPv6 loopback is allowed, brackets and all", async () => {
    const addrs = await resolveProxyHost(proxy({ host: "[::1]" }));
    expect(addrs).toEqual([{ address: "::1", family: 6 }]);
  });

  /**
   * `localhost` is the thing an operator actually types, and on most machines
   * it resolves to ::1 before 127.0.0.1. The shared address classifier refuses
   * ::1 -- it parses as a v4-compatible 0.0.0.1, which is inside the
   * always-refused 0.0.0.0/8 -- so without an explicit loopback exception the
   * most obvious proxy anyone could configure would be rejected.
   */
  it("localhost is accepted however it resolves", async () => {
    const addrs = await resolveProxyHost(proxy({ host: "localhost" }));
    expect(addrs.length).toBeGreaterThan(0);
  });

  it("but a non-loopback :: address is still classified normally", async () => {
    // ::ffff:169.254.169.254 is cloud metadata wearing an IPv6 spelling.
    await expect(
      resolveProxyHost(proxy({ host: "::ffff:169.254.169.254" })),
    ).rejects.toThrow(UpstreamUrlError);
  });
});

describe("DT: the tier that stays refused even for a proxy", () => {
  // These are the addresses isBlockedAddress refuses with allowPrivate=true.
  // Allowing any of them would turn this field into the metadata pivot the
  // SSRF guard exists to prevent.
  for (const [what, host] of [
    ["cloud metadata", "169.254.169.254"],
    ["link-local", "169.254.1.1"],
    ["this host", "0.0.0.0"],
    ["broadcast", "255.255.255.255"],
  ] as const) {
    it(`${what} (${host}) is refused`, async () => {
      await expect(resolveProxyHost(proxy({ host }))).rejects.toThrow(UpstreamUrlError);
    });
  }

  it("a port that is plainly not a proxy is refused", async () => {
    await expect(resolveProxyHost(proxy({ port: 25 }))).rejects.toThrow(/not a proxy port/);
  });

  it("an out-of-range port is refused before any DNS happens", async () => {
    await expect(resolveProxyHost(proxy({ port: 0 }))).rejects.toThrow(/invalid port/);
    await expect(resolveProxyHost(proxy({ port: 70_000 }))).rejects.toThrow(/invalid port/);
  });

  it("a host that does not resolve is an error, not a silent direct connection", async () => {
    await expect(
      resolveProxyHost(proxy({ host: "no-such-host.invalid" })),
    ).rejects.toThrow(UpstreamUrlError);
  });
});

// --- EP: the password never leaves ----------------------------------------

describe("EP: the password is transient and never serialized", () => {
  it("redactProxy drops it and reports only that it exists", () => {
    const red = redactProxy(proxy({ username: "u", password: "hunter2" }));
    expect(red.hasPassword).toBe(true);
    expect(JSON.stringify(red)).not.toContain("hunter2");
  });

  it("the label an error carries names the proxy, never its credentials", () => {
    expect(proxyLabel(proxy({ username: "u", password: "hunter2" }))).toBe("local (http://127.0.0.1:7890)");
  });

  it("the dispatcher key changes with the password but does not contain it", () => {
    const a = proxyKey(proxy({ username: "u", password: "one" }));
    const b = proxyKey(proxy({ username: "u", password: "two" }));
    expect(a).not.toBe(b);
    expect(a).not.toContain("one");
    expect(b).not.toContain("two");
  });

  it("two providers on the same proxy share one dispatcher", () => {
    expect(proxyKey(proxy({ id: 1 }))).toBe(proxyKey(proxy({ id: 2 })));
  });
});

// --- ST: coverage, read off the source ------------------------------------

/**
 * The `Transport` port is an interface with about a dozen hand-written fakes in
 * this suite, so a call site that forgets to pass the proxy compiles cleanly and
 * every existing test still passes -- the request just quietly goes direct,
 * carrying the provider's credential out on the route the operator attached a
 * proxy to avoid. Nothing but reading the source catches that, so this reads it.
 *
 * An earlier version of this test counted regex hits per file against a
 * hardcoded file list. It was worthless twice over: `>=` left slack wherever a
 * file had more `proxy:` matches than transport calls (SendTarget literals count
 * too), and the hardcoded list did not include the one file that actually had
 * the bug. This version discovers the files, strips comments so prose cannot
 * satisfy it, and inspects each call's ACTUAL argument list.
 */
describe("ST: every provider-addressed request carries the proxy", () => {
  const CALL = /\.(postJson|postStream|postRaw|getStream|getJson)\s*\(/g;

  /**
   * Files that reach the transport but must NOT proxy, each for a stated
   * reason. Anything else with a transport call has to carry one.
   */
  const EXEMPT = new Map([
    ["execution/fileFetch.ts", "its URL comes from a client request body; proxying it would let a token holder skip address validation"],
    ["core/upstream/client.ts", "this IS the transport; it selects the dispatcher rather than passing a proxy to itself"],
  ]);

  /** Every .ts under server/src. */
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out);
      else if (e.name.endsWith(".ts")) out.push(full);
    }
    return out;
  }

  /** Comments removed, so an explanatory line mentioning `proxy` cannot pass. */
  function code(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  }

  /** The text between a call's opening paren and its balanced close. */
  function argsAt(src: string, openParen: number): string {
    let depth = 0;
    for (let i = openParen; i < src.length; i++) {
      const ch = src[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) return src.slice(openParen + 1, i);
      }
    }
    return src.slice(openParen);
  }

  it("no transport call reaches a provider without one", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      if (EXEMPT.has(rel)) continue;
      const src = code(fs.readFileSync(file, "utf8"));
      for (const m of src.matchAll(CALL)) {
        const args = argsAt(src, m.index! + m[0].length - 1);
        if (!/\bproxy\b/.test(args)) offenders.push(`${rel}: .${m[1]}(...) has no proxy`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the exemptions are real files, so a rename cannot silently widen them", () => {
    for (const rel of EXEMPT.keys()) {
      expect(fs.existsSync(path.join(SRC, rel)), `${rel} is exempted but does not exist`).toBe(true);
    }
  });

  it("the file pre-pass stays direct — its URL is client-supplied", () => {
    const src = code(fs.readFileSync(path.join(SRC, "execution/fileFetch.ts"), "utf8"));
    expect(src).toContain("getStream");
    expect(src).not.toMatch(/\bproxy\b/);
  });

  it("both SendTarget literals in modelService carry the proxy", () => {
    const src = code(fs.readFileSync(path.join(SRC, "execution/modelService.ts"), "utf8"));
    expect((src.match(/const target: SendTarget = \{/g) ?? []).length).toBe(2);
    expect((src.match(/proxy: t\.upstream\.proxy/g) ?? []).length).toBe(2);
  });

  /**
   * The provider Test button reaches a provider WITHOUT calling the transport
   * directly -- it hands `discoverModels` an UpstreamProvider it builds itself,
   * so the scan above cannot see it. This is exactly the shape that shipped
   * broken once: modelDiscovery forwarded `provider.proxy` while its only
   * caller never set one.
   */
  it("the provider test builds an UpstreamProvider that carries a proxy", () => {
    const src = code(fs.readFileSync(path.join(SRC, "transport/adminRoutes.ts"), "utf8"));
    expect(src).toMatch(/discoverModels\(c\.transport, \{[^}]*\bproxy\b/);
  });
});
