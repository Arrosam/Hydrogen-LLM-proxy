import type { ReasoningPart } from "../ir/content";

/** Client replay metadata preserves block boundaries, text and signature origin.
 * Envelopes are decoded at ingress; only native signatures reach an upstream.
 * The old redacted-only envelope remains readable for existing conversations.
 * Chat clients must retain reasoning_details to replay signed thinking. */
const PREFIX = "hydrogen-redacted-thinking-v1:";

interface Envelope {
  /** The opaque bytes Anthropic issued (`redacted_thinking.data`). */
  d: string;
}

/** Whether a wire value is one of our envelopes rather than a provider's own
 * encrypted payload. */
export function isRedactedEnvelope(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Wrap a canonical redacted reasoning part for transport through a client that
 * has no redacted concept of its own. */
export function encodeRedacted(part: ReasoningPart): string {
  const envelope: Envelope = { d: part.signature ?? "" };
  return PREFIX + Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

/**
 * Restore the canonical part from an envelope, or null when the value is not one
 * (a real provider payload, or a version this build does not know). Never throws:
 * an unreadable envelope degrades to "not an envelope", which loses the block
 * rather than corrupting the request around it.
 */
export function decodeRedacted(value: string): Pick<ReasoningPart, "redacted" | "signature"> | null {
  if (!isRedactedEnvelope(value)) return null;
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), "base64").toString("utf8");
    const parsed = JSON.parse(raw) as Partial<Envelope>;
    if (typeof parsed.d !== "string") return null;
    return { redacted: true, signature: parsed.d };
  } catch {
    return null;
  }
}

const REASONING_PREFIX = "hydrogen-reasoning-v1:";

/** Client-only replay envelope. It must be decoded before any upstream render. */
export function encodeReasoning(part: ReasoningPart): string {
  return REASONING_PREFIX + Buffer.from(JSON.stringify(part), "utf8").toString("base64");
}

export function decodeReasoning(value: string): ReasoningPart | null {
  const redacted = decodeRedacted(value);
  if (redacted) return { type: "reasoning", text: "", origin: "anthropic", ...redacted };
  if (!value.startsWith(REASONING_PREFIX)) return null;
  try {
    const p = JSON.parse(Buffer.from(value.slice(REASONING_PREFIX.length), "base64").toString("utf8"));
    if (p.type !== "reasoning" || typeof p.text !== "string") return null;
    if (p.origin !== undefined && !["anthropic", "openai_responses", "openai_completion"].includes(p.origin)) return null;
    if (p.signature !== undefined && typeof p.signature !== "string") return null;
    if (p.itemId !== undefined && typeof p.itemId !== "string") return null;
    return { type: "reasoning", text: p.text, origin: p.origin, signature: p.signature, itemId: p.itemId, ...(p.redacted === true ? { redacted: true } : {}) };
  } catch { return null; }
}

/** Chat clients that preserve reasoning_details can replay signed blocks. */
export function chatReasoningDetails(parts: ReasoningPart[]): unknown[] {
  return parts.map((p, index) => ({ type: "reasoning.encrypted", data: encodeReasoning(p), index }));
}

/**
 * A reasoning_details item that is NOT one of our envelopes: the shape
 * OpenRouter and compatible gateways use (`reasoning.text`, `reasoning.summary`,
 * or a plain reasoning/thinking item). Reading only the envelope dropped every
 * one of these, so a server that carries its trace solely in `reasoning_details`
 * had its thinking thrown away -- and with `reasoning_details` present the plain
 * `reasoning` field is not consulted either.
 */
function plainReasoningItem(item: Record<string, unknown>): ReasoningPart | null {
  const type = typeof item.type === "string" ? item.type : "";
  // The array is already the reasoning carrier, so a missing type is accepted;
  // a DIFFERENT type is not, since some servers put non-reasoning items here.
  if (type && !/reasoning|thinking|summary/i.test(type)) return null;
  const text = [item.text, item.summary, item.reasoning, item.thinking].find((v): v is string => typeof v === "string" && v !== "");
  if (!text) return null;
  const itemId = typeof item.id === "string" ? item.id : undefined;
  return { type: "reasoning", text, origin: "openai_completion", ...(itemId ? { itemId } : {}) };
}

export function parseChatReasoningDetails(value: unknown): ReasoningPart[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((d) => {
    if (!d || typeof d !== "object") return [];
    const item = d as Record<string, unknown>;
    // Our own envelope first: it is the only form that carries signatures.
    if (typeof item.data === "string") {
      const p = decodeReasoning(item.data);
      if (p) return [p];
    }
    const plain = plainReasoningItem(item);
    return plain ? [plain] : [];
  });
}
