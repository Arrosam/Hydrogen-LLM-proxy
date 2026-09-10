import type { Catalog } from "@areelai/supplier-management";
import type { ServiceFactory } from "@areelai/model-services";
import type { UpstreamClient } from "@areelai/model-services";
import type { ServiceRepo } from "@areelai/model-services";
import type { TokenRepo } from "@areelai/user-management";
import type { RequestLogger } from "../observability/requestLogger.js";
import type { UsageMeter } from "@areelai/user-management";
import type { ActiveRequestRegistry } from "../observability/activeRequests.js";

/** Everything the client-facing proxy needs, injected by the composition root. */
export interface ProxyDeps {
  logMaxChars?: () => number;
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
  /** Silence allowed on a NON-streaming request before 200 is committed and
   * whitespace heartbeats flow into the JSON body (defeats intermediary idle
   * timeouts, e.g. Cloudflare's ~100s 524). 0 disables. Default 30000ms. */
  jsonCommitGraceMs?: number;
}
