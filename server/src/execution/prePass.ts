import type { Request } from "../core/ir/request";
import type { ProgressRecorder } from "../observability/progressRecorder";
import type { OcrCacheStore } from "./ocrCache";
import type { ServiceStep } from "./definition";
import type { AttemptFailure } from "./steps";

/** The progress rows a pre-pass records, which is all its wording. */
export interface PrePassLabels {
  startNode: string;
  doneNode: string;
  /** Detail key the item count is reported under. */
  countKey: string;
  start(total: number, cached: number, pending: number): string;
  /** Completion message when nothing had to be transcribed. */
  doneCached: string;
  doneFresh: string;
}

export interface PrePassOptions<T> {
  /** The attachments, in the order the rewrite will consume their texts. */
  items: T[];
  hash(item: T): string;
  cache: OcrCacheStore | null;
  signal?: AbortSignal;
  /** Call `cache.store` (with nothing) even when every item was a cache hit. */
  storeWhenIdle: boolean;
  progress: ProgressRecorder | null;
  labels: PrePassLabels;
  /** Transcribe the de-duplicated misses, writing each result into `texts` by
   * hash. Returning a failure aborts the pass: nothing is stored or touched. */
  transcribe(pending: Array<{ hash: string; item: T }>, texts: Map<string, string>): Promise<AttemptFailure | undefined>;
  /** Replace the attachments with their texts (one per item, "" when unknown). */
  rewrite(texts: string[]): Request;
}

/**
 * A content-addressed attachment pre-pass (OCR for images, ASR for audio):
 * what the cache already knows is not transcribed again, the same attachment
 * given twice is one job, overlapping fills of the same hashes are serialized
 * for the whole pass (so two concurrent requests transcribe an attachment once), only non-blank results are remembered, and hits are
 * re-stamped only once the pass has succeeded, so a failed run does not extend
 * the life of entries it never used. Positions are kept by hash so the texts
 * land back on the right attachments, whatever their cache status.
 */
export async function runCachedPrePass<T>(o: PrePassOptions<T>): Promise<{ ok: true; request: Request } | AttemptFailure> {
  const { items, cache, labels } = o;
  const hashes = items.map(o.hash);
  const release = await cache?.acquire?.(hashes, o.signal);
  try {
    const known = cache ? cache.lookup(hashes) : new Map<string, string>();

    // Misses, de-duplicated: the same attachment pasted twice is one job.
    const pending: Array<{ hash: string; item: T }> = [];
    const queued = new Set<string>();
    items.forEach((item, i) => {
      const hash = hashes[i];
      if (known.has(hash) || queued.has(hash)) return;
      queued.add(hash);
      pending.push({ hash, item });
    });

    const cached = items.length - pending.length;
    o.progress?.record("agent", labels.startNode, labels.start(items.length, cached, pending.length), {
      [labels.countKey]: items.length,
      cached,
      pending: pending.length,
    });

    const texts = new Map(known);
    const failure = await o.transcribe(pending, texts);
    if (failure) return failure;
    if (pending.length > 0 || o.storeWhenIdle) {
      // Only what the model actually produced is remembered: caching an empty
      // result would make one bad response that attachment's permanent text.
      cache?.store(pending
        .map((job) => ({ hash: job.hash, description: texts.get(job.hash) ?? "" }))
        .filter((entry) => entry.description.trim() !== ""));
    }
    const hits = [...known.keys()];
    if (hits.length > 0) cache?.touch(hits);

    const request = o.rewrite(hashes.map((h) => texts.get(h) ?? ""));
    o.progress?.record("agent", labels.doneNode, pending.length === 0 ? labels.doneCached : labels.doneFresh);
    return { ok: true, request };
  } finally {
    release?.();
  }
}

/** A pre-pass or stage names its model one of two ways: a saved service, or
 * inline steps. Neither is a configuration error (`missing`). */
export function refOrInline<T>(
  ref: { service?: string; steps?: ServiceStep[] },
  byName: (name: string) => { ok: true; value: T } | { ok: false; message: string },
  inline: (steps: ServiceStep[]) => T,
  missing: string,
): { ok: true; value: T } | { ok: false; message: string } {
  if (ref.service) return byName(ref.service);
  if (ref.steps && ref.steps.length) return { ok: true, value: inline(ref.steps) };
  return { ok: false, message: missing };
}
