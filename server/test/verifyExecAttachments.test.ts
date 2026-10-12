/**
 * Independent verification, written from the spec only (EXEC E3).
 *
 * E3  The attachment inlining budget counts each downloaded file's exact byte
 *     length: with a budget of N bytes, files totalling exactly N are accepted
 *     and N+1 rejected.
 */
import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { AnthropicRequest, OpenAICompletionRequest } from "../src/core/format";
import { inlineUrlFiles } from "../src/execution/fileFetch";
import type { Transport, TransportStreamResult } from "../src/core/upstream/transport";

const url = (i: number): string => `https://files.example.com/doc-${i}.pdf`;

/** A request attaching one URL document per size given. */
const withDocs = (count: number) =>
  AnthropicRequest.parse({
    model: "svc",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "read these" },
        ...Array.from({ length: count }, (_, i) => ({ type: "document", source: { type: "url", url: url(i) } })),
      ],
    }],
  });

/** Bytes that are not valid text and not a multiple of anything convenient. */
const bytes = (n: number, fill = 0xa7): Buffer => Buffer.alloc(n, fill);

/** Serves file i with `sizes[i]` bytes, optionally split into several chunks. */
function transportFor(sizes: number[], chunk?: number): Transport & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    async postJson() { throw new Error("unused"); },
    async postStream() { throw new Error("unused"); },
    async getStream(target: string): Promise<TransportStreamResult> {
      seen.push(target);
      const i = Number(/doc-(\d+)\.pdf$/.exec(target)![1]);
      const body = bytes(sizes[i], 0xa0 + i);
      const chunks: Buffer[] = [];
      if (chunk && chunk > 0) for (let off = 0; off < body.length; off += chunk) chunks.push(body.subarray(off, off + chunk));
      else chunks.push(body);
      return { status: 200, headers: { "content-type": "application/pdf" }, body: Readable.from(chunks) };
    },
  };
}

const run = (sizes: number[], maxTotalBytes: number, chunk?: number) =>
  inlineUrlFiles(withDocs(sizes.length), "openai_completion", transportFor(sizes, chunk), { timeoutMs: 5_000, maxTotalBytes });

const REJECTED = /configured for this service/;

describe("E3: one file against the budget", () => {
  // 19/20/21 cover all three base64 padding cases (len % 3 = 1, 2, 0); a
  // budget counted in encoded characters would misplace every one of them.
  it.each([1, 2, 3, 19, 20, 21, 1000, 1001, 1002])("a %i-byte file fits a budget of exactly its size", async (n) => {
    await expect(run([n], n)).resolves.toBeTruthy();
  });

  it.each([2, 3, 19, 20, 21, 1000, 1001, 1002])("a %i-byte file is rejected by a budget one byte smaller", async (n) => {
    await expect(run([n], n - 1)).rejects.toThrow(REJECTED);
  });

  it.each([19, 20, 21])("a %i-byte file fits a budget one byte larger", async (n) => {
    await expect(run([n], n + 1)).resolves.toBeTruthy();
  });

  it("the spec's example: one 19-byte file fits a 19-byte budget, and a 20-byte file does not", async () => {
    await expect(run([19], 19)).resolves.toBeTruthy();
    await expect(run([20], 19)).rejects.toThrow(REJECTED);
  });

  it("the accepted file is inlined whole", async () => {
    const ready = await run([19], 19);
    const body = OpenAICompletionRequest.construct(ready).render({ upstreamModel: "up" });
    expect(JSON.stringify(body.messages)).toContain(`data:application/pdf;base64,${bytes(19, 0xa0).toString("base64")}`);
  });

  it("chunking of the download does not change the count", async () => {
    await expect(run([19], 19, 1)).resolves.toBeTruthy();
    await expect(run([19], 19, 7)).resolves.toBeTruthy();
    await expect(run([20], 19, 1)).rejects.toThrow(REJECTED);
    await expect(run([20], 19, 7)).rejects.toThrow(REJECTED);
  });
});

describe("E3: several files share one budget", () => {
  it("the spec's example: two 20-byte files fit 40, not 39", async () => {
    await expect(run([20, 20], 40)).resolves.toBeTruthy();
    await expect(run([20, 20], 39)).rejects.toThrow(REJECTED);
  });

  it("two 20-byte files also fit 41", async () => {
    await expect(run([20, 20], 41)).resolves.toBeTruthy();
  });

  it.each([
    [[19, 19], 38],
    [[19, 20], 39],
    [[1, 1, 1], 3],
    [[19, 20, 21], 60],
    [[7, 11, 13, 17], 48],
  ] as Array<[number[], number]>)("files of %j bytes: exactly %i accepted, one less rejected", async (sizes, total) => {
    await expect(run(sizes, total)).resolves.toBeTruthy();
    await expect(run(sizes, total - 1)).rejects.toThrow(REJECTED);
  });

  it("each file alone under the budget but the sum one byte over: rejected", async () => {
    await expect(run([30, 30], 59)).rejects.toThrow(REJECTED);
    await expect(run([30, 30], 60)).resolves.toBeTruthy();
  });

  it("chunked downloads of several files still sum exactly", async () => {
    await expect(run([20, 20], 40, 3)).resolves.toBeTruthy();
    await expect(run([20, 20], 39, 3)).rejects.toThrow(REJECTED);
  });
});

describe("E3 neighbours: unchanged behaviour", () => {
  it("no budget: any size is inlined", async () => {
    await expect(
      inlineUrlFiles(withDocs(2), "openai_completion", transportFor([5000, 5000]), { timeoutMs: 5_000 }),
    ).resolves.toBeTruthy();
  });

  it("a budget far above the total accepts; far below rejects", async () => {
    await expect(run([20, 20], 1_000_000)).resolves.toBeTruthy();
    await expect(run([20, 20], 5)).rejects.toThrow(REJECTED);
  });

  it("a URL-capable family downloads nothing, whatever the budget", async () => {
    const transport = transportFor([20]);
    const req = withDocs(1);
    const ready = await inlineUrlFiles(req, "anthropic", transport, { timeoutMs: 5_000, maxTotalBytes: 1 });
    expect(ready).toBe(req);
    expect(transport.seen).toEqual([]);
  });
});
