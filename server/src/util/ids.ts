import crypto from "node:crypto";
import { MS_PER_SECOND } from "./time";

const ID_RANDOM_BYTES = 16;

/** Prefixes of the ids the proxy mints; each names the kind of object the id belongs to. */
export const ID_PREFIX = {
  CALL: "call",
  CHAT_COMPLETION: "chatcmpl",
  CONVERSATION: "conv",
  FUNCTION_CALL: "fc",
  ITEM: "item",
  MESSAGE: "msg",
  REQUEST: "req",
  RESPONSE: "resp",
  REASONING: "rs",
  SESSION: "session",
  SERVER_TOOL: "srv",
  SERVER_TOOL_USE: "srvtoolu",
  TOOL_CALL: "toolcall",
  TOOL_USE: "toolu",
  TRACE: "trace",
  WEB_SEARCH: "ws",
} as const;

/** Generate an id like "chatcmpl-a1b2c3..." for response objects. */
export function genId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(ID_RANDOM_BYTES).toString("hex")}`;
}

/** Current time in epoch seconds. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / MS_PER_SECOND);
}
