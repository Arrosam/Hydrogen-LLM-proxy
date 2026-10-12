/**
 * Responses API identifiers shared by the wire adapter, the stored-response
 * state and the controllers that replay it.
 */

/** Status of a response object, on the wire and in the stored_responses table. */
export const RESPONSE_STATUS = {
  QUEUED: "queued",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  INCOMPLETE: "incomplete",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;
export type ResponseStatus = typeof RESPONSE_STATUS[keyof typeof RESPONSE_STATUS];

/** Statuses of a response that has not reached a terminal state. */
export const RUNNING_RESPONSE_STATUSES = [RESPONSE_STATUS.QUEUED, RESPONSE_STATUS.IN_PROGRESS] as const;

/** Response-level SSE event types. */
export const RESPONSE_EVENT = {
  CREATED: "response.created",
  IN_PROGRESS: "response.in_progress",
  COMPLETED: "response.completed",
  INCOMPLETE: "response.incomplete",
  FAILED: "response.failed",
} as const;
