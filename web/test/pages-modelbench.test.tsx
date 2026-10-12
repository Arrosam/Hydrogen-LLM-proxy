/**
 * Characterization of the Model Bench page, part one: loading, every control
 * of the request side with its default, and the exact request each transport
 * sends. The result side is in pages-modelbench-results.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { formatNumber } from "../src/lib/format";
import { loremOfTokens } from "../src/lib/lorem";
import { ADMIN, MANAGER, button, classes, cls, deferred, fail, field, hasButton, isOn, labelEl, toastShown, toasts, toggle, type } from "./helpers";
import {
  DEFAULT_PROMPT, HINT, JSON_HEADERS, PAGE_TITLE, SEG_OFF, SEG_ON, SERVICE_1, TARGETS, USER_TEXT, XS,
  addParam, attach, attachmentRows, bodyPanel, chatReq, errorNote, file, fileInput, jsonResponse, loaded, options, paramRows, paramValues, paramsBox,
  pick, pretty, secret, section, sel, send, sendTo, sentJson, setup, spinner, sseOf, viaProxy,
} from "./modelbench-harness";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const FORMAT = "Model format (what the bench speaks)";
const PROVIDER_FORMAT = "Provider format (which endpoint is called)";
const ATTACHMENTS = "Attachments (image, PDF, audio…)";
const FAMILIES = ["openai_completion", "anthropic", "openai_responses"];
const PNG = file("dot.png", "image/png", [1, 2, 3]);
const PDF = file("doc.pdf", "application/pdf", [104, 105]);
const PNG_URL = "data:image/png;base64,AQID";
const PDF_URL = "data:application/pdf;base64,aGk=";
const bodyOf = (call: { body: unknown }) => (call.body as { body: Record<string, unknown> }).body;

// ---------------------------------------------------------------------------

describe("ModelBench page: loading", () => {
  it("loads the targets and the keys", async () => {
    const { api } = await loaded();
    expect(api.calls.filter((c) => c.path !== "/me" && c.path !== "/settings/ui-language").map((c) => `${c.method} ${c.path}`).sort())
      .toEqual(["GET /bench/targets", "GET /tokens"]);
  });

  // Like the list pages: the header from the first paint; the form waits for the targets.
  it("shows the header (Send disabled) above a labelled spinner while the targets load - no form yet", async () => {
    const gate = deferred<unknown>();
    const { container } = await setup({ "GET /bench/targets": () => gate.promise });
    expect(container.querySelector("h1")!.textContent).toBe("Model Bench");
    expect(button("Send").disabled).toBe(true);
    expect(container.querySelector(".card")).toBeNull();
    const wrap = spinner()!.parentElement!;
    expect(classes(wrap)).toEqual(cls("flex items-center justify-center gap-2 py-16 text-ink-400"));
    expect(classes(spinner())).toEqual(cls("bi bi-arrow-repeat animate-spin text-xl"));
    expect(wrap.textContent).toBe("Loading targets…");
    expect(classes(wrap.querySelector("span"))).toEqual(cls("text-sm"));
    await act(async () => { gate.resolve(TARGETS); });
    await waitFor(() => expect(container.querySelector(".card")).not.toBeNull());
    expect(spinner()).toBeNull();
  });

  it.each([
    ["the server's message", fail(500, { error: "db down" }), "db down"],
    ["the error's own message for a non-API failure", () => { throw new TypeError("offline"); }, "offline"],
  ])("shows %s under the header when the targets fail - no form", async (_name, handler, text) => {
    const { container } = await setup({ "GET /bench/targets": handler });
    await waitFor(() => expect(errorNote()).not.toBeNull());
    expect(errorNote()!.textContent).toBe(text);
    expect(classes(errorNote())).toEqual(cls("flex items-center gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300"));
    expect(container.querySelector("h1")!.textContent).toBe("Model Bench");
    expect(spinner()).toBeNull();
    expect(container.querySelector(".card")).toBeNull();
  });

  it("still loads when the key list fails: the picker is just empty", async () => {
    await loaded({ "GET /tokens": fail(500, { error: "db down" }) });
    expect(errorNote()).toBeNull();
    fireEvent.click(button("Proxy chain"));
    expect(options(sel("API key"))).toEqual(["Pick a key…"]);
  });

  it("renders the header with Send, two columns and the idle note", async () => {
    const { container } = await loaded();
    const h1 = container.querySelector("h1")!;
    expect(h1.textContent).toBe("Model Bench");
    expect(classes(h1)).toEqual(cls(PAGE_TITLE));
    expect(classes(h1.querySelector("i"))).toEqual(cls("bi bi-clipboard-pulse text-brand-400"));
    expect(screen.getByText("Fire one request at one model and see exactly what came back — chat, media, or a raw mapping.")).toBeTruthy();
    const go = button("Send");
    expect(classes(go)).toEqual(["btn-primary"]);
    expect(classes(go.querySelector("i"))).toEqual(cls("bi bi-send"));
    expect(go.disabled).toBe(false);
    expect(classes(go.parentElement)).toEqual(cls("flex gap-2"));
    expect(hasButton("Stop")).toBe(false);

    const root = h1.closest(".space-y-4")!;
    const grid = root.children[1];
    expect(classes(grid)).toEqual(cls("grid grid-cols-1 gap-4 xl:grid-cols-2"));
    expect([...grid.children].map((c) => classes(c))).toEqual([["space-y-4"], ["space-y-4"]]);
    expect([...grid.children[0].children].map((c) => c.querySelector("h3")!.textContent)).toEqual(["Target", "Request", "Request body (exactly what will be sent)"]);
    for (const title of ["Target", "Request"]) {
      expect(classes(section(title))).toEqual(cls("card card-pad space-y-3"));
      expect(classes(section(title).querySelector("h3"))).toEqual(cls("label m-0"));
    }
    const idle = screen.getByText("Pick a target and send a request. Nothing is sent until you press Send.");
    expect(idle.parentElement).toBe(grid.children[1]);
    expect(grid.children[1].children).toHaveLength(1);
    expect(classes(idle)).toEqual(cls("card card-pad text-sm text-ink-500"));
    expect(classes(idle.querySelector("i"))).toEqual(cls("bi bi-info-circle mr-2"));
  });
});

// ---------------------------------------------------------------------------

describe("ModelBench page: target", () => {
  it("defaults to the internal transport and the first valid Model Service", async () => {
    await loaded();
    const target = section("Target");
    expect([...target.querySelectorAll(".label")].map((l) => l.textContent)).toEqual(["Target", "Transport", "Target", "Model Service", FORMAT, "Timeout (s)"]);
    const [proxy, internal] = [button("Proxy chain"), button("Internal")];
    expect([...proxy.parentElement!.children]).toEqual([proxy, internal]);
    expect(classes(proxy.parentElement)).toEqual(cls("flex gap-2"));
    expect([classes(proxy), classes(internal)]).toEqual([cls(SEG_OFF), cls(SEG_ON)]);
    expect([proxy.type, proxy.disabled, internal.disabled]).toEqual(["button", false, false]);
    expect(classes(proxy.querySelector("i"))).toEqual(cls("bi bi-globe2"));
    expect(classes(internal.querySelector("i"))).toEqual(cls("bi bi-cpu"));
    const hint = screen.getByText(/^Drives the executor directly\./);
    expect(classes(hint)).toEqual(cls(HINT));
    expect(classes(labelEl("Transport"))).toEqual(["label"]);

    const kinds = [...button("Raw model").parentElement!.querySelectorAll("button")];
    expect(kinds.map((b) => [b.textContent, classes(b), b.querySelector("i")])).toEqual([
      ["Model Service", cls(SEG_ON), null], ["Micro Agent", cls(SEG_OFF), null], ["Raw model", cls(SEG_OFF), null],
    ]);
    expect(classes(kinds[0].parentElement)).toEqual(cls("flex gap-2"));

    const service = sel("Model Service");
    expect(classes(service)).toEqual(["select"]);
    expect(service.value).toBe("1");
    // Invalid definitions and agents are left out; a disabled service is marked.
    expect(options(service)).toEqual([
      "chat-svc · chat", "painter · image (disabled)", "ears · stt", "embedder · embedding", "ranker · rerank", "filmer · video", "speaker · tts", "scanner · ocr",
    ]);

    const format = sel(FORMAT);
    expect([classes(format), format.value, format.disabled, options(format)]).toEqual([["select"], "openai_completion", false, FAMILIES]);
    expect(classes(screen.getByText(/^The wire the request is written in\./))).toEqual(cls(HINT));

    const stream = toggle("Stream");
    expect(isOn(stream)).toBe(false);
    expect(classes(stream.closest("label")!.parentElement)).toEqual(cls("flex flex-wrap items-center gap-4"));
    const timeout = field("Timeout (s)");
    expect([timeout.type, timeout.min, timeout.value, classes(timeout)]).toEqual(["number", "1", "300", cls("input w-24")]);
    expect(classes(labelEl("Timeout (s)"))).toEqual(cls("label m-0"));
    expect(classes(timeout.parentElement)).toEqual(cls("flex items-center gap-2"));
    expect(secret()).toBeNull();
  });

  it("Micro Agent lists only agents and targets the first one", async () => {
    const { api } = await loaded();
    fireEvent.click(button("Micro Agent"));
    expect([classes(button("Model Service")), classes(button("Micro Agent"))]).toEqual([cls(SEG_OFF), cls(SEG_ON)]);
    expect(options(sel("Micro Agent"))).toEqual(["router · chat"]);
    await waitFor(() => expect(sel("Micro Agent").value).toBe("3"));
    // An agent is addressed as a service; only the id differs.
    expect(await sendTo(api)).toEqual(chatReq({ model: "router", messages: USER_TEXT() }, { target: { kind: "service", serviceId: 3 } }));
  });

  it("says so, and cannot send, when nothing of the kind is defined", async () => {
    await loaded({ "GET /bench/targets": { services: [], mappings: [] } });
    expect(options(sel("Model Service"))).toEqual(["nothing of this kind is defined"]);
    expect(button("Send").disabled).toBe(true);
    fireEvent.click(button("Raw model"));
    expect(options(sel("Model"))).toEqual(["no model is mapped to a provider yet"]);
    expect([options(sel("Provider")), options(sel(PROVIDER_FORMAT))]).toEqual([[], []]);
    expect(button("Send").disabled).toBe(true);
  });

  it("a media service drops the format picker, the Stream switch and the system prompt, and renames the message", async () => {
    await loaded();
    pick(2);
    const target = section("Target");
    expect([...target.querySelectorAll(".label")].map((l) => l.textContent)).toEqual(["Target", "Transport", "Target", "Model Service", "Timeout (s)"]);
    expect(target.querySelector("label button")).toBeNull();
    expect([...section("Request").querySelectorAll(".label")].map((l) => l.textContent)).toEqual(["Request", "Input text", "Filler (≈ tokens)", ATTACHMENTS, "Extra parameters"]);
    expect(field<HTMLTextAreaElement>("Input text").value).toBe(DEFAULT_PROMPT);
  });

  it("an OCR service is a chat target", async () => {
    const { api } = await loaded();
    pick(10);
    expect(sel(FORMAT).value).toBe("openai_completion");
    expect(isOn(toggle("Stream"))).toBe(false);
    expect(await sendTo(api)).toEqual(chatReq({ model: "scanner", messages: USER_TEXT() }, { target: { kind: "service", serviceId: 10 } }));
  });

  it("Raw model offers model, both formats, provider and category, consistent from the first mapped model down", async () => {
    await loaded();
    fireEvent.click(button("Raw model"));
    await waitFor(() => expect(sel("Provider").value).toBe("openai"));
    const target = section("Target");
    expect([...target.querySelectorAll(".label")].map((l) => l.textContent)).toEqual(["Target", "Transport", "Target", "Model", FORMAT, "Provider", PROVIDER_FORMAT, "Category", "Timeout (s)"]);
    const grid = sel("Model").parentElement!.parentElement!;
    expect(classes(grid)).toEqual(cls("grid grid-cols-2 gap-2"));
    expect([...grid.children].map((c) => c.className)).toEqual(["", "", "", "", "col-span-2"]);
    for (const label of ["Model", FORMAT, "Provider", PROVIDER_FORMAT, "Category"]) expect(classes(sel(label))).toEqual(["select"]);
    // Models are sorted by name; the format hint is not shown here.
    expect([options(sel("Model")), sel("Model").value]).toEqual([["gpt", "sonnet"], "gpt"]);
    expect([options(sel(FORMAT)), sel(FORMAT).value, sel(FORMAT).disabled]).toEqual([FAMILIES, "openai_completion", false]);
    expect(screen.queryByText(/^The wire the request is written in\./)).toBeNull();
    expect(options(sel("Provider"))).toEqual(["openai → gpt-4o"]);
    // The provider format keeps its current value when the mapping reaches it, even if it is not the mapping's first.
    expect([options(sel(PROVIDER_FORMAT)), sel(PROVIDER_FORMAT).value]).toEqual([["openai_responses", "openai_completion"], "openai_completion"]);
    // No "ocr" here, although it is a service category.
    expect([options(sel("Category")), sel("Category").value]).toEqual([["chat", "embedding", "rerank", "image", "video", "tts", "stt"], "chat"]);
  });

  it("Raw model follows the chosen model and provider down to a reachable provider format", async () => {
    await loaded();
    fireEvent.click(button("Raw model"));
    await waitFor(() => expect(sel("Provider").value).toBe("openai"));
    type(sel("Model"), "sonnet");
    await waitFor(() => expect(sel("Provider").value).toBe("anthropic-main"));
    expect(options(sel("Provider"))).toEqual(["anthropic-main → claude-sonnet", "router-x → sonnet-x (disabled)"]);
    await waitFor(() => expect(sel(PROVIDER_FORMAT).value).toBe("anthropic"));
    expect(options(sel(PROVIDER_FORMAT))).toEqual(["anthropic"]);
    type(sel("Provider"), "router-x");
    await waitFor(() => expect(sel(PROVIDER_FORMAT).value).toBe("openai_completion"));
    expect(options(sel(PROVIDER_FORMAT))).toEqual(["openai_completion", "openai_responses"]);
  });

  it("Raw model is internal only: the proxy switch is disabled, explained, and left if it was on", async () => {
    await loaded();
    viaProxy();
    expect(classes(button("Proxy chain"))).toEqual(cls(SEG_ON));
    fireEvent.click(button("Raw model"));
    await waitFor(() => expect(classes(button("Internal"))).toEqual(cls(SEG_ON)));
    expect([button("Proxy chain").disabled, classes(button("Proxy chain"))]).toEqual([true, cls(SEG_OFF)]);
    expect(classes(screen.getByText("The client endpoints address services by name, so a raw mapping can only be reached internally."))).toEqual(cls(HINT));
    expect(screen.queryByText(/^Drives the executor directly\./)).toBeNull();
    expect(secret()).toBeNull();
    // Going back does not return to the proxy.
    fireEvent.click(button("Model Service"));
    expect([button("Proxy chain").disabled, classes(button("Internal"))]).toEqual([false, cls(SEG_ON)]);
  });

  it("a raw non-chat category disables the model format and sends the tuple to the media route", async () => {
    const { api } = await loaded();
    fireEvent.click(button("Raw model"));
    await waitFor(() => expect(sel("Provider").value).toBe("openai"));
    type(sel("Category"), "embedding");
    expect(sel(FORMAT).disabled).toBe(true);
    expect(section("Target").querySelector("label button")).toBeNull();
    expect(await sendTo(api, "/bench/media")).toEqual(sentJson("POST", "/bench/media", {
      target: { kind: "raw", model: "gpt", provider: "openai", providerFormat: "openai_completion" },
      category: "embedding", body: { model: "gpt@openai", input: DEFAULT_PROMPT }, timeoutMs: 300000,
    }));
  });

  it("a raw chat target is named model@provider and carries both formats", async () => {
    const { api } = await loaded();
    fireEvent.click(button("Raw model"));
    await waitFor(() => expect(sel("Provider").value).toBe("openai"));
    type(sel(FORMAT), "anthropic");
    type(sel(PROVIDER_FORMAT), "openai_responses");
    expect(await sendTo(api)).toEqual(sentJson("POST", "/bench/chat", {
      target: { kind: "raw", model: "gpt", provider: "openai", providerFormat: "openai_responses" },
      ingress: "anthropic", body: { model: "gpt@openai", max_tokens: 4096, messages: USER_TEXT() }, timeoutMs: 300000,
    }));
  });

  it.each([
    ["2", "2", 2000], ["1", "1", 1000], ["1.5", "1.5", 1500], ["86400", "86400", 86400000],
    // Empty, zero and non-numeric fall back to 1; below one second the request is floored, not the field.
    ["", "1", 1000], ["0", "1", 1000], ["abc", "1", 1000], ["0.5", "0.5", 1000], ["-5", "-5", 1000],
  ])("timeout %j shows %j and sends timeoutMs %d", async (typed, shown, timeoutMs) => {
    const { api } = await loaded();
    type(field("Timeout (s)"), typed);
    expect(field("Timeout (s)").value).toBe(shown);
    expect((await sendTo(api)).body).toMatchObject({ timeoutMs });
  });

  it.each([
    ["an admin", ADMIN, "Picking a key reveals its secret so the browser can present it, exactly as a client would."],
    ["a manager", MANAGER, "Only an admin can reveal a stored key; paste one you already have."],
  ])("the proxy transport asks for a key and has no timeout, with the hint for %s", async (_name, me, hint) => {
    await loaded({}, {}, me);
    fireEvent.click(button("Proxy chain"));
    expect([classes(button("Proxy chain")), classes(button("Internal"))]).toEqual([cls(SEG_ON), cls(SEG_OFF)]);
    expect(classes(screen.getByText(/^A real client request at Hydrogen's own \/v1 endpoints/))).toEqual(cls(HINT));
    expect([...section("Target").querySelectorAll(".label")].map((l) => l.textContent)).toEqual(["Target", "Transport", "Target", "Model Service", FORMAT, "API key"]);
    const picker = sel("API key");
    expect([classes(picker), picker.value, options(picker)]).toEqual([["select"], "", ["Pick a key…", "laptop · hk_abc"]]);
    expect(classes(picker.parentElement)).toEqual(cls("grid grid-cols-2 gap-2"));
    expect([secret().type, secret().value, secret().placeholder, classes(secret())]).toEqual(["password", "", "or paste a key", cls("input font-mono text-xs")]);
    expect(classes(screen.getByText(hint))).toEqual(cls(HINT));
    expect(button("Send").disabled).toBe(true);
    type(secret(), "hk_test");
    expect(button("Send").disabled).toBe(false);
  });

  it("picking a key as an admin reveals it with POST /tokens/:id/secret; un-picking keeps the secret", async () => {
    const { api } = await loaded({ "POST /tokens/1/secret": { secret: "hk_live" } });
    fireEvent.click(button("Proxy chain"));
    type(sel("API key"), "1");
    await waitFor(() => expect(secret().value).toBe("hk_live"));
    expect(api.mutations()).toEqual([sentJson("POST", "/tokens/1/secret", {})]);
    expect([sel("API key").value, button("Send").disabled]).toEqual(["1", false]);
    type(sel("API key"), "");
    expect([sel("API key").value, secret().value]).toEqual(["", "hk_live"]);
    expect(api.mutations()).toHaveLength(1);
  });

  it("picking a key as a manager selects it and reveals nothing", async () => {
    const { api } = await loaded({}, {}, MANAGER);
    fireEvent.click(button("Proxy chain"));
    type(sel("API key"), "1");
    expect([sel("API key").value, secret().value, button("Send").disabled]).toEqual(["1", "", true]);
    expect(api.mutations()).toEqual([]);
  });

  it.each([
    ["the server's message", fail(404, { error: "secret is not stored" }), "secret is not stored"],
    ["'Could not reveal that key' for a non-API failure", () => { throw new TypeError("offline"); }, "Could not reveal that key"],
  ])("toasts %s when the reveal is refused, and clears a pasted secret", async (_name, handler, text) => {
    await loaded({ "POST /tokens/1/secret": handler });
    viaProxy();
    type(sel("API key"), "1");
    await toastShown(text);
    expect([sel("API key").value, secret().value, button("Send").disabled]).toEqual(["1", "", true]);
  });
});

// ---------------------------------------------------------------------------

describe("ModelBench page: request", () => {
  it("offers system prompt, message, filler, attachments and parameters with their defaults", async () => {
    await loaded();
    const request = section("Request");
    expect([...request.querySelectorAll(".label")].map((l) => l.textContent))
      .toEqual(["Request", "System prompt", "Message", "Filler (≈ tokens)", ATTACHMENTS, "Extra parameters"]);
    const system = field<HTMLTextAreaElement>("System prompt");
    const message = field<HTMLTextAreaElement>("Message");
    expect([system.tagName, system.value, classes(system)]).toEqual(["TEXTAREA", "", cls("input h-16 font-mono text-xs")]);
    expect([message.tagName, message.value, classes(message)]).toEqual(["TEXTAREA", DEFAULT_PROMPT, cls("input h-28 font-mono text-xs")]);

    const filler = field("Filler (≈ tokens)");
    expect([filler.type, filler.min, filler.step, filler.value, classes(filler)]).toEqual(["number", "0", "1000", "10000", cls("input w-32")]);
    const box = filler.closest(".rounded-lg")!;
    expect(classes(box)).toEqual(cls("rounded-lg border border-ink-800 bg-ink-950/50 p-3"));
    expect(classes(box.firstElementChild)).toEqual(cls("flex flex-wrap items-end gap-2"));
    const generate = button("Generate filler");
    expect([classes(generate), generate.type]).toEqual([cls(XS), "button"]);
    expect(classes(generate.querySelector("i"))).toEqual(cls("bi bi-arrows-expand"));
    expect(hasButton("Remove filler")).toBe(false);
    expect(classes(screen.getByText(/^Append lorem ipsum to push the request/))).toEqual(cls("mt-2 text-xs text-ink-500"));

    expect([fileInput().multiple, classes(fileInput())]).toEqual([true, cls("input text-xs")]);
    expect(request.querySelector("ul")).toBeNull();

    expect(classes(labelEl("Extra parameters"))).toEqual(["label"]);
    const hint = screen.getByText("Merged into the body last, so these win. A JSON-shaped value is sent as that shape; anything else goes as a string.");
    expect(classes(hint)).toEqual(cls("mb-1 text-xs text-ink-500"));
    expect([...paramsBox().children].map((c) => c.tagName)).toEqual(["LABEL", "P", "DIV", "BUTTON"]);
    expect(classes(paramsBox().children[2])).toEqual(["space-y-1.5"]);
    expect(paramRows()).toEqual([]);
    const add = button("Add parameter");
    expect([classes(add), add.type]).toEqual([cls("btn-ghost btn-xs mt-1.5"), "button"]);
    expect(classes(add.querySelector("i"))).toEqual(cls("bi bi-plus-lg"));
  });

  it.each([
    ["openai_completion", {}, { model: "chat-svc", messages: USER_TEXT() }],
    ["anthropic", {}, { model: "chat-svc", max_tokens: 4096, messages: USER_TEXT() }],
    ["openai_responses", {}, { model: "chat-svc", input: [{ role: "user", content: [{ type: "input_text", text: DEFAULT_PROMPT }] }] }],
    ["openai_completion", { system: "be brief" }, { model: "chat-svc", messages: [{ role: "system", content: "be brief" }, ...USER_TEXT()] }],
    ["anthropic", { system: "be brief" }, { model: "chat-svc", max_tokens: 4096, system: "be brief", messages: USER_TEXT() }],
    ["openai_responses", { system: "be brief" }, { model: "chat-svc", instructions: "be brief", input: [{ role: "user", content: [{ type: "input_text", text: DEFAULT_PROMPT }] }] }],
    // An empty message is still a text part, except on the Responses wire, where it is no part at all.
    ["openai_completion", { message: "" }, { model: "chat-svc", messages: USER_TEXT("") }],
    ["anthropic", { message: "" }, { model: "chat-svc", max_tokens: 4096, messages: USER_TEXT("") }],
    ["openai_responses", { message: "" }, { model: "chat-svc", input: [{ role: "user", content: [] }] }],
    // Neither field is trimmed.
    ["openai_completion", { system: " s ", message: " m\n" }, { model: "chat-svc", messages: [{ role: "system", content: " s " }, ...USER_TEXT(" m\n")] }],
  ] as Array<[string, { system?: string; message?: string }, Record<string, unknown>]>)(
    "internal, buffered, %s with %j: POST /bench/chat with that wire's body", async (format, fields, body) => {
      const { api, rawCalls } = await loaded();
      type(sel(FORMAT), format);
      if (fields.system !== undefined) type(field("System prompt"), fields.system);
      if (fields.message !== undefined) type(field("Message"), fields.message);
      expect(await sendTo(api)).toEqual(chatReq(body, { ingress: format }));
      expect(api.mutations()).toHaveLength(1);
      expect(rawCalls).toEqual([]);
    });

  it.each([
    ["openai_completion", [{ type: "image_url", image_url: { url: PNG_URL } }, { type: "file", file: { filename: "doc.pdf", file_data: PDF_URL } }]],
    ["anthropic", [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
      { type: "document", title: "doc.pdf", source: { type: "base64", media_type: "application/pdf", data: "aGk=" } },
    ]],
    ["openai_responses", [{ type: "input_image", image_url: PNG_URL }, { type: "input_file", filename: "doc.pdf", file_data: PDF_URL }]],
  ])("%s spells an image and a document attachment its own way, after the text part", async (format, parts) => {
    const { api } = await loaded();
    type(sel(FORMAT), format);
    await attach(PNG, PDF);
    const body = bodyOf(await sendTo(api));
    const message = ((body.messages ?? body.input) as Array<{ content: unknown[] }>)[0];
    expect(message.content.slice(1)).toEqual(parts);
    expect(message.content).toHaveLength(3);
  });

  it("lists attachments with an icon by type; more files append, and each row removes itself", async () => {
    await loaded();
    await attach(PNG, file("clip.mp3", "audio/mpeg", [0]));
    // A file with no type is sent as application/octet-stream.
    await attach(file("blob", "", [255, 0, 128]));
    const rows = attachmentRows();
    expect(classes(rows[0].parentElement)).toEqual(cls("mt-2 space-y-1"));
    expect(rows.map((r) => [...r.querySelectorAll("span")].map((s) => s.textContent))).toEqual([
      ["dot.png", "image/png"], ["clip.mp3", "audio/mpeg"], ["blob", "application/octet-stream"],
    ]);
    expect(rows.map((r) => classes(r.querySelector("i")))).toEqual([cls("bi bi-image"), cls("bi bi-music-note-beamed"), cls("bi bi-file-earmark")]);
    expect(classes(rows[0])).toEqual(cls("flex items-center gap-2 text-xs text-ink-300"));
    const [name, mediaType] = [...rows[0].querySelectorAll("span")];
    expect([classes(name), classes(mediaType)]).toEqual([cls("truncate font-mono"), ["text-ink-500"]]);
    const remove = rows[0].querySelector("button")!;
    expect([classes(remove), remove.type, remove.textContent]).toEqual([cls("btn-ghost btn-xs ml-auto"), "button", ""]);
    expect(classes(remove.querySelector("i"))).toEqual(cls("bi bi-trash"));

    fireEvent.click(rows[1].querySelector("button")!);
    expect(attachmentRows().map((r) => r.querySelector("span")!.textContent)).toEqual(["dot.png", "blob"]);
    fireEvent.click(attachmentRows()[0].querySelector("button")!);
    fireEvent.click(attachmentRows()[0].querySelector("button")!);
    expect(section("Request").querySelector("ul")).toBeNull();
  });

  it("encodes attachments as base64 of the exact bytes, whatever their size", async () => {
    const { api } = await loaded();
    // Larger than one 0x8000 conversion chunk, and bytes above 0x7f.
    const big = Array.from({ length: 0x8000 + 2 }, (_, i) => (i * 7) % 256);
    await attach(file("blob", "", [255, 0, 128]), file("big.bin", "application/x-big", big));
    const parts = (bodyOf(await sendTo(api)).messages as Array<{ content: unknown[] }>)[0].content;
    expect(parts.slice(1)).toEqual([
      { type: "file", file: { filename: "blob", file_data: "data:application/octet-stream;base64,/wCA" } },
      { type: "file", file: { filename: "big.bin", file_data: `data:application/x-big;base64,${btoa(String.fromCharCode(...big))}` } },
    ]);
  });

  it("choosing no file changes nothing", async () => {
    await loaded();
    await attach(PNG);
    fireEvent.change(fileInput(), { target: { files: [] } });
    await act(async () => {});
    expect(attachmentRows()).toHaveLength(1);
  });

  it.each([
    ["1000", "1000", loremOfTokens(1000)],
    ["10000", "10000", loremOfTokens(10000)],
    ["2.5", "2.5", loremOfTokens(2.5)],
    // Empty, negative and non-numeric become 0, and 0 tokens of filler is no filler.
    ["0", "0", ""], ["", "0", ""], ["-5", "0", ""], ["abc", "0", ""],
  ])("filler size %j shows %j and appends that much lorem ipsum after a blank line", async (typed, shown, lorem) => {
    const { api } = await loaded();
    if (typed !== "10000") type(field("Filler (≈ tokens)"), typed);
    expect(field("Filler (≈ tokens)").value).toBe(shown);
    fireEvent.click(button("Generate filler"));
    expect(hasButton("Remove filler")).toBe(lorem !== "");
    expect(bodyOf(await sendTo(api)).messages).toEqual(USER_TEXT(lorem ? `${DEFAULT_PROMPT}\n\n${lorem}` : DEFAULT_PROMPT));
  });

  it("reports the attached filler's size, and Remove filler detaches it", async () => {
    const { api } = await loaded();
    fireEvent.click(button("Generate filler"));
    const note = screen.getByText(`${formatNumber(36000)} chars appended (≈ ${formatNumber(10000)} tokens, estimated — the answer's usage is the real count).`);
    expect(classes(note)).toEqual(cls("mt-2 text-xs text-ink-500"));
    expect(screen.queryByText(/^Append lorem ipsum/)).toBeNull();
    const remove = button("Remove filler");
    expect([classes(remove), remove.type]).toEqual([cls(XS), "button"]);
    expect(classes(remove.querySelector("i"))).toEqual(cls("bi bi-x-lg"));
    expect([...remove.parentElement!.children].map((c) => c.textContent)).toEqual(["Filler (≈ tokens)", "Generate filler", "Remove filler"]);
    fireEvent.click(remove);
    expect(hasButton("Remove filler")).toBe(false);
    expect(screen.getByText(/^Append lorem ipsum/)).toBeTruthy();
    expect(bodyOf(await sendTo(api)).messages).toEqual(USER_TEXT());
  });

  it("the Stream switch adds stream:true and sends the internal request with fetch, not the API client", async () => {
    const { api, rawCalls } = await loaded({}, { "POST /admin/api/bench/chat": () => sseOf(['data: {"choices":[{"delta":{"content":"pong"}}]}']) });
    fireEvent.click(toggle("Stream"));
    expect(isOn(toggle("Stream"))).toBe(true);
    await send();
    expect(rawCalls).toEqual([{
      url: "/admin/api/bench/chat", method: "POST", headers: JSON_HEADERS, credentials: "same-origin", signal: true,
      body: { target: SERVICE_1, ingress: "openai_completion", body: { model: "chat-svc", messages: USER_TEXT(), stream: true }, timeoutMs: 300000 },
    }]);
    expect(api.mutations()).toEqual([]);
  });

  it.each(["anthropic", "openai_responses"])("stream:true is added on the %s wire too", async (format) => {
    const { rawCalls } = await loaded({}, { "POST /admin/api/bench/chat": () => sseOf([]) });
    type(sel(FORMAT), format);
    fireEvent.click(toggle("Stream"));
    await send();
    expect((rawCalls[0].body as { body: unknown }).body).toMatchObject({ model: "chat-svc", stream: true });
  });
});

// ---------------------------------------------------------------------------

describe("ModelBench page: extra parameters", () => {
  it("adds blank rows and removes the row whose button is pressed, keeping the others' text", async () => {
    await loaded();
    fireEvent.click(button("Add parameter"));
    expect(paramValues()).toEqual([["", ""]]);
    const row = paramRows()[0];
    expect(classes(row)).toEqual(cls("flex gap-1.5"));
    const [key, value] = [...row.querySelectorAll("input")];
    expect([key.placeholder, classes(key)]).toEqual(["name", cls("input flex-1 font-mono text-xs")]);
    expect([value.placeholder, classes(value)]).toEqual(["value", cls("input flex-1 font-mono text-xs")]);
    const remove = row.querySelector("button")!;
    expect([classes(remove), remove.type, remove.textContent]).toEqual([cls(XS), "button", ""]);
    expect(classes(remove.querySelector("i"))).toEqual(cls("bi bi-trash"));
    expect([...row.children].map((c) => c.tagName)).toEqual(["INPUT", "INPUT", "BUTTON"]);

    type(key, "a");
    type(value, "1");
    addParam("b", "2");
    addParam("c", "3");
    expect(paramValues()).toEqual([["a", "1"], ["b", "2"], ["c", "3"]]);
    fireEvent.click(paramRows()[1].querySelector("button")!);
    expect(paramValues()).toEqual([["a", "1"], ["c", "3"]]);
    fireEvent.click(paramRows()[0].querySelector("button")!);
    fireEvent.click(paramRows()[0].querySelector("button")!);
    expect(paramRows()).toEqual([]);
  });

  it.each([
    ["0.7", 0.7], ["1e3", 1000], ["-2", -2], ["true", true], ["false", false], ["null", null], ['["a",1]', ["a", 1]], ['{"a":{"b":1}}', { a: { b: 1 } }], ['"quoted"', "quoted"],
    // JSON tolerates surrounding whitespace, so a padded number is a number...
    [" 5 ", 5],
    // ...while anything that is not JSON goes as typed: untrimmed, and an empty value as an empty string.
    ["hello", "hello"], [" padded ", " padded "], ["", ""], ["   ", "   "], ["01", "01"], ["True", "True"], ["{a:1}", "{a:1}"], ["1,5", "1,5"],
  ])("a value typed as %j is sent as %j", async (typed, sent) => {
    const { api } = await loaded();
    addParam("p", typed);
    expect(bodyOf(await sendTo(api))).toEqual({ model: "chat-svc", messages: USER_TEXT(), p: sent });
  });

  it("trims names when sending (not in the field), skips blank-named rows, and lets the last duplicate win", async () => {
    const { api } = await loaded();
    addParam(" temperature ", "0.2");
    addParam("", "ignored");
    addParam("   ", "ignored");
    addParam("temperature", "0.9");
    addParam("top_p", "1");
    expect(paramValues()[0]).toEqual([" temperature ", "0.2"]);
    expect(bodyOf(await sendTo(api))).toEqual({ model: "chat-svc", messages: USER_TEXT(), temperature: 0.9, top_p: 1 });
  });

  it("parameters are merged last, so they replace generated fields on every wire and on media bodies", async () => {
    const { api } = await loaded();
    addParam("model", "other");
    addParam("stream", "false");
    addParam("max_tokens", "16");
    type(sel(FORMAT), "anthropic");
    expect(bodyOf(await sendTo(api))).toEqual({ model: "other", max_tokens: 16, messages: USER_TEXT(), stream: false });
    pick(2);
    expect(bodyOf(await sendTo(api, "/bench/media"))).toEqual({ model: "other", prompt: DEFAULT_PROMPT, n: 1, size: "1024x1024", stream: false, max_tokens: 16 });
  });
});

// ---------------------------------------------------------------------------

describe("ModelBench page: media and proxy requests", () => {
  const p = DEFAULT_PROMPT;
  it.each([
    [6, "embedding", { model: "embedder", input: p }, { model: "embedder", input: "hello" }],
    [7, "rerank", { model: "ranker", query: p, documents: ["first document", "second document"] }, { model: "ranker", query: "hello", documents: ["first document", "second document"] }],
    [2, "image", { model: "painter", prompt: p, n: 1, size: "1024x1024" }, { model: "painter", prompt: "a red circle on a white background", n: 1, size: "1024x1024" }],
    [8, "video", { model: "filmer", prompt: p }, { model: "filmer", prompt: "a red circle rolling across a white background" }],
    [9, "tts", { model: "speaker", input: p, voice: "alloy" }, { model: "speaker", input: "Hydrogen model bench.", voice: "alloy" }],
  ])("internal, service %d (%s): POST /bench/media with the category's starting body, and a stock text when the input is empty", async (id, category, body, emptyBody) => {
    const { api } = await loaded();
    pick(id);
    const request = (b: unknown) => sentJson("POST", "/bench/media", { target: { kind: "service", serviceId: id }, category, body: b, timeoutMs: 300000 });
    expect(await sendTo(api, "/bench/media")).toEqual(request(body));
    type(field("Input text"), "");
    expect(await sendTo(api, "/bench/media")).toEqual(request(emptyBody));
    expect(api.sent("POST", "/bench/chat")).toEqual([]);
  });

  it("speech-to-text takes one audio file, cannot send without it, and sends it beside the body", async () => {
    const { api } = await loaded();
    pick(5);
    expect(labelEl("Audio file to transcribe")).toBeTruthy();
    expect(fileInput().multiple).toBe(false);
    expect(button("Send").disabled).toBe(true);
    // Only the first of a selection is kept, and a new selection replaces it.
    await attach(file("old.wav", "audio/wav", [9]));
    fireEvent.change(fileInput(), { target: { files: [file("a.wav", "audio/wav", [1, 2, 3]), file("b.wav", "audio/wav", [4])] } });
    await screen.findByText("a.wav");
    expect(attachmentRows().map((r) => r.querySelector("span")!.textContent)).toEqual(["a.wav"]);
    expect(button("Send").disabled).toBe(false);
    expect(await sendTo(api, "/bench/media")).toEqual(sentJson("POST", "/bench/media", {
      target: { kind: "service", serviceId: 5 }, category: "stt", body: { model: "ears" }, timeoutMs: 300000,
      file: { name: "a.wav", mediaType: "audio/wav", data: "AQID", dataUrl: "data:audio/wav;base64,AQID" },
    }));
  });

  it.each([
    ["openai_completion", "/v1/chat/completions", {}, { model: "chat-svc", messages: USER_TEXT() }],
    ["anthropic", "/v1/messages", { "anthropic-version": "2023-06-01" }, { model: "chat-svc", max_tokens: 4096, messages: USER_TEXT() }],
    ["openai_responses", "/v1/responses", {}, { model: "chat-svc", input: [{ role: "user", content: [{ type: "input_text", text: DEFAULT_PROMPT }] }] }],
  ])("proxy, %s: POSTs the bare wire body to %s with the key as a bearer and no cookies", async (format, url, extraHeaders, body) => {
    const { api, rawCalls } = await loaded({}, { [`POST ${url}`]: () => jsonResponse({ id: "r" }) });
    viaProxy();
    type(sel(FORMAT), format);
    await send();
    expect(rawCalls).toEqual([{
      url, method: "POST", credentials: "omit", signal: true, body,
      headers: { authorization: "Bearer hk_test", ...extraHeaders, "content-type": "application/json" },
    }]);
    expect(api.mutations()).toEqual([]);
  });

  it("proxy with Stream on adds stream:true to the same endpoint", async () => {
    const { rawCalls } = await loaded({}, { "POST /v1/chat/completions": () => sseOf(["data: [DONE]"]) });
    viaProxy();
    fireEvent.click(toggle("Stream"));
    await send();
    expect(rawCalls[0].body).toEqual({ model: "chat-svc", messages: USER_TEXT(), stream: true });
  });

  it.each([
    [10, "/v1/chat/completions", { model: "scanner", messages: USER_TEXT() }],
    [6, "/v1/embeddings", { model: "embedder", input: p }],
    [7, "/v1/rerank", { model: "ranker", query: p, documents: ["first document", "second document"] }],
    [2, "/v1/images/generations", { model: "painter", prompt: p, n: 1, size: "1024x1024" }],
    [8, "/v1/videos", { model: "filmer", prompt: p }],
    [9, "/v1/audio/speech", { model: "speaker", input: p, voice: "alloy" }],
  ])("proxy, service %d: POSTs JSON to %s", async (id, url, body) => {
    const { rawCalls } = await loaded({}, { [`POST ${url}`]: () => jsonResponse({}) });
    viaProxy();
    pick(id);
    await send();
    expect(rawCalls).toEqual([{ url, method: "POST", credentials: "omit", signal: true, body, headers: { authorization: "Bearer hk_test", "content-type": "application/json" } }]);
  });

  it("proxy, an Anthropic-format media request carries no anthropic-version header", async () => {
    const { rawCalls } = await loaded({}, { "POST /v1/embeddings": () => jsonResponse({}) });
    viaProxy();
    type(sel(FORMAT), "anthropic");
    pick(6);
    await send();
    expect(rawCalls[0].headers).toEqual({ authorization: "Bearer hk_test", "content-type": "application/json" });
  });

  it("proxy, speech-to-text: multipart to /v1/audio/transcriptions with the body's fields as text and the file's bytes", async () => {
    const { rawCalls } = await loaded({}, { "POST /v1/audio/transcriptions": () => jsonResponse({ text: "hi" }) });
    viaProxy();
    pick(5);
    await attach(file("a.wav", "audio/wav", [255, 0, 128]));
    addParam("language", "en");
    addParam("temperature", "0");
    addParam("timestamp_granularities", '["word"]');
    addParam("prompt", "null");
    const card = await send();
    const { body, ...rest } = rawCalls[0];
    // No content-type: the browser adds the multipart boundary itself.
    expect(rest).toEqual({ url: "/v1/audio/transcriptions", method: "POST", credentials: "omit", signal: true, headers: { authorization: "Bearer hk_test" } });
    const form = body as FormData;
    // Non-strings are JSON-encoded; a null is left out.
    expect([...form.keys()]).toEqual(["model", "language", "temperature", "timestamp_granularities", "file"]);
    expect([form.get("model"), form.get("language"), form.get("temperature"), form.get("timestamp_granularities")]).toEqual(["ears", "en", "0", '["word"]']);
    const sent = form.get("file") as File;
    expect([sent.name, sent.type, [...new Uint8Array(await sent.arrayBuffer())]]).toEqual(["a.wav", "audio/wav", [255, 0, 128]]);
    // What is shown as sent names the file instead of carrying it.
    expect(card.querySelector("div:last-child > pre")!.textContent).toBe(pretty({
      model: "ears", language: "en", temperature: 0, timestamp_granularities: ["word"], prompt: null, file: "(a.wav, audio/wav)",
    }));
  });
});

// ---------------------------------------------------------------------------

describe("ModelBench page: request body panel", () => {
  const TITLE = "Request body (exactly what will be sent)";
  const preview = () => bodyPanel().querySelector("pre");
  const editor = () => bodyPanel().querySelector("textarea");
  const heading = () => screen.getByText(TITLE).closest("button")!;

  it("is collapsed by default, with a copy button and Edit", async () => {
    await loaded();
    const panel = bodyPanel();
    expect(classes(panel)).toEqual(cls("card card-pad"));
    expect(classes(panel.firstElementChild)).toEqual(cls("flex items-center justify-between"));
    expect([classes(heading()), heading().type]).toEqual([cls("flex items-center gap-1.5 text-left"), "button"]);
    expect(classes(heading().querySelector("i"))).toEqual(cls("bi bi-chevron-right text-ink-500"));
    expect(classes(screen.getByText(TITLE))).toEqual(cls("label m-0 cursor-pointer select-none"));
    expect(screen.getByText(TITLE).tagName).toBe("H3");
    const [copy, edit] = [...heading().nextElementSibling!.querySelectorAll("button")];
    expect(classes(heading().nextElementSibling)).toEqual(cls("flex gap-1.5"));
    expect([classes(copy), copy.type, copy.textContent]).toEqual([cls(XS), "button", ""]);
    expect(classes(copy.querySelector("i"))).toEqual(cls("bi bi-clipboard"));
    expect([classes(edit), edit.type, edit.textContent]).toEqual([cls(XS), "button", "Edit"]);
    expect(classes(edit.querySelector("i"))).toEqual(cls("bi bi-pencil"));
    expect(classes(screen.getByText(/^Collapsed while you type:/))).toEqual(cls("mt-2 text-xs text-ink-500"));
    expect([preview(), editor()]).toEqual([null, null]);
  });

  it("opened, previews the generated body as indented JSON and follows the form", async () => {
    await loaded();
    fireEvent.click(heading());
    expect(classes(heading().querySelector("i"))).toEqual(cls("bi bi-chevron-down text-ink-500"));
    expect(screen.queryByText(/^Collapsed while you type:/)).toBeNull();
    expect(classes(preview())).toEqual(cls("mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-ink-800 bg-ink-950 p-3 font-mono text-xs leading-relaxed text-ink-300"));
    expect(preview()!.textContent).toBe(pretty({ model: "chat-svc", messages: USER_TEXT() }));
    type(field("Message"), "ping");
    type(field("System prompt"), "sys");
    fireEvent.click(toggle("Stream"));
    addParam("temperature", "0");
    expect(preview()!.textContent).toBe(pretty({
      model: "chat-svc", messages: [{ role: "system", content: "sys" }, ...USER_TEXT("ping")], stream: true, temperature: 0,
    }));
    pick(2);
    expect(preview()!.textContent).toBe(pretty({ model: "painter", prompt: "ping", n: 1, size: "1024x1024", temperature: 0 }));
    fireEvent.click(heading());
    expect(preview()).toBeNull();
  });

  it("Edit opens the body as text detached from the form; what is typed is what is sent", async () => {
    const { api } = await loaded();
    fireEvent.click(button("Edit"));
    const area = editor()!;
    expect(classes(area)).toEqual(cls("input mt-2 h-72 font-mono text-xs"));
    expect([area.value, area.getAttribute("spellcheck"), preview()]).toEqual([pretty({ model: "chat-svc", messages: USER_TEXT() }), "false", null]);
    expect(classes(heading().querySelector("i"))).toEqual(cls("bi bi-chevron-down text-ink-500"));
    expect(hasButton("Edit")).toBe(false);
    const reset = button("Back to generated");
    expect([classes(reset), reset.type]).toEqual([cls(XS), "button"]);
    expect(classes(reset.querySelector("i"))).toEqual(cls("bi bi-arrow-counterclockwise"));

    type(field("Message"), "changed in the form");
    expect(editor()!.value).toBe(pretty({ model: "chat-svc", messages: USER_TEXT() }));
    type(editor()!, '{"model":"hand","n":[1,2]}');
    expect(await sendTo(api)).toEqual(chatReq({ model: "hand", n: [1, 2] }));
    // Any JSON value is accepted, not only an object.
    type(editor()!, "[1]");
    expect(bodyOf(await sendTo(api))).toEqual([1]);

    fireEvent.click(button("Back to generated"));
    expect(editor()).toBeNull();
    expect(preview()!.textContent).toBe(pretty({ model: "chat-svc", messages: USER_TEXT("changed in the form") }));
    expect(bodyOf(await sendTo(api))).toEqual({ model: "chat-svc", messages: USER_TEXT("changed in the form") });
  });

  it.each(["{", "", "{'a':1}", "undefined"])("an edited body of %j is flagged as invalid JSON and blocks Send, even while collapsed", async (text) => {
    await loaded();
    fireEvent.click(button("Edit"));
    type(editor()!, text);
    const note = screen.getByText(/^Not valid JSON: ./);
    expect(classes(note)).toEqual(cls("mt-2 text-xs text-red-300"));
    expect(button("Send").disabled).toBe(true);
    fireEvent.click(heading());
    expect(editor()).toBeNull();
    expect(screen.getByText(/^Collapsed while you type:/)).toBeTruthy();
    expect(screen.getByText(/^Not valid JSON: ./)).toBeTruthy();
    expect(button("Send").disabled).toBe(true);
    fireEvent.click(button("Back to generated"));
    expect(screen.queryByText(/^Not valid JSON: ./)).toBeNull();
    expect(button("Send").disabled).toBe(false);
    expect(toasts()).toEqual([]);
  });
});
