/** Byte units and size ceilings shared across layers. */
export const BYTES_PER_KIB = 1024;
export const BYTES_PER_MIB = 1024 * BYTES_PER_KIB;

/**
 * Ceiling on one serialized conversation: a response context, its event log,
 * its history, or a tool-loop context. The messages that report it say "25 MiB".
 */
export const MAX_CONTEXT_BYTES = 25 * BYTES_PER_MIB;

/** One gibibyte, for the multi-GiB attachment ceiling. */
export const BYTES_PER_GIB = 1024 * BYTES_PER_MIB;
