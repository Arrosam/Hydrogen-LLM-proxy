import type { TokenRepo } from "../persistence/tokenRepo";

/** Counts a request (and its tokens) against a client token's quota, atomically. */
export class UsageMeter {
  constructor(private readonly tokens: TokenRepo) {}

  record(tokenId: number, tokensUsed: number): void {
    this.tokens.incrementUsage(tokenId, 1, tokensUsed);
  }
}
