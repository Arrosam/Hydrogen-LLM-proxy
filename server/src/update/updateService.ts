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

/** Compare two dotted versions; true when `candidate` is strictly newer than `base`.
 * Tolerates a leading "v" and ignores pre-release/build suffixes. Unparsable
 * versions are never "newer" — a garbage tag must not trigger the upgrade banner. */
export function isNewerVersion(candidate: string, base: string): boolean {
  const parse = (v: string): number[] | null => {
    const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
  };
  const a = parse(candidate);
  const b = parse(base);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
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
      checkedAt: Date.now(),
      runtime: detectRuntime(),
      restartSupported: this.restartSupported,
    };
  }

  private async fetchStatus(): Promise<UpdateStatus> {
    const out = this.base();
    let res: Response;
    try {
      res = await this.fetchImpl(`https://api.github.com/repos/${this.repo}/releases/latest`, {
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
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      out.error = "GitHub API returned an unreadable body";
      return out;
    }
    const tag = typeof body.tag_name === "string" ? body.tag_name : "";
    if (!tag) {
      out.error = "GitHub API response carried no release tag";
      return out;
    }
    out.latest = tag.replace(/^v/, "");
    out.updateAvailable = isNewerVersion(tag, this.current);
    out.releaseUrl = typeof body.html_url === "string" ? body.html_url : null;
    out.publishedAt = typeof body.published_at === "string" ? body.published_at : null;
    const notes = typeof body.body === "string" ? body.body : "";
    out.releaseNotes = notes ? notes.slice(0, NOTES_MAX_CHARS) : null;
    return out;
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
