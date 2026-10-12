import { Request, type RequestData } from "../ir/request";
import type { SendTarget, Transport } from "../upstream/transport";
import type { RelayResult, SendResult } from "../upstream/outcome";
import { relayStream, sendBuffered } from "../upstream/roundtrip";

/**
 * A canonical Request bound to one wire family: the base of the three format
 * subclasses. They differ in `parse` and `render`; how a rendered request is
 * emitted and its reply read back is the shared round-trip, so it lives here
 * once.
 *
 * It sits between `ir/Request` and the subclasses rather than on `Request`
 * itself because the round-trip dispatches through the format registry: the
 * canonical base importing it would re-create the import cycle the registry
 * exists to avoid.
 */
export abstract class WireRequest extends Request {
  /** Rebuild any canonical Request as a request of this wire family. */
  static construct<T extends Request>(this: new (data: RequestData) => T, base: Request): T {
    return new this(base.data());
  }

  send(transport: Transport, target: SendTarget): Promise<SendResult> {
    return sendBuffered(this, transport, target);
  }

  relay(transport: Transport, target: SendTarget): Promise<RelayResult> {
    return relayStream(this, transport, target);
  }
}
