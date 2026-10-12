/**
 * Independent verification, written from the spec only (EXEC E8, E11, E15).
 *
 * E8  A duration stored in the settings table as a bare number is read as
 *     milliseconds; suffixed values keep their meaning.
 * E11 Validating a Micro Agent whose OCR or ASR pre-pass references a saved
 *     service with an unparsable stored definition is a normal validation
 *     error (400 on POST /services, {valid:false,error} on /services/validate).
 * E15 (a) Request-log redaction of a payload with a circular reference does
 *     not throw or hang and marks the cycle. (b) The bench multipart file part
 *     cannot carry CR/LF injected through the file's media type.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type BetterSqlite3 from "better-sqlite3";
import { openDatabase, type DB } from "../src/db";
import { parseDurationToMs, SettingsRepo } from "../src/persistence/settingsRepo";
import { serializeForLog } from "../src/util/logPayload";
import { startAdminHarness, type AdminHarness } from "./coverageAdminHarness";

// ---------------------------------------------------------------------------
// E8
// ---------------------------------------------------------------------------

describe("E8: durations in the settings table", () => {
  let dir: string;
  let sqlite: BetterSqlite3.Database;
  let db: DB;

  /** Not the built-in default, so a fallback cannot pass for a parsed value. */
  const DEFAULT_TTL_MS = 45_000;
  const DEFAULTS = {
    allowPrivate: false,
    logPayloadMaxChars: 1234,
    simulatedStreamingTokenRate: 77,
    sessionTtlMs: DEFAULT_TTL_MS,
    imageCacheMaxBytes: 4096,
    promptCacheTtlMinutes: 9,
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydro-verify-settings-"));
    const opened = openDatabase(dir);
    db = opened.db;
    sqlite = opened.sqlite;
  });
  afterAll(() => {
    sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    sqlite.prepare("DELETE FROM settings").run();
  });

  /** The session lifetime a fresh process reads for a value sitting in the table. */
  function storedTtl(raw: string): number {
    sqlite.prepare("DELETE FROM settings WHERE key = 'session_ttl'").run();
    sqlite.prepare("INSERT INTO settings (key, value) VALUES ('session_ttl', ?)").run(raw);
    return new SettingsRepo(db, DEFAULTS).sessionTtlMs();
  }

  it.each([
    ["1", 1],
    ["90", 90],
    ["1000", 1_000],
    ["30000", 30_000],
    ["3600000", 3_600_000],
    ["43200000", 43_200_000],
    ["86400000", 86_400_000],
  ])("a bare number %j is read as that many milliseconds", (raw, ms) => {
    expect(storedTtl(raw)).toBe(ms);
  });

  it("a bare number is not read as seconds, minutes or hours", () => {
    expect(storedTtl("30")).toBe(30);
    expect(storedTtl("30")).not.toBe(30_000);
    expect(storedTtl("12")).toBe(12);
    expect(storedTtl("12")).not.toBe(43_200_000);
  });

  it.each([
    ["30s", 30_000],
    ["5m", 300_000],
    ["12h", 43_200_000],
    ["1d", 86_400_000],
    ["1s", 1_000],
    ["90s", 90_000],
    ["2d", 172_800_000],
  ])("unchanged: the suffixed value %j keeps its meaning", (raw, ms) => {
    expect(storedTtl(raw)).toBe(ms);
  });

  it("the same number with and without a unit differ by the unit's factor", () => {
    expect(storedTtl("30s")).toBe(1_000 * storedTtl("30"));
    expect(storedTtl("5m")).toBe(60_000 * storedTtl("5"));
    expect(storedTtl("12h")).toBe(3_600_000 * storedTtl("12"));
    expect(storedTtl("1d")).toBe(86_400_000 * storedTtl("1"));
  });

  it("a value written through the repo's own `set` reads the same way", () => {
    const settings = new SettingsRepo(db, DEFAULTS);
    settings.set("session_ttl", "2500");
    expect(settings.sessionTtlMs()).toBe(2_500);
    expect(settings.runtimeEnv().sessionTtlMs).toBe(2_500);
    settings.set("session_ttl", "30s");
    expect(settings.sessionTtlMs()).toBe(30_000);
  });

  it("unchanged: nothing stored means the default; junk means the default", () => {
    expect(new SettingsRepo(db, DEFAULTS).sessionTtlMs()).toBe(DEFAULT_TTL_MS);
    expect(storedTtl("soon")).toBe(DEFAULT_TTL_MS);
  });

  it("the exported parser agrees: bare = ms, suffixed = its unit", () => {
    expect(parseDurationToMs("1500")).toBe(1_500);
    expect(parseDurationToMs("30s")).toBe(30_000);
    expect(parseDurationToMs("5m")).toBe(300_000);
    expect(parseDurationToMs("12h")).toBe(43_200_000);
    expect(parseDurationToMs("1d")).toBe(86_400_000);
  });
});

