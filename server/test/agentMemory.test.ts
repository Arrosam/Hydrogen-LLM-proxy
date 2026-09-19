/**
 * The Micro Agent used to keep every stage's full rendered wire body in its
 * `values` map. For a request carrying images that is another complete copy of
 * the base64 conversation per stage, which is what turned one in-flight image
 * request into N copies of it in the heap (see docs/memory-investigation.md).
 *
 * Measuring it needs a forced GC between stages, so only what is genuinely
 * retained counts -- otherwise the garbage the renderer leaves behind looks the
 * same as a body the agent is holding. The heap is read inside the transport,
 * after a GC, while the current stage's body is live: with the retention it
 * climbs by roughly one image per stage; fixed, it stays flat.
 */
import { describe, expect, it } from "vitest";
import v8 from "node:v8";
import vm from "node:vm";
import { Readable } from "node:stream";
import { OpenAICompletionRequest } from "../src/core/format";
import { MicroAgent } from "../src/execution/microAgent";
import { parseService, type AgentDef } from "../src/execution/definition";
import type { Transport } from "../src/core/upstream/transport";
import type { Catalog } from "../src/catalog/catalog";

/** `global.gc` is only present with --expose-gc, so ask V8 for one directly. */
function forcedGc(): (() => void) | null {
  try {
    v8.setFlagsFromString("--expose-gc");
    const fn = vm.runInNewContext("gc");
    return typeof fn === "function" ? (fn as () => void) : null;
  } catch {
    return null;
  }
}

const gc = forcedGc();

const IMAGE_B64 = Buffer.alloc(2 * 1024 * 1024).toString("base64");

const request = (): OpenAICompletionRequest =>
  new OpenAICompletionRequest({
    requestedService: "svc",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", source: { kind: "base64", mediaType: "image/png", data: IMAGE_B64 } },
      ],
    }],
    params: {},
    stream: false,
  });

const jsonBody = () => ({
  id: "c",
  model: "up",
  choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: {},
});

const STAGES = 6;

describe("Micro Agent memory", () => {
  it.skipIf(!gc)("does not retain a separate copy of the request body per stage", async () => {
    const heapAfterStage: number[] = [];
    const measure = (): void => {
      gc!();
      heapAfterStage.push(process.memoryUsage().heapUsed);
    };
    const transport: Transport = {
      async postJson() {
        measure();
        return { status: 200, headers: {}, json: jsonBody(), text: "" };
      },
      async postStream() {
        measure();
        return {
          status: 200,
          headers: {},
          body: Readable.from([`data: ${JSON.stringify(jsonBody())}\n\n`, "data: [DONE]\n\n"]),
        };
      },
    };
    const catalog = {
      resolve: () => ({
        ok: true,
        target: { family: "openai_completion", upstreamModel: "up", url: "http://x", headers: {}, modelName: "m", providerName: "p", upstream: {} },
      }),
      exists: () => true,
    } as unknown as Catalog;
    const def = parseService({
      kind: "micro_agent",
      timeoutMs: 30_000,
      stages: Array.from({ length: STAGES }, (_, i) => ({ name: `s${i}`, steps: [{ model: "m", provider: "p" }], input: [] })),
    }) as AgentDef;
    const agent = new MicroAgent(def, {
      catalog,
      transport,
      resolver: { resolve: () => ({ ok: false, message: "unused" }), sttDef: () => ({ ok: false, message: "unused" }) },
      logMaxChars: 100_000,
    });

    const inv = await agent.invoke(request());
    expect(inv.result.ok).toBe(true);
    expect(heapAfterStage.length).toBe(STAGES);

    // Each stage re-renders the same conversation, so the fixed code holds the
    // canonical request plus (at most) the previous stage's wire body. Keeping
    // one body per stage added ~(STAGES-1) image copies, so a two-copy ceiling
    // separates the two behaviours with room for measurement noise.
    const growth = heapAfterStage[heapAfterStage.length - 1] - heapAfterStage[0];
    expect(growth).toBeLessThan(2 * IMAGE_B64.length);
  }, 60_000);
});
