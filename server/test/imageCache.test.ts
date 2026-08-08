import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type BetterSqlite3 from "better-sqlite3";
import { openDatabase, type DB } from "../src/db";
import { OpenAICompletionRequest } from "../src/core/format";
import { ImageCacheRepo, entrySize } from "../src/persistence/imageCacheRepo";
import { ImageDescriptionCache, imageHash } from "../src/execution/ocrCache";
import { MicroAgent, type ServiceResolver } from "../src/execution/microAgent";
import { parseService, type AgentDef } from "../src/execution/definition";
import type { Transport } from "../src/core/upstream/transport";
import type { Catalog } from "../src/catalog/catalog";
import type { ImagePart } from "../src/core/ir/content";

let dir: string;
let sqlite: BetterSqlite3.Database;
let db: DB;
let repo: ImageCacheRepo;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydro-imgcache-"));
  const opened = openDatabase(dir);
  db = opened.db;
  sqlite = opened.sqlite;
  repo = new ImageCacheRepo(db);
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  repo.clear();
});

// --- repository: the storage budget ----------------------------------------

/** A 100-byte entry: a 4-byte hash plus a 96-byte description. */
const mk = (i: number, description = "x".repeat(96)) => ({ hash: `h${String(i).padStart(3, "0")}`, description });

const T0 = 1_700_000_000_000;
const BUDGET = 1000; // exactly ten 100-byte entries

/** Fill the cache to exactly `BUDGET` with ten entries, oldest first. */
function fillToBudget(): void {
  for (let i = 1; i <= 10; i++) repo.put([mk(i)], T0 + i, BUDGET);
}

const hashesPresent = (): string[] =>
  [...repo.lookup(Array.from({ length: 20 }, (_, i) => mk(i + 1).hash)).keys()].sort();

