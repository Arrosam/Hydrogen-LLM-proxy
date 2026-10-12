/**
 * Minimal multipart/form-data surgery for the speech-to-text passthrough.
 *
 * The proxy forwards the client's multipart body VERBATIM (same boundary, file
 * parts untouched) and only needs to (a) read the text `model` field to route
 * to a service, (b) replace that field's value with the mapped upstream model
 * name, and (c) set the step's override parameters as text fields. Full
 * parsing/re-framing would buffer and re-encode file parts for no benefit.
 */

const CRLF = "\r\n";
/** The blank line that ends a part's header block. */
const HEADER_END = CRLF + CRLF;
/** Prefix of every delimiter line; also the suffix that marks the closing one. */
const DASHES = "--";

function multipartBoundary(contentType: string | undefined): string | null {
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
  const delim = Buffer.from(`${DASHES}${boundary}`);
  const parts: Part[] = [];
  let pos = body.indexOf(delim);
  while (pos !== -1) {
    const lineEnd = pos + delim.length;
    if (body.subarray(lineEnd, lineEnd + DASHES.length).toString("latin1") === DASHES) break; // closing delimiter
    const headerStart = body.indexOf(CRLF, lineEnd);
    if (headerStart === -1) break;
    const headerEnd = body.indexOf(HEADER_END, headerStart);
    if (headerEnd === -1) break;
    const next = body.indexOf(delim, headerEnd);
    if (next === -1) break;
    parts.push({
      contentStart: headerEnd + HEADER_END.length,
      contentEnd: next - CRLF.length, // strip the CRLF that precedes the next delimiter
      headers: body.subarray(headerStart + CRLF.length, headerEnd).toString("utf8"),
    });
    pos = next;
  }
  return parts;
}

function isTextField(headers: string, name: string): boolean {
  return new RegExp(`name="${name}"`, "i").test(headers) && !/filename=/i.test(headers);
}

/** The first text part named `field`, or null when the body has no boundary or no such part. */
function findTextField(body: Buffer, boundary: string | null, field: string): Part | null {
  if (!boundary) return null;
  return scanParts(body, boundary).find((p) => isTextField(p.headers, field)) ?? null;
}

/** Read a text field's value from a multipart body, or null when absent. */
export function readMultipartField(body: Buffer, contentType: string | undefined, field: string): string | null {
  const part = findTextField(body, multipartBoundary(contentType), field);
  return part ? body.subarray(part.contentStart, part.contentEnd).toString("utf8").trim() : null;
}

/** Replace a text field's value in-place, or null when the field is absent. */
export function rewriteMultipartField(
  body: Buffer,
  contentType: string | undefined,
  field: string,
  value: string,
): Buffer | null {
  return replaceField(body, multipartBoundary(contentType), field, value);
}

function replaceField(body: Buffer, boundary: string | null, field: string, value: string): Buffer | null {
  const part = findTextField(body, boundary, field);
  return part ? Buffer.concat([body.subarray(0, part.contentStart), Buffer.from(value, "utf8"), body.subarray(part.contentEnd)]) : null;
}

/**
 * Set a text field's value, appending a new part when the field is absent.
 * Returns null only when the body has no usable framing (no boundary, or no
 * closing delimiter to splice in front of).
 *
 * `lastIndexOf` finds the closing delimiter rather than a byte sequence that
 * merely looks like one inside a file part: the real closing delimiter is the
 * final occurrence.
 */
export function upsertMultipartField(
  body: Buffer,
  contentType: string | undefined,
  field: string,
  value: string,
): Buffer | null {
  const boundary = multipartBoundary(contentType);
  const replaced = replaceField(body, boundary, field, value);
  if (replaced) return replaced;
  if (!boundary) return null;
  const at = body.lastIndexOf(Buffer.from(`${DASHES}${boundary}${DASHES}`));
  if (at === -1) return null;
  const part = Buffer.from(`${DASHES}${boundary}${CRLF}Content-Disposition: form-data; name="${field}"${HEADER_END}${value}${CRLF}`, "utf8");
  return Buffer.concat([body.subarray(0, at), part, body.subarray(at)]);
}
