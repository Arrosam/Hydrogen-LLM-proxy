import { afterEach, describe, expect, it, vi } from "vitest";
import { closeWithDeadline, type ClosableServer } from "../src/util/shutdown";

afterEach(() => {
  vi.useRealTimers();
});

describe("closeWithDeadline", () => {
  it("lets a normal graceful close finish without forcing connections", async () => {
    const closeAllConnections = vi.fn();
    const app: ClosableServer = {
      close: vi.fn(async () => undefined),
      server: { closeAllConnections },
      log: { warn: vi.fn() },
    };

    await expect(closeWithDeadline(app, 30_000)).resolves.toBe(false);
    expect(closeAllConnections).not.toHaveBeenCalled();
  });

  it("forces active connections closed when the grace deadline expires", async () => {
    vi.useFakeTimers();
    const closeAllConnections = vi.fn();
    const app: ClosableServer = {
      close: vi.fn(() => new Promise(() => {})),
      server: { closeAllConnections },
      log: { warn: vi.fn() },
    };

    const closing = closeWithDeadline(app, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(closing).resolves.toBe(true);
    expect(closeAllConnections).toHaveBeenCalledOnce();
    expect(app.log.warn).toHaveBeenCalledOnce();
  });
});
