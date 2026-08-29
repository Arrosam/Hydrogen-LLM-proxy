/**
 * File attachments across the wire families.
 *
 * The three formats reach a file in different ways -- inline base64, a remote
 * URL, or a `file_id` into the issuing API's own storage -- and not every shape
 * survives every hop. What must never happen is a lossy translation that looks
 * successful: a URL written into a field that means "the file's bytes", or a
 * file reference quietly deleted from the request.
 */
import { describe, expect, it } from "vitest";
import { AnthropicRequest, OpenAICompletionRequest, OpenAIResponsesRequest } from "../src/core/format";
import { FormatConversionError } from "../src/core/format/errors";
import { ModelService } from "../src/execution/modelService";
import { classifyError } from "../src/execution/steps";
import type { ServiceSteps } from "../src/execution/definition";
import type { Catalog } from "../src/catalog/catalog";
import type { Transport } from "../src/core/upstream/transport";

const PDF_B64 = Buffer.from("%PDF-1.7 fake").toString("base64");
const PDF_URL = "https://example.com/report.pdf";

const target = { upstreamModel: "up" };

/** An Anthropic request carrying one document block. */
const anthropicWithDoc = (source: Record<string, unknown>) =>
  AnthropicRequest.parse({
    model: "svc",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "summarize this" },
        { type: "document", source, title: "report.pdf" },
      ],
    }],
  });

describe("base64 documents convert everywhere", () => {
  it("Anthropic base64 PDF -> Chat Completions file_data", () => {
    const req = anthropicWithDoc({ type: "base64", media_type: "application/pdf", data: PDF_B64 });
    const body = OpenAICompletionRequest.construct(req).render(target);
    const part = JSON.stringify(body.messages);
    expect(part).toContain('"type":"file"');
    expect(part).toContain(`data:application/pdf;base64,${PDF_B64}`);
    expect(part).toContain('"filename":"report.pdf"');
  });

  it("Anthropic base64 PDF -> Responses file_data", () => {
    const req = anthropicWithDoc({ type: "base64", media_type: "application/pdf", data: PDF_B64 });
    const body = OpenAIResponsesRequest.construct(req).render(target);
    expect(JSON.stringify(body.input)).toContain(`data:application/pdf;base64,${PDF_B64}`);
  });
});