// ---------------------------------------------------------------------------
// E15 (a)
// ---------------------------------------------------------------------------

describe("E15a: redacting a payload that contains a cycle", () => {
  const CYCLE = /circular|cycl/i;
  const AMPLE = 100_000;

  function selfRef(): Record<string, unknown> {
    const o: Record<string, unknown> = { model: "m", note: "visible-note" };
    o.self = o;
    return o;
  }
  function deepCycle(): Record<string, unknown> {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b" };
    const c: Record<string, unknown> = { name: "c", back: a };
    a.next = b;
    b.next = c;
    return { model: "m", chain: a };
  }
  function arrayCycle(): Record<string, unknown> {
    const list: unknown[] = ["first"];
    list.push(list);
    return { messages: list };
  }

  it.each([
    ["an object that contains itself", selfRef],
    ["a cycle three objects long", deepCycle],
    ["an array that contains itself", arrayCycle],
  ])("%s: no throw, a string comes back, and the cycle is marked", (_label, make) => {
    let out = "";
    expect(() => { out = serializeForLog(make(), AMPLE); }).not.toThrow();
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(AMPLE);
    expect(out).toMatch(CYCLE);
  });

  it("the result is still JSON, and what sits outside the cycle is kept", () => {
    const out = serializeForLog(selfRef(), AMPLE);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.model).toBe("m");
    expect(parsed.note).toBe("visible-note");
    expect(JSON.stringify(parsed.self)).toMatch(CYCLE);
  });

  it("credentials inside a cyclic payload are still redacted", () => {
    const o = selfRef();
    o.authorization = "Bearer sk-live-secret";
    o.nested = { api_key: "sk-nested-secret", loop: o };
    const out = serializeForLog(o, AMPLE);
    expect(out).not.toContain("sk-live-secret");
    expect(out).not.toContain("sk-nested-secret");
    expect(out).toMatch(CYCLE);
  });

  it("unlimited budget (maxChars 0): no throw, cycle marked", () => {
    let out = "";
    expect(() => { out = serializeForLog(deepCycle(), 0); }).not.toThrow();
    expect(out).toMatch(CYCLE);
  });

  it("a cyclic payload over the budget: no throw, bounded output", () => {
    const o = selfRef();
    o.messages = Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(5_000), owner: o }));
    let out = "";
    expect(() => { out = serializeForLog(o, 20_000); }).not.toThrow();
    expect(out.length).toBeLessThanOrEqual(20_000);
  });

  it("a tiny budget with a cyclic payload: no throw, bounded output", () => {
    let out = "";
    expect(() => { out = serializeForLog(selfRef(), 20); }).not.toThrow();
    expect(out.length).toBeLessThanOrEqual(20);
  });

  it("neighbour: the same object referenced twice WITHOUT a cycle is not marked and is kept whole", () => {
    const shared = { role: "user", content: "shared-content" };
    const value = { first: shared, second: shared, list: [shared, shared] };
    const out = serializeForLog(value, AMPLE);
    expect(out).toBe(JSON.stringify(value, null, 2));
    expect(out).not.toMatch(CYCLE);
  });

  it("neighbour: a payload with no cycle is stored byte for byte", () => {
    const value = { model: "m", temperature: 0.2, messages: [{ role: "user", content: "hi" }] };
    expect(serializeForLog(value, AMPLE)).toBe(JSON.stringify(value, null, 2));
  });
});

