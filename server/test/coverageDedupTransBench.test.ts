/**
 * Characterization of the admin bench's wire details that test/modelBench does
 * not pin: the exact key ORDER of each report (the trailing `event: bench`
 * frame of a streamed run, and the in-body report of a buffered or media run),
 * the streamed run's own response headers, and the two wordings of the
 * missing-endpoint message (the buffered run adds advice the streamed one
 * omits).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeUpstream, type FakeUpstream, type UpstreamBehavior } from "./fixtures/fakeUpstream";
import { startAdminHarness, type AdminHarness } from "./coverageAdminHarness";

let h: AdminHarness;
let upstream: FakeUpstream;
const script: UpstreamBehavior[] = [];
const ids: Record<string, number> = {};

const STEPS = { timeoutMs: 30_000, steps: [{ model: "m", provider: "fake" }] };

beforeAll(async () => {
  upstream = await startFakeUpstream({ text: "pong", script });
  h = await startAdminHarness("cov-dedup-bench", { ALLOW_PRIVATE_UPSTREAMS: "1" });
  const provider = h.c.providers.create({ name: "fake", type: "openai_completion", baseUrl: upstream.baseUrl, apiKey: "k" });
  const model = h.c.models.create({ name: "m" });
  h.c.mappings.create({ modelId: model.id, providerId: provider.id, upstreamModel: "up" });
  ids.svc = h.c.services.create({ name: "svc", definition: STEPS as never }).id;
  ids.embedder = h.c.services.create({ name: "embedder", definition: { ...STEPS, category: "embedding" } as never }).id;
}, 30_000);

afterAll(async () => {
  await h.close();
  await upstream.close();
});

/** Volatile values out, structure and order kept. */
const stable = (text: string): string =>
  text
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:PORT")
    .replace(/"latencyMs":\d+/g, '"latencyMs":N')
    .replace(/"created":\d+/g, '"created":N')
    .replace(/chatcmpl-[A-Za-z0-9_-]+/g, "chatcmpl-ID");

const RAW = { kind: "raw", model: "m", provider: "fake", providerFormat: "openai_completion" };
const chat = (target: unknown, stream: boolean) =>
  h.admin({ method: "POST", url: "/bench/chat", payload: { target, ingress: "openai_completion", body: { model: "x", stream, messages: [{ role: "user", content: "hi" }] } } });
const benchFrame = (body: string): string => stable(body.slice(body.lastIndexOf("event: bench")));
/** Script the upstream's next attempt(s): the fixture indexes its script by attempt number. */
const next = (...behaviors: UpstreamBehavior[]): void => {
  behaviors.forEach((behavior, i) => { script[upstream.requests + i] = behavior; });
};

describe("streamed chat run", () => {
  it("answers with the bench's own SSE header set", async () => {
    const res = await chat(RAW, true);
    expect(res.statusCode).toBe(200);
    expect({
      "content-type": res.headers["content-type"],
      "cache-control": res.headers["cache-control"],
      connection: res.headers.connection,
      "x-accel-buffering": res.headers["x-accel-buffering"],
    }).toMatchSnapshot();
  });

  it("raw tuple: the whole stream, client frames then the bench frame", async () => {
    expect(stable((await chat(RAW, true)).body)).toMatchSnapshot();
  });

  it("saved service: the bench frame", async () => {
    expect(benchFrame((await chat({ kind: "service", serviceId: ids.svc }, true)).body)).toMatchSnapshot();
  });

  it("saved service whose upstream refuses", async () => {
    next({ kind: "status", status: 400, body: { error: { message: "bad thing" } } });
    expect(stable((await chat({ kind: "service", serviceId: ids.svc }, true)).body)).toMatchSnapshot();
  });

  it("raw tuple whose upstream refuses", async () => {
    next({ kind: "status", status: 400, body: { error: { message: "bad thing" } } });
    expect(stable((await chat(RAW, true)).body)).toMatchSnapshot();
  });

  it("raw tuple whose connection dies", async () => {
    next({ kind: "hangup" });
    expect(stable((await chat(RAW, true)).body)).toMatchSnapshot();
  });

  it("raw tuple with no such endpoint, and with no such mapping", async () => {
    expect(stable((await chat({ ...RAW, providerFormat: "anthropic" }, true)).body)).toMatchSnapshot("no endpoint");
    expect(stable((await chat({ ...RAW, model: "ghost" }, true)).body)).toMatchSnapshot("no mapping");
  });
});

describe("buffered chat run", () => {
  it("raw tuple", async () => {
    expect(stable((await chat(RAW, false)).body)).toMatchSnapshot();
  });
  it("saved service", async () => {
    expect(stable((await chat({ kind: "service", serviceId: ids.svc }, false)).body)).toMatchSnapshot();
  });
  it("raw tuple whose upstream refuses", async () => {
    next({ kind: "status", status: 400, body: { error: { message: "bad thing" } } });
    expect(stable((await chat(RAW, false)).body)).toMatchSnapshot();
  });
  it("saved service whose upstream refuses", async () => {
    next({ kind: "status", status: 400, body: { error: { message: "bad thing" } } });
    expect(stable((await chat({ kind: "service", serviceId: ids.svc }, false)).body)).toMatchSnapshot();
  });
  it("raw tuple with no such endpoint (with advice), and with no such mapping", async () => {
    expect(stable((await chat({ ...RAW, providerFormat: "anthropic" }, false)).body)).toMatchSnapshot("no endpoint");
    expect(stable((await chat({ ...RAW, model: "ghost" }, false)).body)).toMatchSnapshot("no mapping");
  });
});

describe("media run", () => {
  const media = (target: unknown, category: string, extra: Record<string, unknown> = {}) =>
    h.admin({ method: "POST", url: "/bench/media", payload: { target, category, body: { input: "hi" }, ...extra } });
  const FILE = { name: 'a"b.wav', mediaType: "audio/wav", data: Buffer.from("RIFF").toString("base64") };
  const refuse = (): void => next({ kind: "status", status: 400, body: { error: { message: "bad thing" } } });

  it("a refused JSON category, speech and transcription each report in their own key order", async () => {
    refuse();
    expect(stable((await media(RAW, "embedding")).body)).toMatchSnapshot("embedding");
    refuse();
    expect(stable((await media(RAW, "tts")).body)).toMatchSnapshot("tts");
    refuse();
    expect(stable((await media(RAW, "stt", { file: FILE })).body)).toMatchSnapshot("stt");
  });

  it("a raw tuple with no usable endpoint, and with no mapping", async () => {
    expect(stable((await media({ ...RAW, providerFormat: "openai_responses" }, "embedding")).body)).toMatchSnapshot("no endpoint");
    expect(stable((await media({ ...RAW, model: "ghost" }, "embedding")).body)).toMatchSnapshot("no mapping");
    expect(stable((await media({ kind: "raw", model: "m", provider: "fake", providerFormat: "anthropic" }, "rerank")).body)).toMatchSnapshot("anthropic format");
  });

  it("a saved service resolves through its first step", async () => {
    refuse();
    expect(stable((await media({ kind: "service", serviceId: ids.embedder }, "embedding")).body)).toMatchSnapshot();
  });

  it("a connection that dies", async () => {
    next({ kind: "hangup" });
    expect(stable((await media(RAW, "rerank")).body)).toMatchSnapshot();
  });
});
