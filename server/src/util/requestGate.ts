/** Coordinates instance restore with both HTTP handlers and detached model jobs. */
export class RequestGateError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

export class RequestGate {
  private leases = 0;
  private maintenance = false;

  acquire(): () => void {
    if (this.maintenance) throw new RequestGateError("The instance is being restored; retry later", 503);
    this.leases++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases--;
    };
  }

  /** Synchronous check-and-lock: no request can enter during asynchronous KDF work. */
  beginMaintenance(): () => void {
    if (this.maintenance) throw new RequestGateError("Instance maintenance is already in progress", 503);
    if (this.leases) throw new RequestGateError("Wait for active requests to finish before restoring a backup", 409);
    this.maintenance = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.maintenance = false;
    };
  }

  get activeCount(): number { return this.leases; }
}
