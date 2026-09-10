import { z } from "zod";

export type ParseResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Validate an unknown body against a Zod schema, returning a flat error string. */
export function parse<S extends z.ZodTypeAny>(
  schema: S,
  body: unknown,
): ParseResult<z.infer<S>> {
  const r = schema.safeParse(body);
  if (r.success) return { ok: true, data: r.data };
  const error = r.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, error };
}

/** Parse a positive integer route/query param; returns null when invalid. */
export function toId(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Parse the `:id` route param of a request; null when missing/invalid. */
export function idParam(req: { params: unknown }): number | null {
  return toId((req.params as { id?: string }).id);
}
