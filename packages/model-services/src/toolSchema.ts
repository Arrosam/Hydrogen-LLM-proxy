import Ajv, { type ValidateFunction } from "ajv";

// Draft 7, local references only. Compilation never fetches a remote schema.
const ajv = new Ajv({ strict: false, allErrors: false, ownProperties: true, validateFormats: false });
const cache = new Map<string, ValidateFunction>();
export function toolValidator(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  let validate = cache.get(key);
  if (!validate) {
    if (Buffer.byteLength(key) > 64 * 1024) throw new Error("Tool parameter schema exceeds 64 KiB");
    validate = ajv.compile(schema);
    if (cache.size >= 128) cache.clear();
    cache.set(key, validate);
    ajv.removeSchema(schema);
  }
  return validate;
}
