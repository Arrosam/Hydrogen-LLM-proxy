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
  /** Silence allowed on a streaming request before the SSE response is
   * committed and keep-alive pings start. Default 2500ms. */
  streamCommitGraceMs?: number;
  /** Interval between keep-alive pings once committed. Default 10000ms. */
  streamPingIntervalMs?: number;
}
