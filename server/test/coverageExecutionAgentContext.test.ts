/**
 * Micro Agent context assembly: the messages a stage receives from its input
 * blocks, how OCR output is read back per image, and how OCR work is batched.
 */
import { describe, expect, it } from "vitest";
import { OpenAICompletionRequest } from "../src/core/format";
import type { ContentPart, ImagePart, Message, Tool, ToolChoice } from "../src/core/ir/content";
import { buildStageRequest, parseOcrResults } from "../src/execution/agentContext";
import { AgentStageSchema, type AgentStage } from "../src/execution/definition";
import { batchImages, OCR_IMAGES_PER_CALL } from "../src/execution/microAgent";

const text = (value: string): ContentPart => ({ type: "text", text: value });
const IMAGE: ImagePart = { type: "image", source: { kind: "url", url: "https://img.example.com/cat.png" } };

const requestOf = (messages: Message[], extra: { system?: string; tools?: Tool[]; toolChoice?: ToolChoice } = {}) =>
  new OpenAICompletionRequest({ requestedService: "svc", messages, params: {}, stream: false, ...extra });

const CONVERSATION: Message[] = [
  { role: "user", content: [text("first")] },
  { role: "assistant", content: [text("reply")] },
  { role: "user", content: [text("second"), IMAGE] },
];

const stageWith = (input: unknown[], extra: Record<string, unknown> = {}): AgentStage => AgentStageSchema.parse({ name: "s", input, ...extra });
const messagesFor = (messages: Message[], input: unknown[]): Message[] =>
  buildStageRequest(requestOf(messages), stageWith(input), new Map(), new Map(), false).messages;

describe("stage input blocks", () => {
  it("text_conversation drops images, and messages left with nothing", () => {
    const messages: Message[] = [
      { role: "user", content: [text("look"), IMAGE] },
      { role: "assistant", content: [text("ok")] },
      { role: "user", content: [IMAGE] },
    ];
    expect(messagesFor(messages, [{ kind: "text_conversation" }])).toEqual([
      { role: "user", content: [text("look")] },
      { role: "assistant", content: [text("ok")] },
    ]);
  });

  it("last_user is the final user message of a multi-turn request", () => {
    expect(messagesFor(CONVERSATION, [{ kind: "last_user" }])).toEqual([{ role: "user", content: [text("second"), IMAGE] }]);
  });

  it("last_user_text and last_user_images split one mixed message", () => {
    expect(messagesFor(CONVERSATION, [{ kind: "last_user_text" }])).toEqual([{ role: "user", content: [text("second")] }]);
    expect(messagesFor(CONVERSATION, [{ kind: "last_user_images" }])).toEqual([{ role: "user", content: [IMAGE] }]);
  });

  it("a message block with empty text is skipped", () => {
    expect(messagesFor(CONVERSATION, [{ kind: "message", text: "" }, { kind: "message", role: "assistant", text: "primed" }]))
      .toEqual([{ role: "assistant", content: [text("primed")] }]);
  });

  it("tool_turn yields an assistant call and its result under one id", () => {
    const [call, result] = messagesFor(CONVERSATION, [{ kind: "tool_turn", name: "lookup", input: '{"q":"x"}', result: "found", id: "call_1" }]);
    expect(call).toEqual({ role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } }] });
    expect(result).toEqual({ role: "user", content: [{ type: "tool_result", toolUseId: "call_1", content: [text("found")], isError: undefined }] });
  });

  it("tool_turn generates a shared id when none is given, and reads bad JSON input as {}", () => {
    const [call, result] = messagesFor(CONVERSATION, [{ kind: "tool_turn", name: "lookup", input: "{not json", result: "found", isError: true }]);
    const use = call.content[0], outcome = result.content[0];
    if (use.type !== "tool_use" || outcome.type !== "tool_result") throw new Error("expected a tool_use / tool_result pair");
    expect(use.input).toEqual({});
    expect(use.id).toBeTruthy();
    expect(outcome.toolUseId).toBe(use.id);
    expect(outcome.isError).toBe(true);
  });

  it("consecutive blocks of one role merge into a single message", () => {
    expect(messagesFor(CONVERSATION, [{ kind: "message", text: "one" }, { kind: "message", text: "two" }, { kind: "message", role: "assistant", text: "three" }]))
      .toEqual([{ role: "user", content: [text("one"), text("two")] }, { role: "assistant", content: [text("three")] }]);
  });

  it("falls back to the original user text when every block produces nothing", () => {
    const textOnly: Message[] = [{ role: "user", content: [text("first")] }, { role: "assistant", content: [text("reply")] }, { role: "user", content: [text("second")] }];
    expect(messagesFor(textOnly, [{ kind: "last_user_images" }, { kind: "stage_output", stage: "never-ran" }, { kind: "message", text: "" }]))
      .toEqual([{ role: "user", content: [text("first\nsecond")] }]);
  });
});

