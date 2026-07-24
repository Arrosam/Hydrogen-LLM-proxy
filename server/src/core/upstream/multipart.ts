/**
 * Minimal multipart/form-data surgery for the speech-to-text passthrough.
 *
 * The proxy forwards the client's multipart body VERBATIM (same boundary, file
 * parts untouched) and only needs to (a) read the text `model` field to route
 * to a service, and (b) replace that field's value with the mapped upstream
 * model name. Full parsing/re-framing would buffer and re-encode file parts
 * for no benefit.
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

function scanParts(body: Buffer, boundary: string): Part[] {
  const delim = Buffer.from(`--${boundary}`);
  const parts: Part[] = [];
  let pos = body.indexOf(delim);
  while (pos !== -1) {
    const lineEnd = pos + delim.length;
    if (body.subarray(lineEnd, lineEnd + 2).toString("latin1") === "--") break; // closing delimiter
    const headerStart = body.indexOf("\r\n", lineEnd);
    if (headerStart === -1) break;
    const headerEnd = body.indexOf("\r\n\r\n", headerStart);
    if (headerEnd === -1) break;
    const next = body.indexOf(delim, headerEnd);
    if (next === -1) break;
    parts.push({
      contentStart: headerEnd + 4,
      contentEnd: next - 2, // strip the CRLF that precedes the next delimiter
      headers: body.subarray(headerStart + 2, headerEnd).toString("utf8"),
    });
    pos = next;
  }
  return parts;
}

function isTextField(headers: string, name: string): boolean {
  return new RegExp(`name="${name}"`, "i").test(headers) && !/filename=/i.test(headers);
}

/** Read a text field's value from a multipart body, or null when absent. */
export function readMultipartField(body: Buffer, contentType: string | undefined, field: string): string | null {
  const boundary = multipartBoundary(contentType);
  if (!boundary) return null;
  for (const p of scanParts(body, boundary)) {
    if (isTextField(p.headers, field)) return body.subarray(p.contentStart, p.contentEnd).toString("utf8").trim();
  }
  return null;
}

/** Replace a text field's value in-place, or null when the field is absent. */
export function rewriteMultipartField(
  body: Buffer,
  contentType: string | undefined,
  field: string,
  value: string,
): Buffer | null {
  const boundary = multipartBoundary(contentType);
  if (!boundary) return null;
  for (const p of scanParts(body, boundary)) {
    if (isTextField(p.headers, field)) {
      return Buffer.concat([body.subarray(0, p.contentStart), Buffer.from(value, "utf8"), body.subarray(p.contentEnd)]);
    }
  }
  return null;
}
