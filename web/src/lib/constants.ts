/**
 * Numbers more than one file agrees on: unit sizes and shared validation
 * bounds. A value only one file uses is named at the top of that file instead.
 */

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60_000;
export const SECONDS_PER_MINUTE = 60;
export const MINUTES_PER_HOUR = 60;
export const HOURS_PER_DAY = 24;

/** A ratio as a percentage. */
export const PERCENT = 100;

/** Bytes in one mebibyte; the unit every size field in the UI is entered in. */
export const MIB = 1024 * 1024;

/** Shortest password the change-password forms accept (the server enforces it too). */
export const MIN_PASSWORD_LENGTH = 8;
