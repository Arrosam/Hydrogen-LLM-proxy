import fs from "node:fs";
import { APP_VERSION } from "../util/version";

/**
 * Release check + restart-to-upgrade.
 *
 * Hydrogen ships as a container image; the proxy cannot swap its own binaries.
 * What it CAN do is (1) tell the admin a newer release exists, and (2) shut
 * itself down cleanly when an operator explicitly enables that capability.
 * Runtime detection is informational only: a normal Docker restart reuses the
 * existing container image, and a bare Node process may have no supervisor at
 * all. Deployments that cannot guarantee a new supervised start get manual
 * instructions instead of a remote kill switch.
 *
 * The version check calls the GitHub releases API. Results are cached so the
 * Settings page can poll freely without tripping GitHub's unauthenticated
 * rate limit (60 requests/hour/IP).
 */

export interface UpdateStatus {
  /** Version of the running server (inlined from package.json at build time). */
  current: string;
  /** Newest release tag, with any leading "v" stripped. Null when the check failed. */
  latest: string | null;
  /** True only when `latest` is a strictly newer semver than `current`. */
  updateAvailable: boolean;
  releaseUrl: string | null;
  /** Release notes (markdown), truncated for transport. */
  releaseNotes: string | null;
  publishedAt: string | null;
  /** Whether the offered release is a pre-release. Only a deployment already
   * running one is ever offered one, but the UI still says so plainly. */
  prerelease: boolean;
  /** When the underlying GitHub fetch happened (ms epoch) — cached answers keep it. */
  checkedAt: number;
  /** How the server is running, so the UI can word the upgrade step honestly. */
  runtime: "kubernetes" | "docker" | "node";
  /** True only when the operator explicitly confirmed that a supervisor will
   * restart this process onto the intended deployment version. */
  restartSupported: boolean;
  /** Present when the GitHub check failed; `current` is still filled in. */
  error?: string;
}

/** A version parsed into its precedence parts: the numeric core, plus the
 * dot-separated pre-release identifiers when the tag carries a `-suffix`. */
interface ParsedVersion {
  core: [number, number, number];
  /** null for a normal release; a release always outranks its own pre-releases. */
  pre: string[] | null;
}

/** Parse a tag into comparable parts. Tolerates a leading "v", a missing patch,
 * and trailing build metadata. Null for anything unparsable. */
export function parseVersion(v: string): ParsedVersion | null {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)],
    pre: m[4] ? m[4].split(".") : null,
  };
}

/** Whether a version is a pre-release (1.7.0-rc.1) rather than a normal release.
 * This is what decides which channel a deployment is offered. */
export function isPrerelease(v: string): boolean {
  return parseVersion(v)?.pre != null;
}

/** Semver pre-release precedence: identifier by identifier, numeric ones
 * compared as numbers and ranking below alphanumeric ones, and a shorter set of
 * identifiers ranking below a longer one that shares its prefix. */
function comparePre(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return Number(x) < Number(y) ? -1 : 1;
    if (xNum !== yNum) return xNum ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Order two versions: -1, 0 or 1. An unparsable version compares as 0 and is
 * therefore never "newer" -- a garbage tag must not trigger the upgrade banner.
 *
 * Pre-releases are ordered rather than truncated away, which is what the old
 * comparator did: it read 1.7.0-rc.1 and 1.7.0-rc.2 as the same version, so an
 * operator running a release candidate was never offered the next one -- nor
 * the final 1.7.0, which it also read as equal, leaving the deployment stranded
 * on every future release of that line.
 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i] ? 1 : -1;
  }
  // Same core: the release itself outranks every pre-release of it.
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return comparePre(x.pre, y.pre);
}

/** True when `candidate` is strictly newer than `base`. */
export function isNewerVersion(candidate: string, base: string): boolean {
  return compareVersions(candidate, base) > 0;
}

function detectRuntime(): UpdateStatus["runtime"] {
  if (process.env.KUBERNETES_SERVICE_HOST) return "kubernetes";
  try {
    if (fs.existsSync("/.dockerenv")) return "docker";
  } catch {
    /* ignore */
  }
  return "node";
}

const CACHE_TTL_MS = 10 * 60 * 1000;
/** Releases read per check. GitHub returns them newest-first by publish date;
 * a page this size covers the window in which a still-current version could
 * be the newest, and the pick inside it is by precedence, not by position. */
const RELEASE_PAGE_SIZE = 30;
const NOTES_MAX_CHARS = 4000;
const FETCH_TIMEOUT_MS = 10_000;

export interface UpdateServiceOptions {
  /** "owner/name" GitHub repository whose releases are checked. */
  repo: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to APP_VERSION. */
  currentVersion?: string;
  cacheTtlMs?: number;
  /** Explicit operator opt-in; false by default because runtime detection alone
   * cannot prove that a restart will recreate or upgrade the deployment. */
  restartEnabled?: boolean;
}

