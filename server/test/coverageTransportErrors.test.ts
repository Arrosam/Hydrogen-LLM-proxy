/**
 * The error a client is shown: its `type`, its envelope, its SSE framing, and
 * which message is chosen for it.
 *
 * Every failure path in the proxy ends in one of these builders, and SDKs
 * branch on `error.type` (retry on rate_limit_error / overloaded_error, give up
 * on authentication_error), so the status -> type table is client-visible
 * behaviour, not presentation.
 */
import { describe, expect, it } from "vitest";
import { buildErrorBody, buildErrorFrame, extractUpstreamMessage, failureMessage, pingFrame } from "../src/core/proxy/errors";
import type { AttemptFailure } from "../src/execution/steps";

describe("EP/BVA: OpenAI-family error type by status", () => {
  it.each([
    [401, "authentication_error"],
    [403, "authentication_error"],
    [429, "rate_limit_error"],
    [500, "server_error"], // lower bound of the 5xx class
    [503, "server_error"],
    [599, "server_error"],
    [400, "invalid_request_error"], // lower bound of the 4xx class
    [404, "invalid_request_error"],
    [499, "invalid_request_error"], // upper bound of the 4xx class
    [399, "api_error"], // just below it
    [200, "api_error"],
  ])("%d -> %s", (status, type) => {
    for (const family of ["openai_completion", "openai_responses"] as const) {
      expect(buildErrorBody(family, status, "m")).toEqual({ error: { message: "m", type, code: null, param: null } });
    }
  });
});

describe("EP/BVA: Anthropic error type by status", () => {
  it.each([
    [400, "invalid_request_error"],
    [401, "authentication_error"],
    [403, "permission_error"],
    [404, "not_found_error"],
    [429, "rate_limit_error"],
    [529, "overloaded_error"],
    [500, "api_error"], // lower bound of the 5xx class
    [502, "api_error"],
    [528, "api_error"], // neighbours of the one special 5xx
    [530, "api_error"],
    [499, "invalid_request_error"], // upper bound of "everything else below 500"
    [418, "invalid_request_error"],
    [399, "invalid_request_error"],
  ])("%d -> %s", (status, type) => {
    expect(buildErrorBody("anthropic", status, "m")).toEqual({ type: "error", error: { type, message: "m" } });
  });
});

describe("the same error as an in-stream frame", () => {
  it("OpenAI chat completions: a bare data frame carrying the error body", () => {
    const frame = buildErrorFrame("openai_completion", 503, "upstream down");
    expect(frame).toBe(`data: ${JSON.stringify(buildErrorBody("openai_completion", 503, "upstream down"))}\n\n`);
    expect(frame).not.toContain("[DONE]");
  });

  it.each(["anthropic", "openai_responses"] as const)("%s: a named `error` event", (family) => {
    const frame = buildErrorFrame(family, 503, "upstream down");
    expect(frame).toBe(`event: error\ndata: ${JSON.stringify(buildErrorBody(family, 503, "upstream down"))}\n\n`);
  });

  it("a message with newlines still fits on one data line", () => {
    const frame = buildErrorFrame("openai_completion", 500, "line one\nline two");
    expect(frame.endsWith("\n\n")).toBe(true);
    expect(frame.slice(0, -2)).not.toContain("\n");
    expect((JSON.parse(frame.slice("data: ".length)) as { error: { message: string } }).error.message).toBe("line one\nline two");
  });
});

describe("keep-alive frames", () => {
  it("Anthropic gets its protocol's ping event", () => {
    expect(pingFrame("anthropic")).toBe('event: ping\ndata: {"type":"ping"}\n\n');
  });

  it.each(["openai_completion", "openai_responses"] as const)("%s gets an SSE comment", (family) => {
    expect(pingFrame(family)).toBe(": ping\n\n");
  });
});

describe("EP: which message the client is shown for a failure", () => {
  const failure = (errorBody: unknown): AttemptFailure =>
    ({ ok: false, status: 500, kind: "http", message: "upstream returned 500", errorBody });

  it.each([
    ["an OpenAI-style error object", { error: { message: "a" } }, "a"],
    ["a string error", { error: "b" }, "b"],
    ["a top-level message", { message: "c" }, "c"],
    ["error.message wins over a top-level message", { error: { message: "inner" }, message: "outer" }, "inner"],
    ["a plain-text body", "plain text", "plain text"],
  ])("%s -> the upstream's own words", (_what, body, expected) => {
    expect(failureMessage(failure(body))).toBe(expected);
    expect(extractUpstreamMessage(body)).toBe(expected);
  });

  it("a long plain-text body is cut to its first 500 characters", () => {
    const long = "x".repeat(499) + "YZ" + "z".repeat(99);
    expect(failureMessage(failure(long))).toBe("x".repeat(499) + "Y");
    expect(failureMessage(failure("x".repeat(500)))).toHaveLength(500);
  });

  it("a structured message is not cut", () => {
    const long = "m".repeat(600);
    expect(failureMessage(failure({ error: { message: long } }))).toBe(long);
  });

  it.each([
    ["an empty string", ""],
    ["undefined", undefined],
    ["null", null],
    ["an empty object", {}],
    ["an error object without a message", { error: { code: 1 } }],
    ["a non-string message", { error: { message: 5 }, message: 7 }],
    ["an array", ["x"]],
    ["a number", 42],
  ])("%s -> falls back to the transport message", (_what, body) => {
    expect(extractUpstreamMessage(body)).toBeNull();
    expect(failureMessage(failure(body))).toBe("upstream returned 500");
  });
});
