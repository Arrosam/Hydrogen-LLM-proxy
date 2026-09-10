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
