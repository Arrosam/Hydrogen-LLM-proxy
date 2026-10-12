import { ApiError } from "../api";

/**
 * Display text for a failed admin-API call: the server's own message when it
 * answered, `fallback` for anything else (so a network failure reads "Save
 * failed", not "Failed to fetch").
 */
export const apiErrorMessage = (e: unknown, fallback: string): string => (e instanceof ApiError ? e.message : fallback);

/**
 * Display text for any thrown value: an Error's own message, else `fallback`
 * (or the value itself as text when no fallback is given).
 *
 * Deliberately separate from `apiErrorMessage`: merging them would change which
 * text a network failure shows.
 */
export const errorMessage = (e: unknown, fallback?: string): string =>
  e instanceof Error ? e.message : (fallback ?? String(e));
