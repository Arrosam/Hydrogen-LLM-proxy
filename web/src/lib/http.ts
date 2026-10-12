/** HTTP status codes the UI gives a meaning to. */

export const HTTP_OK = 200;
export const HTTP_UNAUTHORIZED = 401;
/** nginx's "client closed request": the caller went away, nothing failed. */
export const HTTP_CLIENT_CLOSED = 499;
export const HTTP_SERVER_ERROR = 500;

/** The range of codes that are valid HTTP statuses at all. */
export const HTTP_STATUS_RANGE = { min: 100, max: 599 } as const;

const SUCCESS_RANGE = { min: 200, max: 300 } as const;

/** 2xx. */
export const isSuccessStatus = (status: number): boolean => status >= SUCCESS_RANGE.min && status < SUCCESS_RANGE.max;
