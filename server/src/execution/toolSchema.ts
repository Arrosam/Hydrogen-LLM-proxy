import Ajv, { type ValidateFunction } from "ajv";
import { BYTES_PER_KIB } from "../config/limits";

/** Largest serialized tool-parameter schema that is compiled. */
const MAX_TOOL_SCHEMA_BYTES = 64 * BYTES_PER_KIB;
/** Compiled validators kept before the cache is emptied. */
const VALIDATOR_CACHE_MAX = 128;

// Draft 7, local references only. Compilation never fetches a remote schema.
const ajv = new Ajv({ strict: false, allErrors: false, ownProperties: true, validateFormats: false });
const cache = new Map<string, ValidateFunction>();
export function toolValidator(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  let validate = cache.get(key);
  if (!validate) {
    if (Buffer.byteLength(key) > MAX_TOOL_SCHEMA_BYTES) throw new Error("Tool parameter schema exceeds 64 KiB");
    validate = ajv.compile(schema);
    if (cache.size >= VALIDATOR_CACHE_MAX) cache.clear();
    cache.set(key, validate);
    ajv.removeSchema(schema);
  }
  return validate;
}
