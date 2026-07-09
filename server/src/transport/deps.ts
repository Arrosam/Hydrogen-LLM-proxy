import type { Catalog } from "../catalog/catalog";
import type { ServiceFactory } from "../execution/serviceFactory";
import type { UpstreamClient } from "../core/upstream/client";
import type { ServiceRepo } from "../persistence/serviceRepo";
import type { TokenRepo } from "../persistence/tokenRepo";
import type { RequestLogger } from "../observability/requestLogger";
import type { UsageMeter } from "../observability/usageMeter";
import type { ActiveRequestRegistry } from "../observability/activeRequests";

/** Everything the client-facing proxy needs, injected by the composition root. */
export interface ProxyDeps {
  services: ServiceRepo;
  factory: ServiceFactory;
  tokens: TokenRepo;
  catalog: Catalog;
  transport: UpstreamClient;
  logger: RequestLogger;
  usage: UsageMeter;
  activeRequests: ActiveRequestRegistry;
}
