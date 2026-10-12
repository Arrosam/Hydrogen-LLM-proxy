/**
 * E15: the minor findings S-4, S-7 and S-8 of the execution test audit.
 *  S-4  a video status poll is cancelled when the client goes away, like every
 *       other media call.
 *  S-7  a cyclic payload serializes for the log instead of overflowing the stack.
 *  S-8  the bench's multipart file part cannot carry CRLF in its Content-Type.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startAdminHarness, type AdminHarness } from "./coverageAdminHarness";
import { serializeForLog } from "../src/util/logPayload";

let h: AdminHarness;
let ids: { provider: number; video: number };

beforeAll(async () => {
  h = await startAdminHarness("fix-exec-minor", { ALLOW_PRIVATE_UPSTREAMS: "true" });
  const provider = h.c.providers.create({ name: "fake", type: "openai_completion", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k" });
  const model = h.c.models.create({ name: "m" });
  h.c.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "up" });
  const video = h.c.services.create({ name: "video-svc", definition: h.c.validator.validate({ category: "video", steps: [{ model: "m", provider: "fake" }] }).def });
  ids = { provider: provider.id, video: video.id };
});
afterAll(async () => {
  await h.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("S-4: video status poll", () => {
  it("passes a client-abort signal to the upstream call", async () => {
    const getJson = vi.spyOn(h.c.transport, "getJson").mockResolvedValue({ status: 200, headers: {}, json: { id: "video_abc", status: "completed" }, text: "" });
    const { secret } = h.c.tokens.create({ name: "poller" });
    const id = `video_abc-h${ids.video}x${ids.provider}e0`;
    const res = await h.app.inject({ method: "GET", url: `/v1/videos/${id}`, headers: { authorization: `Bearer ${secret}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id, status: "completed" });
    expect(getJson).toHaveBeenCalledTimes(1);
    expect(getJson.mock.calls[0][2]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("S-7: serializeForLog on a cyclic payload", () => {
  it("degrades the cycle to a marker and still redacts, bounded or not", () => {
    const payload: Record<string, unknown> = { model: "m", api_key: "sk-secret", shared: { n: 1 } };
    payload.again = payload.shared; // the same object twice is not a cycle
    payload.self = payload;
    (payload.shared as Record<string, unknown>).up = payload;
    for (const maxChars of [0, 10_000]) {
      const parsed = JSON.parse(serializeForLog(payload, maxChars)) as Record<string, unknown>;
      expect(parsed).toEqual({
        model: "m",
        api_key: "[redacted]",
        shared: { n: 1, up: "[circular]" },
        again: { n: 1, up: "[circular]" },
        self: "[circular]",
      });
    }
  });

  it("leaves an acyclic payload exactly as it was", () => {
    const value = { a: [{ b: 1 }, { b: 1 }], c: null };
    expect(serializeForLog(value, 0)).toBe(JSON.stringify(value, null, 2));
  });
});

describe("S-8: bench transcription form", () => {
  it("strips CR/LF from the file part's Content-Type", async () => {
    const postRaw = vi.spyOn(h.c.transport, "postRaw").mockResolvedValue({ status: 200, headers: {}, json: { text: "hello" }, text: "" });
    const res = await h.admin({
      method: "POST",
      url: "/bench/media",
      payload: {
        target: { kind: "raw", model: "m", provider: "fake", providerFormat: "openai_completion" },
        category: "stt",
        body: { language: "en" },
        file: { name: "a.wav", mediaType: "audio/wav\r\nX-Injected: 1\r\n\r\nforged", data: Buffer.from("RIFF").toString("base64") },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(postRaw).toHaveBeenCalledTimes(1);
    const form = (postRaw.mock.calls[0][2] as Buffer).toString("latin1");
    expect(form).not.toMatch(/\r\nX-Injected: 1/);
    expect(form).toContain('filename="a.wav"\r\nContent-Type: audio/wavX-Injected: 1forged\r\n\r\nRIFF');
  });
});
