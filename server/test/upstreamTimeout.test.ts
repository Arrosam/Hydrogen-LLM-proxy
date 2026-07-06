import { describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// Bypass the SSRF guard so we can point at a loopback test server.
vi.mock("../src/core/ssrf", () => ({ assertUpstreamAllowed: vi.fn(async () => {}) }));

import { postStream } from "../src/core/upstream";

/** A server that returns 200 + one SSE chunk, then goes silent forever. */
function stallingServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {\"hi\":1}\n\n");
      // never write again, never end -- simulate a mid-stream stall.
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1/messages`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("streaming upstream idle timeout", () => {
  it("aborts a stalled stream after timeoutMs instead of hanging", async () => {
    const srv = await stallingServer();
    try {
      const res = await postStream(srv.url, {}, {}, { timeoutMs: 500 });
      expect(res.status).toBe(200); // headers arrived fine
      let errored = false;
      const start = Date.now();
      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _chunk of res.body) {
          /* consume until the idle timeout fires */
        }
      } catch {
        errored = true;
      }
      const elapsed = Date.now() - start;
      expect(errored).toBe(true); // the body stream errored (bodyTimeout)
      expect(elapsed).toBeGreaterThanOrEqual(400);
      expect(elapsed).toBeLessThan(3000); // aborted ~500ms, did not hang
    } finally {
      await srv.close();
    }
  });
});
