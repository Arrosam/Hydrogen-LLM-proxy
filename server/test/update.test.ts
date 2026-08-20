import { describe, expect, it, vi } from "vitest";
import { isNewerVersion, UpdateService } from "../src/update/updateService";

const release = (tag: string, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      tag_name: tag,
      html_url: `https://github.com/x/y/releases/tag/${tag}`,
      published_at: "2026-08-19T16:32:04Z",
      body: "## What's New\n\nThings.",
      ...extra,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("isNewerVersion", () => {
  it("compares dotted triples, tolerating a leading v", () => {
    expect(isNewerVersion("v1.6.0", "1.4.1")).toBe(true);
    expect(isNewerVersion("1.4.2", "1.4.1")).toBe(true);
    expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
    expect(isNewerVersion("1.4.1", "1.4.1")).toBe(false);
    expect(isNewerVersion("1.4.0", "1.4.1")).toBe(false);
    expect(isNewerVersion("v1.4.1", "v1.10.0")).toBe(false);
  });

  it("treats a missing patch as .0 and ignores pre-release suffixes", () => {
    expect(isNewerVersion("1.5", "1.4.9")).toBe(true);
    expect(isNewerVersion("1.5.0-rc.1", "1.4.1")).toBe(true);
  });

  it("never calls an unparsable tag newer", () => {
    expect(isNewerVersion("nightly", "1.4.1")).toBe(false);
    expect(isNewerVersion("", "1.4.1")).toBe(false);
  });
});

describe("UpdateService.check", () => {
  it("reports an available update when the release tag is newer", async () => {
    const fetchImpl = vi.fn(async () => release("v1.6.0"));
    const svc = new UpdateService({ repo: "x/y", fetchImpl: fetchImpl as unknown as typeof fetch, currentVersion: "1.4.1" });
    const s = await svc.check();
    expect(s.updateAvailable).toBe(true);
    expect(s.current).toBe("1.4.1");
    expect(s.latest).toBe("1.6.0");
    expect(s.releaseUrl).toContain("/releases/tag/v1.6.0");
    expect(s.releaseNotes).toContain("What's New");
    expect(s.restartSupported).toBe(false);
    expect(s.error).toBeUndefined();
  });

  it("reports up-to-date when the running version matches the release", async () => {
    const fetchImpl = vi.fn(async () => release("v1.6.0"));
    const svc = new UpdateService({ repo: "x/y", fetchImpl: fetchImpl as unknown as typeof fetch, currentVersion: "1.6.0" });
    const s = await svc.check();
    expect(s.updateAvailable).toBe(false);
    expect(s.latest).toBe("1.6.0");
  });

  it("serves cached answers until forced, then refetches", async () => {
    const fetchImpl = vi.fn(async () => release("v1.6.0"));
    const svc = new UpdateService({ repo: "x/y", fetchImpl: fetchImpl as unknown as typeof fetch, currentVersion: "1.4.1" });
    await svc.check();
    await svc.check();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await svc.check(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces a rate-limit response as an error and does not cache it", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 403 }))
      .mockResolvedValueOnce(release("v1.6.0"));
    const svc = new UpdateService({ repo: "x/y", fetchImpl: fetchImpl as unknown as typeof fetch, currentVersion: "1.4.1" });
    const first = await svc.check();
    expect(first.error).toMatch(/rate limit/i);
    expect(first.updateAvailable).toBe(false);
    expect(first.current).toBe("1.4.1"); // current is still reported on failure
    // A failed check must not stick: the next call retries and succeeds.
    const second = await svc.check();
    expect(second.error).toBeUndefined();
    expect(second.updateAvailable).toBe(true);
  });

  it("survives a network failure with an error status instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.github.com");
    });
    const svc = new UpdateService({ repo: "x/y", fetchImpl: fetchImpl as unknown as typeof fetch, currentVersion: "1.4.1" });
    const s = await svc.check();
    expect(s.error).toContain("ENOTFOUND");
    expect(s.updateAvailable).toBe(false);
  });

  it("rejects a release with no tag", async () => {
    const fetchImpl = vi.fn(async () => release("", { tag_name: undefined }));
    const svc = new UpdateService({ repo: "x/y", fetchImpl: fetchImpl as unknown as typeof fetch, currentVersion: "1.4.1" });
    const s = await svc.check();
    expect(s.error).toMatch(/no release tag/);
  });

  it("requires an explicit operator opt-in before scheduling a restart", async () => {
    const disabled = new UpdateService({ repo: "x/y", fetchImpl: vi.fn(async () => release("v1.6.0")) as unknown as typeof fetch });
    expect(() => disabled.scheduleRestart()).toThrow(/disabled/i);

    const enabled = new UpdateService({
      repo: "x/y",
      fetchImpl: vi.fn(async () => release("v1.6.0")) as unknown as typeof fetch,
      restartEnabled: true,
    });
    expect((await enabled.check()).restartSupported).toBe(true);
  });
});
