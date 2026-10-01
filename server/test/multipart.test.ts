import { describe, expect, it } from "vitest";
import { readMultipartField, rewriteMultipartField, upsertMultipartField } from "../src/core/upstream/multipart";

const BOUNDARY = "----hydrogenMultipart";
const CONTENT_TYPE = `multipart/form-data; boundary="${BOUNDARY}"`;
const textPart = (name: string, value: string) => Buffer.from(
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
);
const filePart = (name: string, bytes: Buffer, filenameParam = 'filename="reference.png"') => Buffer.concat([
  Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"; ${filenameParam}\r\nContent-Type: image/png\r\n\r\n`),
  bytes, Buffer.from("\r\n"),
]);
const form = (...parts: Buffer[]) => Buffer.concat([...parts, Buffer.from(`--${BOUNDARY}--\r\n`)]);

describe("multipart text-field surgery", () => {
  it("ignores boundary-like bytes and fake text fields embedded in binary images", () => {
    const image = Buffer.concat([
      Buffer.from([0x89, 0x00, 0xff, 0x80]),
      Buffer.from(`pixels--${BOUNDARY}\r\nContent-Disposition: form-data; name="model"\r\n\r\nforged-service\r\n`),
      Buffer.from(`\r\n--${BOUNDARY}--not-a-delimiter\r\nmore-pixels\r\n--${BOUNDARY}-not-a-delimiter`),
    ]);
    const file = filePart("image", image);
    const source = form(file, textPart("model", "image-service"));
    expect(readMultipartField(source, CONTENT_TYPE, "model")).toBe("image-service");
    expect(rewriteMultipartField(source, CONTENT_TYPE, "model", "mapped-model"))
      .toEqual(form(file, textPart("model", "mapped-model")));
    expect(upsertMultipartField(source, CONTENT_TYPE, "quality", "high"))
      .toEqual(form(file, textPart("model", "image-service"), textPart("quality", "high")));
  });

  it("matches literal field names, not regex wildcards or unrelated header parameters", () => {
    const source = form(textPart("qualityXlevel", "wrong"), textPart("quality.level", "low"));
    expect(readMultipartField(source, CONTENT_TYPE, "quality.level")).toBe("low");
    expect(rewriteMultipartField(source, CONTENT_TYPE, "quality.level", "high"))
      .toEqual(form(textPart("qualityXlevel", "wrong"), textPart("quality.level", "high")));
    const unrelated = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; x-name="model"\r\n\r\nforged\r\n`,
    );
    expect(readMultipartField(form(unrelated, textPart("model", "real")), CONTENT_TYPE, "model")).toBe("real");
  });

  it.each(['filename="model.png"', "filename*=UTF-8''model.png"])("does not treat an upload with %s as a text model", (filename) => {
    const file = filePart("model", Buffer.from("image-bytes"), filename);
    expect(readMultipartField(form(file), CONTENT_TYPE, "model")).toBeNull();
    expect(rewriteMultipartField(form(file), CONTENT_TYPE, "model", "mapped")).toBeNull();
    expect(upsertMultipartField(form(file), CONTENT_TYPE, "model", "mapped"))
      .toEqual(form(file, textPart("model", "mapped")));
  });

  it("rewrites every duplicate text model so upstream parsing cannot bypass the mapping", () => {
    const file = filePart("image[]", Buffer.from([0xff, 0x00, 0x80]));
    const source = form(textPart("model", "service"), file, textPart("model", "unmapped-model"));
    expect(rewriteMultipartField(source, CONTENT_TYPE, "model", "mapped-model"))
      .toEqual(form(textPart("model", "mapped-model"), file, textPart("model", "mapped-model")));
  });

  it("inserts before the real closing delimiter, not a matching string in an epilogue", () => {
    const epilogue = Buffer.from(`epilogue--${BOUNDARY}--`);
    const source = Buffer.concat([form(textPart("model", "service")), epilogue]);
    expect(upsertMultipartField(source, CONTENT_TYPE, "n", "2"))
      .toEqual(Buffer.concat([form(textPart("model", "service"), textPart("n", "2")), epilogue]));
  });

  it("returns null for absent fields or unusable multipart framing", () => {
    const source = form(textPart("prompt", "hello"));
    expect(readMultipartField(source, CONTENT_TYPE, "model")).toBeNull();
    expect(rewriteMultipartField(source, CONTENT_TYPE, "model", "mapped")).toBeNull();
    expect(readMultipartField(source, "multipart/form-data", "model")).toBeNull();
    expect(upsertMultipartField(source, "multipart/form-data", "n", "2")).toBeNull();
    expect(upsertMultipartField(Buffer.from("unframed"), CONTENT_TYPE, "n", "2")).toBeNull();
  });
});
