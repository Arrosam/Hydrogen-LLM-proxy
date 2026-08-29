/**
 * The file pre-pass: a URL attachment inlined for an egress family that cannot
 * carry a URL (OpenAI Chat Completions).
 *
 * Hydrogen is a relay, so it imposes no size or content limits of its own -- the
 * provider is the one that knows what it accepts, and it is the one that errors.
 * What the proxy does own is its own egress: a URL out of a request body is
 * attacker-controlled, and this process can reach networks the client cannot, so
 * every hop (redirects included) goes through the SSRF guard.
 */
import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { AnthropicRequest, OpenAICompletionRequest, OpenAIResponsesRequest } from "../src/core/format";
import { inlineUrlFiles, needsUrlFileInlining } from "../src/execution/fileFetch";
import { ModelService } from "../src/execution/modelService";
import { SsrfGuard, UpstreamUrlError } from "../src/core/upstream/ssrf";
import type { Catalog } from "../src/catalog/catalog";
import type { ServiceSteps } from "../src/execution/definition";
import type { Transport, TransportStreamResult } from "../src/core/upstream/transport";

const PDF_URL = "https://files.example.com/report.pdf";
const PDF_BYTES = Buffer.from("%PDF-1.7 real bytes");

const withUrlDoc = (url = PDF_URL) =>
  AnthropicRequest.parse({
    model: "svc",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "summarize this" },
        { type: "document", source: { type: "url", url }, title: "report.pdf" },
      ],
    }],
  });

/** A transport whose GET is scripted per URL. Records every URL it was asked for
 * so redirect hops are visible. */
function fetchTransport(
  script: (url: string) => { status: number; headers?: Record<string, string>; body?: Buffer },
): Transport & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    async postJson() { throw new Error("unused"); },
    async postStream() { throw new Error("unused"); },
    async getStream(url: string): Promise<TransportStreamResult> {
      seen.push(url);
      const r = script(url);
      return {
        status: r.status,
        headers: { "content-type": "application/pdf", ...(r.headers ?? {}) },
        body: Readable.from([r.body ?? Buffer.alloc(0)]),
      };
    },
  };
}

const opts = { timeoutMs: 5_000 };

describe("when the pre-pass runs at all", () => {
  it("is skipped for families that carry a URL natively", () => {
    expect(needsUrlFileInlining(withUrlDoc(), "anthropic")).toBe(false);
    expect(needsUrlFileInlining(withUrlDoc(), "openai_responses")).toBe(false);
  });

  it("is needed for Chat Completions, which has no URL field", () => {
    expect(needsUrlFileInlining(withUrlDoc(), "openai_completion")).toBe(true);
  });

  it("is skipped when the request has no URL attachment", () => {
    const inline = AnthropicRequest.parse({
      model: "svc",
      messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "AAA" } }] }],
    });
    expect(needsUrlFileInlining(inline, "openai_completion")).toBe(false);
  });
});

