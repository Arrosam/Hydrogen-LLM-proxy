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

describe("closeWithDeadline — secondary paths", () => {
  it("a failing close rejects with the same error, forces nothing, and leaves no timer", async () => {
    vi.useFakeTimers();
    const boom = new Error("close failed");
    const closeAllConnections = vi.fn();
    const app: ClosableServer = {
      close: vi.fn(async () => { throw boom; }),
      server: { closeAllConnections },
      log: { warn: vi.fn() },
    };

    await expect(closeWithDeadline(app, 1_000)).rejects.toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(closeAllConnections).not.toHaveBeenCalled();
    expect(app.log.warn).not.toHaveBeenCalled();
  });

  it("a server without closeAllConnections still resolves at the deadline", async () => {
    vi.useFakeTimers();
    const app: ClosableServer = {
      close: vi.fn(() => new Promise(() => {})),
      server: {},
      log: { warn: vi.fn() },
    };

    const closing = closeWithDeadline(app, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(closing).resolves.toBe(true);
    expect(app.log.warn).toHaveBeenCalledWith("shutdown grace period (1000ms) expired; closing active connections");
  });

  it("the deadline is not reached one millisecond early", async () => {
    vi.useFakeTimers();
    const closeAllConnections = vi.fn();
    const app: ClosableServer = {
      close: vi.fn(() => new Promise(() => {})),
      server: { closeAllConnections },
      log: { warn: vi.fn() },
    };

    let settled = false;
    const closing = closeWithDeadline(app, 1_000).then((forced) => { settled = true; return forced; });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    expect(closeAllConnections).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(closing).resolves.toBe(true);
  });

  it("a close that finishes just inside the grace period is not forced, and its timer is cleared", async () => {
    vi.useFakeTimers();
    const closeAllConnections = vi.fn();
    const app: ClosableServer = {
      close: vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 999))),
      server: { closeAllConnections },
      log: { warn: vi.fn() },
    };

    const closing = closeWithDeadline(app, 1_000);
    await vi.advanceTimersByTimeAsync(999);
    await expect(closing).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(closeAllConnections).not.toHaveBeenCalled();
    expect(app.log.warn).not.toHaveBeenCalled();
  });
});
