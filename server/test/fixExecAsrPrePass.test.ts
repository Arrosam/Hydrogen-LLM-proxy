/**
 * E4: the ASR pre-pass serializes overlapping fills of the same audio, exactly
 * like OCR, so two concurrent requests carrying one clip transcribe it once.
 * E10: an `input_audio` part without string data is not collected, so it must
 * not consume a transcript slot either.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { openDatabase } from "../src/db";
import { OpenAICompletionRequest } from "../src/core/format/completion";
import { MicroAgent, type ServiceResolver } from "../src/execution/microAgent";
import { parseService, type AgentDef } from "../src/execution/definition";
import { ImageDescriptionCache } from "../src/execution/ocrCache";
import { ImageCacheRepo } from "../src/persistence/imageCacheRepo";
import { collectAudio, translateAudioInRequest } from "../src/execution/agentContext";
import type { Catalog } from "../src/catalog/catalog";
import type { Transport, TransportJsonResult } from "../src/core/upstream/transport";

const wav = (seed: string) => Buffer.from(seed).toString("base64");

let dir: string;
let sqlite: BetterSqlite3.Database;
let cache: ImageDescriptionCache;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydro-fix-asr-"));
  const opened = openDatabase(dir);
  sqlite = opened.sqlite;
  cache = new ImageDescriptionCache(new ImageCacheRepo(opened.db), () => 1_000_000);
});
afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const target = (model: string, provider: string) => ({
  family: "openai_completion", upstreamModel: `up-${model}`, url: "http://upstream", headers: {}, modelName: model, providerName: provider, endpointIndex: 0,
  upstream: { type: "openai_completion", baseUrl: "http://u.test/v1", apiKey: "k", extraHeaders: null },
});
const catalog = {
  resolve: (model: string, provider: string) => ({ ok: true, target: target(model, provider) }),
  resolveWithin: (model: string, provider: string) => ({ ok: true, target: target(model, provider) }),
  exists: () => true,
} as unknown as Catalog;
const resolver: ServiceResolver = {
  sttDef: (name) => ({ ok: false, message: `no stt ${name}` }),
  resolve: (name) => ({ ok: false, message: `no service ${name}` }),
};

describe("E4: concurrent identical audio", () => {
  it("is transcribed once; the second request is served from the cache the first filled", async () => {
    let asrCalls = 0;
    const bodies: string[] = [];
    const transport: Transport = {
      postStream: async () => { throw new Error("unused"); },
      postJson: async (_url, _headers, raw) => {
        bodies.push(JSON.stringify(raw));
        return {
          status: 200, headers: {}, text: "",
          json: { id: "c", model: "up", choices: [{ message: { role: "assistant", content: "final" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        };
      },
      postRaw: async (): Promise<TransportJsonResult> => {
        asrCalls++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { status: 200, headers: {}, json: { text: "heard once" }, text: "" };
      },
    };
    const step = { retry: { maxAttempts: 1 } };
    const def = {
      ...(parseService({ kind: "micro_agent", timeoutMs: 1000, stages: [{ name: "main", steps: [{ model: "m", provider: "p", ...step }] }] }) as AgentDef),
      asr: { steps: [{ model: "stt", provider: "p", ...step }] },
    } as unknown as AgentDef;
    const agent = () => new MicroAgent(def, { catalog, transport, resolver, logMaxChars: 10_000, ocrCache: cache });
    const request = () => OpenAICompletionRequest.parse({
      model: "svc",
      messages: [{ role: "user", content: [{ type: "text", text: "listen" }, { type: "input_audio", input_audio: { data: wav("same clip"), format: "wav" } }] }],
    });

    const [one, two] = await Promise.all([agent().invoke(request()), agent().invoke(request())]);
    expect(one.result.ok && two.result.ok).toBe(true);
    expect(asrCalls).toBe(1);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body).toContain("[Audio 1 transcript]\\nheard once\\n");
  });
});

describe("E10: an input_audio part with no string data", () => {
  it("is left in place and does not shift later transcripts", () => {
    const req = OpenAICompletionRequest.parse({
      model: "svc",
      messages: [{
        role: "user",
        content: [
          { type: "input_audio", input_audio: { format: "wav" } },
          { type: "input_audio", input_audio: { data: wav("real"), format: "mp3" } },
        ],
      }],
    });
    const audios = collectAudio(req);
    expect(audios).toEqual([{ data: wav("real"), format: "mp3" }]);

    const content = translateAudioInRequest(req, ["the real transcript"]).messages[0].content;
    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({ type: "opaque", value: { type: "input_audio", input_audio: { format: "wav" } } });
    expect(content[1]).toEqual({ type: "text", text: "\n[Audio 1 transcript]\nthe real transcript\n" });
  });
});
