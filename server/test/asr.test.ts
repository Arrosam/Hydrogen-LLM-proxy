/**
 * ASR pre-pass: audio attachments transcribed to text before the stages run,
 * mirroring the OCR pre-pass for images.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { audioHash, buildTranscriptionForm, transcribeAudio } from "../src/execution/asr";
import { collectAudio, translateAudioInRequest } from "../src/execution/agentContext";
import { OpenAICompletionRequest } from "../src/core/format/completion";
import type { Catalog } from "../src/catalog/catalog";
import type { Transport, TransportJsonResult } from "../src/core/upstream/transport";
import { readMultipartField } from "../src/core/upstream/multipart";
import { parseServiceSteps } from "../src/execution/definition";

const AUDIO_B64 = Buffer.from("RIFFxxxxWAVE").toString("base64");
afterEach(() => vi.useRealTimers());

const reqWithAudio = () =>
  OpenAICompletionRequest.parse({
    model: "svc",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "what did they say?" },
        { type: "input_audio", input_audio: { data: AUDIO_B64, format: "wav" } },
      ],
    }],
  });

describe("collect & translate audio", () => {
  it("finds input_audio attachments and replaces them with transcripts", () => {
    const req = reqWithAudio();
    const audios = collectAudio(req);
    expect(audios).toHaveLength(1);
    expect(audios[0].format).toBe("wav");

    const translated = translateAudioInRequest(req, ["hello world"]);
    const body = translated.render({ upstreamModel: "up" });
    const text = JSON.stringify(body.messages);
    expect(text).toContain("hello world");
    expect(text).not.toContain("input_audio");
  });

  it("hashes are audio-prefixed so they can never collide with image entries", () => {
    expect(audioHash({ data: AUDIO_B64, format: "wav" }).startsWith("a:")).toBe(true);
  });
});

describe("transcription transport", () => {
  const cases = [
    { name: "nested configured strings", overrides: { extra: { language: "en", prompt: "Recognize English proper names.\r\nKeep punctuation." } }, language: "en", prompt: "Recognize English proper names.\r\nKeep punctuation." },
    { name: "direct override keys", overrides: { language: "en", prompt: "Keep English names." }, language: "en", prompt: "Keep English names." },
    { name: "existing direct-key precedence", overrides: { language: "en", prompt: "Use the direct hint.", extra: { language: "fr", prompt: "Use the nested hint." } }, language: "en", prompt: "Use the direct hint." },
    { name: "direct null/empty precedence", overrides: { language: null, prompt: "", extra: { language: "en", prompt: "Use the nested hint." } }, language: null, prompt: "" },
    { name: "absent", overrides: {}, language: null, prompt: null },
    { name: "null and undefined", overrides: { extra: { language: null, prompt: undefined } }, language: null, prompt: null },
    { name: "empty", overrides: { extra: { language: "", prompt: "" } }, language: "", prompt: "" },
    { name: "existing scalar and structured representation", overrides: { extra: { language: false, prompt: { hint: "English names" } } }, language: "false", prompt: '{"hint":"English names"}' },
  ];
  it.each(cases)("honors the public STT field representation for $name", async ({ overrides, language, prompt }) => {
    const bytes = Buffer.from([82, 73, 70, 70, 0, 255, 13, 10, 128]);
    const catalog = { resolveWithin: () => ({ ok: true, target: { upstreamModel: "mapped-speech", upstream: { type: "openai_completion", baseUrl: "https://provider.test/v1", apiKey: "synthetic" } } }) } as unknown as Catalog;
    const seen: Array<{ body: Buffer; contentType: string }> = [];
    const transport = { postRaw: async (_url: string, headers: Record<string, string>, body: Buffer) => {
      seen.push({ body, contentType: headers["content-type"] }); return { status: 200, headers: {}, json: { text: "transcript" }, text: "" };
    } } as unknown as Transport;
    const def = parseServiceSteps({ category: "stt", steps: [{ model: "m", provider: "p", overrides: {
      ...overrides, extra: { ...("extra" in overrides ? overrides.extra : {}), tools: [{ type: "function", name: "unrelated" }], tool_choice: "required", temperature: 0.5, model: "wrong-model" },
    } }] });
    const out = await transcribeAudio(def, { data: bytes.toString("base64"), format: 'wav"\r\nInjected: yes' }, { catalog, transport });
    expect(out.result).toMatchObject({ ok: true, value: "transcript" }); expect(seen).toHaveLength(1);
    const form = seen[0];
    expect(readMultipartField(form.body, form.contentType, "model")).toBe("mapped-speech");
    expect(readMultipartField(form.body, form.contentType, "language")).toBe(language);
    expect(readMultipartField(form.body, form.contentType, "prompt")).toBe(prompt);
    expect(form.body.includes(bytes)).toBe(true); expect(form.body.toString()).toContain('filename="audio.wav"');
    expect(form.body.toString()).not.toContain("Injected:");
    for (const key of ["model", "language", "prompt"]) expect(form.body.toString().split(`name="${key}"`).length - 1).toBe(key === "model" || (key === "language" ? language : prompt) !== null ? 1 : 0);
    for (const key of ["tools", "tool_choice", "temperature"]) expect(readMultipartField(form.body, form.contentType, key)).toBeNull();
  });

  it.each([
    { name: "configured", overrides: { language: "fr", prompt: "Next English hint." }, language: "fr", prompt: "Next English hint." },
    { name: "omitted", overrides: undefined, language: null, prompt: null },
    { name: "null", overrides: { extra: { language: null, prompt: null } }, language: null, prompt: null },
  ])("rebuilds configured fields per retry and $name fallback without changing audio", async ({ overrides, language, prompt }) => {
    vi.useFakeTimers();
    const seen: Array<{ provider: string; body: Buffer; contentType: string }> = [];
    const catalog = { resolveWithin: (_model: string, provider: string) => ({ ok: true, target: { upstreamModel: `mapped-${provider}`, upstream: { type: "openai_completion", baseUrl: `https://provider.test/${provider}`, apiKey: "synthetic" } } }) } as unknown as Catalog;
    const transport = { postRaw: async (url: string, headers: Record<string, string>, body: Buffer) => {
      const provider = url.includes("/first/") ? "first" : "next"; seen.push({ provider, body, contentType: headers["content-type"] });
      return provider === "first" ? { status: 503, headers: {}, json: { error: { message: "Unavailable" } }, text: "" } : { status: 200, headers: {}, json: { text: "transcript" }, text: "" };
    } } as unknown as Transport;
    const def = parseServiceSteps({ category: "stt", steps: [
      { model: "m", provider: "first", retry: { maxAttempts: 2, on: [503], intervalMs: 100 }, overrides: { extra: { language: "en", prompt: "First English hint." } } },
      { model: "m", provider: "next", overrides },
    ] });
    const before = Date.now();
    const pending = transcribeAudio(def, { data: AUDIO_B64, format: "wav" }, { catalog, transport });
    await vi.advanceTimersByTimeAsync(100); const out = await pending;
    expect(out.result).toMatchObject({ ok: true, value: "transcript" });
    expect(out.path.map(attempt => [attempt.step, attempt.attempt])).toEqual([[1, 1], [1, 2], [2, 1]]);
    expect(Date.now() - before).toBe(100); expect(seen.map(form => form.provider)).toEqual(["first", "first", "next"]);
    for (const form of seen) {
      expect(readMultipartField(form.body, form.contentType, "model")).toBe(`mapped-${form.provider}`);
      expect(readMultipartField(form.body, form.contentType, "language")).toBe(form.provider === "first" ? "en" : language);
      expect(readMultipartField(form.body, form.contentType, "prompt")).toBe(form.provider === "first" ? "First English hint." : prompt);
      for (const key of ["model", "language", "prompt"]) expect(form.body.toString().split(`name="${key}"`).length - 1).toBe(key === "model" || form.provider === "first" || (key === "language" ? language : prompt) !== null ? 1 : 0);
      expect(form.body.includes(Buffer.from(AUDIO_B64, "base64"))).toBe(true);
    }
  });

  it("frames a valid multipart form with the model and the audio bytes", () => {
    const { body, contentType } = buildTranscriptionForm("whisper-1", { data: AUDIO_B64, format: "mp3" });
    const raw = body.toString("latin1");
    expect(contentType).toContain("multipart/form-data; boundary=");
    expect(raw).toContain('name="model"\r\n\r\nwhisper-1');
    expect(raw).toContain('filename="audio.mp3"');
    expect(raw).toContain("RIFFxxxxWAVE"); // decoded audio bytes present
  });

  it("runs the step chain and returns the transcript text", async () => {
    const catalog = {
      resolveWithin: () => ({
        ok: true,
        target: {
          family: "openai_completion", upstreamModel: "whisper-1", endpointIndex: 0,
          upstream: { type: "openai_completion", baseUrl: "http://u.test/v1", apiKey: "k", extraHeaders: null },
        },
      }),
    } as unknown as Catalog;
    const seen: Array<{ url: string; contentType: string }> = [];
    const transport: Transport = {
      postJson: async () => { throw new Error("unused"); },
      postStream: async () => { throw new Error("unused"); },
      postRaw: async (url, headers): Promise<TransportJsonResult> => {
        seen.push({ url, contentType: headers["content-type"] });
        return { status: 200, headers: {}, json: { text: " bonjour " }, text: '{"text":" bonjour "}' };
      },
    };
    const out = await transcribeAudio(
      { timeoutMs: 10_000, steps: [{ model: "m", provider: "p" }] },
      { data: AUDIO_B64, format: "wav" },
      { catalog, transport },
    );
    expect(out.result.ok).toBe(true);
    expect((out.result as { value: string }).value).toBe("bonjour");
    expect(seen[0].url).toContain("/audio/transcriptions");
    expect(seen[0].contentType).toContain("multipart/form-data");
  });

  it("rejects a step whose mapping enables no OpenAI endpoint, with a clear error", async () => {
    // What the constrained resolve reports for an Anthropic-only mapping: the
    // endpoint pool is empty rather than "the target happens to be Anthropic".
    const catalog = { resolveWithin: () => ({ ok: false, error: "no_endpoint_in_family" }) } as unknown as Catalog;
    const transport = { postJson: async () => { throw new Error(); }, postStream: async () => { throw new Error(); } } as unknown as Transport;
    const out = await transcribeAudio({ timeoutMs: 1000, steps: [{ model: "m", provider: "p" }] }, { data: AUDIO_B64, format: "wav" }, { catalog, transport });
    expect(out.result.ok).toBe(false);
    expect((out.result as { message: string }).message).toContain("OpenAI-compatible endpoint");
    // A config fault, not a network blip: retrying the same step cannot help.
    expect((out.result as { kind: string }).kind).toBe("error");
  });

  it("an unmapped pair still reports the mapping error, not the endpoint one", async () => {
    const catalog = { resolveWithin: () => ({ ok: false, error: "mapping_not_found" }) } as unknown as Catalog;
    const transport = { postJson: async () => { throw new Error(); }, postStream: async () => { throw new Error(); } } as unknown as Transport;
    const out = await transcribeAudio({ timeoutMs: 1000, steps: [{ model: "m", provider: "p" }] }, { data: AUDIO_B64, format: "wav" }, { catalog, transport });
    expect(out.result.ok).toBe(false);
    expect((out.result as { message: string }).message).toContain("mapping m@p: mapping_not_found");
  });
});
