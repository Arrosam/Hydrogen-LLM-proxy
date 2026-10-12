import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { callHttpTool, HttpToolSchema, renderToolBody, selectToolResult, type ToolCallContext } from "../src/execution/toolHttp";

const context: ToolCallContext = {
  arguments: { query: 'a "quoted" query', count: 2, filters: ["news"], enabled: false },
  tool: { name: "search" }, call: { id: "call_1" }, session: { id: "conv_1" },
};
const tool = () => HttpToolSchema.parse({ name: "search", parameters: { type: "object" }, url: "https://adapter.example/tools", bodyTemplate: { query: "{{arguments.query}}", id: "{{call.id}}" } });

describe("HTTP tool templates", () => {
  it("preserves JSON types and safely escapes string arguments", () => {
    expect(renderToolBody({ q: "{{arguments.query}}", n: "{{ arguments.count }}", filters: "{{arguments.filters}}", enabled: "{{arguments.enabled}}", label: "{{tool.name}}/{{session.id}}" }, context))
      .toEqual({ q: 'a "quoted" query', n: 2, filters: ["news"], enabled: false, label: "search/conv_1" });
  });
  it("copies the full arguments without aliasing model input", () => {
    const result = renderToolBody({ params: "{{arguments}}" }, context);
    expect(result.params).toEqual(context.arguments);
    expect(result.params).not.toBe(context.arguments);
  });
  it("rejects missing/inherited values and expressions", () => {
    for (const variable of ["arguments.missing", "arguments.constructor", "arguments.count + 1", "env.API_KEY"]) {
      expect(() => renderToolBody({ value: `{{${variable}}}` }, context)).toThrow();
    }
    expect(() => renderToolBody({ value: "prefix {{arguments.filters}}" }, context)).toThrow();
  });
  it("supports JSON Pointer escaping, arrays and null results", () => {
    expect(selectToolResult({ "a/b": { "~": [null, 3] } }, "/a~1b/~0/1")).toBe(3);
    expect(selectToolResult({ result: null }, "/result")).toBeNull();
    expect(() => selectToolResult({}, "/constructor")).toThrow();
  });
  it("rejects request bodies larger than the byte cap", () => {
    expect(() => renderToolBody({ value: "{{arguments.query}}" }, { ...context, arguments: { query: "字".repeat(400_000) } })).toThrow("1 MiB");
  });
  it("rejects embedded credentials, header injection and non-HTTP endpoints", () => {
    for (const url of ["file:///tmp/tool", "https://secret:password@example.com/tools"]) expect(() => HttpToolSchema.parse({ ...tool(), url })).toThrow();
    for (const headers of [{ Host: "elsewhere" }, { Authorization: "Bearer key\r\nInjected: true" }]) expect(() => HttpToolSchema.parse({ ...tool(), headers })).toThrow();
  });
});