export class UpdateService {
  private readonly repo: string;
  private readonly fetchImpl: typeof fetch;
  private readonly current: string;
  private readonly cacheTtlMs: number;
  readonly restartSupported: boolean;
  private cached: UpdateStatus | null = null;

  constructor(opts: UpdateServiceOptions) {
    this.repo = opts.repo;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.current = opts.currentVersion ?? APP_VERSION;
    this.cacheTtlMs = opts.cacheTtlMs ?? CACHE_TTL_MS;
    this.restartSupported = opts.restartEnabled === true;
  }

  /** Latest-release status, cached. `force` refetches (the "Check now" button). */
  async check(force = false): Promise<UpdateStatus> {
    if (!force && this.cached && Date.now() - this.cached.checkedAt < this.cacheTtlMs) {
      return this.cached;
    }
    const status = await this.fetchStatus();
    // A failed check is not worth caching: the next click should retry.
    if (!status.error) this.cached = status;
    return status;
  }

  private base(): UpdateStatus {
    return {
      current: this.current,
      latest: null,
      updateAvailable: false,
      releaseUrl: null,
      releaseNotes: null,
      publishedAt: null,
      prerelease: false,
      checkedAt: Date.now(),
      runtime: detectRuntime(),
      restartSupported: this.restartSupported,
    };
  }

  private async fetchStatus(): Promise<UpdateStatus> {
    const out = this.base();
    let res: Response;
    try {
      res = await this.fetchImpl(`https://api.github.com/repos/${this.repo}/releases?per_page=${RELEASE_PAGE_SIZE}`, {
        headers: {
          accept: "application/vnd.github+json",
          // GitHub rejects requests without a User-Agent.
          "user-agent": `hydrogen-llm-proxy/${this.current}`,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      out.error = `update check failed: ${e instanceof Error ? e.message : String(e)}`;
      return out;
    }
    if (!res.ok) {
      out.error =
        res.status === 403 || res.status === 429
          ? `GitHub API rate limit hit (${res.status}); try again later`
          : `GitHub API returned ${res.status}`;
      return out;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      out.error = "GitHub API returned an unreadable body";
      return out;
    }
    if (!Array.isArray(body)) {
      out.error = "GitHub API returned an unreadable body";
      return out;
    }
    const best = this.pickRelease(body);
    if (!best) {
      out.error = "GitHub API listed no usable release";
      return out;
    }
    const tag = String(best.tag_name);
    out.latest = tag.replace(/^v/, "");
    out.prerelease = best.prerelease === true;
    out.updateAvailable = isNewerVersion(tag, this.current);
    out.releaseUrl = typeof best.html_url === "string" ? best.html_url : null;
    out.publishedAt = typeof best.published_at === "string" ? best.published_at : null;
    const notes = typeof best.body === "string" ? best.body : "";
    out.releaseNotes = notes ? notes.slice(0, NOTES_MAX_CHARS) : null;
    return out;
  }

  /**
   * The newest release this deployment may be offered.
   *
   * `/releases/latest` was the wrong question to ask GitHub: it hides
   * pre-releases entirely, so a deployment running 1.7.0-rc.1 was told the
   * newest release was the last STABLE one -- an OLDER version than the one it
   * was running, and so never an upgrade, however many release candidates had
   * shipped since.
   *
   * The full list is read instead and the pick is by version precedence rather
   * than by publish order, because a patch to an older line can be published
   * after a newer minor and would otherwise win on position alone.
   *
   * A pre-release is offered only to a deployment already running one. An
   * operator on a stable version therefore stays on the stable channel with
   * nothing to configure -- which is the one thing `/releases/latest` did give
   * for free, and is worth keeping.
   */
  private pickRelease(releases: unknown[]): Record<string, unknown> | null {
    const allowPrerelease = isPrerelease(this.current);
    let best: Record<string, unknown> | null = null;
    for (const raw of releases) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      // Drafts are invisible to an unauthenticated read anyway; skipped so an
      // authenticated one cannot be offered something unpublished.
      if (r.draft === true) continue;
      if (r.prerelease === true && !allowPrerelease) continue;
      if (typeof r.tag_name !== "string" || !parseVersion(r.tag_name)) continue;
      if (!best || isNewerVersion(r.tag_name, String(best.tag_name))) best = r;
    }
    return best;
  }


  /**
   * Restart-to-upgrade: reply first, then raise SIGTERM so index.ts runs its
   * normal graceful shutdown (close the listener, close SQLite, exit 0). The
   * configured supervisor starts the replacement. This is available only after
   * explicit operator opt-in; the delay lets the HTTP response leave the socket
   * first.
   */
  scheduleRestart(delayMs = 500): void {
    if (!this.restartSupported) {
      throw new Error("remote restart is disabled; set UPDATE_RESTART_ENABLED=true only for a supervised deployment");
    }
    const t = setTimeout(() => {
      try {
        process.kill(process.pid, "SIGTERM");
      } catch {
        process.exit(0);
      }
    }, delayMs);
    t.unref?.();
  }
}
