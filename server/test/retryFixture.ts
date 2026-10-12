import type { z } from "zod";
import { RetrySchema, type RetryConfig } from "../src/execution/definition";

/**
 * A step's `retry` block as a service definition would carry it: written in
 * its input shape (every field optional) and completed by RetrySchema, so a
 * fixture gets exactly the defaults a saved definition gets.
 */
export function retryConfig(input: z.input<typeof RetrySchema>): RetryConfig {
  return RetrySchema.parse(input);
}
