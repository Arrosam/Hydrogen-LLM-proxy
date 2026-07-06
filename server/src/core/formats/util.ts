/** Small wire-format coercion helpers shared by the OpenAI/Anthropic adapters. */

export function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** JSON-parse tool arguments, falling back to the raw value. */
export function safeJsonParse(v: unknown): unknown {
  if (typeof v !== "string") return v ?? {};
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** Copy the listed keys (when present) into a pass-through extras object. */
export function pickExtra(body: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (body[k] !== undefined) out[k] = body[k];
  return Object.keys(out).length ? out : undefined;
}
