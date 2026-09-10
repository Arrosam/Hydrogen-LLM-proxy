/**
 * Filler text for context-window probing.
 *
 * The point of the filler is to make a request BIG, not to make it meaningful,
 * so a repeated Latin paragraph is exactly right: no instruction inside it can
 * steer the model, and no cached prefix from a real conversation can shorten
 * it. What makes it usable as a probe is that the size is chosen by the person
 * running it and the model reports back what it actually counted.
 *
 * The token figure here is an ESTIMATE and is labelled as one everywhere it is
 * shown. There is no tokenizer in this bundle and there could not be a correct
 * one: every provider tokenizes differently, and the same text costs different
 * numbers of tokens on each. ~3.6 characters per token is a reasonable middle
 * for Latin prose across the BPE vocabularies in common use. The real number
 * comes back in `usage.prompt_tokens` -- that is the measurement; this is only
 * how you aim.
 */

const PARAGRAPH =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor " +
  "incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud " +
  "exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure " +
  "dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. " +
  "Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt " +
  "mollit anim id est laborum. ";

/** Characters per token, averaged over Latin prose. See the note above. */
export const CHARS_PER_TOKEN = 3.6;

/** Rough token count for a string, by the same ratio the generator uses. */
export function estimateTokens(text: string): number {
  return Math.round(text.length / CHARS_PER_TOKEN);
}

/**
 * Filler of approximately `tokens` tokens.
 *
 * Each paragraph is numbered. Two reasons, both practical: a provider that
 * de-duplicates or caches repeated blocks cannot collapse the request into
 * something smaller than it was asked for, and a truncated answer that echoes
 * "paragraph 412" says exactly where the model stopped reading.
 */
export function loremOfTokens(tokens: number): string {
  const targetChars = Math.max(0, Math.round(tokens * CHARS_PER_TOKEN));
  if (targetChars === 0) return "";
  const out: string[] = [];
  let length = 0;
  for (let i = 1; length < targetChars; i++) {
    const chunk = `[${i}] ${PARAGRAPH}`;
    out.push(chunk);
    length += chunk.length;
  }
  return out.join("").slice(0, targetChars);
}
