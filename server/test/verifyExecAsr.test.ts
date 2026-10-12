/**
 * Independent verification, written from the spec only (EXEC E4, E10).
 *
 * E4  Two concurrent Micro Agent requests carrying the same audio through the
 *     ASR pre-pass (cache enabled) cause exactly one transcription call.
 * E10 With several `input_audio` parts of which one has no usable data, each
 *     transcript replaces the part it was made from and the unusable part is
 *     left as it was.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { openDatabase } from "../src/db";
import { OpenAICompletionRequest } from "../src/core/format/completion";
import { MicroAgent, type ServiceResolver } from "../src/execution/microAgent";
import { parseService, type AgentDef } from "../src/execution/definition";
import { ImageCacheRepo } from "../src/persistence/imageCacheRepo";
import { ImageDescriptionCache, type OcrCacheStore } from "../src/execution/ocrCache";
import type { Catalog } from "../src/catalog/catalog";
import type { Transport, TransportJsonResult } from "../src/core/upstream/transport";

const b64 = (seed: string): string => Buffer.from(seed).toString("base64");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Part = Record<string, unknown>;
const audioPart = (data: string, format = "wav"): Part => ({ type: "input_audio", input_audio: { data, format } });
const request = (content: Part[]) => OpenAICompletionRequest.parse({ model: "svc", messages: [{ role: "user", content }] });

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

const STEP = { retry: { maxAttempts: 1 } };
const asrAgent = (): AgentDef =>
  parseService({
    kind: "micro_agent",
    timeoutMs: 5000,
    stages: [{ name: "main", steps: [{ model: "m", provider: "p", ...STEP }] }],
    asr: { steps: [{ model: "stt", provider: "p", ...STEP }] },
  }) as AgentDef;

/**
 * A fake upstream. A transcription upload is answered after `asrDelayMs` with
 * a transcript naming the audio bytes it was handed (the upload carries the
 * decoded audio, so the marker inside it is readable), which ties every
 * transcript to the attachment it was made from.
 */
function upstream(asrDelayMs = 0) {
  const chatBodies: Array<Record<string, unknown>> = [];
  const uploads: string[] = [];
  const completion = (content: string) => ({
    id: "c", model: "up", choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const transport: Transport = {
    postStream: async () => { throw new Error("unused"); },
    postJson: async (_url, _headers, raw) => {
      chatBodies.push(raw as Record<string, unknown>);
      return { status: 200, headers: {}, json: completion("final"), text: "" };
    },
    postRaw: async (_url, _headers, body): Promise<TransportJsonResult> => {
      const raw = Buffer.isBuffer(body) ? body.toString("latin1") : body;
      const marker = /AUDIO-MARK-([A-Z]+)/.exec(raw)?.[1] ?? "UNKNOWN";
      uploads.push(marker);
      if (asrDelayMs) await sleep(asrDelayMs);
      return { status: 200, headers: {}, json: { text: `transcript-of-${marker}` }, text: "" };
    },
  };
  return { transport, chatBodies, uploads };
}

const mark = (name: string): string => b64(`RIFF....AUDIO-MARK-${name}....WAVE`);

function agent(up: ReturnType<typeof upstream>, cache: OcrCacheStore | null): MicroAgent {
  return new MicroAgent(asrAgent(), { catalog, transport: up.transport, resolver, logMaxChars: 10_000, ocrCache: cache });
}

let dir: string;
let sqlite: BetterSqlite3.Database;
let repo: ImageCacheRepo;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydro-verify-asr-"));
  const opened = openDatabase(dir);
  sqlite = opened.sqlite;
  repo = new ImageCacheRepo(opened.db);
});
afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { repo.clear(); });

const enabledCache = (): ImageDescriptionCache => new ImageDescriptionCache(repo, () => 1_000_000);

