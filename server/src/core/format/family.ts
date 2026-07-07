import type { Family } from "../ir/params";

export type { Family };

/**
 * The kind an upstream endpoint is configured as. It is exactly the wire family
 * the endpoint speaks -- there is no separate "openai_compatible": a compatible
 * server is just an `openai_completion` provider with a different base URL.
 */
export type ProviderType = Family;

/** A provider's type is its wire family (a 1:1 identity, kept for call-site clarity). */
export function familyForProviderType(t: ProviderType): Family {
  return t;
}
