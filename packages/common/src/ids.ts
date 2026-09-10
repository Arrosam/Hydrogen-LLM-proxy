import crypto from "node:crypto";

/** Generate an id like "chatcmpl-a1b2c3..." for response objects. */
export function genId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(16).toString("hex")}`;
}

/** Current time in epoch seconds. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
