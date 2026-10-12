/**
 * Micro Agent routing: which condition holds for a request, and which stage a
 * stage's transitions lead to.
 */
import { describe, expect, it } from "vitest";
import { OpenAICompletionRequest } from "../src/core/format";
import type { ContentPart } from "../src/core/ir/content";
import { conditionHolds, inputContext, nextStep, type InputCtx } from "../src/execution/agentContext";
import { AgentStageSchema, type AgentCondition, type AgentStage } from "../src/execution/definition";

const requestOf = (...content: ContentPart[]) =>
  new OpenAICompletionRequest({ requestedService: "svc", messages: [{ role: "user", content }], params: {}, stream: false });
const IMAGE: ContentPart = { type: "image", source: { kind: "url", url: "https://img.example.com/cat.png" } };

const textInput = (text: string): InputCtx => ({ text, hasImage: false });
const holds = (cond: AgentCondition, input: InputCtx, outputs: Record<string, string> = {}, current = "now"): boolean =>
  conditionHolds(cond, input, new Map(Object.entries(outputs)), current);

describe("routing conditions", () => {
  it("input_has_image follows the request's image parts", () => {
    const withImage = inputContext(requestOf({ type: "text", text: "look" }, IMAGE));
    const withoutImage = inputContext(requestOf({ type: "text", text: "look" }));
    expect(withImage).toEqual({ text: "look", hasImage: true });
    expect(withoutImage).toEqual({ text: "look", hasImage: false });
    expect(holds({ type: "input_has_image" }, withImage)).toBe(true);
    expect(holds({ type: "input_has_image" }, withoutImage)).toBe(false);
  });

  it("always holds", () => {
    expect(holds({ type: "always" }, textInput(""))).toBe(true);
  });

  it("input_contains is a case-sensitive substring test", () => {
    const cond: AgentCondition = { type: "input_contains", value: "refund" };
    expect(holds(cond, textInput("I want a refund please"))).toBe(true);
    expect(holds(cond, textInput("I want a Refund please"))).toBe(false);
  });

  it("input_matches tests the pattern as a regular expression", () => {
    const cond: AgentCondition = { type: "input_matches", value: "^\\d+$" };
    expect(holds(cond, textInput("123"))).toBe(true);
    expect(holds(cond, textInput("12a"))).toBe(false);
  });

  it("a pattern longer than 200 characters never matches", () => {
    const text = "a".repeat(300);
    expect(holds({ type: "input_matches", value: "a".repeat(200) }, textInput(text))).toBe(true);
    expect(holds({ type: "input_matches", value: "a".repeat(201) }, textInput(text))).toBe(false);
  });

  it("an invalid pattern never matches and does not throw", () => {
    expect(holds({ type: "input_matches", value: "(" }, textInput("("))).toBe(false);
    expect(holds({ type: "output_matches", value: "(" }, textInput(""), { now: "(" })).toBe(false);
  });

  it("only the first 10 000 characters of the text are matched", () => {
    const cond: AgentCondition = { type: "input_matches", value: "Z" };
    expect(holds(cond, textInput("a".repeat(9_999) + "Z"))).toBe(true);
    expect(holds(cond, textInput("a".repeat(10_000) + "Z"))).toBe(false);
    expect(holds({ type: "output_matches", value: "Z" }, textInput(""), { now: "a".repeat(10_000) + "Z" })).toBe(false);
  });

  it("output conditions read the current stage unless one is named", () => {
    const outputs = { now: "current says yes", a: "stage a says no" };
    expect(holds({ type: "output_contains", value: "yes" }, textInput(""), outputs)).toBe(true);
    expect(holds({ type: "output_contains", value: "yes", stage: "a" }, textInput(""), outputs)).toBe(false);
    expect(holds({ type: "output_contains", value: "no", stage: "a" }, textInput(""), outputs)).toBe(true);
    expect(holds({ type: "output_matches", value: "^stage a" , stage: "a" }, textInput(""), outputs)).toBe(true);
    expect(holds({ type: "output_matches", value: "^stage a" }, textInput(""), outputs)).toBe(false);
  });

  it("a stage with no output satisfies no output condition", () => {
    expect(holds({ type: "output_contains", value: "x", stage: "missing" }, textInput("x"))).toBe(false);
    expect(holds({ type: "output_matches", value: "x", stage: "missing" }, textInput("x"))).toBe(false);
  });
});

describe("stage transitions", () => {
  const byName = new Map([["a", 0], ["b", 1], ["c", 2], ["d", 3]]);
  const stage = (name: string, transitions?: unknown[]): AgentStage => AgentStageSchema.parse({ name, transitions });
  const next = (s: AgentStage, idx: number, text = "") => nextStep(s, idx, byName, textInput(text), new Map());

  it("falls through to the following stage when there are no transitions or none match", () => {
    expect(next(stage("b"), 1)).toEqual({ index: 2 });
    expect(next(stage("b", [{ when: { type: "input_contains", value: "skip" }, goto: "d" }]), 1, "nothing")).toEqual({ index: 2 });
  });

  it("takes the first matching transition", () => {
    const s = stage("a", [
      { when: { type: "input_contains", value: "absent" }, goto: "b" },
      { when: { type: "always" }, goto: "c" },
      { when: { type: "always" }, goto: "d" },
    ]);
    expect(next(s, 0)).toEqual({ index: 2 });
  });

  it("ends the run on goto end, naming the stage whose output to return", () => {
    expect(next(stage("b", [{ when: { type: "always" }, goto: "end", output: "a" }]), 1)).toEqual({ end: true, output: "a" });
    expect(next(stage("b", [{ when: { type: "always" }, goto: "end" }]), 1)).toEqual({ end: true, output: undefined });
  });

  it("ends the run rather than jumping backwards, to itself, or to an unknown stage", () => {
    for (const goto of ["a", "b", "nowhere"]) {
      expect(next(stage("b", [{ when: { type: "always" }, goto }]), 1)).toEqual({ end: true });
    }
  });
});
