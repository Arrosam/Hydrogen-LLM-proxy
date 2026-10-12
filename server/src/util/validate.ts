import { z } from "zod";

/** How a zod issue with an empty path is labelled in a flattened error. */
const ROOT_PATH_LABEL = "(root)";

/** Flatten zod issues to `path: message` entries, one per issue. */
export function formatZodIssues(issues: readonly z.ZodIssue[], separator = "; ", indent = ""): string {
  return issues.map((i) => `${indent}${i.path.join(".") || ROOT_PATH_LABEL}: ${i.message}`).join(separator);
}

/** A positive integer in a JSON body: a row id, a quota, a budget. */
export const PositiveIntSchema = z.number().int().positive();

export type ParseResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Validate an unknown body against a Zod schema, returning a flat error string. */
export function parse<S extends z.ZodTypeAny>(
  schema: S,
  body: unknown,
): ParseResult<z.infer<S>> {
  const r = schema.safeParse(body);
  if (r.success) return { ok: true, data: r.data };
  return { ok: false, error: formatZodIssues(r.error.issues) };
}

/** Parse a positive integer route/query param; returns null when invalid. */
export function toId(v: unknown): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  if (!/^[1-9]\d*$/.test(String(v))) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Parse the `:id` route param of a request; null when missing/invalid. */
export function idParam(req: { params: unknown }): number | null {
  return toId((req.params as { id?: string }).id);
}

/** A numeric query param; undefined when absent, empty or not a finite number. */
export function numParam(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** A boolean query param ("true"/"1", "false"/"0"); undefined for anything else. */
export function boolParam(v: unknown): boolean | undefined {
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
}
