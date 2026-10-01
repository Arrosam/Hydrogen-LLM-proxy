/** Incremental quotation state for the built-in think-tag convention.
 * This is deliberately a small Markdown/prose recognizer, not a document parser.
 * Inline quotes are line-bounded; fences require matching markers at line start
 * (at most three spaces) and a closing line containing no other text. An open
 * quotation is only evidence to investigate a boundary, never permission to
 * hide the remainder of an unbounded response. */
export type ThinkingQuoteKind = "inline" | "prose" | "fence";
export interface QuoteBoundary { closed?: ThinkingQuoteKind; expired?: boolean }

export class ThinkingQuotes {
  private fence: { marker: string; length: number } | undefined;
  private span = 0;
  private prose: string | undefined;
  private pendingApostrophe = false;
  private run = "";
  private runLength = 0;
  private runAtLineStart = false;
  private fenceEnd = false;
  private indent = 0;
  private lineStart = true;
  private escaped = false;
  private previous = "";

  get kind(): ThinkingQuoteKind | undefined {
    return this.fence ? "fence" : this.span ? "inline" : this.prose ? "prose" : undefined;
  }

  /** Settle a marker run BEFORE consuming its proof character. Chunk endings
   * never call this with undefined; only actual EOF does. */
  before(ch: string | undefined): QuoteBoundary {
    let closed: ThinkingQuoteKind | undefined;
    if (this.pendingApostrophe) {
      // A closing apostrophe needs right-hand context: the one in 'don't ...'
      // is a contraction, not the end of the surrounding single-quoted prose.
      if (ch === undefined || !/[\p{L}\p{N}_]/u.test(ch)) { this.prose = undefined; closed = "prose"; }
      this.pendingApostrophe = false;
    }
    if (this.runLength && ch !== this.run) {
      if (this.fence) {
        if (this.runAtLineStart && this.run === this.fence.marker && this.runLength >= this.fence.length) this.fenceEnd = true;
      } else if (!this.span && !this.prose && this.runAtLineStart && this.runLength >= 3) {
        this.fence = { marker: this.run, length: this.runLength };
      } else if (this.run === "`" && !this.prose) {
        if (this.span === this.runLength) { this.span = 0; closed = "inline"; }
        else if (!this.span) this.span = this.runLength;
      }
      this.runLength = 0;
      this.run = "";
    }
    const lineEnd = ch === undefined || ch === "\n" || ch === "\r";
    if (this.fenceEnd) {
      if (lineEnd) { this.fence = undefined; this.fenceEnd = false; closed = "fence"; }
      else if (ch !== " " && ch !== "\t") this.fenceEnd = false;
    }
    const expired = lineEnd && !!(this.span || this.prose);
    if (expired) { this.span = 0; this.prose = undefined; }
    return { closed, expired };
  }

  /** Consume after before(ch). A prose closing quote is unambiguous at this
   * character; a backtick/fence run needs the next character as proof. */
  push(ch: string): ThinkingQuoteKind | undefined {
    let closed: ThinkingQuoteKind | undefined;
    const marker = (ch === "`" && !this.prose && (this.span > 0 || !this.escaped)) ||
      (ch === "~" && !this.prose && !this.span && (!!this.fence || this.lineStart || this.run === "~"));
    if (marker) {
      if (!this.runLength) { this.run = ch; this.runAtLineStart = this.lineStart && this.indent <= 3; }
      this.runLength++;
    } else if (!this.fence && !this.span) {
      if (this.prose) {
        if (ch === this.prose && !this.escaped) {
          if ((ch === "'" || ch === "’") && /[\p{L}\p{N}_]/u.test(this.previous)) this.pendingApostrophe = true;
          else { this.prose = undefined; closed = "prose"; }
        }
      } else if (!this.escaped && !/[\p{L}\p{N}_]/u.test(this.previous) && ["'", '"', "“", "‘"].includes(ch)) {
        // Apostrophes in don't / model's are not opening quotations.
        this.prose = ch === "“" ? "”" : ch === "‘" ? "’" : ch;
      }
    }
    if (ch === "\n" || ch === "\r") { this.lineStart = true; this.indent = 0; }
    else if (this.lineStart && ch === " ") this.indent++;
    else this.lineStart = false;
    this.escaped = ch === "\\" ? !this.escaped : false;
    this.previous = ch;
    return closed;
  }

  text(text: string): void {
    for (let i = 0; i < text.length; i++) { this.before(text[i]); this.push(text[i]); }
  }
}
