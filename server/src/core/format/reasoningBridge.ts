import type { ReasoningPart } from "../ir/content";

/**
 * Carrying an Anthropic `redacted_thinking` block across an OpenAI-format client.
 *
 * Ordinary thinking already survives the round trip on its own: its text becomes
 * the reasoning item's text and its signature becomes `encrypted_content`, and
 * both come back intact for an Anthropic upstream to accept. A redacted block
 * does not, because what makes it redacted is not its content -- it has none --
 * but a flag, and the canonical form of "a reasoning item with opaque bytes and
 * no text" is indistinguishable from a thinking block whose text was empty.
 * Replay it as the wrong one and the upstream rejects the whole request.
 *
 * So the block is wrapped: the flag plus its opaque payload, base64'd behind a
 * versioned prefix, riding in the field the destination protocol already
 * reserves for exactly this kind of opaque replay data (`encrypted_content`).
 * The idea is borrowed from cc-switch's reasoning bridge, which does the same
 * thing in the other direction (OpenAI reasoning items through Anthropic blocks).
 *
 * The envelope exists ONLY between Hydrogen and its own client, which is the one
 * party guaranteed to hand it back here. It is decoded on the way in and never
 * forwarded to an upstream: an Anthropic provider gets a real `redacted_thinking`
 * block back, and a provider that cannot express one gets nothing rather than
 * another vendor's bytes in a field it would try to decrypt.
 */

/** Bump only if the payload shape changes; an older prefix simply stops decoding
 * and the block degrades to being dropped, exactly as it was before this existed. */
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
