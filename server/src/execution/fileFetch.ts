import { FormatConversionError } from "../core/format/errors";
import type { Family } from "../core/ir/params";
import type { ContentPart, FilePart, Message } from "../core/ir/content";
import type { Request, RequestData } from "../core/ir/request";
import type { Transport } from "../core/upstream/transport";
import { DEFAULT_FILE_MEDIA_TYPE } from "../core/ir/content";
import { BYTES_PER_MIB } from "../config/limits";
import { HEADER, MIME } from "../util/httpHeaders";
import { isSuccessStatus } from "../util/httpStatus";
import { readBounded } from "./boundedBody";

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
 * The proxy imposes no MIME or content limits of its own: it is a relay, and
 * the provider is the one that knows (and enforces) what it accepts. Size it
 * DOES bound: one download is capped at {@link MAX_DOWNLOAD_BYTES}, and a
 * Model Service / Micro Agent may set an aggregate budget of its own
 * (`maxAttachmentBytes`), so the buffering below cannot be turned into a
 * memory-exhaustion primitive by default or by accident. What it
 * enforces beyond that is its own egress safety -- every hop, redirects
 * included, goes through the SSRF guard, because a URL that arrives in a
 * request body is attacker-controlled input and this process can reach
 * networks the client cannot.
 */

/** Egress families whose wire format can carry a file by URL as-is. */
const URL_CAPABLE: ReadonlySet<Family> = new Set<Family>(["anthropic", "openai_responses"]);

/** Redirect hops followed before giving up. Each hop is re-checked by the guard. */
const MAX_REDIRECTS = 5;

/**
 * Byte budget for one downloaded attachment. The client-facing `bodyLimit`
 * does not apply to this server-side fetch, so without a cap any API-key
 * holder could point the proxy at a huge (or endless) response and OOM the
 * process: the bytes are fully buffered, then base64-inflated by a third.
 */
export const MAX_DOWNLOAD_BYTES = 50 * BYTES_PER_MIB;

/** The 3xx range: a response the download follows rather than reads. */
const REDIRECT_STATUS_MIN = 300;
const REDIRECT_STATUS_END = 400;

/** The download takes whatever media type the file server offers. */
const ACCEPT_ANY = "*/*";

/** A downloaded attachment: its base64 form, and the size of the file itself. */
interface Downloaded {
  data: string;
  mediaType: string;
  byteLength: number;
}

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
  const raw = headers[HEADER.CONTENT_TYPE];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const type = value?.split(";")[0]?.trim();
  return type && type !== MIME.OCTET_STREAM ? type : DEFAULT_FILE_MEDIA_TYPE;
}

function locationOf(headers: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers[HEADER.LOCATION];
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
): Promise<Downloaded> {
  // Deliberately no `proxy` in `opts`: this is the ONE transport caller whose
  // URL comes out of a client's request body rather than a provider row.
  // Leaving it unset keeps it on the direct, DNS-pinned path -- so nothing an
  // API-token holder can write into a request can select a proxy, and with it
  // opt out of the address validation that path performs.
  if (!transport.getStream) {
    throw new FormatConversionError(`cannot inline the file at ${url}: this transport cannot fetch URLs`);
  }
  const signal = AbortSignal.any([AbortSignal.timeout(opts.timeoutMs), ...(opts.signal ? [opts.signal] : [])]);
  opts = { ...opts, signal };
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    signal.throwIfAborted();
    const res = await transport.getStream(current, { [HEADER.ACCEPT]: ACCEPT_ANY }, opts);
    if (res.status >= REDIRECT_STATUS_MIN && res.status < REDIRECT_STATUS_END) {
      const next = locationOf(res.headers);
      res.body?.destroy?.();
      if (!next) {
        throw new FormatConversionError(`cannot inline the file at ${url}: redirect with no location header`);
      }
      current = new URL(next, current).toString();
      continue;
    }
    if (!isSuccessStatus(res.status)) {
      res.body?.destroy?.();
      throw new FormatConversionError(`cannot inline the file at ${url}: the file server returned ${res.status}`);
    }
    const abort = () => res.body.destroy(signal.reason instanceof Error ? signal.reason : new Error("download aborted"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const bytes = await readBounded(res.body, MAX_DOWNLOAD_BYTES, signal);
      if (!bytes) {
        // Stopped before buffering more: destroy the stream so the connection
        // does not drain a huge body nobody will use.
        res.body?.destroy?.();
        throw new FormatConversionError(
          `cannot inline the file at ${url}: it exceeds the ${MAX_DOWNLOAD_BYTES}-byte download limit`,
        );
      }
      return { data: bytes.toString("base64"), mediaType: mediaTypeOf(res.headers), byteLength: bytes.length };
    } finally {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) res.body.destroy();
    }
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
  opts: {
    timeoutMs: number;
    signal?: AbortSignal;
    /**
     * Optional aggregate budget for this inline pass, from the Model Service /
     * Micro Agent serving the request (`maxAttachmentBytes` in its definition).
     * The proxy sets no limit of its own -- a relay should not decide what a
     * user may attach -- but an operator who knows their provider's (or their
     * box's) appetite can set one per service. Absent or 0 means unlimited.
     */
    maxTotalBytes?: number;
  },
): Promise<Request> {
  if (!needsUrlFileInlining(request, family)) return request;

  const urls = new Set<string>();
  for (const m of request.messages) for (const p of m.content) if (isUrlFile(p)) urls.add(p.source.url);

  const limit = opts.maxTotalBytes != null && opts.maxTotalBytes > 0 ? opts.maxTotalBytes : Infinity;
  const fetched = new Map<string, Downloaded>();
  let totalBytes = 0;
  for (const url of urls) {
    const got = await download(url, transport, opts);
    // The file's own size: its base64 form is padded, so deriving the size
    // from that would over-count by up to two bytes.
    totalBytes += got.byteLength;
    if (totalBytes > limit) {
      throw new FormatConversionError(
        `cannot inline the URL attachments: together they exceed the ${limit}-byte limit configured for this service`,
      );
    }
    fetched.set(url, got);
  }

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