// ---------------------------------------------------------------------------
// E11 and E15 (b) -- over the admin HTTP API
// ---------------------------------------------------------------------------

interface Hit { path: string; raw: string }

describe("admin API", () => {
  let h: AdminHarness;
  let upstream: http.Server;
  let hits: Hit[] = [];

  const STEP = { model: "m", provider: "fake" };
  const stage = (name: string) => ({ name, input: [], steps: [STEP] });
  const agent = (extra: Record<string, unknown>) => ({ kind: "micro_agent", timeoutMs: 30_000, stages: [stage("main")], ...extra });

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (d: Buffer) => chunks.push(d));
      req.on("end", () => {
        hits.push({ path: req.url ?? "", raw: Buffer.concat(chunks).toString("latin1") });
        res.writeHead(200, { "content-type": "application/json" });
        if ((req.url ?? "").includes("/audio/transcriptions")) res.end(JSON.stringify({ text: "hello world" }));
        else res.end(JSON.stringify({
          id: "c", object: "chat.completion", created: 1, model: "up",
          choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;

    h = await startAdminHarness("verify-exec-persistence", { ALLOW_PRIVATE_UPSTREAMS: "1" });
    const provider = h.c.providers.create({ name: "fake", type: "openai_completion", baseUrl, apiKey: "k" });
    const model = h.c.models.create({ name: "m" });
    h.c.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "up" });
  });

  afterAll(async () => {
    await h.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  const create = (payload: unknown) => h.admin({ method: "POST", url: "/services", payload });
  const validate = (steps: unknown) => h.admin({ method: "POST", url: "/services/validate", payload: { steps } });

  describe("E11: a pre-pass reference to a service whose stored definition is unparsable", () => {
    /** Stored `definition_json` texts that no longer describe a service. */
    const BROKEN: Array<[string, string]> = [
      ["an object of the wrong shape", JSON.stringify({ nonsense: true })],
      ["a chain with no steps", JSON.stringify({ steps: [] })],
      ["a category with no steps", JSON.stringify({ category: "stt" })],
      ["a JSON string", JSON.stringify("not a definition")],
      ["a JSON number", "5"],
    ];

    let counter = 0;
    /** Save a healthy service, then spoil what is stored for it. */
    async function brokenService(category: "ocr" | "stt" | "chat", definitionJson: string): Promise<string> {
      const name = `broken-${category}-${++counter}`;
      const steps = category === "chat" ? { timeoutMs: 30_000, steps: [STEP] } : { category, timeoutMs: 30_000, steps: [STEP] };
      const res = await create({ name, steps });
      expect(res.statusCode, res.body).toBe(201);
      const id = res.json().service.id as number;
      h.c.sqlite.prepare("UPDATE model_services SET definition_json = ? WHERE id = ?").run(definitionJson, id);
      return name;
    }

    function expectValidationError(res: { statusCode: number; body: string; json: () => unknown }): void {
      expect(res.statusCode, res.body).toBe(400);
      const body = res.json() as { error?: unknown };
      expect(typeof body.error).toBe("string");
      expect((body.error as string).length).toBeGreaterThan(0);
    }
    function expectInvalidVerdict(res: { statusCode: number; body: string; json: () => unknown }): void {
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as { valid?: unknown; error?: unknown };
      expect(body.valid).toBe(false);
      expect(typeof body.error).toBe("string");
      expect((body.error as string).length).toBeGreaterThan(0);
    }

    describe.each(BROKEN)("stored definition is %s", (_label, definitionJson) => {
      it("OCR reference: POST /services answers 400 with a validation message and saves nothing", async () => {
        const ref = await brokenService("ocr", definitionJson);
        const name = `agent-ocr-${counter}`;
        const res = await create({ name, steps: agent({ ocr: { service: ref } }) });
        expectValidationError(res);
        expect(h.c.services.getByName(name)).toBeUndefined();
      });

      it("OCR reference: /services/validate answers {valid:false,error}", async () => {
        const ref = await brokenService("ocr", definitionJson);
        expectInvalidVerdict(await validate(agent({ ocr: { service: ref } })));
      });

      it("OCR reference to a (formerly chat) service: same", async () => {
        const ref = await brokenService("chat", definitionJson);
        expectInvalidVerdict(await validate(agent({ ocr: { service: ref } })));
        expectValidationError(await create({ name: `agent-ocr-chat-${counter}`, steps: agent({ ocr: { service: ref } }) }));
      });

      it("ASR reference: POST /services answers 400 with a validation message and saves nothing", async () => {
        const ref = await brokenService("stt", definitionJson);
        const name = `agent-asr-${counter}`;
        const res = await create({ name, steps: agent({ asr: { service: ref } }) });
        expectValidationError(res);
        expect(h.c.services.getByName(name)).toBeUndefined();
      });

      it("ASR reference: /services/validate answers {valid:false,error}", async () => {
        const ref = await brokenService("stt", definitionJson);
        expectInvalidVerdict(await validate(agent({ asr: { service: ref } })));
      });

      it("both pre-passes broken at once: still a validation error, not a 500", async () => {
        const ocr = await brokenService("ocr", definitionJson);
        const asr = await brokenService("stt", definitionJson);
        const def = agent({ ocr: { service: ocr }, asr: { service: asr } });
        expectInvalidVerdict(await validate(def));
        expectValidationError(await create({ name: `agent-both-${counter}`, steps: def }));
      });

      it("PATCH of an existing agent onto the broken reference: 400, not 500", async () => {
        const made = await create({ name: `agent-patch-${++counter}`, steps: agent({}) });
        expect(made.statusCode, made.body).toBe(201);
        const id = made.json().service.id as number;
        const ocr = await brokenService("ocr", definitionJson);
        const asr = await brokenService("stt", definitionJson);
        expectValidationError(await h.admin({ method: "PATCH", url: `/services/${id}`, payload: { steps: agent({ ocr: { service: ocr } }) } }));
        expectValidationError(await h.admin({ method: "PATCH", url: `/services/${id}`, payload: { steps: agent({ asr: { service: asr } }) } }));
      });
    });

    it("neighbour: healthy OCR and stt references validate and save", async () => {
      expect((await create({ name: "good-ocr", steps: { category: "ocr", timeoutMs: 30_000, steps: [STEP] } })).statusCode).toBe(201);
      expect((await create({ name: "good-stt", steps: { category: "stt", timeoutMs: 30_000, steps: [STEP] } })).statusCode).toBe(201);
      const def = agent({ ocr: { service: "good-ocr" }, asr: { service: "good-stt" } });
      const verdict = await validate(def);
      expect(verdict.statusCode).toBe(200);
      expect(verdict.json().valid).toBe(true);
      const saved = await create({ name: "agent-good", steps: def });
      expect(saved.statusCode, saved.body).toBe(201);
    });

    it("neighbour: an unknown reference is the same kind of validation error", async () => {
      expectInvalidVerdict(await validate(agent({ ocr: { service: "no-such-service" } })));
      expectInvalidVerdict(await validate(agent({ asr: { service: "no-such-service" } })));
      expectValidationError(await create({ name: "agent-unknown", steps: agent({ asr: { service: "no-such-service" } }) }));
    });

    it("neighbour: an agent with no pre-pass is unaffected by broken services elsewhere", async () => {
      await brokenService("ocr", JSON.stringify({ nonsense: true }));
      const verdict = await validate(agent({}));
      expect(verdict.statusCode).toBe(200);
      expect(verdict.json().valid).toBe(true);
    });
  });

  describe("E15b: the bench's multipart file part and the file's media type", () => {
    const RAW = { kind: "raw", model: "m", provider: "fake", providerFormat: "openai_completion" } as const;
    const AUDIO = Buffer.from("RIFF-VERIFY-AUDIO-DATA");

    const bench = (mediaType: string) =>
      h.admin({
        method: "POST",
        url: "/bench/media",
        payload: { target: RAW, category: "stt", body: { model: "x" }, file: { name: "a.wav", mediaType, data: AUDIO.toString("base64") } },
      });

    /** The header block of the multipart part that carries the file. */
    function filePartHeaders(form: string): string {
      const start = form.indexOf('name="file"');
      expect(start, "the form has no file part").toBeGreaterThanOrEqual(0);
      const lineStart = form.lastIndexOf("\r\n", start) + 2;
      const end = form.indexOf("\r\n\r\n", start);
      expect(end).toBeGreaterThan(start);
      return form.slice(lineStart, end);
    }

    it.each([
      ["CRLF then a forged header", "audio/wav\r\nX-Injected: yes"],
      ["bare LF then a forged header", "audio/wav\nX-Injected: yes"],
      ["bare CR then a forged header", "audio/wav\rX-Injected: yes"],
      ["CRLF CRLF closing the headers early", "audio/wav\r\n\r\nINJECTED-BODY"],
      ["a forged second part", 'audio/wav\r\n\r\nx\r\n--boundary\r\nContent-Disposition: form-data; name="model"\r\n\r\nevil-model'],
      ["a trailing CRLF", "audio/wav\r\n"],
    ])("%s never reaches the upstream form", async (_label, mediaType) => {
      hits = [];
      const res = await bench(mediaType);
      // Either the request is refused outright or the value is made harmless;
      // a server error is neither.
      expect(res.statusCode, res.body).toBeLessThan(500);
      const forms = hits.filter((x) => x.path.includes("/audio/transcriptions"));
      if (res.statusCode !== 200) {
        expect(forms).toEqual([]);
        return;
      }
      for (const form of forms) {
        const headers = filePartHeaders(form.raw);
        // The part's headers are exactly the lines the proxy writes: no line
        // the caller's media type could have started.
        const lines = headers.split("\r\n");
        for (const line of lines) {
          expect(line).not.toMatch(/[\r\n]/);
          expect(line).toMatch(/^(Content-Disposition|Content-Type):/i);
        }
        expect(lines.filter((l) => /^Content-Type:/i.test(l)).length).toBeLessThanOrEqual(1);
        expect(lines.filter((l) => /^Content-Disposition:/i.test(l))).toHaveLength(1);
        // The forged text may survive as inert characters inside the one
        // Content-Type value; what it must not do is start a line of its own.
        expect(lines.some((l) => /^X-Injected/i.test(l))).toBe(false);
        // The file's bytes start right after the part's own blank line.
        const bodyStart = form.raw.indexOf("\r\n\r\n", form.raw.indexOf('name="file"')) + 4;
        expect(form.raw.slice(bodyStart, bodyStart + AUDIO.length)).toBe(AUDIO.toString("latin1"));
        // And no extra part was smuggled in: the form still has exactly the
        // model part and the file part, split on the form's real boundary.
        const boundary = form.raw.slice(0, form.raw.indexOf("\r\n"));
        const parts = form.raw.split(boundary).filter((part) => part.includes("Content-Disposition"));
        expect(parts).toHaveLength(2);
        expect(parts.filter((part) => /^\r\nContent-Disposition: form-data; name="model"\r\n\r\nup\r\n$/.test(part))).toHaveLength(1);
        expect(form.raw.split("\r\n").filter((l) => /^Content-Disposition:/i.test(l))).toHaveLength(2);
      }
    });

    it("neighbour: an ordinary media type is framed as given and the run succeeds", async () => {
      hits = [];
      const res = await bench("audio/wav");
      expect(res.statusCode).toBe(200);
      const out = res.json() as { ok: boolean; response: unknown };
      expect(out.ok).toBe(true);
      expect(out.response).toEqual({ text: "hello world" });
      expect(hits).toHaveLength(1);
      const headers = filePartHeaders(hits[0].raw);
      expect(headers).toContain('filename="a.wav"');
      expect(headers).toMatch(/Content-Type: audio\/wav(\r\n|$)/);
      expect(hits[0].raw).toContain(AUDIO.toString("latin1"));
    });

    it("neighbour: another ordinary media type (audio/mpeg) is passed through", async () => {
      hits = [];
      const res = await bench("audio/mpeg");
      expect(res.statusCode).toBe(200);
      expect(hits).toHaveLength(1);
      expect(filePartHeaders(hits[0].raw)).toMatch(/Content-Type: audio\/mpeg(\r\n|$)/);
    });
  });
});
