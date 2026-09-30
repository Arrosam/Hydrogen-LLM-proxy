export interface QuotaLease { retain(): () => void; release(): void }

/** Ref-counted admission reservation: raw response completion does not end a
 * detached model job or streaming relay's accounting. */
export function quotaLease(onRelease: () => void): QuotaLease {
  let holds = 1;
  let initialReleased = false;
  const releaseOne = () => { if (--holds === 0) onRelease(); };
  return {
    retain() {
      holds++;
      let released = false;
      return () => { if (!released) { released = true; releaseOne(); } };
    },
    release() { if (!initialReleased) { initialReleased = true; releaseOne(); } },
  };
}
