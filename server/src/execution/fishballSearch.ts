import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Transport } from "../core/upstream/transport";
import { callHttpTool, type HttpTool, type HttpToolResult } from "./toolHttp";
import registry from "./fishball-source-tiers.json";

export const FISHBALL_SEARCH = "fishball_search_v1";
export const SearchArguments = z.object({
  queries: z.array(z.string().trim().min(1).max(2048)).min(1).max(5),
  language: z.string().max(64).default("zh-CN"), categories: z.string().max(256).optional(),
  time_range: z.enum(["day", "month", "year"]).optional(), page: z.number().int().min(1).max(100).default(1),
});
export const searchParameters = {
  type: "object", required: ["queries"], additionalProperties: false,
  properties: {
    queries: { type: "array", minItems: 1, maxItems: 5, items: { type: "string", minLength: 1, maxLength: 2048 } },
    language: { type: "string", maxLength: 64 }, categories: { type: "string", maxLength: 256 },
    time_range: { type: "string", enum: ["day", "month", "year"] }, page: { type: "integer", minimum: 1, maximum: 100 },
  },
};
const Hit = z.object({ url: z.string().url().max(4096).refine(u => /^https?:\/\//i.test(u)), title: z.string().default(""), content: z.string().default(""), engine: z.string().default(""), author: z.string().nullish() });
export type SearchHit = { url: string; title: string; snippet: string; engine: string; account?: string | null };
export type SearchOutcome = { query: string; status: "success" | "empty" | "degraded" | "failed"; engines: string[]; hits: SearchHit[]; error?: string; ranking?: "reranked" | "engine" };
const suffix = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
/** Same default-context publisher-first rules as Fishball TrustResolver. UI remains authoritative. */
export function trust(hit: SearchHit): { tier: string; displayName: string; explanation?: string } {
  const host = new URL(hit.url).hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  const publisher = registry.publishers.flatMap(p => p.domains.filter(d => suffix(host, d)).map(d => ({ p, length: d.length }))).sort((a, b) => b.length - a.length)[0];
  const platform = registry.platforms.filter(p => suffix(host, p.domain)).sort((a, b) => b.domain.length - a.domain.length)[0];
  if (platform && (!publisher || platform.domain.length >= publisher.length)) {
    const account = hit.account?.trim();
    const known = account ? registry.publishers.find(p => (p.accounts as string[] | undefined)?.includes(account)) : undefined;
    if (known) return { tier: known.tier === "AUTHORITATIVE" ? "HIGH" : known.tier, displayName: known.displayName, explanation: known.explanation };
    return { tier: platform.defaultTier, displayName: platform.displayName, explanation: platform.explanation };
  }
  if (publisher) return { tier: publisher.p.tier, displayName: publisher.p.displayName, explanation: publisher.p.explanation };
  const pattern = registry.publisherPatterns.filter(p => suffix(host, p.match.replace(/^\*\./, ""))).sort((a, b) => b.match.length - a.match.length)[0];
  return pattern ? { tier: pattern.tier, displayName: pattern.displayName, explanation: pattern.explanation } : { tier: "LOW", displayName: host };
}
function engineNames(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("invalid_result");
  return value.map(e => typeof e === "string" ? e : Array.isArray(e) ? e[0] : e?.name)
    .filter((e): e is string => typeof e === "string").slice(0, 64).map(e => e.slice(0, 128));
}
/** Strict shape checking: missing results is failure, never an empty search. */
export function normalizeSearch(query: string, value: unknown): SearchOutcome {
  const dto = z.object({ results: z.array(z.unknown()), unresponsive_engines: z.unknown().optional() }).parse(value);
  const engines = engineNames(dto.unresponsive_engines);
  const valid = dto.results.map(row => Hit.safeParse(row));
  if (valid.length && valid.every(row => !row.success)) throw new Error("invalid_result");
  const hits = valid.flatMap(row => row.success ? [{ url: row.data.url, title: row.data.title.slice(0, 512), snippet: row.data.content.slice(0, 2000), engine: row.data.engine.slice(0, 128), account: row.data.author?.slice(0, 256) }] : []);
  return { query, status: engines.length || valid.some(row => !row.success) ? "degraded" : hits.length ? "success" : "empty", engines, hits: [...new Map(hits.map(h => [h.url, h])).values()].slice(0, 30) };
}
/** Bound even DNS/connection setup; discard and destroy a transport that resolves late. */
async function openSearch(transport: Pick<Transport, "getStream">, url: string, headers: Record<string, string>, timeoutMs: number, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!transport.getStream) throw new Error("transport_unavailable");
  return new Promise<Awaited<ReturnType<NonNullable<Transport["getStream"]>>>>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    transport.getStream!(url, headers, { timeoutMs, signal, proxy: null }).then(response => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) { response.body.destroy(); reject(signal.reason); } else resolve(response);
    }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
async function search(tool: HttpTool, query: string, args: z.infer<typeof SearchArguments>, transport: Pick<Transport, "getStream">, signal?: AbortSignal): Promise<SearchOutcome> {
  const timeout = AbortSignal.timeout(tool.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let error = "connection_error";
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    let destroyOnAbort: (() => void) | undefined;
    let response: Awaited<ReturnType<NonNullable<Transport["getStream"]>>> | undefined;
    try {
      combined.throwIfAborted();
      if (!transport.getStream) throw new Error("transport_unavailable");
      const url = new URL(tool.url);
      url.searchParams.set("q", query); url.searchParams.set("format", "json"); url.searchParams.set("safesearch", "1"); url.searchParams.set("pageno", String(args.page));
      for (const key of ["language", "categories", "time_range"] as const) if (args[key]) url.searchParams.set(key, args[key]!);
      response = await openSearch(transport, url.toString(), { ...tool.headers, accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; Fishball/1.0)" }, tool.timeoutMs, combined);
      destroyOnAbort = () => response?.body.destroy(new Error("Search aborted"));
      combined.addEventListener("abort", destroyOnAbort, { once: true });
      if (response.status < 200 || response.status >= 300) {
        error = response.status === 401 || response.status === 403 ? "authorization_failed" : `http_${response.status}`;
        if (![429, 502, 503, 504].includes(response.status)) break;
      } else {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of response.body) {
          combined.throwIfAborted(); const buffer = Buffer.from(chunk); bytes += buffer.length;
          if (bytes > tool.maxResultBytes) { error = "result_too_large"; break; }
          chunks.push(buffer);
        }
        if (bytes > tool.maxResultBytes) break;
        combined.throwIfAborted();
        try { return normalizeSearch(query, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { error = "invalid_result"; break; }
      }
    } catch { signal?.throwIfAborted(); error = timeout.aborted ? "timeout" : "connection_error"; }
    finally { if (destroyOnAbort) combined.removeEventListener("abort", destroyOnAbort); response?.body.destroy(); }
    if (timeout.aborted) break;
    if (attempt === 0) try { await delay(100, undefined, { signal: combined }); } catch { signal?.throwIfAborted(); error = "timeout"; break; }
  }
  return { query, status: "failed", engines: [], hits: [], error };
}
export async function callFishballSearch(tool: HttpTool, input: unknown, tools: HttpTool[], transport: Pick<Transport, "postStream" | "getStream">, signal?: AbortSignal): Promise<HttpToolResult> {
  const started = Date.now(); const args = SearchArguments.safeParse(input);
  if (!args.success) return { output: JSON.stringify({ error: "invalid_arguments" }), isError: true, durationMs: 0 };
  const outcomes = await Promise.all(args.data.queries.map(async query => {
    const result = await search(tool, query, args.data, transport, signal);
    const ranker = tools.find(t => t.enabled && t.name === tool.adapter?.rerankTool);
    result.ranking = "engine";
    if (ranker && result.hits.length > 1) {
      const ranked = await callHttpTool({ ...ranker, timeoutMs: Math.min(ranker.timeoutMs, 8000) }, { arguments: { query, documents: result.hits.map(h => `${h.title}\n${h.snippet}`) }, tool: { name: ranker.name }, call: { id: "rank" }, session: { id: "search" } }, transport, signal);
      if (!ranked.isError) try {
        const scores = z.array(z.object({ index: z.number().int().nonnegative(), relevance_score: z.number().finite() })).parse(JSON.parse(ranked.output));
        const indices = [...new Set(scores.sort((a, b) => b.relevance_score - a.relevance_score).map(s => s.index).filter(i => i < result.hits.length))];
        if (indices.length) { result.hits = [...indices.map(i => result.hits[i]), ...result.hits.filter((_, i) => !indices.includes(i))]; result.ranking = "reranked"; }
      } catch { /* Engine order is the documented ranking fallback. */ }
    }
    result.hits = result.hits.slice(0, 10); return result;
  }));
  const hits: SearchHit[] = []; const seen = new Set<string>();
  for (let i = 0; i < 10; i++) for (const outcome of outcomes) { const hit = outcome.hits[i]; if (hit && !seen.has(hit.url) && hits.length < 30) { hits.push(hit); seen.add(hit.url); } }
  const status = outcomes.every(o => o.status === "failed") ? "failed" : outcomes.some(o => o.status === "degraded" || o.status === "failed") ? "degraded" : hits.length ? "success" : "empty";
  return { output: JSON.stringify({ status, queries: outcomes.map(({ hits: _hits, ...rest }) => rest), hits: hits.map(h => ({ ...h, ...trust(h), tierLabel: ({ LOW: "低", MEDIUM: "中", HIGH: "高", AUTHORITATIVE: "权威" } as Record<string, string>)[trust(h).tier] })), instruction: status === "failed" ? "Search failed. Tell the user you could not search; do not substitute model knowledge." : status === "degraded" ? "Search is incomplete. Disclose the degradation; missing hits do not prove absence." : undefined }), isError: status === "failed", durationMs: Date.now() - started };
}