describe("E4: concurrent requests with the same audio transcribe it once", () => {
  const sameAudio = () => request([{ type: "text", text: "what was said?" }, audioPart(mark("SAME"))]);

  it("two concurrent requests through one agent: exactly one transcription call", async () => {
    const up = upstream(60);
    const a = agent(up, enabledCache());
    const [one, two] = await Promise.all([a.invoke(sameAudio()), a.invoke(sameAudio())]);
    expect(one.result.ok ? "" : one.result.message).toBe("");
    expect(two.result.ok ? "" : two.result.message).toBe("");
    expect(up.uploads).toEqual(["SAME"]);
    // Both requests still got the transcript in place of the audio.
    expect(up.chatBodies).toHaveLength(2);
    for (const body of up.chatBodies) {
      expect(JSON.stringify(body)).toContain("transcript-of-SAME");
      expect(JSON.stringify(body)).not.toContain("input_audio");
    }
  });

  it("two concurrent requests through two agents sharing the instance's cache: exactly one call", async () => {
    const up = upstream(60);
    const cache = enabledCache();
    const [one, two] = await Promise.all([agent(up, cache).invoke(sameAudio()), agent(up, cache).invoke(sameAudio())]);
    expect(one.result.ok && two.result.ok).toBe(true);
    expect(up.uploads).toEqual(["SAME"]);
  });

  it("five concurrent requests: still exactly one call", async () => {
    const up = upstream(40);
    const a = agent(up, enabledCache());
    const all = await Promise.all(Array.from({ length: 5 }, () => a.invoke(sameAudio())));
    expect(all.every((inv) => inv.result.ok)).toBe(true);
    expect(up.uploads).toEqual(["SAME"]);
  });

  it("neighbour: concurrent requests with DIFFERENT audio each transcribe their own", async () => {
    const up = upstream(40);
    const a = agent(up, enabledCache());
    const [one, two] = await Promise.all([
      a.invoke(request([audioPart(mark("LEFT"))])),
      a.invoke(request([audioPart(mark("RIGHT"))])),
    ]);
    expect(one.result.ok && two.result.ok).toBe(true);
    expect([...up.uploads].sort()).toEqual(["LEFT", "RIGHT"]);
  });

  it("neighbour: sequential requests with the same audio transcribe once (cache hit)", async () => {
    const up = upstream();
    const a = agent(up, enabledCache());
    expect((await a.invoke(sameAudio())).result.ok).toBe(true);
    expect((await a.invoke(sameAudio())).result.ok).toBe(true);
    expect(up.uploads).toEqual(["SAME"]);
  });
});

/**
 * What "no usable data" may look like on the wire. The spec does not say which
 * shapes count, so every shape the request schema accepts that has no audio
 * bytes to transcribe is exercised; each must be skipped and left as it was.
 */
const UNUSABLE: Array<[string, Part]> = [
  ["no data field", { type: "input_audio", input_audio: { format: "wav" } }],
  ["null data", { type: "input_audio", input_audio: { data: null, format: "wav" } }],
  ["no input_audio object", { type: "input_audio" }],
  ["empty-string data", { type: "input_audio", input_audio: { data: "", format: "wav" } }],
];

