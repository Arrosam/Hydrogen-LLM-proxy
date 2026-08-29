import { FormatConversionError } from "../core/format/errors";
import type { Family } from "../core/ir/params";
import type { ContentPart, FilePart, Message } from "../core/ir/content";
import type { Request, RequestData } from "../core/ir/request";
import type { Transport } from "../core/upstream/transport";

/**
 * File pre-pass: fetch a URL attachment and inline its bytes for an egress
 * family that cannot carry a URL.
 *
 * Anthropic (`document.source.type: "url"`) and OpenAI Responses (`file_url`)
 * both take a URL and fetch it themselves. Chat Completions does not: its only
 * inline shape is `file_data`, which means the file's actual bytes. Writing the
 * URL string there produces a document whose content is the literal URL, so the
 * pre-pass downloads it once here and hands the upstream real bytes -- the same
 * shape the OCR and ASR pre-passes use to make an attachment expressible.
 *
 * The proxy imposes no size, MIME or content limits of its own: it is a relay,
 * and the provider is the one that knows (and enforces) what it accepts. What it
 * DOES enforce is its own egress safety -- every hop, redirects included, goes
 * through the SSRF guard, because a URL that arrives in a request body is
 * attacker-controlled input and this process can reach networks the client
 * cannot.
 */

/** Egress families whose wire format can carry a file by URL as-is. */
const URL_CAPABLE: ReadonlySet<Family> = new Set<Family>(["anthropic", "openai_responses"]);

/** Redirect hops followed before giving up. Each hop is re-checked by the guard. */
const MAX_REDIRECTS = 5;

const isUrlFile = (p: ContentPart): p is FilePart & { source: { kind: "url"; url: string } } =>
  p.type === "file" && p.source.kind === "url";

/** Whether this request has anything the target family would have to inline. */
export function needsUrlFileInlining(request: Request, family: Family): boolean {
  if (URL_CAPABLE.has(family)) return false;
  return request.messages.some((m) => m.content.some(isUrlFile));
}

/** The media type to label the inlined bytes with. The provider re-sniffs the
 * content anyway; this only has to be honest about what the server said. */
function mediaTypeOf(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers["content-type"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const type = value?.split(";")[0]?.trim();
  return type && type !== "application/octet-stream" ? type : "application/pdf";
}

function locationOf(headers: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers["location"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value || undefined;
}

/**
 * Download one URL and return its bytes plus the server's media type.
 *
 * Redirects are followed by hand rather than by undici, and each hop is passed
 * back through `getStream` -- whose implementation runs the SSRF guard -- so a
 * public URL cannot 302 its way to a loopback or link-local address (169.254.169.254
 * being the one that matters). Failures are thrown: `runSteps` classifies an
 * SSRF rejection or an HTTP status as a fault that will not change on retry,
 * while a dropped connection stays a retryable network error.
 */
async function download(
  url: string,
  transport: Transport,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ data: string; mediaType: string }> {
  if (!transport.getStream) {
    throw new FormatConversionError(`cannot inline the file at ${url}: this transport cannot fetch URLs`);
  }
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await transport.getStream(current, { accept: "*/*" }, opts);
    if (res.status >= 300 && res.status < 400) {
      const next = locationOf(res.headers);
      res.body?.destroy?.();
      if (!next) {
        throw new FormatConversionError(`cannot inline the file at ${url}: redirect with no location header`);
      }
      current = new URL(next, current).toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      res.body?.destroy?.();
      throw new FormatConversionError(`cannot inline the file at ${url}: the file server returned ${res.status}`);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of res.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    return { data: Buffer.concat(chunks).toString("base64"), mediaType: mediaTypeOf(res.headers) };
  }
  throw new FormatConversionError(`cannot inline the file at ${url}: more than ${MAX_REDIRECTS} redirects`);
}

/**
 * Return a request whose URL file attachments have been replaced by their bytes,
 * or the request unchanged when the target family can carry URLs (or there is
 * nothing to inline). Each distinct URL is fetched once, however many messages
 * reference it.
 */
export async function inlineUrlFiles(
  request: Request,
  family: Family,
  transport: Transport,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<Request> {
  if (!needsUrlFileInlining(request, family)) return request;

  const urls = new Set<string>();
  for (const m of request.messages) for (const p of m.content) if (isUrlFile(p)) urls.add(p.source.url);

  const fetched = new Map<string, { data: string; mediaType: string }>();
  for (const url of urls) fetched.set(url, await download(url, transport, opts));

  const messages: Message[] = request.messages.map((m) => ({
    ...m,
    content: m.content.map((p): ContentPart => {
      if (!isUrlFile(p)) return p;
      const got = fetched.get(p.source.url)!;
      return { ...p, source: { kind: "base64", mediaType: got.mediaType, data: got.data } };
    }),
  }));

  const data: RequestData = { ...request.data(), messages };
  return new (request.constructor as new (d: RequestData) => Request)(data);
}
