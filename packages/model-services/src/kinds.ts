import type { Catalog } from "@areelai/supplier-management";
import type { ServiceCategory, ServiceDef, ServiceEnvelope } from "./definition.js";
import type { ModelService, ServiceDeps } from "./modelService.js";
import type { ServiceResolver } from "./resolver.js";
import type { ModelServiceRow } from "./schema.js";

/**
 * The service-kind registry.
 *
 * A step chain is the one kind this package understands natively. Any other
 * kind -- a Micro Agent, for one -- is a definition stored in the same table
 * under its own `kind`, and this package treats it as opaque: parsing,
 * validating, summarizing and building it are delegated to the handler the
 * owning package registered. Without that registration a row of that kind is
 * rejected as an unknown kind, which is exactly what an adopter who installed
 * only this package should see.
 */

/** What a handler gets to build an executor. */
export interface KindBuildContext {
  deps: ServiceDeps;
  /** Resolves saved service names to executors (nested references). */
  resolver: ServiceResolver;
  /** Per-call log payload budget, live. */
  logMaxChars: number | (() => number);
}

/** The slice of the service store validation needs. */
export interface ServiceLookup {
  getByName(name: string): ModelServiceRow | undefined;
  /** Parse a row's stored definition (throws on an invalid one). */
  def(row: ModelServiceRow): ServiceDef;
}

/** What a handler gets to validate a definition against the live catalog. */
export interface KindValidationContext {
  catalog: Catalog;
  services: ServiceLookup;
  /** Unmapped (model, provider) pairs collected across the whole definition;
   * the validator reports them together at the end. */
  invalidPairs: string[];
  /** The category of a saved service by name, or null when it cannot be read. */
  categoryOf(name: string): string | null;
  /** Check that a step can reach an OpenAI-shaped media endpoint the way the
   * runtime resolves it. Returns the pair to report as unmapped when the
   * catalog has no entry, null when fine; throws when mapped but unusable. */
  requireMediaEndpoint(model: string, provider: string, what: string): string | null;
  /** Abort validation with a message (throws ServiceValidationError). */
  fail(message: string): never;
}

export interface ServiceKindHandler<D extends ServiceEnvelope = ServiceEnvelope> {
  /** The canonical kind, as stored in the `kind` column. */
  kind: string;
  /** Other spellings accepted on input (e.g. a legacy discriminant). */
  aliases?: readonly string[];
  /** Parse and validate the shape. Throws ZodError. */
  parse(raw: unknown): D;
  category(def: D): ServiceCategory;
  summarize(def: D): string;
  /** Names of saved services this definition references (nested resolution,
   * hosted-tool lookup through stages). */
  references(def: D): string[];
  /** Semantic validation against the live catalog and service store. */
  validate(def: D, ctx: KindValidationContext): void;
  build(def: D, ctx: KindBuildContext): ModelService;
}

const handlers = new Map<string, ServiceKindHandler>();

/** Register (or replace) the handler for a kind and its aliases. */
export function registerServiceKind<D extends ServiceEnvelope>(handler: ServiceKindHandler<D>): void {
  const h = handler as unknown as ServiceKindHandler;
  handlers.set(handler.kind, h);
  for (const alias of handler.aliases ?? []) handlers.set(alias, h);
}

/** The handler for a kind (or alias), if one is registered. */
export function serviceKind(kind: string): ServiceKindHandler | undefined {
  return handlers.get(kind);
}

/** The canonical kinds registered so far, step chain first. */
export function registeredKinds(): string[] {
  return ["model_service", ...new Set([...handlers.values()].map((h) => h.kind))];
}

/** The handler for a kind, or an UnknownServiceKindError. */
export function requireKind(kind: string): ServiceKindHandler {
  const h = handlers.get(kind);
  if (!h) throw new UnknownServiceKindError(kind);
  return h;
}

/** Thrown for a definition whose `kind` no installed package has registered. */
export class UnknownServiceKindError extends Error {
  constructor(public readonly kind: string) {
    super(`unknown service kind "${kind}"`);
    this.name = "UnknownServiceKindError";
  }
}
