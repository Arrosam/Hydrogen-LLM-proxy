import { describe, expect, it, vi } from "vitest";
import { isNewerVersion, isPrerelease, UpdateService } from "../src/update/updateService";

/** One entry of the GitHub releases list. A tag carrying a `-suffix` defaults to
 * prerelease, the way this project's own releases are marked. */
const rel = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/x/y/releases/tag/${tag}`,
  published_at: "2026-08-19T16:32:04Z",
  body: "## What is New\n\nThings.",
  prerelease: tag.includes("-"),
  draft: false,
  ...extra,
});

/** The list endpoint's response: newest-first by publish date, as GitHub sends it. */
const feed = (...releases: Array<Record<string, unknown>>) =>
  new Response(JSON.stringify(releases), { status: 200, headers: { "content-type": "application/json" } });

const svc = (currentVersion: string, fetchImpl: unknown, extra: Record<string, unknown> = {}) =>
  new UpdateService({ repo: "x/y", fetchImpl: fetchImpl as typeof fetch, currentVersion, ...extra });

describe("isNewerVersion", () => {
  it("compares dotted triples, tolerating a leading v", () => {
    expect(isNewerVersion("v1.6.0", "1.4.1")).toBe(true);
    expect(isNewerVersion("1.4.2", "1.4.1")).toBe(true);
    expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
    expect(isNewerVersion("1.4.1", "1.4.1")).toBe(false);
    expect(isNewerVersion("1.4.0", "1.4.1")).toBe(false);
    expect(isNewerVersion("v1.4.1", "v1.10.0")).toBe(false);
  });

  it("treats a missing patch as .0", () => {
    expect(isNewerVersion("1.5", "1.4.9")).toBe(true);
    expect(isNewerVersion("1.5.0-rc.1", "1.4.1")).toBe(true);
  });

  it("ranks a release above its own pre-releases", () => {
    expect(isNewerVersion("1.7.0", "1.7.0-rc.1")).toBe(true);
    expect(isNewerVersion("1.7.0-rc.1", "1.7.0")).toBe(false);
    expect(isNewerVersion("1.7.0-rc.1", "1.7.0-rc.1")).toBe(false);
  });

  it("orders one release candidate against the next", () => {
    // The regression that stranded a 1.7.0-rc.1 deployment: the old comparator
    // truncated the suffix, so every rc of a version looked like the same one.
    expect(isNewerVersion("v1.7.0-rc.2", "1.7.0-rc.1")).toBe(true);
    expect(isNewerVersion("v1.7.0-rc.1", "1.7.0-rc.2")).toBe(false);
  });

  it("compares numeric identifiers as numbers, not as strings", () => {
    expect(isNewerVersion("1.7.0-rc.10", "1.7.0-rc.9")).toBe(true);
    expect(isNewerVersion("1.7.0-rc.9", "1.7.0-rc.10")).toBe(false);
  });

  it("ranks a numeric identifier below an alphanumeric one, and a prefix below its extension", () => {
    expect(isNewerVersion("1.7.0-beta", "1.7.0-1")).toBe(true);
    expect(isNewerVersion("1.7.0-rc.1.1", "1.7.0-rc.1")).toBe(true);
    expect(isNewerVersion("1.7.0-alpha", "1.7.0-beta")).toBe(false);
  });

  it("never calls an unparsable tag newer", () => {
    expect(isNewerVersion("nightly", "1.4.1")).toBe(false);
    expect(isNewerVersion("", "1.4.1")).toBe(false);
    expect(isNewerVersion("1.5.0", "nightly")).toBe(false);
  });
});

describe("isPrerelease", () => {
  it("recognises a suffixed version and nothing else", () => {
    expect(isPrerelease("1.7.0-rc.1")).toBe(true);
    expect(isPrerelease("v1.7.0-rc.2")).toBe(true);
    expect(isPrerelease("1.7.0")).toBe(false);
    expect(isPrerelease("nightly")).toBe(false);
  });
});

describe("UpdateService.check", () => {
  it("reports an available update when the newest release is newer", async () => {
    const fetchImpl = vi.fn(async () => feed(rel("v1.6.0")));
    const s = await svc("1.4.1", fetchImpl).check();
    expect(s.updateAvailable).toBe(true);
    expect(s.current).toBe("1.4.1");
    expect(s.latest).toBe("1.6.0");
    expect(s.prerelease).toBe(false);
    expect(s.releaseUrl).toContain("/releases/tag/v1.6.0");
    expect(s.releaseNotes).toContain("Things");
    expect(s.restartSupported).toBe(false);
    expect(s.error).toBeUndefined();
  });

  it("reports up-to-date when the running version matches the release", async () => {
    const s = await svc("1.6.0", vi.fn(async () => feed(rel("v1.6.0")))).check();
    expect(s.updateAvailable).toBe(false);
    expect(s.latest).toBe("1.6.0");
  });

  it("offers the next release candidate to a deployment running one", async () => {
    // The reported bug: /releases/latest hides the prerelease and answers with
    // the last stable one -- older than what is running, so never an upgrade.
    const fetchImpl = vi.fn(async () => feed(rel("v1.7.0-rc.2"), rel("v1.6.1")));
    const s = await svc("1.7.0-rc.1", fetchImpl).check();
    expect(s.latest).toBe("1.7.0-rc.2");
    expect(s.updateAvailable).toBe(true);
    expect(s.prerelease).toBe(true);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/releases?per_page=");
  });

  it("offers the finished release to a deployment running its candidate", async () => {
    const fetchImpl = vi.fn(async () => feed(rel("v1.7.0"), rel("v1.7.0-rc.2"), rel("v1.6.1")));
    const s = await svc("1.7.0-rc.1", fetchImpl).check();
    expect(s.latest).toBe("1.7.0");
    expect(s.updateAvailable).toBe(true);
    expect(s.prerelease).toBe(false);
  });

  it("never offers a pre-release to a deployment on a stable version", async () => {
    const fetchImpl = vi.fn(async () => feed(rel("v1.7.0-rc.2"), rel("v1.6.1")));
    const s = await svc("1.6.1", fetchImpl).check();
    expect(s.latest).toBe("1.6.1");
    expect(s.updateAvailable).toBe(false);
    expect(s.prerelease).toBe(false);
  });

  it("picks by version precedence, not by publish order", async () => {
    // A patch to an older line, published after the newer minor: first in the
    // list, but not the newest version.
    const fetchImpl = vi.fn(async () => feed(rel("v1.6.2"), rel("v1.7.0"), rel("v1.6.1")));
    const s = await svc("1.6.1", fetchImpl).check();
    expect(s.latest).toBe("1.7.0");
  });

  it("ignores drafts and unparsable tags", async () => {
    const fetchImpl = vi.fn(async () => feed(rel("v9.9.9", { draft: true }), rel("nightly"), rel("v1.6.0")));
    const s = await svc("1.4.1", fetchImpl).check();
    expect(s.latest).toBe("1.6.0");
  });

  it("serves cached answers until forced, then refetches", async () => {
    const fetchImpl = vi.fn(async () => feed(rel("v1.6.0")));
    const service = svc("1.4.1", fetchImpl);
    await service.check();
    await service.check();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await service.check(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces a rate-limit response as an error and does not cache it", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 403 }))
      .mockResolvedValueOnce(feed(rel("v1.6.0")));
    const service = svc("1.4.1", fetchImpl);
    const first = await service.check();
    expect(first.error).toMatch(/rate limit/i);
    expect(first.updateAvailable).toBe(false);
    expect(first.current).toBe("1.4.1"); // current is still reported on failure
    // A failed check must not stick: the next call retries and succeeds.
    const second = await service.check();
    expect(second.error).toBeUndefined();
    expect(second.updateAvailable).toBe(true);
  });

  it("survives a network failure with an error status instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.github.com");
    });
    const s = await svc("1.4.1", fetchImpl).check();
    expect(s.error).toContain("ENOTFOUND");
    expect(s.updateAvailable).toBe(false);
  });

  it("rejects a feed with nothing usable in it", async () => {
    const empty = await svc("1.4.1", vi.fn(async () => feed())).check();
    expect(empty.error).toMatch(/no usable release/);
    const untagged = await svc("1.4.1", vi.fn(async () => feed(rel("", { tag_name: undefined })))).check();
    expect(untagged.error).toMatch(/no usable release/);
    const notAList = await svc("1.4.1", vi.fn(async () => new Response("{}", { status: 200 }))).check();
    expect(notAList.error).toMatch(/unreadable body/);
  });

  it("requires an explicit operator opt-in before scheduling a restart", async () => {
    const disabled = svc("1.4.1", vi.fn(async () => feed(rel("v1.6.0"))));
    expect(() => disabled.scheduleRestart()).toThrow(/disabled/i);

    const enabled = svc("1.4.1", vi.fn(async () => feed(rel("v1.6.0"))), { restartEnabled: true });
    expect((await enabled.check()).restartSupported).toBe(true);
  });
});
