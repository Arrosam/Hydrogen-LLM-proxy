import { afterEach, beforeEach, vi } from "vitest";

/** jsdom has no layout. Supply a scroll viewport for Headless UI's real virtualizer;
 * functional browser checks separately verify positioning and scrolling. */
export function comboboxLayout() {
  let restore: () => void;
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.getAttribute("role") === "listbox" ? 240 : 40; });
    const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    restore = () => {
      height.mockRestore(); width.mockRestore();
      if (scroll) Object.defineProperty(HTMLElement.prototype, "scrollTo", scroll);
      else delete (HTMLElement.prototype as unknown as { scrollTo?: unknown }).scrollTo;
    };
  });
  afterEach(() => restore());
}
