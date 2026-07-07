/** Small wire-format coercion helpers shared by the format subclasses. */

import type { ImagePart } from "../ir/content";

export function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function boolOrUndef(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

export function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
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

/** Parse a stop/stop_sequences field (string or array) into a string[]. */
export function parseStop(v: unknown): string[] | undefined {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.map(String);
  return undefined;
}

/** Split an image URL into an image source (data: URLs become base64). */
export function parseDataUrl(url: string): ImagePart["source"] {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (m) return { kind: "base64", mediaType: m[1], data: m[2] };
  return { kind: "url", url };
}

/** Build a displayable image URL from an image source. */
export function imageUrlOf(source: ImagePart["source"]): string {
  return source.kind === "base64" ? `data:${source.mediaType};base64,${source.data}` : source.url;
}