describe("ImageCacheRepo", () => {
  it("round-trips a description and reports its size", () => {
    const e = mk(1);
    expect(entrySize(e.hash, e.description)).toBe(100);

    const report = repo.put([e], T0, BUDGET);
    expect(report).toEqual({ stored: 1, skipped: 0, evicted: 0 });
    expect(repo.lookup([e.hash]).get(e.hash)).toBe(e.description);
    expect(repo.stats()).toEqual({ entries: 1, usedBytes: 100 });
  });

  it("fills to exactly the budget without evicting anything", () => {
    fillToBudget();
    expect(repo.stats()).toEqual({ entries: 10, usedBytes: BUDGET });
  });

  it("evicts the least-recently-used entry when a full cache takes one more", () => {
    fillToBudget();

    const report = repo.put([mk(11)], T0 + 11, BUDGET);
    expect(report).toMatchObject({ stored: 1, evicted: 1 });

    const stats = repo.stats();
    expect(stats.usedBytes).toBeLessThanOrEqual(BUDGET);
    expect(stats.entries).toBe(10);
    expect(repo.lookup([mk(1).hash]).size).toBe(0); // the oldest is gone
    expect(repo.lookup([mk(11).hash]).get(mk(11).hash)).toBe(mk(11).description);
  });

  // The failure this guards: freeing room for the first image of a batch and
  // then writing all of them, which leaves the cache over budget (or silently
  // drops every image but one).
  it("frees room for EVERY entry of a batch, not just the first", () => {
    fillToBudget();

    const report = repo.put([mk(11), mk(12), mk(13)], T0 + 11, BUDGET);
    expect(report).toEqual({ stored: 3, skipped: 0, evicted: 3 });

    const stats = repo.stats();
    expect(stats.entries).toBe(10);
    expect(stats.usedBytes).toBe(BUDGET);
    expect(stats.usedBytes).toBeLessThanOrEqual(BUDGET);
    // The three oldest made way for the three new ones.
    expect(hashesPresent()).toEqual(["h004", "h005", "h006", "h007", "h008", "h009", "h010", "h011", "h012", "h013"]);
  });

  it("stays within budget when a batch is larger than the whole cache", () => {
    fillToBudget();

    // 15 entries × 100 bytes against a 1000-byte budget: 10 fit, 5 cannot.
    const batch = Array.from({ length: 15 }, (_, i) => mk(101 + i));
    const report = repo.put(batch, T0 + 20, BUDGET);

    expect(report.stored + report.skipped).toBe(15);
    expect(report.stored).toBe(10);
    expect(report.skipped).toBe(5);
    expect(repo.stats().usedBytes).toBeLessThanOrEqual(BUDGET);
  });

  it("keeps an old entry alive once it is touched", () => {
    fillToBudget();
    repo.touch([mk(1).hash], T0 + 100); // h001 becomes the most recently used

    repo.put([mk(11)], T0 + 101, BUDGET);

    expect(repo.lookup([mk(1).hash]).size).toBe(1); // survived
    expect(repo.lookup([mk(2).hash]).size).toBe(0); // now the oldest, evicted
  });

  it("charges only the difference when an existing entry is rewritten", () => {
    fillToBudget();

    // Same size: nothing has to go.
    const same = repo.put([mk(5, "y".repeat(96))], T0 + 50, BUDGET);
    expect(same).toEqual({ stored: 1, skipped: 0, evicted: 0 });
    expect(repo.stats()).toEqual({ entries: 10, usedBytes: BUDGET });
    expect(repo.lookup([mk(5).hash]).get(mk(5).hash)).toBe("y".repeat(96));

    // 100 bytes bigger: exactly one old entry has to go, and never the row
    // being rewritten.
    const bigger = repo.put([mk(5, "z".repeat(196))], T0 + 51, BUDGET);
    expect(bigger).toMatchObject({ stored: 1, evicted: 1 });
    expect(repo.stats().usedBytes).toBe(BUDGET);
    expect(repo.lookup([mk(5).hash]).get(mk(5).hash)).toBe("z".repeat(196));
    expect(repo.lookup([mk(1).hash]).size).toBe(0);
  });

  it("accepts a grow+shrink batch whose net cost fits, whatever the order", () => {
    fillToBudget();

    // h002 gains 95 bytes, h003 gives back 95: net zero, so nothing needs to be
    // evicted and neither rewrite may be turned away — including the grower,
    // which is listed first and would not fit before the shrinker is applied.
    const report = repo.put([mk(2, "y".repeat(191)), mk(3, "z")], T0 + 60, BUDGET);
    expect(report).toEqual({ stored: 2, skipped: 0, evicted: 0 });
    expect(repo.stats()).toEqual({ entries: 10, usedBytes: BUDGET });
  });

  it("refuses an entry bigger than the whole budget without disturbing the cache", () => {
    fillToBudget();

    const report = repo.put([mk(11, "x".repeat(BUDGET * 2))], T0 + 11, BUDGET);
    expect(report).toEqual({ stored: 0, skipped: 1, evicted: 0 });
    expect(repo.stats()).toEqual({ entries: 10, usedBytes: BUDGET });
  });

  it("enforces a lowered budget immediately, keeping the most recently used", () => {
    fillToBudget();

    const evicted = repo.enforceBudget(450);
    expect(evicted).toBe(6);
    expect(repo.stats()).toEqual({ entries: 4, usedBytes: 400 });
    expect(hashesPresent()).toEqual(["h007", "h008", "h009", "h010"]);

    expect(repo.enforceBudget(450)).toBe(0); // already inside the budget
  });

  it("treats a budget of zero as off: nothing stored, nothing left behind", () => {
    fillToBudget();

    const report = repo.put([mk(11)], T0 + 11, 0);
    expect(report).toMatchObject({ stored: 0, skipped: 1 });
    expect(repo.stats()).toEqual({ entries: 0, usedBytes: 0 });
  });
});

// --- hashing ---------------------------------------------------------------

describe("imageHash", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");

  it("is stable for the same bytes and distinct for different ones", () => {
    const a: ImagePart = { type: "image", source: { kind: "base64", mediaType: "image/png", data: b64("A") } };
    const a2: ImagePart = { type: "image", source: { kind: "base64", mediaType: "image/png", data: b64("A") } };
    const b: ImagePart = { type: "image", source: { kind: "base64", mediaType: "image/png", data: b64("B") } };
    expect(imageHash(a)).toBe(imageHash(a2));
    expect(imageHash(a)).not.toBe(imageHash(b));
  });

  it("separates a URL image from base64 content and from other URLs", () => {
    const u1: ImagePart = { type: "image", source: { kind: "url", url: "https://example.test/a.png" } };
    const u2: ImagePart = { type: "image", source: { kind: "url", url: "https://example.test/b.png" } };
    expect(imageHash(u1)).not.toBe(imageHash(u2));
    expect(imageHash(u1)).toHaveLength(64);
  });
});

// --- the OCR pre-pass through a Micro Agent --------------------------------

const b64 = (s: string) => Buffer.from(s).toString("base64");

const imagePart = (label: string): ImagePart => ({
  type: "image",
  source: { kind: "base64", mediaType: "image/png", data: b64(label) },
});

