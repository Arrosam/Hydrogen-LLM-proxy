import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerToolPrefixCard } from "../src/components/ServerToolPrefixCard";
import { I18nProvider } from "../src/lib/i18n";

const success = vi.fn(), toastError = vi.fn();
vi.mock("../src/components/Toast", () => ({ useToast: () => ({ success, error: toastError }) }));
let stored: string;
let failRead: boolean;
let failSave: boolean;
let writes: string[];
const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
  let status = 200;
  let result: unknown;
  if (url === "/admin/api/settings/ui-language") result = { language: "en" };
  else if (url === "/admin/api/settings/server-tool-name-prefix") {
    if (init.method === "PUT") {
      const prefix = JSON.parse(String(init.body)).prefix;
      writes.push(prefix);
      if (failSave) { status = 500; result = { error: "Fixture save failed" }; }
      else { stored = prefix; result = { prefix: stored }; }
    } else if (failRead) { status = 503; result = { error: "Fixture load failed" }; }
    else result = { prefix: stored };
  } else throw new Error(`Unexpected request: ${url}`);
  return new Response(JSON.stringify(result), { status, headers: { "content-type": "application/json" } });
});
beforeEach(() => {
  stored = "provider_server_side_"; failRead = false; failSave = false; writes = [];
  localStorage.clear(); vi.clearAllMocks(); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function card() { return render(<I18nProvider><ServerToolPrefixCard /></I18nProvider>); }
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save prefix" }));

describe("server tool name prefix settings UI", () => {
  it.each(["", "Case-Sensitive_9"])("saves exact prefix %j and reloads it from persistence", async prefix => {
    const view = card();
    const input = await screen.findByLabelText("Server tool name prefix");
    expect((input as HTMLInputElement).value).toBe("provider_server_side_");
    fireEvent.change(input, { target: { value: prefix } });
    save();
    await screen.findByRole("status");
    expect(writes).toEqual([prefix]);
    expect(stored).toBe(prefix);
    view.unmount();
    card();
    expect(((await screen.findByLabelText("Server tool name prefix")) as HTMLInputElement).value).toBe(prefix);
  });

  it.each([" padded_", "bad.prefix", "x".repeat(65)])("rejects invalid prefix %j without saving and accepts a corrected value", async invalid => {
    card();
    const input = await screen.findByLabelText("Server tool name prefix");
    fireEvent.change(input, { target: { value: invalid } });
    save();
    expect(screen.getByRole("alert").textContent).toMatch(/at most 64/);
    expect(writes).toEqual([]);
    expect((input as HTMLInputElement).value).toBe(invalid);
    fireEvent.change(input, { target: { value: "valid_" } });
    save();
    await screen.findByRole("status");
    expect(writes).toEqual(["valid_"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("retains the unsaved draft after a server failure and permits retry", async () => {
    failSave = true;
    card();
    const input = await screen.findByLabelText("Server tool name prefix");
    fireEvent.change(input, { target: { value: "retry_" } });
    save();
    expect((await screen.findByRole("alert")).textContent).toBe("Fixture save failed");
    expect((input as HTMLInputElement).value).toBe("retry_");
    expect(stored).toBe("provider_server_side_");
    failSave = false;
    save();
    await screen.findByRole("status");
    expect(writes).toEqual(["retry_", "retry_"]);
    expect(stored).toBe("retry_");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("recovers from an initial load error with an explicit retry", async () => {
    failRead = true;
    card();
    await screen.findByText("Fixture load failed");
    expect(screen.queryByLabelText("Server tool name prefix")).toBeNull();
    failRead = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry loading prefix" }));
    await screen.findByLabelText("Server tool name prefix");
    expect(screen.queryByText("Fixture load failed")).toBeNull();
  });

  it("resets an invalid draft to the last saved prefix including empty", async () => {
    stored = "";
    card();
    const input = await screen.findByLabelText("Server tool name prefix");
    fireEvent.change(input, { target: { value: "bad prefix" } });
    save();
    fireEvent.click(screen.getByRole("button", { name: "Reset to saved prefix" }));
    expect((input as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(writes).toEqual([]);
    save();
    await waitFor(() => expect(stored).toBe(""));
  });
});
