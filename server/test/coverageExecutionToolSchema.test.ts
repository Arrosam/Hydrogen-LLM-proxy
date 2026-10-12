/** The hosted-tool parameter validator: its size bound and its compile cache. */
import { describe, expect, it } from "vitest";
import { toolValidator } from "../src/execution/toolSchema";

/** An object schema whose JSON encoding is exactly `bytes` long. */
const schemaOfSize = (bytes: number): Record<string, unknown> => {
  const empty = JSON.stringify({ type: "object", description: "" }).length;
  return { type: "object", description: "x".repeat(bytes - empty) };
};

describe("tool parameter schema validator", () => {
  it("compiles a schema of exactly 64 KiB and rejects one byte more", () => {
    const atLimit = schemaOfSize(65_536);
    expect(Buffer.byteLength(JSON.stringify(atLimit))).toBe(65_536);
    expect(toolValidator(atLimit)({})).toBe(true);
    expect(() => toolValidator(schemaOfSize(65_537))).toThrow("exceeds 64 KiB");
  });

  it("returns the same validator for the same schema", () => {
    const schema = { type: "object", properties: { cached: { type: "string" } } };
    const first = toolValidator(schema);
    expect(toolValidator(schema)).toBe(first);
    expect(toolValidator(structuredClone(schema))).toBe(first);
  });

  it("keeps validating correctly after more distinct schemas than the cache holds", () => {
    const schema = (i: number) => ({ type: "object", properties: { value: { const: i } }, required: ["value"], additionalProperties: false });
    for (let i = 0; i < 129; i++) {
      const validate = toolValidator(schema(i));
      expect(validate({ value: i })).toBe(true);
      expect(validate({ value: i + 1 })).toBe(false);
    }
    const again = toolValidator(schema(0));
    expect(again({ value: 0 })).toBe(true);
    expect(again({ value: 1 })).toBe(false);
    expect(again({ value: 0, extra: true })).toBe(false);
  });

  it("refuses a schema that references a remote document", () => {
    expect(() => toolValidator({ type: "object", properties: { a: { $ref: "https://schemas.example.com/remote.json" } } })).toThrow();
  });
});