describe("inlining", () => {
  it("downloads the file and renders real bytes into file_data", async () => {
    const transport = fetchTransport(() => ({ status: 200, body: PDF_BYTES }));
    const ready = await inlineUrlFiles(withUrlDoc(), "openai_completion", transport, opts);
    const body = OpenAICompletionRequest.construct(ready).render({ upstreamModel: "up" });
    const messages = JSON.stringify(body.messages);
    expect(messages).toContain(`data:application/pdf;base64,${PDF_BYTES.toString("base64")}`);
    // Specifically NOT the URL sitting in a field that means "the file's bytes".
    expect(messages).not.toContain(PDF_URL);
    expect(transport.seen).toEqual([PDF_URL]);
  });

  it("labels the bytes with the media type the server reported", async () => {
    const transport = fetchTransport(() => ({ status: 200, headers: { "content-type": "image/png; charset=binary" }, body: PDF_BYTES }));
    const ready = await inlineUrlFiles(withUrlDoc(), "openai_completion", transport, opts);
    const body = OpenAICompletionRequest.construct(ready).render({ upstreamModel: "up" });
    expect(JSON.stringify(body.messages)).toContain("data:image/png;base64,");
  });

  it("fetches each distinct URL once, however many messages reference it", async () => {
    const other = "https://files.example.com/second.pdf";
    const req = AnthropicRequest.parse({
      model: "svc",
      messages: [
        { role: "user", content: [{ type: "document", source: { type: "url", url: PDF_URL } }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [
          { type: "document", source: { type: "url", url: PDF_URL } },
          { type: "document", source: { type: "url", url: other } },
        ] },
      ],
    });
    const transport = fetchTransport(() => ({ status: 200, body: PDF_BYTES }));
    await inlineUrlFiles(req, "openai_completion", transport, opts);
    expect(transport.seen).toEqual([PDF_URL, other]);
  });

  it("leaves the request untouched for a URL-capable family", async () => {
    const transport = fetchTransport(() => ({ status: 200, body: PDF_BYTES }));
    const req = withUrlDoc();
    const ready = await inlineUrlFiles(req, "openai_responses", transport, opts);
    expect(ready).toBe(req);
    expect(transport.seen).toEqual([]);
    expect(JSON.stringify(OpenAIResponsesRequest.construct(ready).render({ upstreamModel: "up" }))).toContain(PDF_URL);
  });
});

describe("redirects", () => {
  it("follows a redirect and fetches the final URL", async () => {
    const finalUrl = "https://cdn.example.com/blob/123";
    const transport = fetchTransport((url) =>
      url === PDF_URL
        ? { status: 302, headers: { location: finalUrl } }
        : { status: 200, body: PDF_BYTES },
    );
    const ready = await inlineUrlFiles(withUrlDoc(), "openai_completion", transport, opts);
    const body = OpenAICompletionRequest.construct(ready).render({ upstreamModel: "up" });
    expect(JSON.stringify(body.messages)).toContain(PDF_BYTES.toString("base64"));
    // Both hops went through the transport, which is where the guard lives.
    expect(transport.seen).toEqual([PDF_URL, finalUrl]);
  });

  it("resolves a relative redirect against the current URL", async () => {
    const transport = fetchTransport((url) =>
      url === PDF_URL ? { status: 301, headers: { location: "/moved/report.pdf" } } : { status: 200, body: PDF_BYTES },
    );
    await inlineUrlFiles(withUrlDoc(), "openai_completion", transport, opts);
    expect(transport.seen[1]).toBe("https://files.example.com/moved/report.pdf");
  });

  it("gives up rather than looping forever", async () => {
    const transport = fetchTransport(() => ({ status: 302, headers: { location: "https://files.example.com/again" } }));
    await expect(inlineUrlFiles(withUrlDoc(), "openai_completion", transport, opts)).rejects.toThrow(/redirects/);
  });

  it("re-checks every hop against the SSRF guard", async () => {
    // The attack this closes: a public URL that 302s to cloud metadata. The
    // guard only ever sees the URL it is handed, so the hop has to be re-checked
    // rather than followed inside the HTTP client.
    const guard = new SsrfGuard({ allowPrivate: false, allowlist: () => [] });
    const metadata = "http://169.254.169.254/latest/meta-data/";
    const guarded: Transport = {
      async postJson() { throw new Error("unused"); },
      async postStream() { throw new Error("unused"); },
      async getStream(url: string): Promise<TransportStreamResult> {
        await guard.assertAllowed(url); // what UpstreamClient does on every call
        return {
          status: url === PDF_URL ? 302 : 200,
          headers: { "content-type": "application/pdf", ...(url === PDF_URL ? { location: metadata } : {}) },
          body: Readable.from([PDF_BYTES]),
        };
      },
    };
    await expect(inlineUrlFiles(withUrlDoc(), "openai_completion", guarded, opts)).rejects.toThrow(UpstreamUrlError);
  });
});

describe("failures", () => {
  it("reports the file server's status rather than inventing a document", async () => {
    const transport = fetchTransport(() => ({ status: 404 }));
    await expect(inlineUrlFiles(withUrlDoc(), "openai_completion", transport, opts)).rejects.toThrow(/returned 404/);
  });

  it("says so when the transport cannot fetch at all", async () => {
    const noGet: Transport = {
      async postJson() { throw new Error("unused"); },
      async postStream() { throw new Error("unused"); },
    };
    await expect(inlineUrlFiles(withUrlDoc(), "openai_completion", noGet, opts)).rejects.toThrow(/cannot fetch URLs/);
  });
});

describe("through a Model Service", () => {
  const catalogFor = (family: string): Catalog =>
    ({
      resolve: (model: string, provider: string) => ({
        ok: true,
        target: { family, upstreamModel: `up-${model}`, url: "http://upstream", headers: {}, modelName: model, providerName: provider, upstream: {} },
      }),
      exists: () => true,
    }) as unknown as Catalog;

  const sendingTransport = (sent: { body: unknown }): Transport & { seen: string[] } => {
    const seen: string[] = [];
    return {
      seen,
      async postStream() { throw new Error("unused"); },
      async postJson(_url, _headers, body) {
        sent.body = body;
        return {
          status: 200, headers: {},
          json: { choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: {} },
          text: "",
        };
      },
      async getStream(url: string): Promise<TransportStreamResult> {
        seen.push(url);
        return { status: 200, headers: { "content-type": "application/pdf" }, body: Readable.from([PDF_BYTES]) };
      },
    };
  };

  it("inlines before sending to a Chat Completions upstream", async () => {
    const sent: { body: unknown } = { body: null };
    const transport = sendingTransport(sent);
    const svc = new ModelService(
      { timeoutMs: 5_000, steps: [{ model: "m", provider: "p" }] } as ServiceSteps,
      { catalog: catalogFor("openai_completion"), transport },
    );
    const inv = await svc.invoke(withUrlDoc().withStream(false));
    expect(inv.result.ok).toBe(true);
    expect(transport.seen).toEqual([PDF_URL]);
    expect(JSON.stringify(sent.body)).toContain(PDF_BYTES.toString("base64"));
  });

  it("does not download at all when the step resolves to a URL-capable family", async () => {
    const sent: { body: unknown } = { body: null };
    const transport = sendingTransport(sent);
    const svc = new ModelService(
      { timeoutMs: 5_000, steps: [{ model: "m", provider: "p" }] } as ServiceSteps,
      { catalog: catalogFor("anthropic"), transport },
    );
    await svc.invoke(withUrlDoc().withStream(false));
    expect(transport.seen).toEqual([]);
    expect(JSON.stringify(sent.body)).toContain(PDF_URL);
  });
});
