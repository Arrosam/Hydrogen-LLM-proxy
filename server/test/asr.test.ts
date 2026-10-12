/**
 * ASR pre-pass: audio attachments transcribed to text before the stages run,
 * mirroring the OCR pre-pass for images.
 */
import { describe, expect, it } from "vitest";
import { audioHash, buildTranscriptionForm, safeAudioFormat, transcribeAudio } from "../src/execution/asr";
import { collectAudio, translateAudioInRequest } from "../src/execution/agentContext";
import { OpenAICompletionRequest } from "../src/core/format/completion";
import type { Catalog } from "../src/catalog/catalog";
import type { Transport, TransportJsonResult } from "../src/core/upstream/transport";

const AUDIO_B64 = Buffer.from("RIFFxxxxWAVE").toString("base64");

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

describe("audio format hint", () => {
  it("normalizes a short alphanumeric token and falls back to wav otherwise", () => {
    expect(safeAudioFormat("MP3")).toBe("mp3");
    expect(safeAudioFormat("a".repeat(12))).toBe("a".repeat(12));
    for (const raw of ["mp3; x", "", "a".repeat(13)]) expect(safeAudioFormat(raw)).toBe("wav");
  });

  it("never frames a hostile format into the multipart headers", () => {
    const raw = buildTranscriptionForm("whisper-1", { data: AUDIO_B64, format: "../x" }).body.toString("latin1");
    expect(raw).toContain('filename="audio.wav"');
    expect(raw).toContain("Content-Type: audio/wav");
  });
});

describe("transcription transport outcomes", () => {
  const catalog = {
    resolveWithin: () => ({
      ok: true,
      target: {
        family: "openai_completion", upstreamModel: "whisper-1", endpointIndex: 0,
        upstream: { type: "openai_completion", baseUrl: "http://u.test/v1", apiKey: "k", extraHeaders: null },
      },
    }),
  } as unknown as Catalog;
  const def = { timeoutMs: 10_000, steps: [{ model: "m", provider: "p" }] };
  const audio = { data: AUDIO_B64, format: "wav" };
  /** A transport that answers each upload with the next scripted response. */
  const scripted = (responses: Array<Partial<TransportJsonResult>>): Transport & { calls: number } => {
    const transport: Transport & { calls: number } = {
      calls: 0,
      postJson: async () => { throw new Error("unused"); },
      postStream: async () => { throw new Error("unused"); },
      postRaw: async (): Promise<TransportJsonResult> => ({ status: 200, headers: {}, json: undefined, text: "", ...responses[transport.calls++] }),
    };
    return transport;
  };

  it("retries a 503 under the default retry rules and returns the transcript", async () => {
    const transport = scripted([{ status: 503, json: { error: { message: "busy" } } }, { status: 200, json: { text: "second try" } }]);
    const out = await transcribeAudio(def, audio, { catalog, transport });
    expect(out.result).toEqual({ ok: true, value: "second try" });
    expect(transport.calls).toBe(2);
    expect(out.path.map((a) => a.status)).toEqual([503, 200]);
  });

  it("reports a 400 with the upstream's own message, without retrying", async () => {
    const transport = scripted([{ status: 400, json: { error: { message: "unsupported audio" } } }]);
    const out = await transcribeAudio(def, audio, { catalog, transport });
    expect(out.result).toMatchObject({ ok: false, status: 400, kind: "http", message: "unsupported audio" });
    expect(transport.calls).toBe(1);
  });

  it("uses the raw body as the transcript when the response is not JSON", async () => {
    const out = await transcribeAudio(def, audio, { catalog, transport: scripted([{ status: 200, json: undefined, text: " hello " }]) });
    expect(out.result).toEqual({ ok: true, value: "hello" });
  });

  it("fails clearly on a transport that cannot upload multipart bodies", async () => {
    const transport: Transport = { postJson: async () => { throw new Error("unused"); }, postStream: async () => { throw new Error("unused"); } };
    const out = await transcribeAudio(def, audio, { catalog, transport });
    expect(out.result).toMatchObject({ ok: false, status: 0, kind: "error" });
    expect((out.result as { message: string }).message).toContain("does not support multipart uploads");
  });
});