/** A request carrying `labels` as images, in order. */
const reqWithImages = (...labels: string[]) =>
  new OpenAICompletionRequest({
    requestedService: "svc",
    messages: [{ role: "user", content: [{ type: "text", text: "read these" }, ...labels.map(imagePart)] }],
    params: {},
    stream: false,
  });

/** The label behind a `data:image/png;base64,...` URL in an upstream body. */
const labelOf = (url: string) => Buffer.from(url.split(",")[1] ?? "", "base64").toString();

function imageUrlsIn(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const m of (body.messages ?? []) as Array<{ content?: unknown }>) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as Array<Record<string, unknown>>) {
      if (p.type === "image_url") out.push(String((p.image_url as { url?: unknown })?.url ?? ""));
    }
  }
  return out;
}

function userTextIn(body: Record<string, unknown>): string {
  const msgs = (body.messages ?? []) as Array<{ role?: string; content?: unknown }>;
  return msgs
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
}

interface Recorder {
  /** The image labels each OCR call was asked to transcribe, per call. */
  ocrCalls: string[][];
  /** Every non-OCR (stage) body the upstream received. */
  stageBodies: Record<string, unknown>[];
  /** Descriptions the fake OCR model returns; default `desc:<label>`. */
  describe: (label: string) => string;
}

const newRecorder = (): Recorder => ({ ocrCalls: [], stageBodies: [], describe: (l) => `desc:${l}` });

