import crypto from "node:crypto";
import type { ImagePart } from "../core/ir/content";
import type { ImageCacheRepo } from "../persistence/imageCacheRepo";

/**
 * The image-description cache behind the Micro Agent's OCR pre-pass, expressed
 * as the narrow port the agent actually needs. The agent depends on this
 * interface, not on the repository, so the cache can be switched off, stubbed in
 * a test, or re-pointed without the execution layer knowing about SQLite.
 */
export interface OcrCacheStore {
  /** Whether caching is on right now — the budget is a runtime setting and 0
   * means off, so this is asked per request rather than at construction. */
  enabled(): boolean;
  /** Serialize overlapping cache fills; the caller must release in finally. */
  acquire?(hashes: string[], signal?: AbortSignal): Promise<() => void>;
  /** Descriptions already known for these hashes; absent keys are misses. */
  lookup(hashes: string[]): Map<string, string>;
  /** Mark hits as just-used so eviction treats them as fresh. */
  touch(hashes: string[]): void;
  /** Remember freshly transcribed descriptions, evicting to stay in budget. */
  store(entries: Array<{ hash: string; description: string }>): void;
}

/** Version tag in the hash preimage. Bumping it invalidates every cached
 * description at once, which is the escape hatch if what we hash ever changes. */
const HASH_VERSION = "hydrogen-image-v1";

/**
 * A stable content address for an image.
 *
 * Base64 images hash their DECODED bytes plus the media type, so the same
 * picture keys the same entry whichever wire format delivered it (an OpenAI
 * `data:image/png;base64,...` URL and an Anthropic `{media_type, data}` block
 * both normalize to the same source before they get here).
 *
 * A URL image can only be addressed by its URL — the proxy never fetches it. If
 * the bytes behind that URL change, the cached description goes stale; that is
 * the price of not downloading every referenced image, and the LRU budget bounds
 * how long such an entry can linger.
 */
/** How much base64 is decoded per hash update. The slice boundary is a
 * multiple of 4, so the decoded bytes are byte-for-byte what a whole-string
 * decode produces -- the point is that a large image never has to be
 * materialized as one big Buffer just to be content-addressed. */
const HASH_DECODE_CHUNK = 256 * 1024;

function updateWithBase64(h: crypto.Hash, data: string): void {
  for (let i = 0; i < data.length; i += HASH_DECODE_CHUNK) {
    h.update(Buffer.from(data.slice(i, i + HASH_DECODE_CHUNK), "base64"));
  }
}

export function imageHash(img: ImagePart): string {
  const h = crypto.createHash("sha256");
  h.update(HASH_VERSION);
  h.update("\n");
  if (img.source.kind === "url") {
    h.update("url\n");
    h.update(img.source.url);
  } else {
    h.update("b64\n");
    h.update(img.source.mediaType);
    h.update("\n");
    updateWithBase64(h, img.source.data);
  }
  return h.digest("hex");
}

/**
 * The live cache: an {@link ImageCacheRepo} bound to the runtime storage budget.
 * The budget is read through a getter on every call so changing it in the
 * dashboard takes effect on the next request, with no restart.
 *
 * Every operation is fail-safe. A cache is an optimization, so a database fault
 * has to degrade the pre-pass to "transcribe it again" — never fail a request
 * that the OCR model itself answered perfectly well.
 */
export class ImageDescriptionCache implements OcrCacheStore {
  private readonly fills = new Map<string, Promise<void>>();

  async acquire(hashes: string[], signal?: AbortSignal): Promise<() => void> {
    if (!this.enabled()) return () => {};
    signal?.throwIfAborted();
    const releases: Array<() => void> = [];
    const waits: Promise<void>[] = [];
    for (const hash of new Set(hashes)) {
      const previous = this.fills.get(hash) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const tail = previous.then(() => gate);
      this.fills.set(hash, tail);
      waits.push(previous);
      releases.push(() => {
        release();
        void tail.then(() => { if (this.fills.get(hash) === tail) this.fills.delete(hash); });
      });
    }
    let abort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal?.reason ?? new Error("OCR wait aborted"));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    try {
      await Promise.race([Promise.all(waits), cancelled]);
      signal?.throwIfAborted();
      return () => releases.forEach(release => release());
    } catch (error) {
      releases.forEach(release => release());
      throw error;
    } finally { if (abort) signal?.removeEventListener("abort", abort); }
  }

  constructor(
    private readonly repo: ImageCacheRepo,
    private readonly maxBytes: () => number,
    private readonly now: () => number = Date.now,
    private readonly onError: (op: string, err: unknown) => void = warnOnce,
  ) {}

  enabled(): boolean {
    return this.maxBytes() > 0;
  }

  lookup(hashes: string[]): Map<string, string> {
    if (!this.enabled()) return new Map();
    try {
      return this.repo.lookup(hashes);
    } catch (e) {
      this.onError("lookup", e);
      return new Map(); // every image counts as a miss
    }
  }

  touch(hashes: string[]): void {
    if (!this.enabled() || hashes.length === 0) return;
    try {
      this.repo.touch(hashes, this.now());
    } catch (e) {
      // The entries keep their old timestamps and age out sooner than they
      // deserve. Harmless.
      this.onError("touch", e);
    }
  }

  store(entries: Array<{ hash: string; description: string }>): void {
    // Nothing to write when the cache is off — emptying it is the settings
    // route's job (on the change), not every request's.
    if (!this.enabled() || entries.length === 0) return;
    try {
      this.repo.put(entries, this.now(), this.maxBytes());
    } catch (e) {
      this.onError("store", e);
    }
  }
}

/** One warning per failing operation. A broken database would otherwise print a
 * line per request, burying whatever else is going wrong. */
const warned = new Set<string>();
function warnOnce(op: string, err: unknown): void {
  if (warned.has(op)) return;
  warned.add(op);
  // eslint-disable-next-line no-console
  console.warn(`[image-cache] ${op} failed, continuing without the cache:`, err instanceof Error ? err.message : err);
}
