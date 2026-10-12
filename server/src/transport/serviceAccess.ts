import { tokenAllowsService } from "../auth/authorization";
import type { ModelServiceRow, Token } from "../db/schema";
import type { ServiceDef } from "../execution/definition";

/**
 * Whether a client token may run a service row, and with which definition.
 *
 * Pure: it decides and reports why not, in a fixed order (existence, then
 * scope, then the stored definition). Every caller owns what a refusal looks
 * like -- the chat, media and Responses surfaces answer the same reason with
 * different words and statuses, and differ in which refusals they log -- and
 * applies its own category rule to the definition afterwards.
 */
export type ServiceAccess =
  | { ok: true; service: ModelServiceRow; def: ServiceDef }
  /** No such row, or it is disabled: indistinguishable on purpose. */
  | { ok: false; reason: "unknown" }
  /** The token's scope does not include the service. */
  | { ok: false; reason: "forbidden"; service: ModelServiceRow }
  /** The stored definition no longer parses; `error` is what the parser threw. */
  | { ok: false; reason: "invalid_definition"; service: ModelServiceRow; error: unknown };

export function resolveServiceAccess(
  token: Pick<Token, "scopeServices">,
  service: ModelServiceRow | undefined,
  parseDef: (row: ModelServiceRow) => ServiceDef,
): ServiceAccess {
  if (!service || !service.enabled) return { ok: false, reason: "unknown" };
  if (!tokenAllowsService(token, service.id)) return { ok: false, reason: "forbidden", service };
  try {
    return { ok: true, service, def: parseDef(service) };
  } catch (error) {
    return { ok: false, reason: "invalid_definition", service, error };
  }
}
