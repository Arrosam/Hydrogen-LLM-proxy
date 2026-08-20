/**
 * ASR pre-pass: audio attachments transcribed to text before the stages run,
 * mirroring the OCR pre-pass for images.
 */
import { describe, expect, it } from "vitest";
import { audioHash, buildTranscriptionForm, transcribeAudio } from "../src/execution/asr";
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
      resolve: () => ({
        ok: true,
        target: {
          family: "openai_completion", upstreamModel: "whisper-1",
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

  it("rejects an Anthropic-family step with a clear error", async () => {
    const catalog = { resolve: () => ({ ok: true, target: { family: "anthropic", upstream: {} } }) } as unknown as Catalog;
    const transport = { postJson: async () => { throw new Error(); }, postStream: async () => { throw new Error(); } } as unknown as Transport;
    const out = await transcribeAudio({ timeoutMs: 1000, steps: [{ model: "m", provider: "p" }] }, { data: AUDIO_B64, format: "wav" }, { catalog, transport });
    expect(out.result.ok).toBe(false);
    expect((out.result as { message: string }).message).toContain("OpenAI-compatible");
  });
});