const jsonBody = (content: string) => ({
  id: "c",
  model: "up",
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

/** A body carrying images is the OCR call; anything else is a stage call. */
function recordingTransport(rec: Recorder): Transport {
  const answer = (body: Record<string, unknown>) => {
    const urls = imageUrlsIn(body);
    if (urls.length === 0) {
      rec.stageBodies.push(body);
      return jsonBody("STAGE-OK");
    }
    const labels = urls.map(labelOf);
    rec.ocrCalls.push(labels);
    return jsonBody(JSON.stringify(labels.map((l, i) => ({ index: i + 1, image: rec.describe(l) }))));
  };
  return {
    async postStream(_url, _headers, body) {
      return {
        status: 200,
        headers: {},
        body: Readable.from([`data: ${JSON.stringify(answer(body as Record<string, unknown>))}\n\n`, "data: [DONE]\n\n"]),
      };
    },
    async postJson(_url, _headers, body) {
      return { status: 200, headers: {}, json: answer(body as Record<string, unknown>), text: "" };
    },
  };
}

const fakeCatalog = (): Catalog =>
  ({
    resolve: (model: string, provider: string) => ({
      ok: true,
      target: { family: "openai_completion", upstreamModel: `up-${model}`, url: "http://upstream", headers: {}, modelName: model, providerName: provider, upstream: {} },
    }),
    exists: () => true,
  }) as unknown as Catalog;

const noResolver: ServiceResolver = { resolve: () => ({ ok: false, message: "not used" }) };

const ocrAgent = (): AgentDef =>
  parseService({
    kind: "micro_agent",
    timeoutMs: 1000,
    stages: [{ name: "answer", input: [], steps: [{ model: "m", provider: "p" }] }],
    ocr: { steps: [{ model: "ocr-m", provider: "p" }] },
  }) as AgentDef;

function agentWith(rec: Recorder, maxBytes: number | (() => number) = 1_000_000): MicroAgent {
  const budget = typeof maxBytes === "function" ? maxBytes : () => maxBytes;
  return new MicroAgent(ocrAgent(), {
    catalog: fakeCatalog(),
    transport: recordingTransport(rec),
    resolver: noResolver,
    logMaxChars: 2000,
    ocrCache: new ImageDescriptionCache(repo, budget),
  });
}

describe("MicroAgent OCR pre-pass with the image cache", () => {
  it("transcribes an image once and serves the repeat from the cache", async () => {
    const rec = newRecorder();

    const first = await agentWith(rec).invoke(reqWithImages("A"));
    expect(first.result.ok).toBe(true);
    expect(rec.ocrCalls).toEqual([["A"]]);
    expect(userTextIn(rec.stageBodies[0])).toContain("desc:A");

    const second = await agentWith(rec).invoke(reqWithImages("A"));
    expect(second.result.ok).toBe(true);
    expect(rec.ocrCalls).toEqual([["A"]]); // no second OCR call
    expect(userTextIn(rec.stageBodies[1])).toContain("desc:A");

    // The cached run makes one upstream call (the stage), not two.
    expect((second.attemptPath as unknown[]).length).toBe(1);
  });

  it("sends only the uncached images and reassembles the results in order", async () => {
    const rec = newRecorder();
    await agentWith(rec).invoke(reqWithImages("B")); // warm B only
    rec.ocrCalls.length = 0;

    const inv = await agentWith(rec).invoke(reqWithImages("A", "B", "C"));
    expect(inv.result.ok).toBe(true);
    expect(rec.ocrCalls).toEqual([["A", "C"]]); // B came from the cache

    const text = userTextIn(rec.stageBodies[rec.stageBodies.length - 1]);
    expect(text).toContain("[Image 1]\ndesc:A");
    expect(text).toContain("[Image 2]\ndesc:B");
    expect(text).toContain("[Image 3]\ndesc:C");
    expect(text.indexOf("desc:A")).toBeLessThan(text.indexOf("desc:B"));
    expect(text.indexOf("desc:B")).toBeLessThan(text.indexOf("desc:C"));
  });

  it("transcribes a repeated image within one request only once", async () => {
    const rec = newRecorder();

    const inv = await agentWith(rec).invoke(reqWithImages("A", "A", "D"));
    expect(inv.result.ok).toBe(true);
    expect(rec.ocrCalls).toEqual([["A", "D"]]);

    const text = userTextIn(rec.stageBodies[0]);
    expect(text).toContain("[Image 1]\ndesc:A");
    expect(text).toContain("[Image 2]\ndesc:A");
    expect(text).toContain("[Image 3]\ndesc:D");
  });

  it("does not remember an empty description", async () => {
    const rec = newRecorder();
    rec.describe = () => "";

    await agentWith(rec).invoke(reqWithImages("E"));
    expect(repo.lookup([imageHash(imagePart("E"))]).size).toBe(0);

    rec.describe = (l) => `desc:${l}`;
    await agentWith(rec).invoke(reqWithImages("E"));
    expect(rec.ocrCalls).toEqual([["E"], ["E"]]); // retried rather than cached blank
  });

  it("goes to the model every time when the budget is zero", async () => {
    const rec = newRecorder();

    await agentWith(rec, 0).invoke(reqWithImages("F"));
    await agentWith(rec, 0).invoke(reqWithImages("F"));

    expect(rec.ocrCalls).toEqual([["F"], ["F"]]);
    expect(repo.stats().entries).toBe(0);
  });

  it("re-stamps a cache hit so it survives later eviction pressure", async () => {
    const rec = newRecorder();
    await agentWith(rec).invoke(reqWithImages("G"));
    await agentWith(rec).invoke(reqWithImages("H"));

    const g = imageHash(imagePart("G"));
    const before = sqlite.prepare("select last_used_at from image_cache where hash = ?").get(g) as { last_used_at: number };

    await new Promise((r) => setTimeout(r, 5));
    await agentWith(rec).invoke(reqWithImages("G")); // a pure cache hit

    const after = sqlite.prepare("select last_used_at from image_cache where hash = ?").get(g) as { last_used_at: number };
    expect(after.last_used_at).toBeGreaterThan(before.last_used_at);
  });

  it("still answers the request when the cache database throws", async () => {
    const rec = newRecorder();
    const errors: string[] = [];
    const broken = {
      lookup: () => { throw new Error("disk I/O error"); },
      touch: () => { throw new Error("disk I/O error"); },
      put: () => { throw new Error("disk I/O error"); },
    } as unknown as ImageCacheRepo;
    const agent = new MicroAgent(ocrAgent(), {
      catalog: fakeCatalog(),
      transport: recordingTransport(rec),
      resolver: noResolver,
      logMaxChars: 2000,
      ocrCache: new ImageDescriptionCache(broken, () => 1_000_000, Date.now, (op) => errors.push(op)),
    });

    const inv = await agent.invoke(reqWithImages("J"));
    expect(inv.result.ok).toBe(true); // a cache fault is not a request fault
    expect(rec.ocrCalls).toEqual([["J"]]);
    expect(userTextIn(rec.stageBodies[0])).toContain("desc:J");
    expect(errors).toEqual(["lookup", "store"]);
  });

  it("keeps working with no cache configured at all", async () => {
    const rec = newRecorder();
    const agent = new MicroAgent(ocrAgent(), {
      catalog: fakeCatalog(),
      transport: recordingTransport(rec),
      resolver: noResolver,
      logMaxChars: 2000,
    });

    await agent.invoke(reqWithImages("I"));
    await agent.invoke(reqWithImages("I"));
    expect(rec.ocrCalls).toEqual([["I"], ["I"]]);
  });
});
