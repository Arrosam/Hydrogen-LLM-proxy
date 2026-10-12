/**
 * Values per statement when a list of unbounded length becomes bound
 * parameters (an `IN (...)` list, a multi-row INSERT). SQLite's parameter
 * ceiling is far higher, but the lists here are sized by a request -- its
 * images, a provider's model list -- and one statement per 200 costs nothing.
 */
export const PARAM_CHUNK = 200;

/** `items` in consecutive runs of at most `size` (one statement each). */
export function chunked<T>(items: T[], size: number = PARAM_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
