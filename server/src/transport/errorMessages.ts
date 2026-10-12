/** Error strings repeated across the transport layer; each `{ error }` body stays a fresh literal at its site. */
export const ERR_INVALID_ID = "invalid id";
export const ERR_NOT_FOUND = "not found";
/** Logged when a client token's scope does not include the requested service. */
export const ERR_SERVICE_OUT_OF_SCOPE = "service out of token scope";
/** A bench or dry-run target named a service id that does not exist. */
export const ERR_MODEL_SERVICE_NOT_FOUND = "Model Service not found";