describe.each(UNUSABLE)("E10: each transcript replaces the audio part it was made from (unusable part: %s)", (_label, EMPTY) => {
  type Msg = { role: string; content: unknown };
  /** The user messages of the request the stage finally sent upstream. */
  function userMessages(up: ReturnType<typeof upstream>): Msg[] {
    const body = up.chatBodies[up.chatBodies.length - 1] as { messages: Msg[] };
    return body.messages.filter((m) => m.role === "user");
  }
  /**
   * What a message's content holds, in reading order: `transcript:X` for the
   * transcript made from audio X, `audio` for a surviving audio part, and
   * `text:<word>` for the caller's own marker words. The wire may merge
   * neighbouring text parts into one string, so order is read off positions
   * inside each text rather than off part boundaries.
   */
  function sequence(content: unknown): string[] {
    const parts: Part[] = typeof content === "string" ? [{ type: "text", text: content }] : (content as Part[]);
    const out: string[] = [];
    for (const p of parts) {
      if (p.type === "input_audio") { out.push("audio"); continue; }
      if (p.type !== "text") { out.push(`other:${String(p.type)}`); continue; }
      for (const m of String(p.text).matchAll(/transcript-of-([A-Z]+)|WORD([a-z]+)/g)) {
        out.push(m[1] ? `transcript:${m[1]}` : `text:${m[2]}`);
      }
    }
    return out;
  }
  const survivingAudio = (content: unknown): Part[] =>
    Array.isArray(content) ? (content as Part[]).filter((p) => p.type === "input_audio") : [];
  const text = (word: string): Part => ({ type: "text", text: `WORD${word}` });

  async function run(content: Part[], cache: OcrCacheStore | null = null): Promise<{ up: ReturnType<typeof upstream>; content: unknown }> {
    const up = upstream();
    const inv = await agent(up, cache).invoke(request(content));
    expect(inv.result.ok ? "" : inv.result.message).toBe("");
    const users = userMessages(up);
    expect(users).toHaveLength(1);
    return { up, content: users[0].content };
  }

  it("unusable part in the MIDDLE: the transcripts stay on the first and third parts", async () => {
    const { up, content } = await run([text("lead"), audioPart(mark("ALPHA")), EMPTY, audioPart(mark("BRAVO")), text("tail")]);
    expect(up.uploads).toEqual(["ALPHA", "BRAVO"]);
    expect(sequence(content)).toEqual(["text:lead", "transcript:ALPHA", "audio", "transcript:BRAVO", "text:tail"]);
    // The unusable part is left as it was.
    expect(survivingAudio(content)).toEqual([EMPTY]);
  });

  it("unusable part FIRST: the transcripts do not shift onto it", async () => {
    const { up, content } = await run([EMPTY, audioPart(mark("ALPHA")), text("mid"), audioPart(mark("BRAVO"))]);
    expect(up.uploads).toEqual(["ALPHA", "BRAVO"]);
    expect(sequence(content)).toEqual(["audio", "transcript:ALPHA", "text:mid", "transcript:BRAVO"]);
    expect(survivingAudio(content)).toEqual([EMPTY]);
  });

  it("unusable part LAST: left alone", async () => {
    const { up, content } = await run([audioPart(mark("ALPHA")), text("mid"), audioPart(mark("BRAVO")), EMPTY]);
    expect(up.uploads).toEqual(["ALPHA", "BRAVO"]);
    expect(sequence(content)).toEqual(["transcript:ALPHA", "text:mid", "transcript:BRAVO", "audio"]);
    expect(survivingAudio(content)).toEqual([EMPTY]);
  });

  it("two unusable parts around one usable one", async () => {
    const { up, content } = await run([EMPTY, text("a"), audioPart(mark("ALPHA")), text("b"), EMPTY]);
    expect(up.uploads).toEqual(["ALPHA"]);
    expect(sequence(content)).toEqual(["audio", "text:a", "transcript:ALPHA", "text:b", "audio"]);
  });

  it("the same holds with the cache enabled", async () => {
    const { up, content } = await run([audioPart(mark("ALPHA")), EMPTY, audioPart(mark("BRAVO"))], enabledCache());
    expect(up.uploads).toEqual(["ALPHA", "BRAVO"]);
    expect(sequence(content)).toEqual(["transcript:ALPHA", "audio", "transcript:BRAVO"]);
  });

  /**
   * Independent of what exactly counts as "unusable": whichever parts the
   * pre-pass did transcribe, every transcript must sit where its own audio
   * was -- between the same marker words -- and never on another part.
   */
  it("whatever was transcribed, no transcript lands on a part it was not made from", async () => {
    const { up, content } = await run([
      text("one"), audioPart(mark("ALPHA")), text("two"), EMPTY, text("three"), audioPart(mark("BRAVO")), text("four"),
    ]);
    const seq = sequence(content);
    expect(seq.slice(0, 3)).toEqual(["text:one", "transcript:ALPHA", "text:two"]);
    expect(seq.slice(-3)).toEqual(["text:three", "transcript:BRAVO", "text:four"]);
    expect(up.uploads.filter((u) => u !== "UNKNOWN")).toEqual(["ALPHA", "BRAVO"]);
  });

  it("neighbour: with every part usable, each is replaced in order and no audio remains", async () => {
    const { up, content } = await run([audioPart(mark("ALPHA")), text("x"), audioPart(mark("BRAVO")), text("y"), audioPart(mark("CHARLIE"))]);
    expect(up.uploads).toEqual(["ALPHA", "BRAVO", "CHARLIE"]);
    expect(sequence(content)).toEqual(["transcript:ALPHA", "text:x", "transcript:BRAVO", "text:y", "transcript:CHARLIE"]);
  });

  it("neighbour: an unusable part in one message does not pull a transcript in from another message", async () => {
    const up = upstream();
    const req = OpenAICompletionRequest.parse({
      model: "svc",
      messages: [
        { role: "user", content: [EMPTY, text("first")] },
        { role: "assistant", content: "ok" },
        { role: "user", content: [audioPart(mark("ALPHA")), text("second")] },
      ],
    });
    const inv = await agent(up, null).invoke(req);
    expect(inv.result.ok ? "" : inv.result.message).toBe("");
    const users = userMessages(up);
    expect(users).toHaveLength(2);
    expect(up.uploads).toEqual(["ALPHA"]);
    expect(sequence(users[0].content)).toEqual(["audio", "text:first"]);
    expect(sequence(users[1].content)).toEqual(["transcript:ALPHA", "text:second"]);
  });
});
