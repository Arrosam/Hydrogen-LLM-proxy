/** WB3, WB5, WB6: the small lib helpers. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "../src/lib/clipboard";
import { relativeTime } from "../src/lib/format";
import { editedExpiry } from "../src/lib/tokenForm";

afterEach(() => {
  vi.useRealTimers();
});

describe("WB3 clipboard legacy copy", () => {
  const doc = document as unknown as { execCommand?: unknown };
  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
    Reflect.deleteProperty(window, "isSecureContext");
    delete doc.execCommand;
    document.body.innerHTML = "";
  });

  it("removes the textarea holding the text when execCommand throws", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    doc.execCommand = vi.fn(() => { throw new Error("blocked"); });
    await expect(copyToClipboard("hk_secret")).resolves.toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("removes it when execCommand does not exist at all", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    await expect(copyToClipboard("hk_secret")).resolves.toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });
});

describe("WB5 editedExpiry", () => {
  it.each([["not a date"], ["2027-13-45T99:99"], ["tomorrow"]])("answers undefined, not NaN, for the unparsable %s", (input) => {
    expect(editedExpiry(input)).toBeUndefined();
    expect(editedExpiry(input, new Date(2026, 8, 21, 9, 5).getTime())).toBeUndefined();
  });

  it("still answers null for an emptied field and a number for a date", () => {
    expect(editedExpiry("")).toBeNull();
    expect(editedExpiry("2027-01-02T03:04")).toBe(new Date(2027, 0, 2, 3, 4).getTime());
  });
});

describe("WB6 relativeTime", () => {
  const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
  it.each([[1], [400], [5_000], [3_600_000], [86_400_000 * 3]])("a timestamp %i ms in the future reads like now, never negative", (ahead) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(relativeTime(NOW + ahead)).toBe(relativeTime(NOW));
    expect(relativeTime(NOW + ahead)).not.toContain("-");
  });
});
