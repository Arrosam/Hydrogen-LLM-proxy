const JSON_INDENT = 2;

/** JSON as the editors show it: two-space indented. */
export const formatJson = (value: unknown): string => JSON.stringify(value, null, JSON_INDENT);

/** `text` parsed as JSON, or `text` itself when it is not JSON. */
export function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** `text` parsed as a JSON object, or null when it is not JSON or is any other
 * JSON value (a scalar, `null`, an array). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const value = parseJsonOrText(text);
  // Unparsable text comes back as the string it was, which is not an object either.
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Anything, as text for a code block: JSON text is re-indented, text that is
 * not JSON is shown as it is, a value is serialized, and `undefined` is empty.
 */
export function prettyJson(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") {
    try {
      return formatJson(JSON.parse(value));
    } catch {
      return value;
    }
  }
  try {
    return formatJson(value);
  } catch {
    return String(value);
  }
}
