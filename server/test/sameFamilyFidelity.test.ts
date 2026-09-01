/**
 * Same-family fidelity: a request that goes out on the wire format it came in on
 * must reach the provider as the client wrote it.
 *
 * There is no pass-through shortcut in the pipeline -- `modelService` always
 * calls `buildRequest(target.family, request.data())`, so even anthropic ->
 * anthropic is a parse into the canonical IR and a render back out. That is not
 * optional: a fallback chain can cross families between steps, step overrides
 * patch params, the model name is rewritten, and max_tokens is capped against
 * the provider. All of it needs the IR.
 *
 * What the round trip owes the caller, then, is two properties, and this file
 * pins both:
 *
 *  - LOSSLESS. A key the IR has no opinion about survives verbatim, via the
 *    family-scoped client passthrough (`collectPassthrough` / `applyNonCanonical`).
 *  - ADDITIVE-FREE. The renderer emits no field the caller never set. The one
 *    exception is Anthropic's `max_tokens`, which that API requires.
 *
 * The second property is what `thinking: {"type":"disabled"}` used to violate on
 * every Anthropic request -- see the note in AnthropicRequest.render.
 */
import { describe, expect, it } from "vitest";
import { AnthropicRequest, OpenAICompletionRequest, OpenAIResponsesRequest } from "../src/core/format";

const target = (upstreamModel: string) => ({ upstreamModel });

const COMPLETION_BODY = { model: "svc", messages: [{ role: "user", content: "hi" }] };
const ANTHROPIC_BODY = { model: "svc", max_tokens: 1024, messages: [{ role: "user", content: "hi" }] };
const RESPONSES_BODY = { model: "svc", input: "hi" };

/** A knob no format models: nested, so a shallow copy that stringifies or
 * flattens it would show up as a mismatch rather than passing by accident. */
const VENDOR = { enable_secret_mode: true, tuning: { alpha: 0.25, tags: ["a", "b"] } };

describe("lossless: an unmodeled key survives its own family", () => {
  it("OpenAI Chat Completions", () => {
    const body = OpenAICompletionRequest.construct(
      OpenAICompletionRequest.parse({ ...COMPLETION_BODY, vendor_knob: VENDOR }),
    ).render(target("m"));
    expect(body.vendor_knob).toEqual(VENDOR);
  });

  it("Anthropic", () => {
    const body = AnthropicRequest.construct(
      AnthropicRequest.parse({ ...ANTHROPIC_BODY, vendor_knob: VENDOR }),
    ).render(target("m"));
    expect(body.vendor_knob).toEqual(VENDOR);
  });

  it("OpenAI Responses", () => {
    const body = OpenAIResponsesRequest.construct(
      OpenAIResponsesRequest.parse({ ...RESPONSES_BODY, vendor_knob: VENDOR }),
    ).render(target("m"));
    expect(body.vendor_knob).toEqual(VENDOR);
  });
});

describe("scoped: an unmodeled key does not leak onto another family", () => {
  // The client wrote it for one wire format. Replaying an OpenAI-only knob onto
  // an Anthropic body does not help the caller -- it gets the request rejected.
  it("Chat Completions knob does not reach an Anthropic egress", () => {
    const req = OpenAICompletionRequest.parse({ ...COMPLETION_BODY, vendor_knob: VENDOR });
    expect(AnthropicRequest.construct(req).render(target("m")).vendor_knob).toBeUndefined();
  });

  it("Anthropic knob does not reach a Chat Completions egress", () => {
    const req = AnthropicRequest.parse({ ...ANTHROPIC_BODY, vendor_knob: VENDOR });
    expect(OpenAICompletionRequest.construct(req).render(target("m")).vendor_knob).toBeUndefined();
  });

  it("but it is still there when the egress is its own family again", () => {
    // A chain that steps openai -> anthropic -> openai must not lose the knob on
    // the way through: passthrough is scoped at render time, not stripped at parse.
    const req = OpenAICompletionRequest.parse({ ...COMPLETION_BODY, vendor_knob: VENDOR });
    expect(AnthropicRequest.construct(req).render(target("m")).vendor_knob).toBeUndefined();
    expect(OpenAICompletionRequest.construct(req).render(target("m")).vendor_knob).toEqual(VENDOR);
  });
});

describe("precedence: a renderer decision beats a leftover client key", () => {
  it("an override's extra wins over the client's own passthrough", () => {
    const req = OpenAICompletionRequest.parse({ ...COMPLETION_BODY, vendor_knob: "from-client" });
    const body = OpenAICompletionRequest.construct(req.withOverrides({ extra: { vendor_knob: "from-step" } })).render(target("m"));
    expect(body.vendor_knob).toBe("from-step");
  });
});

describe("additive-free: nothing the caller never set is invented", () => {
  // Rendered keys are compared against what a bare request is allowed to carry.
  // A new unconditional `out.x = ...` in any renderer fails here, which is the
  // point: that is how the pinned `thinking` disable got onto every Anthropic
  // request without anyone noticing.
  it("Anthropic emits only model, messages and the required max_tokens", () => {
    const body = AnthropicRequest.construct(AnthropicRequest.parse(ANTHROPIC_BODY)).render(target("m"));
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model"]);
  });

  it("Chat Completions emits only model and messages", () => {
    const body = OpenAICompletionRequest.construct(OpenAICompletionRequest.parse(COMPLETION_BODY)).render(target("m"));
    expect(Object.keys(body).sort()).toEqual(["messages", "model"]);
  });

  it("Responses emits only model, input and its stateless store flag", () => {
    const body = OpenAIResponsesRequest.construct(OpenAIResponsesRequest.parse(RESPONSES_BODY)).render(target("m"));
    expect(Object.keys(body).sort()).toEqual(["input", "model", "store"]);
  });
});