describe("URL documents", () => {
  it("Anthropic URL document -> Responses file_url", () => {
    const req = anthropicWithDoc({ type: "url", url: PDF_URL });
    const body = OpenAIResponsesRequest.construct(req).render(target);
    const input = JSON.stringify(body.input);
    expect(input).toContain(`"file_url":"${PDF_URL}"`);
    expect(input).not.toContain("file_data");
  });

  it("Anthropic URL document -> Anthropic URL document (unchanged)", () => {
    const req = anthropicWithDoc({ type: "url", url: PDF_URL });
    const body = AnthropicRequest.construct(req).render(target);
    expect(JSON.stringify(body.messages)).toContain(`"type":"url","url":"${PDF_URL}"`);
  });

  it("Anthropic URL document -> Chat Completions is refused, never smuggled into file_data", () => {
    const req = anthropicWithDoc({ type: "url", url: PDF_URL });
    let thrown: unknown;
    try {
      OpenAICompletionRequest.construct(req).render(target);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(FormatConversionError);
    expect((thrown as Error).message).toContain(PDF_URL);
    expect((thrown as Error).message).toMatch(/carries files inline \(file_data\) or by file_id/);
  });
});

describe("file_id references", () => {
  it("Responses file_id round-trips within its own family", () => {
    const req = OpenAIResponsesRequest.parse({
      model: "svc",
      input: [{ role: "user", content: [{ type: "input_file", file_id: "file-abc123", filename: "r.pdf" }] }],
    });
    const body = OpenAIResponsesRequest.construct(req).render(target);
    const input = JSON.stringify(body.input);
    expect(input).toContain('"file_id":"file-abc123"');
    expect(input).toContain('"filename":"r.pdf"');
  });

  it("Chat Completions file_id round-trips within its own family", () => {
    const req = OpenAICompletionRequest.parse({
      model: "svc",
      messages: [{ role: "user", content: [{ type: "file", file: { file_id: "file-xyz789", filename: "r.pdf" } }] }],
    });
    const body = OpenAICompletionRequest.construct(req).render(target);
    expect(JSON.stringify(body.messages)).toContain('"file_id":"file-xyz789"');
  });

  it("a Responses file_id is refused by Chat Completions rather than dropped", () => {
    const req = OpenAIResponsesRequest.parse({
      model: "svc",
      input: [{ role: "user", content: [{ type: "input_file", file_id: "file-abc123" }] }],
    });
    expect(() => OpenAICompletionRequest.construct(req).render(target)).toThrowError(FormatConversionError);
    expect(() => OpenAICompletionRequest.construct(req).render(target)).toThrowError(/only resolves in the API that issued it/);
  });

  it("a Chat Completions file_id is refused by Responses rather than dropped", () => {
    const req = OpenAICompletionRequest.parse({
      model: "svc",
      messages: [{ role: "user", content: [{ type: "file", file: { file_id: "file-xyz789" } }] }],
    });
    expect(() => OpenAIResponsesRequest.construct(req).render(target)).toThrowError(/openai_completion file_id/);
  });

  it("an Anthropic Files API id round-trips within its own family", () => {
    const req = AnthropicRequest.parse({
      model: "svc",
      messages: [{
        role: "user",
        content: [{ type: "document", source: { type: "file", file_id: "file_011anthropic" }, title: "r.pdf" }],
      }],
    });
    const body = AnthropicRequest.construct(req).render(target);
    expect(JSON.stringify(body.messages)).toContain('"type":"file","file_id":"file_011anthropic"');
  });

  it("an Anthropic Files API id is refused by the OpenAI families rather than dropped", () => {
    const req = AnthropicRequest.parse({
      model: "svc",
      messages: [{ role: "user", content: [{ type: "document", source: { type: "file", file_id: "file_011anthropic" } }] }],
    });
    expect(() => OpenAICompletionRequest.construct(req).render(target)).toThrowError(/anthropic file_id/);
    expect(() => OpenAIResponsesRequest.construct(req).render(target)).toThrowError(/anthropic file_id/);
  });

  it("a foreign file_id is refused by Anthropic rather than dropped", () => {
    const req = OpenAIResponsesRequest.parse({
      model: "svc",
      input: [{ role: "user", content: [{ type: "input_file", file_id: "file-abc123" }] }],
    });
    expect(() => AnthropicRequest.construct(req).render(target)).toThrowError(/to an Anthropic provider/);
  });

  it("a file_id never silently disappears from a rendered body", () => {
    // The failure mode this replaces: the attachment vanishing and the model
    // answering confidently about a document it was never given.
    const req = OpenAIResponsesRequest.parse({
      model: "svc",
      input: [{ role: "user", content: [{ type: "input_text", text: "summarize" }, { type: "input_file", file_id: "file-abc123" }] }],
    });
    let body: Record<string, unknown> | null = null;
    try {
      body = OpenAICompletionRequest.construct(req).render(target);
    } catch {
      body = null;
    }
    expect(body).toBeNull(); // refused outright...
    // ...rather than a body that kept the prompt and lost the file.
    const same = OpenAIResponsesRequest.construct(req).render(target);
    expect(JSON.stringify(same.input)).toContain("file-abc123");
  });
});

describe("an unrepresentable file is a fault, not a network blip", () => {
  const conversionCatalog = (family: string): Catalog =>
    ({
      resolve: (model: string, provider: string) => ({
        ok: true,
        target: { family, upstreamModel: `up-${model}`, url: "http://upstream", headers: {}, modelName: model, providerName: provider, upstream: {} },
      }),
      exists: () => true,
    }) as unknown as Catalog;

  /** Counts sends so a retry would be visible. */
  const countingTransport = (sends: { n: number }): Transport => ({
    async postStream() {
      sends.n++;
      return { status: 200, headers: {}, body: null as never };
    },
    async postJson() {
      sends.n++;
      return { status: 200, headers: {}, json: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }, text: "" };
    },
  });

  it("classifies the render failure as a config error, not a network failure", () => {
    const c = classifyError(new FormatConversionError("nope"));
    expect(c.kind).toBe("error");
    // "network" is the default for anything thrown out of a send, and it IS in
    // the default retry set -- exactly the misclassification being prevented.
    expect(c.kind).not.toBe("network");
  });

  /** A foreign file_id, unlike a URL, is beyond any pre-pass: the bytes live in
   * another provider's storage, so the renderer is the last word on it. */
  const foreignFileIdRequest = () =>
    OpenAIResponsesRequest.parse({
      model: "svc",
      input: [{ role: "user", content: [{ type: "input_text", text: "summarize" }, { type: "input_file", file_id: "file-abc123" }] }],
    }).withStream(false);

  it("does not retry the same step, since the render can only fail identically", async () => {
    const sends = { n: 0 };
    const svc = new ModelService(
      { timeoutMs: 1000, steps: [{ model: "m", provider: "p", retry: { on: ["network", "timeout", 502], maxAttempts: 3, intervalMs: 0, idempotency: "safe_write" } }] } as ServiceSteps,
      { catalog: conversionCatalog("openai_completion"), transport: countingTransport(sends) },
    );
    const inv = await svc.invoke(foreignFileIdRequest());
    expect(inv.result.ok).toBe(false);
    expect(inv.attempts).toBe(1); // one attempt, no retry
    expect(sends.n).toBe(0); // it never reached the wire
    expect((inv.result as { kind: string }).kind).toBe("error");
    expect((inv.result as { message: string }).message).toContain("file_id");
  });

  it("still advances to a later step whose family CAN express the file", async () => {
    const sends = { n: 0 };
    // Step 1 resolves to Chat Completions (cannot express a Responses file_id);
    // step 2 to Responses, whose own storage the id belongs to. The chain must
    // fall through to the family that can actually express the reference.
    let call = 0;
    const catalog = {
      resolve: (model: string, provider: string) => {
        const family = call++ === 0 ? "openai_completion" : "openai_responses";
        return {
          ok: true,
          target: { family, upstreamModel: `up-${model}`, url: "http://upstream", headers: {}, modelName: model, providerName: provider, upstream: {} },
        };
      },
      exists: () => true,
    } as unknown as Catalog;

    const svc = new ModelService(
      { timeoutMs: 1000, steps: [{ model: "m", provider: "chat" }, { model: "m", provider: "responses" }] } as ServiceSteps,
      {
        catalog,
        transport: {
          async postStream() {
            sends.n++;
            return { status: 200, headers: {}, body: null as never };
          },
          async postJson() {
            sends.n++;
            return {
              status: 200, headers: {},
              json: { id: "r", model: "up", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }], usage: {} },
              text: "",
            };
          },
        },
      },
    );
    const inv = await svc.invoke(foreignFileIdRequest());
    expect(inv.result.ok).toBe(true);
    expect(sends.n).toBe(1); // only the second step actually sent
  });
});