describe("HTTP tool forwarding", () => {
  it("makes one configured POST, selects JSON output and passes cancellation", async () => {
    const controller = new AbortController();
    const postStream = vi.fn(async () => ({ status: 200, headers: {}, body: Readable.from([Buffer.from('{"data":{"result":"answer"}}')]) }));
    const result = await callHttpTool({ ...tool(), resultPath: "/data/result", headers: { Authorization: "Bearer adapter-secret" } }, context, { postStream }, controller.signal);
    expect(result).toMatchObject({ output: "answer", isError: false, status: 200 });
    expect(postStream).toHaveBeenCalledOnce();
    expect(postStream).toHaveBeenCalledWith("https://adapter.example/tools", expect.objectContaining({ authorization: "Bearer adapter-secret", "content-type": "application/json" }), { query: context.arguments.query, id: "call_1" }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  it("rejects redirects without retrying and closes the response", async () => {
    const body = Readable.from(["redirect"]);
    const postStream = vi.fn(async () => ({ status: 302, headers: { location: "http://internal" }, body }));
    expect(await callHttpTool(tool(), context, { postStream })).toMatchObject({ isError: true, status: 302 });
    expect(postStream).toHaveBeenCalledOnce();
    expect(body.destroyed).toBe(true);
  });
  it("enforces byte limits across chunks", async () => {
    const body = Readable.from([Buffer.from('"aaa'), Buffer.from('aaa"')]);
    const result = await callHttpTool({ ...tool(), maxResultBytes: 5 }, context, { postStream: async () => ({ status: 200, headers: {}, body }) });
    expect(JSON.parse(result.output).error.code).toBe("result_too_large");
    expect(body.destroyed).toBe(true);
  });
  it("reports invalid JSON and missing result paths as tool errors", async () => {
    for (const content of ["not JSON", '{"other":1}']) {
      const result = await callHttpTool({ ...tool(), resultPath: "/result" }, context, { postStream: async () => ({ status: 200, headers: {}, body: Readable.from([content]) }) });
      expect(JSON.parse(result.output).error.code).toBe("invalid_result");
    }
  });
  it("does not convert caller cancellation into a tool result or start a request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const postStream = vi.fn();
    await expect(callHttpTool(tool(), context, { postStream }, controller.signal)).rejects.toThrow("cancelled");
    expect(postStream).not.toHaveBeenCalled();
  });
  it("does not leak transport error messages containing credentials", async () => {
    const result = await callHttpTool(tool(), context, { postStream: async () => { throw new Error("adapter-secret"); } });
    expect(result.isError).toBe(true);
    expect(result.output).not.toContain("adapter-secret");
  });
});

/** A template whose innermost value sits `depth` levels below the root object. */
const nested = (depth: number): unknown => {
  let value: unknown = "x";
  for (let i = 0; i < depth; i++) value = { a: value };
  return value;
};
const errorCode = (result: { output: string }): string => JSON.parse(result.output).error.code;
const respond = (status: number, text: string) => vi.fn(async () => ({ status, headers: {}, body: Readable.from([Buffer.from(text)]) }));

describe("HTTP tool template limits", () => {
  it("accepts a value at depth 32 and rejects one at depth 33", () => {
    expect(renderToolBody(nested(32), context)).toEqual(nested(32));
    expect(() => renderToolBody(nested(33), context)).toThrow("too complex");
  });
  it("accepts 10 000 nodes and rejects 10 001", () => {
    // root object + array + items
    expect(renderToolBody({ a: Array(9_998).fill("x") }, context).a).toHaveLength(9_998);
    expect(() => renderToolBody({ a: Array(9_999).fill("x") }, context)).toThrow("too complex");
  });
  it("requires a JSON object at the root", () => {
    for (const template of [[], "x"]) expect(() => renderToolBody(template, context)).toThrow("Request body must be a JSON object");
  });
  it("rejects non-JSON template values", () => {
    for (const value of [NaN, Infinity, undefined, () => 1]) expect(() => renderToolBody({ value }, context)).toThrow("JSON values only");
  });
  it("stringifies placeholders that are not the whole value", () => {
    expect(renderToolBody({ a: "n={{arguments.count}}", b: "{{arguments.count}}{{arguments.count}}" }, context)).toEqual({ a: "n=2", b: "22" });
  });
});

describe("HTTP tool schema limits", () => {
  const accepts = (patch: Record<string, unknown>) => HttpToolSchema.safeParse({ ...tool(), ...patch }).success;
  it("rejects a URL fragment", () => {
    expect(accepts({ url: "https://adapter.example/tools#frag" })).toBe(false);
    expect(accepts({ url: "https://adapter.example/tools?x=1" })).toBe(true);
  });
  it("rejects reserved headers in any case and NUL in values", () => {
    for (const name of ["content-length", "Transfer-Encoding", "CONNECTION", "Upgrade", "trailer"]) expect(accepts({ headers: { [name]: "x" } })).toBe(false);
    expect(accepts({ headers: { "x-custom": "ok" } })).toBe(true);
    expect(accepts({ headers: { "x-custom": "a\0b" } })).toBe(false);
  });
  it("validates the result JSON Pointer", () => {
    for (const resultPath of ["data", "/a~2"]) expect(accepts({ resultPath })).toBe(false);
    expect(accepts({ resultPath: "/a~0~1" })).toBe(true);
  });
  it("bounds timeoutMs, maxResultBytes and the tool name", () => {
    for (const timeoutMs of [99, 600_001]) expect(accepts({ timeoutMs })).toBe(false);
    for (const timeoutMs of [100, 600_000]) expect(accepts({ timeoutMs })).toBe(true);
    for (const maxResultBytes of [0, 1_048_577]) expect(accepts({ maxResultBytes })).toBe(false);
    for (const maxResultBytes of [1, 1_048_576]) expect(accepts({ maxResultBytes })).toBe(true);
    expect(accepts({ name: "a".repeat(64) })).toBe(true);
    for (const name of ["a".repeat(65), "a b"]) expect(accepts({ name })).toBe(false);
  });
  it("requires object parameters and an object body template", () => {
    expect(accepts({ parameters: { type: "array" } })).toBe(false);
    for (const bodyTemplate of [[], null]) expect(accepts({ bodyTemplate })).toBe(false);
  });
  it("defaults a server tool's result type", () => {
    expect(HttpToolSchema.parse({ ...tool(), serverTool: { name: "web_search" } }).serverTool).toEqual({ name: "web_search", resultType: "web_search_result", resultPath: "" });
  });
});

describe("HTTP tool error codes", () => {
  it("reports a disabled tool without calling the adapter", async () => {
    const postStream = vi.fn();
    const result = await callHttpTool({ ...tool(), enabled: false }, context, { postStream });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("tool_disabled");
    expect(postStream).not.toHaveBeenCalled();
  });
  it("reports template failures as invalid arguments without calling the adapter", async () => {
    const postStream = vi.fn();
    for (const bodyTemplate of [{ q: "{{arguments.missing}}" }, nested(33), { a: Array(9_999).fill("x") }, { value: NaN }]) {
      expect(errorCode(await callHttpTool({ ...tool(), bodyTemplate }, context, { postStream }))).toBe("invalid_arguments");
    }
    expect(postStream).not.toHaveBeenCalled();
  });
  it("reports a failed connection without a status", async () => {
    const result = await callHttpTool(tool(), context, { postStream: async () => { throw new Error("ECONNRESET"); } });
    expect(errorCode(result)).toBe("tool_connection_error");
    expect(result.status).toBeUndefined();
  });
  it("reports its own timeout as tool_timeout", async () => {
    const postStream = vi.fn((_url: string, _headers: unknown, _body: unknown, opts: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      opts.signal!.addEventListener("abort", () => reject(opts.signal!.reason), { once: true });
    }));
    const result = await callHttpTool({ ...tool(), timeoutMs: 100 }, context, { postStream });
    expect(errorCode(result)).toBe("tool_timeout");
    expect(result.status).toBeUndefined();
  });
  it("treats only 200-299 as success", async () => {
    for (const status of [199, 300]) {
      const result = await callHttpTool(tool(), context, { postStream: respond(status, '"ok"') });
      expect(errorCode(result)).toBe("http_error");
      expect(result.status).toBe(status);
    }
    for (const status of [200, 299]) {
      expect(await callHttpTool(tool(), context, { postStream: respond(status, '"ok"') })).toMatchObject({ output: "ok", isError: false, status });
    }
  });
  it("reports a body that fails mid-read as a connection error and closes it", async () => {
    const body = Readable.from((async function* () { yield Buffer.from('{"a"'); throw new Error("socket hang up"); })());
    const result = await callHttpTool(tool(), context, { postStream: async () => ({ status: 200, headers: {}, body }) });
    expect(errorCode(result)).toBe("tool_connection_error");
    expect(body.destroyed).toBe(true);
  });
});

describe("HTTP tool result shaping", () => {
  it("accepts a response of exactly maxResultBytes and rejects one byte more", async () => {
    expect(await callHttpTool({ ...tool(), maxResultBytes: 5 }, context, { postStream: respond(200, '"abc"') })).toMatchObject({ output: "abc", isError: false });
    expect(errorCode(await callHttpTool({ ...tool(), maxResultBytes: 5 }, context, { postStream: respond(200, '"abcd"') }))).toBe("result_too_large");
  });
  it("serializes non-string results as JSON", async () => {
    expect((await callHttpTool(tool(), context, { postStream: respond(200, '{"a":1}') })).output).toBe('{"a":1}');
    expect((await callHttpTool({ ...tool(), resultPath: "/r" }, context, { postStream: respond(200, '{"r":null}') })).output).toBe("null");
    expect((await callHttpTool({ ...tool(), resultPath: "/r" }, context, { postStream: respond(200, '{"r":3}') })).output).toBe("3");
  });
});
