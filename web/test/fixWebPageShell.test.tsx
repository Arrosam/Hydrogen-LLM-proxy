/**
 * WB14: the Proxies page drew the Providers icon instead of its own nav icon,
 * and Proxies and Model Bench were the only pages without a header while
 * loading or after a failed load.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ResourcePage } from "../src/components/Page";
import { ENTITY_ICON } from "../src/lib/icons";
import { ROUTES } from "../src/lib/routes";
import { ModelBench } from "../src/pages/ModelBench";
import { Proxies } from "../src/pages/Proxies";
import type { Proxy } from "../src/types";
import { ADMIN, button, classes, cls, deferred, fail, hasButton, mockApi, openModal, renderPage } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const spinner = () => document.querySelector(".animate-spin");
const errorNote = () => document.querySelector(".border-red-900\\/50.px-4");
const LOCAL: Proxy = { id: 3, name: "local", scheme: "http", host: "127.0.0.1", port: 7890, username: null, hasPassword: false, enabled: true, createdAt: 1 };

describe("Proxies page", () => {
  it("draws the icon of its nav entry everywhere: header, cards, dialog and empty state", async () => {
    const nav = ROUTES.find((r) => r.id === "proxies")!.icon;
    expect(nav).toBe("bi-shuffle");
    expect(ENTITY_ICON.proxy).toBe(nav);
    const api = mockApi({ "GET /proxies": { proxies: [LOCAL] } }, ADMIN);
    const { container, unmount } = await renderPage(<Proxies />);
    await screen.findByText("local");
    expect(classes(container.querySelector("h1 i"))).toEqual(cls("bi bi-shuffle text-brand-400"));
    expect(classes(screen.getByText("local").closest(".card")!.querySelector("i"))).toEqual(cls("bi bi-shuffle text-brand-400"));
    fireEvent.click(button("New proxy"));
    expect(classes(openModal("New proxy").querySelector("h2 i"))).toEqual(cls("bi bi-shuffle text-brand-400"));
    unmount();
    api.on("GET /proxies", { proxies: [] });
    await renderPage(<Proxies />);
    const empty = await screen.findByText("No proxies yet");
    expect(classes(empty.parentElement!.querySelector("i"))).toEqual(cls("bi bi-shuffle text-4xl text-ink-600"));
  });

  it("shows its header, with New, above the spinner while loading", async () => {
    const gate = deferred<unknown>();
    mockApi({ "GET /proxies": () => gate.promise }, ADMIN);
    const { container } = await renderPage(<Proxies />);
    expect(container.querySelector("h1")!.textContent).toBe("Proxies");
    expect(hasButton("New proxy")).toBe(true);
    expect(spinner()).not.toBeNull();
    expect(screen.getByText("Loading proxies…")).toBeTruthy();
    await act(async () => { gate.resolve({ proxies: [] }); });
    await screen.findByText("No proxies yet");
    expect(spinner()).toBeNull();
  });

  it("shows its header above the error after a failed load", async () => {
    mockApi({ "GET /proxies": fail(500, { error: "db down" }) }, ADMIN);
    const { container } = await renderPage(<Proxies />);
    await waitFor(() => expect(errorNote()).not.toBeNull());
    expect(errorNote()!.textContent).toBe("db down");
    expect(container.querySelector("h1")!.textContent).toBe("Proxies");
  });
});

describe("Model Bench page", () => {
  const routes = (targets: unknown) => ({ "GET /bench/targets": targets, "GET /tokens": { tokens: [] } });

  it("shows its header above the spinner while the targets load, and the form only once they are in", async () => {
    const gate = deferred<unknown>();
    mockApi(routes(() => gate.promise), ADMIN);
    const { container } = await renderPage(<ModelBench />);
    expect(container.querySelector("h1")!.textContent).toBe("Model Bench");
    expect(button("Send").disabled).toBe(true);
    expect(spinner()!.parentElement!.textContent).toBe("Loading targets…");
    expect(container.querySelector(".card")).toBeNull();
    await act(async () => { gate.resolve({ services: [], mappings: [] }); });
    await waitFor(() => expect(container.querySelector(".card")).not.toBeNull());
    expect(document.querySelector(".py-16 .animate-spin")).toBeNull();
  });

  it("shows its header above the error, and no form, when the targets fail", async () => {
    mockApi(routes(fail(500, { error: "db down" })), ADMIN);
    const { container } = await renderPage(<ModelBench />);
    await waitFor(() => expect(errorNote()).not.toBeNull());
    expect(errorNote()!.textContent).toBe("db down");
    expect(container.querySelector("h1")!.textContent).toBe("Model Bench");
    expect(container.querySelector(".card")).toBeNull();
  });
});

describe("ResourcePage bodyWhenLoaded", () => {
  const body = <section>body</section>;
  it.each([
    ["while loading", { data: null, loading: true, error: null }, ["T", ""]],
    ["after a failed load", { data: null, loading: false, error: "down" }, ["T", "down"]],
    ["once loaded", { data: [1], loading: false, error: null }, ["T", "body"]],
    ["during a reload", { data: [1], loading: true, error: null }, ["T", "", "body"]],
  ])("%s", (_name, state, expected) => {
    const { container } = render(<ResourcePage title="T" bodyWhenLoaded state={state}>{body}</ResourcePage>);
    expect([...container.firstElementChild!.children].map((c) => c.textContent)).toEqual(expected);
  });

  it("without it the body is there from the first paint", () => {
    render(<ResourcePage title="T" state={{ data: null, loading: true, error: null }}>{body}</ResourcePage>);
    expect(screen.getByText("body")).toBeTruthy();
  });
});
