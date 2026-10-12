/** src/api.ts against a mocked fetch: request shape per verb, and every response partition. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../src/api";

interface Sent { url: string; init: RequestInit }

/** Install a fetch that answers with one fixed status/text and records what it was given. */
function respond(status: number, text: string): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => text } as Response;
  }));
  return sent;
}

async function caught(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("expected the request to reject");
}

afterEach(() => vi.unstubAllGlobals());

describe("api request shape", () => {
  it("GET sends no body and no content-type, under /admin/api with same-origin credentials", async () => {
    const sent = respond(200, "{}");
    await api.get("/users");
    expect(sent).toEqual([{ url: "/admin/api/users", init: { method: "GET", credentials: "same-origin", headers: {}, body: undefined } }]);
  });

  it("DELETE sends no body and no content-type", async () => {
    const sent = respond(200, "");
    await api.del("/users/3");
    expect(sent[0]).toEqual({ url: "/admin/api/users/3", init: { method: "DELETE", credentials: "same-origin", headers: {}, body: undefined } });
  });

  it.each([
    ["POST", () => api.post("/x")],
    ["PUT", () => api.put("/x")],
    ["PATCH", () => api.patch("/x")],
  ])("%s without a body sends an explicit {} as JSON", async (method, call) => {
    const sent = respond(200, "");
    await call();
    expect(sent[0].init).toEqual({ method, credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" });
  });

  it.each([
    ["POST", () => api.post("/x", { a: 1, b: [true, null] })],
    ["PUT", () => api.put("/x", { a: 1, b: [true, null] })],
    ["PATCH", () => api.patch("/x", { a: 1, b: [true, null] })],
  ])("%s serialises the given body as JSON", async (method, call) => {
    const sent = respond(200, "");
    await call();
    expect(sent[0].init).toEqual({ method, credentials: "same-origin", headers: { "content-type": "application/json" }, body: '{"a":1,"b":[true,null]}' });
  });

  it.each([
    [null, "null"],
    [0, "0"],
    [false, "false"],
    ["", '""'],
    [[], "[]"],
  ])("sends the falsy-but-defined body %j as %s rather than replacing it with {}", async (body, wire) => {
    const sent = respond(200, "");
    await api.post("/x", body);
    expect(sent[0].init.body).toBe(wire);
    expect(sent[0].init.headers).toEqual({ "content-type": "application/json" });
  });

  it("passes the path through verbatim, including a query string", async () => {
    const sent = respond(200, "{}");
    await api.get("/logs?limit=10&q=a%20b");
    expect(sent[0].url).toBe("/admin/api/logs?limit=10&q=a%20b");
  });
});

describe("api response handling", () => {
  it("returns the parsed JSON of a 2xx response", async () => {
    respond(200, '{"users":[{"id":1}]}');
    await expect(api.get("/users")).resolves.toEqual({ users: [{ id: 1 }] });
  });

  it.each([[200], [201], [204], [299]])("treats %i as success", async (status) => {
    respond(status, '{"ok":true}');
    await expect(api.post("/x")).resolves.toEqual({ ok: true });
  });

  it("returns undefined for an empty 2xx body", async () => {
    respond(204, "");
    await expect(api.del("/x")).resolves.toBeUndefined();
  });

  it("returns the raw text of a 2xx body that is not JSON", async () => {
    respond(200, "plain ok");
    await expect(api.get("/x")).resolves.toBe("plain ok");
  });

  it("returns JSON scalars and null as they are", async () => {
    respond(200, "5");
    await expect(api.get("/x")).resolves.toBe(5);
    respond(200, "null");
    await expect(api.get("/x")).resolves.toBeNull();
  });

  it("throws ApiError carrying the status, the server's error text and the parsed body", async () => {
    respond(403, '{"error":"nope","detail":{"a":1}}');
    const e = await caught(api.get("/x"));
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ApiError");
    expect(e.status).toBe(403);
    expect(e.message).toBe("nope");
    expect(e.data).toEqual({ error: "nope", detail: { a: 1 } });
  });

  it.each([[300], [400], [401], [404], [409], [422], [500], [503]])("rejects on status %i", async (status) => {
    respond(status, '{"error":"e"}');
    const e = await caught(api.post("/x", {}));
    expect(e.status).toBe(status);
    expect(e.message).toBe("e");
  });

  it("has no special case for 401: it is an ordinary ApiError and nothing else is fetched", async () => {
    const sent = respond(401, '{"error":"unauthorized"}');
    const e = await caught(api.get("/me"));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(401);
    expect(e.message).toBe("unauthorized");
    expect(sent).toHaveLength(1);
  });

  it("uses a generic message when the JSON error body has no error key", async () => {
    respond(500, '{"message":"x"}');
    const e = await caught(api.get("/x"));
    expect(e.message).toBe("Request failed (500)");
    expect(e.data).toEqual({ message: "x" });
  });

  it("stringifies a non-string error value", async () => {
    respond(400, '{"error":42}');
    expect((await caught(api.get("/x"))).message).toBe("42");
  });

  it("keeps a non-JSON error body as text with the generic message", async () => {
    respond(502, "<html>Bad Gateway</html>");
    const e = await caught(api.get("/x"));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(502);
    expect(e.message).toBe("Request failed (502)");
    expect(e.data).toBe("<html>Bad Gateway</html>");
  });

  it.each([
    ["an empty body", "", undefined],
    ["JSON null", "null", null],
    ["a JSON string", '"oops"', "oops"],
    ["a JSON array", '[{"error":"x"}]', [{ error: "x" }]],
  ])("uses the generic message for an error response with %s", async (_name, text, data) => {
    respond(500, text);
    const e = await caught(api.get("/x"));
    expect(e.message).toBe("Request failed (500)");
    expect(e.data).toEqual(data);
  });

  it("lets a network failure propagate as the original error, not an ApiError", async () => {
    const failure = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", vi.fn(async () => { throw failure; }));
    const e = await caught(api.get("/x"));
    expect(e).toBe(failure);
    expect(e).not.toBeInstanceOf(ApiError);
  });

  it("lets a body-read failure propagate", async () => {
    const failure = new Error("stream aborted");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => { throw failure; } })));
    await expect(api.get("/x")).rejects.toBe(failure);
  });
});

describe("ApiError", () => {
  it("exposes status, message and optional data", () => {
    const e = new ApiError(418, "teapot", { a: 1 });
    expect({ name: e.name, status: e.status, message: e.message, data: e.data }).toEqual({ name: "ApiError", status: 418, message: "teapot", data: { a: 1 } });
    expect(new ApiError(500, "x").data).toBeUndefined();
  });
});
