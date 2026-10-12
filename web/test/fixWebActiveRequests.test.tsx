/** WB12: the ActiveRequests page's three small lies. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { ActiveRequests } from "../src/pages/ActiveRequests";
import { API } from "../src/lib/endpoints";
import { ADMIN, fail, mockApi, openModal, renderPage, type Routes } from "./helpers";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const tick = (ms = 0) => act(async () => {
  vi.advanceTimersByTime(ms);
  await new Promise((r) => setTimeout(r, 0));
});
const request = (traceId: string, extra: Record<string, unknown> = {}) => ({
  traceId, tokenId: 1, serviceId: 10, serviceName: "svc-a", ingress: "openai", streaming: false, startedAt: 1, updatedAt: 2,
  elapsedMs: 1500, blocked: false, done: false, httpStatus: null, error: null, eventCount: 0, lastPhase: "llm", lastNode: "n",
  lastMessage: "m", lastEventTs: 2, events: [], ...extra,
});
const LIST = "/active-requests";
const setup = async (list: unknown, routes: Routes = {}) => {
  const api = mockApi({ [`GET ${LIST}`]: list, ...routes }, ADMIN);
  const view = await renderPage(<ActiveRequests />);
  await tick();
  return { api, ...view };
};
const status = (container: HTMLElement) => container.querySelector(".mb-4 > span")!.textContent;
const tiles = (within: ParentNode) => Object.fromEntries([...within.querySelectorAll(".grid.grid-cols-3 > div")].map((d) => [d.children[0].textContent, d.children[1].textContent]));

describe("ActiveRequests", () => {
  it("a finished request without a recorded status shows a dash, not the word null", async () => {
    const done = request("tr-1", { done: true, httpStatus: null });
    const { container } = await setup({ active: [done], completed: [], blockThresholdMs: 30_000, now: 3 }, { [`GET ${LIST}/tr-1`]: { request: done, blockThresholdMs: 30_000 } });
    fireEvent.click(container.querySelector("tbody tr")!);
    const m = await waitFor(() => openModal("Trace tr-1"));
    expect(tiles(m).Status).toBe("-");
  });

  it("asks for a trace's detail with the id percent-encoded", async () => {
    const id = "a/b?c#d e";
    expect(API.activeRequest(id)).toBe("/active-requests/a%2Fb%3Fc%23d%20e");
    const tricky = request(id);
    const { api, container } = await setup({ active: [tricky], completed: [], blockThresholdMs: 30_000, now: 3 }, { "GET /active-requests/a%2Fb%3Fc%23d%20e": { request: tricky, blockThresholdMs: 30_000 } });
    fireEvent.click(container.querySelector("tbody tr")!);
    await waitFor(() => openModal(`Trace ${id}`));
    expect(api.calls.at(-1)!.path).toBe("/active-requests/a%2Fb%3Fc%23d%20e");
  });

  it("stops saying 'loading...' once the first load has failed", async () => {
    const { container } = await setup(fail(500, { error: "db down" }));
    expect(container.querySelector(".border-red-900\\/50")!.textContent).toBe("db down");
    expect(status(container)).toBe("");
  });
});
