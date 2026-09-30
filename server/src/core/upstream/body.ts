import { StringDecoder } from "node:string_decoder";

export const MAX_ERROR_BODY_BYTES = 64 * 1024;
export const MAX_JSON_BODY_BYTES = 25 * 1024 * 1024;

/** Bound before concatenation and decode UTF-8 across chunks. Destroy the
 * upstream on overflow so an endless error page cannot exhaust memory. */
export async function readBoundedBody(body: AsyncIterable<Buffer | string> & { destroy?: () => unknown }, maxBytes: number, truncate = false): Promise<string> {
  const decoder = new StringDecoder("utf8");
  const parts: string[] = [];
  let bytes = 0;
  try {
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBytes - bytes;
      if (buffer.length > remaining) {
        if (truncate && remaining > 0) parts.push(decoder.write(buffer.subarray(0, remaining)));
        body.destroy?.();
        if (!truncate) throw new Error("Upstream response exceeds the 25 MiB limit");
        break;
      }
      bytes += buffer.length;
      parts.push(decoder.write(buffer));
    }
    parts.push(decoder.end());
    return parts.join("");
  } catch (error) {
    body.destroy?.();
    if (truncate) { parts.push(decoder.end()); return parts.join(""); }
    throw error;
  }
}
