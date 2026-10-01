/**
 * Minimal multipart/form-data surgery for transcription and image-edit passthroughs.
 *
 * The proxy forwards the client's multipart body VERBATIM (same boundary, file
 * parts untouched) and only needs to (a) read the text `model` field to route
 * to a service, (b) replace that field's value with the mapped upstream model
 * name, and (c) set the step's override parameters as text fields. Full
 * parsing/re-framing would buffer and re-encode file parts for no benefit.
 */

export function multipartBoundary(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  return m ? (m[1] ?? m[2]).trim() : null;
}

interface Part {
  /** Offset of the part's content (just past the blank line). */
  contentStart: number;
  /** Offset one past the content's last byte (before the next delimiter's CRLF). */
  contentEnd: number;
  /** The part's header block, decoded as UTF-8. */
  headers: string;
}

interface Delimiter {
  start: number;
  /** Offset just past the delimiter line, including its CRLF. */
  end: number;
  closing: boolean;
}

/** A boundary is a whole delimiter line, never a substring of binary content.
 * Allow MIME transport padding, but not lookalikes such as --boundary--pixels. */
function findDelimiter(body: Buffer, marker: Buffer, from = 0): Delimiter | null {
  let pos = body.indexOf(marker, from);
  while (pos !== -1) {
    if (pos === 0 || (body[pos - 2] === 13 && body[pos - 1] === 10)) {
      let end = pos + marker.length;
      const closing = body[end] === 45 && body[end + 1] === 45;
      if (closing) end += 2;
      while (body[end] === 32 || body[end] === 9) end++;
      if (body[end] === 13 && body[end + 1] === 10) return { start: pos, end: end + 2, closing };
      if (closing && end === body.length) return { start: pos, end, closing };
    }
    pos = body.indexOf(marker, pos + marker.length);
  }
  return null;
}

function scanMultipart(body: Buffer, boundary: string): { parts: Part[]; closingStart: number } | null {
  const marker = Buffer.from(`--${boundary}`);
  const parts: Part[] = [];
  let current = findDelimiter(body, marker);
  if (!current) return null;
  while (!current.closing) {
    const next = findDelimiter(body, marker, current.end);
    const headerEnd = body.indexOf("\r\n\r\n", current.end);
    if (!next || headerEnd === -1 || headerEnd + 4 > next.start - 2) return null;
    parts.push({
      contentStart: headerEnd + 4,
      contentEnd: next.start - 2, // exclude the delimiter's leading CRLF
      headers: body.subarray(current.end, headerEnd).toString("utf8"),
    });
    current = next;
  }
  return { parts, closingStart: current.start };
}

function isTextField(headers: string, name: string): boolean {
  const disposition = /(?:^|\r\n)content-disposition:[ \t]*([^\r\n]*)/i.exec(headers)?.[1];
  if (!disposition || !/^form-data(?:[ \t]*;|[ \t]*$)/i.test(disposition)) return false;
  // Parse every parameter so a semicolon inside another quoted value cannot
  // masquerade as a name. Field names are literal, not regular expressions.
  const params = /(?:^|;)[ \t]*([^=;\s]+)[ \t]*=[ \t]*(?:"((?:\\.|[^"\\])*)"|([^;\r\n]*))/g;
  let fieldName: string | undefined;
  for (const m of disposition.matchAll(params)) {
    const key = m[1].toLowerCase();
    if (key === "filename" || key === "filename*") return false;
    if (key === "name") fieldName = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3].trim();
  }
  return fieldName === name;
}

/** Read a text field's value from a multipart body, or null when absent. */
export function readMultipartField(body: Buffer, contentType: string | undefined, field: string): string | null {
  const boundary = multipartBoundary(contentType);
  if (!boundary) return null;
  const scanned = scanMultipart(body, boundary);
  if (!scanned) return null;
  for (const p of scanned.parts) {
    if (isTextField(p.headers, field)) return body.subarray(p.contentStart, p.contentEnd).toString("utf8").trim();
  }
  return null;
}

/** Replace every matching text field, leaving file parts untouched; null if absent. */
export function rewriteMultipartField(
  body: Buffer,
  contentType: string | undefined,
  field: string,
  value: string,
): Buffer | null {
  const boundary = multipartBoundary(contentType);
  if (!boundary) return null;
  const scanned = scanMultipart(body, boundary);
  if (!scanned) return null;
  const chunks: Buffer[] = [];
  const replacement = Buffer.from(value, "utf8");
  let cursor = 0;
  for (const p of scanned.parts) {
    if (!isTextField(p.headers, field)) continue;
    chunks.push(body.subarray(cursor, p.contentStart), replacement);
    cursor = p.contentEnd;
  }
  if (!chunks.length) return null;
  chunks.push(body.subarray(cursor));
  return Buffer.concat(chunks);
}

/**
 * Set a text field's value, appending a new part when the field is absent.
 * Returns null when the body has no usable framing. Locate the closing
 * delimiter via the same line-aware scan so files and epilogues stay untouched.
 */
export function upsertMultipartField(
  body: Buffer,
  contentType: string | undefined,
  field: string,
  value: string,
): Buffer | null {
  const replaced = rewriteMultipartField(body, contentType, field, value);
  if (replaced) return replaced;
  const boundary = multipartBoundary(contentType);
  if (!boundary) return null;
  const scanned = scanMultipart(body, boundary);
  if (!scanned) return null;
  const at = scanned.closingStart;
  const part = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"\r\n\r\n${value}\r\n`, "utf8");
  return Buffer.concat([body.subarray(0, at), part, body.subarray(at)]);
}
