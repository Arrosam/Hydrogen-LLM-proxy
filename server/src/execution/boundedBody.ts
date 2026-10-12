/**
 * Read a response body into memory under a byte cap, for bodies whose size is
 * the other side's choice (a client-supplied file URL, a tool's HTTP API).
 *
 * Returns null as soon as a chunk takes the total past `maxBytes`, before
 * buffering it; what an oversized body means -- and closing the stream -- is the
 * caller's business. `signal` is checked before every chunk and once more when
 * the body ends, so an abort surfaces as a throw rather than as a short read.
 */
export async function readBounded(body: AsyncIterable<unknown>, maxBytes: number, signal: AbortSignal): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of body) {
    signal.throwIfAborted();
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    received += buffer.length;
    if (received > maxBytes) return null;
    chunks.push(buffer);
  }
  signal.throwIfAborted();
  return Buffer.concat(chunks);
}
