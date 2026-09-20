import { afterEach, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useAsync } from "../src/lib/hooks";
import { useListKeys } from "../src/lib/useListKeys";
import { intInput } from "../src/lib/input";
afterEach(cleanup);
it.each([["1.5", 1], ["12.5", 12], ["0", 0], ["", 99], ["bad", 99], ["-4", 0]])("parses integer input %s", (raw, value) => {
 expect(intInput(String(raw), 99)).toBe(value);
});
it("clamps zero to the minimum rather than falling back", () => expect(intInput("0", 60000, 1000)).toBe(1000));
it("keeps the newest response and uses the latest loader", async () => {
 let old!: (value: string) => void;
 const pending = new Promise<string>(resolve => { old = resolve; });
 const {result, rerender} = renderHook(({fn}) => useAsync(fn), {initialProps: {fn: () => pending}});
 await act(async () => {});
 rerender({fn: async () => "new"});
 act(() => result.current.reload());
 await waitFor(() => expect(result.current.data).toBe("new"));
 await act(async () => { old("old"); await pending; });
 expect(result.current.data).toBe("new");
 expect(result.current.loading).toBe(false);
});
it("invalidates in-flight responses on unmount", async () => {
 let done!: (value: string) => void;
 const pending = new Promise<string>(resolve => { done = resolve; });
 const {result, unmount} = renderHook(() => useAsync(() => pending));
 await act(async () => {});
 unmount();
 await act(async () => { done("late"); await pending; });
 expect(result.current.data).toBeNull();
});
it("regenerates keys on an equal-length reset and preserves keys on move", () => {
 const {result, rerender} = renderHook(() => useListKeys(2));
 const before = [...result.current.keys];
 result.current.move(0, 1); rerender();
 expect(result.current.keys).toEqual([before[1], before[0]]);
 result.current.reset(); rerender();
 expect(result.current.keys.every(k => !before.includes(k))).toBe(true);
});

import { msToLocalInput, editedExpiry } from "../src/lib/tokenForm";
it("keeps expiry precision for unrelated edits and permits explicit change/removal",()=>{
 const original=Date.UTC(2026,8,21,1,2,35,123);expect(editedExpiry(msToLocalInput(original),original)).toBe(original);
 expect(editedExpiry("",original)).toBeNull();const changed=msToLocalInput(original+60000);expect(editedExpiry(changed,original)).toBe(new Date(changed).getTime());
});