describe("stage tool policy", () => {
  const tools: Tool[] = [{ name: "get_weather", description: "Look up the weather", parameters: { type: "object", properties: {} } }];
  const REFERENCE = "# Tools the assistant had available";
  const build = (system: string | undefined, policy: "inherit" | "none" | undefined, withTools = true) =>
    buildStageRequest(
      requestOf(CONVERSATION, { system, ...(withTools ? { tools, toolChoice: { type: "required" } as ToolChoice } : {}) }),
      stageWith([], policy ? { tools: policy } : {}), new Map(), new Map(), false,
    );

  it("passes tools and tool choice through by default", () => {
    for (const policy of [undefined, "inherit"] as const) {
      const stageReq = build("Be brief.", policy);
      expect(stageReq.tools).toEqual(tools);
      expect(stageReq.toolChoice).toEqual({ type: "required" });
      expect(stageReq.system).toBe("Be brief.");
    }
  });

  it("none removes the tools and appends them to the system prompt as reference", () => {
    const stageReq = build("Be brief.", "none");
    expect(stageReq.tools).toBeUndefined();
    expect(stageReq.toolChoice).toBeUndefined();
    expect(stageReq.system?.startsWith(`Be brief.\n\n${REFERENCE}`)).toBe(true);
    expect(stageReq.system).toContain("## get_weather\nLook up the weather\nParameters (JSON Schema): {\"type\":\"object\",\"properties\":{}}");
  });

  it("none makes the tool reference the whole system prompt when there was none", () => {
    for (const system of [undefined, "   "]) expect(build(system, "none").system?.startsWith(REFERENCE)).toBe(true);
  });

  it("none leaves the system prompt alone when the request has no tools", () => {
    const stageReq = build("Be brief.", "none", false);
    expect(stageReq.system).toBe("Be brief.");
    expect(stageReq.tools).toBeUndefined();
  });
});

describe("reading OCR results back per image", () => {
  it("reads a plain array in order", () => {
    expect(parseOcrResults('[{"image":"a"},{"image":"b"}]', 2)).toEqual(["a", "b"]);
  });

  it("reads through a code fence or surrounding prose", () => {
    expect(parseOcrResults('```json\n[{"image":"a"},{"image":"b"}]\n```', 2)).toEqual(["a", "b"]);
    expect(parseOcrResults('```\n[{"image":"a"},{"image":"b"}]\n```', 2)).toEqual(["a", "b"]);
    expect(parseOcrResults('Here you go:\n[{"image":"a"},{"image":"b"}]\nDone.', 2)).toEqual(["a", "b"]);
  });

  it("places a result by its explicit 1-based index", () => {
    expect(parseOcrResults('[{"index":2,"image":"b"},{"index":1,"image":"a"}]', 2)).toEqual(["a", "b"]);
  });

  it("drops a result whose index is outside the batch", () => {
    expect(parseOcrResults('[{"index":5,"image":"x"},{"index":1,"image":"a"}]', 2)).toEqual(["a", ""]);
    expect(parseOcrResults('[{"index":0,"image":"x"},{"index":2,"image":"b"}]', 2)).toEqual(["", "b"]);
  });

  it("leaves images the model skipped empty", () => {
    expect(parseOcrResults('[{"image":"a"}]', 3)).toEqual(["a", "", ""]);
  });

  it("serializes a non-string image value", () => {
    expect(parseOcrResults('[{"image":{"text":"hi"}},{"image":null}]', 2)).toEqual(['{"text":"hi"}', ""]);
  });

  it("gives unparsable output, or an empty array, to the first image as raw text", () => {
    expect(parseOcrResults("  a cat on a mat  ", 2)).toEqual(["a cat on a mat", ""]);
    expect(parseOcrResults("[]", 2)).toEqual(["[]", ""]);
  });

  it("returns nothing for zero images", () => {
    expect(parseOcrResults('[{"image":"a"}]', 0)).toEqual([]);
    expect(parseOcrResults("free text", 0)).toEqual([]);
  });
});

describe("OCR batching", () => {
  const base64 = (chars: number) => ({ image: { type: "image", source: { kind: "base64", mediaType: "image/png", data: "A".repeat(chars) } } as ImagePart });
  const url = (address: string) => ({ image: { type: "image", source: { kind: "url", url: address } } as ImagePart });
  const sizes = (batches: unknown[][]) => batches.map((batch) => batch.length);

  it("sends up to 32 images in one call and starts a second at 33", () => {
    expect(OCR_IMAGES_PER_CALL).toBe(32);
    expect(sizes(batchImages(Array.from({ length: 32 }, () => base64(4))))).toEqual([32]);
    expect(sizes(batchImages(Array.from({ length: 33 }, () => base64(4))))).toEqual([32, 1]);
  });

  it("keeps images that exactly fill the byte budget together, and splits one byte over", () => {
    expect(sizes(batchImages([base64(6), base64(4)], 32, 10))).toEqual([2]);
    expect(sizes(batchImages([base64(6), base64(5)], 32, 10))).toEqual([1, 1]);
  });

  it("gives an oversized image its own batch instead of dropping it", () => {
    const items = [base64(2), base64(50), base64(2)];
    const batches = batchImages(items, 32, 10);
    expect(sizes(batches)).toEqual([1, 1, 1]);
    expect(batches.flat()).toEqual(items);
    expect(sizes(batchImages([base64(50)], 32, 10))).toEqual([1]);
  });

  it("returns no batches for no images", () => {
    expect(batchImages([])).toEqual([]);
  });

  it("sizes a URL image by the length of its URL", () => {
    const address = "https://img.example.com/a.png";
    expect(sizes(batchImages([url(address), url(address)], 32, address.length * 2))).toEqual([2]);
    expect(sizes(batchImages([url(address), url(address)], 32, address.length * 2 - 1))).toEqual([1, 1]);
  });
});
