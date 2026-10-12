/**
 * Coercion of untyped wire values into the few primitive shapes the canonical
 * model uses. Format-agnostic, so it sits below both the wire adapters and the
 * canonical stream code that share it.
 */

export function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function num(v: unknown): number {
  return numOrUndef(v) ?? 0;
}

export function boolOrUndef(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

export function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** JSON-parse tool arguments, falling back to the raw value (and to `{}` for a missing one). */
export function parseToolArguments(v: unknown): unknown {
  if (typeof v !== "string") return v ?? {};
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}
