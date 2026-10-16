/**
 * How long a validated upstream address stays pinned, in milliseconds.
 *
 * Shared by the direct-path pin (client.ts) and the proxy-host pin
 * (egress/pool.ts). The proxy comment says it "matches the direct path", so the
 * two must stay equal. One definition keeps a future tuning from changing only
 * one path. Defined in its own module so neither file has to import the other.
 *
 * Pinning happens immediately before each request, so this TTL only bounds how
 * long a cached entry may be reused by a pooled connection re-established on its
 * own. Every request re-pins, so an active stream's reconnects always re-validate
 * first.
 */
export const PIN_TTL_MS = 30_000;
