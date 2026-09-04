import net from "node:net";

/**
 * Egress proxying: the optional network hop between Hydrogen and a provider.
 *
 * The whole feature is a TRANSPORT concern and nothing else. A proxy changes
 * how a socket is opened; it never touches what is sent, how the answer is
 * parsed, which model served it, or anything the request pipeline reasons
 * about. Everything in this directory exists below the wire formats and knows
 * nothing about them.
 *
 * Only HTTP and HTTPS proxies are supported, because those are the two undici
 * implements natively (`ProxyAgent`). SOCKS would mean hand-writing the undici
 * `connect` function -- which is precisely where the SSRF address pin lives --
 * so it is left out rather than reimplemented carelessly. The `scheme` enum is
 * the only thing that would have to grow to add it later.
 */

/** A proxy resolved for use: the password is decrypted and in memory. */
export interface EgressProxy {
  id: number;
  name: string;
  scheme: "http" | "https";
  host: string;
  port: number;
  username: string | null;
  /** Plaintext, transient. Never logged, never serialized -- see redactProxy. */
  password: string | null;
}

/**
 * The identity of a dispatcher. Two providers pointing at the same proxy share
 * one connection pool, and an edit to the proxy row changes the key so the old
 * pool is retired rather than silently reused with stale credentials.
 *
 * The password is included because changing only the password must produce a
 * new dispatcher; it is hashed rather than embedded so the key can appear in a
 * debug log without leaking anything.
 */
export function proxyKey(p: EgressProxy): string {
  const secret = p.password ? `#${hash(p.password)}` : "";
  return `${p.scheme}://${p.username ?? ""}@${p.host}:${p.port}${secret}`;
}

/** A short non-reversible digest, for dispatcher keying only. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/**
 * The proxy's own origin, which is what a socket is actually opened to.
 *
 * An IPv6 literal MUST be bracketed here. Unbracketed, `http://::1:7890` is not
 * a parseable URL and `new ProxyAgent({ uri })` throws a bare TypeError -- which
 * is worse than a rejection, because classifyError sees no UpstreamUrlError and
 * files it under "network", i.e. worth retrying. A permanent configuration
 * mistake would then burn the whole retry budget on every request and be
 * reported to the operator as a transient blip.
 */
export function proxyOrigin(p: EgressProxy): string {
  const host = p.host.trim().replace(/^\[|\]$/g, "");
  return `${p.scheme}://${net.isIP(host) === 6 ? `[${host}]` : host}:${p.port}`;
}

/** How a proxy is named in an error or a log line. Credentials never appear. */
export function proxyLabel(p: EgressProxy): string {
  return `${p.name} (${proxyOrigin(p)})`;
}

/**
 * A proxy stripped of its secret, for anywhere a config might be serialized.
 * The password is the one field on {@link EgressProxy} that must never leave
 * the process, and the type system will not stop `JSON.stringify` -- so
 * anything that logs a proxy goes through here.
 */
export function redactProxy(p: EgressProxy): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    scheme: p.scheme,
    host: p.host,
    port: p.port,
    username: p.username,
    hasPassword: Boolean(p.password),
  };
}
