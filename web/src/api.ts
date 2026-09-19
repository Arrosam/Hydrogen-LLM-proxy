export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
  // Every mutating call carries an explicit JSON body. A POST/PUT/PATCH sent
  // with no body and no Content-Type is answered with 415 Unsupported Media Type
  // by some fronting proxies, and a body sent without a Content-Type is rejected
  // by the server's own parser; "{}" makes the request well-formed either way,
  // and the endpoints that take no input (logout, restart, reveal-secret) simply
  // ignore it.
  const mutating = method === "POST" || method === "PUT" || method === "PATCH";
  const payload: unknown = body !== undefined ? body : mutating ? {} : undefined;
  const res = await fetch(`/admin/api${path}`, {
    method,
    credentials: "same-origin",
    headers: payload !== undefined ? { "content-type": "application/json" } : {},
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    if (data && typeof data === "object" && "error" in data) {
      message = String((data as { error: unknown }).error);
    }
    throw new ApiError(res.status, message, data);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, "GET"),
  post: <T>(path: string, body?: unknown) => request<T>(path, "POST", body),
  put: <T>(path: string, body?: unknown) => request<T>(path, "PUT", body),
  patch: <T>(path: string, body?: unknown) => request<T>(path, "PATCH", body),
  del: <T>(path: string) => request<T>(path, "DELETE"),
};
