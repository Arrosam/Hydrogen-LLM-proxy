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

/** Split an image URL into an IR image source (data: URLs become base64). */
export function parseDataUrl(
  url: string,
): { kind: "base64"; mediaType: string; data: string } | { kind: "url"; url: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (m) return { kind: "base64", mediaType: m[1], data: m[2] };
  return { kind: "url", url };
}
