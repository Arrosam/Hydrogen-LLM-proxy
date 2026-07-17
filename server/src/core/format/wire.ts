/** Small wire-format coercion helpers shared by the format subclasses. */

import type { ImagePart } from "../ir/content";
import type { Family, GenerationParams } from "../ir/params";

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

/**
 * Fit a requested output-token max under the provider's hard cap. Asking for
 * more than a provider allows gets the whole request rejected, so the cap wins.
 * A request that named no max keeps naming none — the provider's own default is
 * already within its limit.
 */
export function capMaxTokens(maxTokens: number | undefined, cap: number | undefined): number | undefined {
  if (maxTokens == null) return undefined;
  return cap != null && maxTokens > cap ? cap : maxTokens;
}

/**
 * Collect the body keys a format's parser and renderer don't own. Everything a
 * format models canonically is listed in its `reserved` set; whatever is left is
 * a param this proxy has no opinion about, and dropping it would silently change
 * the request the client actually made.
 */
export function collectPassthrough(
  body: Record<string, unknown>,
  reserved: ReadonlySet<string>,
  family: Family,
): GenerationParams["passthrough"] {
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (reserved.has(k) || v === undefined) continue;
    params[k] = v;
  }
  return Object.keys(params).length ? { family, params } : undefined;
}

/**
 * Merge the non-canonical params onto an outgoing body, weakest first: the
 * client's own unrecognized params, then the step/stage `extra` override.
 *
 * Client passthrough only replays onto its own family — an OpenAI-only knob is
 * meaningless on an Anthropic body, and sending it there gets the request
 * rejected. It also never overwrites a key the renderer already decided, so a
 * translated or overridden value always beats a leftover.
 */
export function applyNonCanonical(out: Record<string, unknown>, p: GenerationParams, family: Family): void {
  if (p.passthrough && p.passthrough.family === family) {
    for (const [k, v] of Object.entries(p.passthrough.params)) {
      if (!(k in out)) out[k] = v;
    }
  }
  if (p.extra) Object.assign(out, p.extra);
}
