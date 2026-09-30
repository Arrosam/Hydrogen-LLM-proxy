import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useAsync } from "../src/lib/hooks";
import { useListKeys } from "../src/lib/useListKeys";

afterEach(cleanup);
it("uses the latest loader and ignores older reload results", async () => {
  let first!: (value: string) => void;
  const pending = new Promise<string>(resolve => { first = resolve; });
  const hook = renderHook(({ loader }) => useAsync(loader), { initialProps: { loader: () => pending } });
  hook.rerender({ loader: async () => "new" });
  act(() => hook.result.current.reload());
  await waitFor(() => expect(hook.result.current.data).toBe("new"));
  await act(async () => { first("old"); await pending; });
  expect(hook.result.current.data).toBe("new");
});
it("resets keys even when replacement lists have the same length", () => {
  const hook = renderHook(() => useListKeys(2));
  const before = [...hook.result.current.keys];
  act(() => hook.result.current.reset()); hook.rerender();
  expect(hook.result.current.keys).not.toEqual(before);
});
