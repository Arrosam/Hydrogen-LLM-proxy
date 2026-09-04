import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { PageHeader } from "../components/Layout";
import { ErrorNote, Spinner, StatusBadge, Toggle } from "../components/common";
import { useToast } from "../components/Toast";
import { useAuth } from "../auth";
import { useI18n } from "../lib/i18n";
import { copyToClipboard } from "../lib/clipboard";
import { estimateTokens, loremOfTokens } from "../lib/lorem";
import { formatNumber } from "../lib/format";
import type { BenchMapping, BenchServiceInfo, BenchTargets, Family, ServiceCategory, Token } from "../types";

/**
 * Model Bench: aim one request at one model and see exactly what came back.
 *
 * Two transports, because they answer different questions and neither answer
 * substitutes for the other:
 *
 *  - PROXY runs in this browser, straight at Hydrogen's own /v1/* endpoints
 *    with a real client token. It is a client request in every respect --
 *    ingress translation, quota, the request log -- so what it shows is what a
 *    client sees, byte for byte.
 *  - INTERNAL goes through an admin route that drives the executor directly.
 *    It cannot tell you what a client sees, and in exchange it shows what a
 *    client never can: the exact body that went upstream, the attempt path,
 *    and a raw (model, provider, endpoint) tuple that no Model Service wraps.
 *
 * The proxy surface addresses services by name and nothing else, so a raw
 * target has no proxy form -- the switch says so rather than silently
 * producing a request against a service that does not exist.
 */

type Transport = "proxy" | "internal";
type TargetKind = "service" | "agent" | "raw";

const FAMILIES: Family[] = ["openai_completion", "anthropic", "openai_responses"];
const MEDIA_CATEGORIES: ServiceCategory[] = ["embedding", "rerank", "image", "video", "tts", "stt"];
const ALL_CATEGORIES: ServiceCategory[] = ["chat", ...MEDIA_CATEGORIES];

const isChatCategory = (c: ServiceCategory): boolean => c === "chat" || c === "ocr";

/** The client endpoint a category (and, for chat, an ingress family) lives on. */
function proxyPath(category: ServiceCategory, ingress: Family): string {
  if (isChatCategory(category)) {
    if (ingress === "anthropic") return "/v1/messages";
    if (ingress === "openai_responses") return "/v1/responses";
    return "/v1/chat/completions";
  }
  switch (category) {
    case "embedding": return "/v1/embeddings";
    case "rerank": return "/v1/rerank";
    case "image": return "/v1/images/generations";
    case "video": return "/v1/videos";
    case "tts": return "/v1/audio/speech";
    case "stt": return "/v1/audio/transcriptions";
    default: return "/v1/chat/completions";
  }
}

interface Attachment {
  name: string;
  mediaType: string;
  /** base64, without the data: prefix. */
  data: string;
  /** The same bytes as a `data:` URL. Built once, at read time, because three
   * of the four wire spellings want it and there is no reason to re-derive it
   * per send. (Not a hot path: a JS engine ropes a concatenation and only
   * flattens it when the string is consumed, which is at serialization.) */
  dataUrl: string;
}

async function readAttachment(file: File): Promise<Attachment> {
  const buf = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  // Chunked, because String.fromCharCode(...bytes) blows the argument limit on
  // anything bigger than a small image.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const mediaType = file.type || "application/octet-stream";
  const data = btoa(binary);
  return { name: file.name, mediaType, data, dataUrl: `data:${mediaType};base64,${data}` };
}

/** One attachment as the content part its wire family spells it with. */
function attachmentPart(a: Attachment, family: Family): Record<string, unknown> {
  const isImage = a.mediaType.startsWith("image/");
  if (family === "anthropic") {
    return isImage
      ? { type: "image", source: { type: "base64", media_type: a.mediaType, data: a.data } }
      : { type: "document", title: a.name, source: { type: "base64", media_type: a.mediaType, data: a.data } };
  }
  if (family === "openai_responses") {
    return isImage
      ? { type: "input_image", image_url: a.dataUrl }
      : { type: "input_file", filename: a.name, file_data: a.dataUrl };
  }
  return isImage
    ? { type: "image_url", image_url: { url: a.dataUrl } }
    : { type: "file", file: { filename: a.name, file_data: a.dataUrl } };
}

interface ChatInput {
  model: string;
  family: Family;
  system: string;
  text: string;
  attachments: Attachment[];
  stream: boolean;
  params: Record<string, unknown>;
}

/** The wire body a client of `family` would send. */
function buildChatBody(i: ChatInput): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [];
  if (i.family === "openai_responses") {
    if (i.text) parts.push({ type: "input_text", text: i.text });
  } else {
    parts.push({ type: "text", text: i.text });
  }
  for (const a of i.attachments) parts.push(attachmentPart(a, i.family));

  if (i.family === "anthropic") {
    return {
      model: i.model,
      // Required on this wire and deliberately not invented anywhere else in
      // Hydrogen, so the bench states it like a real Anthropic client would.
      max_tokens: 4096,
      ...(i.system ? { system: i.system } : {}),
      messages: [{ role: "user", content: parts }],
      ...(i.stream ? { stream: true } : {}),
      ...i.params,
    };
  }
  if (i.family === "openai_responses") {
    return {
      model: i.model,
      ...(i.system ? { instructions: i.system } : {}),
      input: [{ role: "user", content: parts }],
      ...(i.stream ? { stream: true } : {}),
      ...i.params,
    };
  }
  return {
    model: i.model,
    messages: [
      ...(i.system ? [{ role: "system", content: i.system }] : []),
      { role: "user", content: parts },
    ],
    ...(i.stream ? { stream: true } : {}),
    ...i.params,
  };
}

/** A starting body for each media category, so the panel is never a blank box. */
function defaultMediaBody(category: ServiceCategory, model: string, text: string): Record<string, unknown> {
  switch (category) {
    case "embedding": return { model, input: text || "hello" };
    case "rerank": return { model, query: text || "hello", documents: ["first document", "second document"] };
    case "image": return { model, prompt: text || "a red circle on a white background", n: 1, size: "1024x1024" };
    case "video": return { model, prompt: text || "a red circle rolling across a white background" };
    case "tts": return { model, input: text || "Hydrogen model bench.", voice: "alloy" };
    case "stt": return { model };
    default: return { model };
  }
}

interface Served {
  model: string;
  provider: string;
  family: Family;
  upstreamModel: string;
  url?: string;
}

interface Outcome {
  ok: boolean;
  status: number;
  latencyMs: number;
  message?: string;
  served?: Served;
  /** The exact body Hydrogen sent upstream. Internal transport only. */
  upstreamRequest?: unknown;
  /** The body the client received (parsed when it was JSON). */
  response?: unknown;
  usage?: unknown;
  attemptPath?: unknown;
  /** Raw SSE frames, in arrival order. */
  frames?: string[];
  audio?: { mediaType: string; base64: string; bytes: number };
  /** What the bench itself sent, and where. */
  sentBody?: unknown;
  sentUrl?: string;
}

const prettyJson = (v: unknown): string => {
  if (v === undefined) return "";
  if (typeof v === "string") {
    try {
      return JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      return v;
    }
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

/**
 * Assemble the text a streamed run produced, from the raw frames, in whichever
 * dialect they arrived in. A bench that only showed frames would make you read
 * SSE to find out whether the model answered.
 */
function textFromFrames(frames: string[]): string {
  let out = "";
  for (const frame of frames) {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      // Anthropic
      const delta = data.delta as Record<string, unknown> | undefined;
      if (data.type === "content_block_delta" && delta && typeof delta.text === "string") out += delta.text;
      // Responses
      else if (data.type === "response.output_text.delta" && typeof data.delta === "string") out += data.delta;
      // Chat Completions
      else if (Array.isArray(data.choices)) {
        for (const ch of data.choices as Array<Record<string, unknown>>) {
          const d = ch.delta as Record<string, unknown> | undefined;
          if (d && typeof d.content === "string") out += d.content;
        }
      }
    }
  }
  return out;
}

/**
 * The usage a streamed run reported, dug out of the frames.
 *
 * Every wire puts it somewhere different and all of them put it at the END,
 * which is precisely where a reader watching the text stop has stopped looking.
 * Without this the bench showed a streamed run with no token counts at all --
 * no cached share, no thinking tokens -- beside a buffered run that showed all
 * three, which reads as the proxy having lost them.
 */
function usageFromFrames(frames: string[]): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  // Anthropic splits it in two: the input side and both cache counters arrive
  // on message_start, the output side on message_delta. Merge, do not replace.
  let anthropic: Record<string, unknown> | undefined;
  for (const frame of frames) {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = String(data.type ?? "");
      if (type === "message_start") {
        const u = (data.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined;
        if (u) anthropic = { ...anthropic, ...u };
      } else if (type === "message_delta" && data.usage) {
        anthropic = { ...anthropic, ...(data.usage as Record<string, unknown>) };
      } else if (type.startsWith("response.") && data.response) {
        const u = (data.response as Record<string, unknown>).usage as Record<string, unknown> | undefined;
        if (u) found = u;
      } else if (data.usage) {
        found = data.usage as Record<string, unknown>;
      }
    }
  }
  return found ?? anthropic;
}

/** Split an SSE body into frames, keeping each one whole. */
function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let rest = buffer;
  for (;;) {
    const m = /\r?\n\r?\n/.exec(rest);
    if (!m) break;
    const raw = rest.slice(0, m.index);
    rest = rest.slice(m.index + m[0].length);
    if (raw.trim()) frames.push(raw);
  }
  return { frames, rest };
}

export function ModelBench() {
  const { t } = useI18n();
  const { user } = useAuth();
  const toast = useToast();

  const [targets, setTargets] = useState<BenchTargets | null>(null);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [transport, setTransport] = useState<Transport>("internal");
  const [targetKind, setTargetKind] = useState<TargetKind>("service");
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [rawModel, setRawModel] = useState("");
  const [rawProvider, setRawProvider] = useState("");
  const [rawProviderFormat, setRawProviderFormat] = useState<Family>("openai_completion");
  const [rawCategory, setRawCategory] = useState<ServiceCategory>("chat");

  const [ingress, setIngress] = useState<Family>("openai_completion");
  const [streaming, setStreaming] = useState(false);
  const [tokenId, setTokenId] = useState<number | null>(null);
  const [tokenSecret, setTokenSecret] = useState("");

  const [system, setSystem] = useState("");
  const [prompt, setPrompt] = useState("Reply with the single word: pong.");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [fillerTokens, setFillerTokens] = useState(10_000);
  const [filler, setFiller] = useState("");
  const [params, setParams] = useState<Array<{ key: string; value: string }>>([]);
  const [bodyOverride, setBodyOverride] = useState<string | null>(null);
  const [timeoutSec, setTimeoutSec] = useState(300);

  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [liveFrames, setLiveFrames] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    api
      .get<BenchTargets>("/bench/targets")
      .then((r) => {
        setTargets(r);
        setLoadError(null);
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
    api
      .get<{ tokens: Token[] }>("/tokens")
      .then((r) => setTokens(r.tokens))
      .catch(() => setTokens([]));
  }, []);

  const services = targets?.services ?? [];
  const mappings = targets?.mappings ?? [];

  const pickable = useMemo<BenchServiceInfo[]>(
    () => services.filter((s) => s.valid && (targetKind === "agent" ? s.kind === "micro_agent" : s.kind === "model_service")),
    [services, targetKind],
  );

  const selectedService = useMemo(
    () => services.find((s) => s.id === serviceId) ?? null,
    [services, serviceId],
  );

  // Models that have at least one mapping, and the mappings for the chosen one.
  const rawModels = useMemo(() => {
    const names = new Set<string>();
    for (const m of mappings) if (m.model) names.add(m.model);
    return [...names].sort();
  }, [mappings]);

  const rawProviders = useMemo<BenchMapping[]>(
    () => mappings.filter((m) => m.model === rawModel),
    [mappings, rawModel],
  );

  const rawFamilies = useMemo<Family[]>(
    () => rawProviders.find((m) => m.provider === rawProvider)?.families ?? [],
    [rawProviders, rawProvider],
  );

  // Keep the raw tuple internally consistent as each level is chosen.
  useEffect(() => {
    if (targetKind !== "raw") return;
    if (!rawModel && rawModels.length) setRawModel(rawModels[0]);
  }, [targetKind, rawModel, rawModels]);
  useEffect(() => {
    if (rawProviders.length && !rawProviders.some((m) => m.provider === rawProvider)) {
      setRawProvider(rawProviders[0].provider);
    }
  }, [rawProviders, rawProvider]);
  useEffect(() => {
    if (rawFamilies.length && !rawFamilies.includes(rawProviderFormat)) setRawProviderFormat(rawFamilies[0]);
  }, [rawFamilies, rawProviderFormat]);
  useEffect(() => {
    if (targetKind !== "raw" && pickable.length && !pickable.some((s) => s.id === serviceId)) {
      setServiceId(pickable[0].id);
    }
  }, [pickable, serviceId, targetKind]);

  const category: ServiceCategory = targetKind === "raw" ? rawCategory : selectedService?.category ?? "chat";
  const isChat = isChatCategory(category);

  // A raw tuple has no name on the proxy surface, so it has no proxy form.
  const proxyAvailable = targetKind !== "raw";
  useEffect(() => {
    if (!proxyAvailable && transport === "proxy") setTransport("internal");
  }, [proxyAvailable, transport]);

  const modelName = targetKind === "raw" ? `${rawModel}@${rawProvider}` : selectedService?.name ?? "";

  const paramObject = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const { key, value } of params) {
      if (!key.trim()) continue;
      // A bare word stays a string; anything JSON-shaped is sent as that shape,
      // so `true`, `0.7` and `["a"]` reach the provider as what they look like.
      try {
        out[key.trim()] = JSON.parse(value);
      } catch {
        out[key.trim()] = value;
      }
    }
    return out;
  }, [params]);

  const composedText = filler ? `${prompt}\n\n${filler}` : prompt;

  /**
   * The request body, built ON DEMAND rather than on every render.
   *
   * It used to be a `useMemo`, which meant every keystroke in the message box
   * reassembled it -- and with a context-window filler attached, or a picture,
   * "it" is a multi-megabyte object that was then pretty-printed and written
   * into the DOM for a preview nobody was necessarily looking at. Typing was
   * unusable. Now nothing builds it until something needs it: opening the
   * preview, opening the raw editor, or pressing Send.
   */
  const buildBody = useCallback((): Record<string, unknown> => {
    if (isChat) {
      return buildChatBody({
        model: modelName,
        family: ingress,
        system,
        text: composedText,
        attachments,
        stream: streaming,
        params: paramObject,
      });
    }
    return { ...defaultMediaBody(category, modelName, composedText), ...paramObject };
  }, [isChat, modelName, ingress, system, composedText, attachments, streaming, paramObject, category]);

  /**
   * Validity of a hand-edited body, from the edited TEXT alone. Deliberately
   * not derived from the assembled body: whether the Send button is enabled
   * must not cost a rebuild on every keystroke, and when no override is in play
   * there is nothing that can be invalid.
   */
  const overrideError = useMemo<string | null>(() => {
    if (bodyOverride == null) return null;
    try {
      JSON.parse(bodyOverride);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }, [bodyOverride]);

  /** What will actually be sent: the hand-edited body when there is one. */
  const currentBody = useCallback((): Record<string, unknown> => {
    if (bodyOverride == null) return buildBody();
    return JSON.parse(bodyOverride) as Record<string, unknown>;
  }, [bodyOverride, buildBody]);

  const target = useMemo(
    () =>
      targetKind === "raw"
        ? { kind: "raw" as const, model: rawModel, provider: rawProvider, providerFormat: rawProviderFormat }
        : { kind: "service" as const, serviceId: serviceId ?? 0 },
    [targetKind, rawModel, rawProvider, rawProviderFormat, serviceId],
  );

  const ready =
    overrideError == null &&
    (targetKind === "raw" ? Boolean(rawModel && rawProvider) : Boolean(serviceId)) &&
    (transport !== "proxy" || Boolean(tokenSecret)) &&
    (category !== "stt" || attachments.length > 0);

  const revealToken = useCallback(
    async (id: number) => {
      setTokenId(id);
      if (user?.role !== "admin") return;
      try {
        const r = await api.post<{ secret: string }>(`/tokens/${id}/secret`);
        setTokenSecret(r.secret);
      } catch (e) {
        setTokenSecret("");
        toast.error(e instanceof ApiError ? e.message : t("bench.token.revealFailed"));
      }
    },
    [user, toast, t],
  );

  const stop = (): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  };

  const run = async (): Promise<void> => {
    if (!ready || running) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setOutcome(null);
    setLiveFrames([]);
    const started = Date.now();
    try {
      // The one place the body is assembled for a send. Inside the try, so a
      // hand-edited body that will not parse is reported like any other failure
      // rather than escaping as an unhandled rejection.
      const body = currentBody();
      const result =
        transport === "proxy"
          ? await runProxy(body, controller.signal, started)
          : await runInternal(body, controller.signal, started);
      setOutcome(result);
    } catch (e) {
      if (controller.signal.aborted) {
        setOutcome({ ok: false, status: 0, latencyMs: Date.now() - started, message: t("bench.aborted") });
      } else {
        setOutcome({ ok: false, status: 0, latencyMs: Date.now() - started, message: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  /** Transport A: a real client request at Hydrogen's own client surface. */
  const runProxy = async (body: Record<string, unknown>, signal: AbortSignal, started: number): Promise<Outcome> => {
    const url = proxyPath(category, ingress);
    const headers: Record<string, string> = { authorization: `Bearer ${tokenSecret}` };
    if (isChat && ingress === "anthropic") headers["anthropic-version"] = "2023-06-01";

    // Speech-to-text is the one multipart surface; everything else is JSON.
    let init: RequestInit;
    let sentBody: unknown;
    if (category === "stt") {
      const form = new FormData();
      for (const [k, v] of Object.entries(body)) {
        if (v == null) continue;
        form.append(k, typeof v === "string" ? v : JSON.stringify(v));
      }
      const a = attachments[0];
      form.append("file", new Blob([Uint8Array.from(atob(a.data), (ch) => ch.charCodeAt(0))], { type: a.mediaType }), a.name);
      init = { method: "POST", headers, body: form, signal, credentials: "omit" };
      sentBody = { ...body, file: `(${a.name}, ${a.mediaType})` };
    } else {
      headers["content-type"] = "application/json";
      sentBody = body;
      init = { method: "POST", headers, body: JSON.stringify(body), signal, credentials: "omit" };
    }

    const res = await fetch(url, init);
    const contentType = res.headers.get("content-type") ?? "";

    if (contentType.includes("text/event-stream") && res.body) {
      const frames = await drainSse(res.body, (f) => setLiveFrames((prev) => [...prev, ...f]));
      return {
        ok: res.ok,
        status: res.status,
        latencyMs: Date.now() - started,
        frames,
        usage: usageFromFrames(frames),
        sentBody,
        sentUrl: url,
      };
    }

    if (contentType.startsWith("audio/") || contentType.startsWith("video/") || contentType === "application/octet-stream") {
      const buf = new Uint8Array(await res.arrayBuffer());
      let binary = "";
      for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return {
        ok: res.ok,
        status: res.status,
        latencyMs: Date.now() - started,
        audio: { mediaType: contentType, base64: btoa(binary), bytes: buf.length },
        sentBody,
        sentUrl: url,
      };
    }

    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON: keep the text */
    }
    const usage = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).usage : undefined;
    return {
      ok: res.ok,
      status: res.status,
      latencyMs: Date.now() - started,
      response: parsed,
      usage,
      message: res.ok ? undefined : messageOf(parsed) ?? `HTTP ${res.status}`,
      sentBody,
      sentUrl: url,
    };
  };

  /** Transport B: the admin route that drives the executor directly. */
  const runInternal = async (body: Record<string, unknown>, signal: AbortSignal, started: number): Promise<Outcome> => {
    const timeoutMs = Math.max(1000, timeoutSec * 1000);
    if (!isChat) {
      const payload: Record<string, unknown> = { target, category, body, timeoutMs };
      if (category === "stt") payload.file = attachments[0];
      const r = await api.post<Record<string, unknown>>("/bench/media", payload);
      return {
        ok: r.ok === true,
        status: Number(r.status ?? 0),
        latencyMs: Number(r.latencyMs ?? Date.now() - started),
        message: typeof r.message === "string" ? r.message : undefined,
        served: r.served as Served | undefined,
        upstreamRequest: r.upstreamRequest,
        response: r.response,
        audio: r.audio as Outcome["audio"],
        sentBody: body,
        sentUrl: "/admin/api/bench/media",
      };
    }

    const payload = { target, ingress, body, timeoutMs };

    if (streaming) {
      // The admin route answers SSE, with one trailing `event: bench` frame
      // carrying what only the server side can see.
      const res = await fetch("/admin/api/bench/chat", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
      if (!res.headers.get("content-type")?.includes("text/event-stream")) {
        const text = await res.text();
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* keep text */ }
        return { ok: false, status: res.status, latencyMs: Date.now() - started, message: messageOf(parsed) ?? `HTTP ${res.status}`, response: parsed };
      }
      const all = await drainSse(res.body!, (f) => setLiveFrames((prev) => [...prev, ...f.filter((x) => !x.startsWith("event: bench"))]));
      const metaFrame = all.filter((f) => f.startsWith("event: bench")).pop();
      const frames = all.filter((f) => !f.startsWith("event: bench"));
      let meta: Record<string, unknown> = {};
      if (metaFrame) {
        const line = metaFrame.split("\n").find((l) => l.startsWith("data:"));
        try { meta = JSON.parse(line!.slice(5).trim()) as Record<string, unknown>; } catch { /* leave empty */ }
      }
      return {
        ok: meta.ok === true,
        status: Number(meta.status ?? res.status),
        latencyMs: Number(meta.latencyMs ?? Date.now() - started),
        message: typeof meta.message === "string" ? meta.message : undefined,
        served: meta.served as Served | undefined,
        upstreamRequest: meta.upstreamRequest,
        // The server taps it off the terminal event; reading the frames is the
        // fallback when talking to a build that did not send it.
        usage: meta.usage ?? usageFromFrames(frames),
        attemptPath: meta.attemptPath,
        frames,
        sentBody: body,
        sentUrl: "/admin/api/bench/chat",
      };
    }

    const r = await api.post<Record<string, unknown>>("/bench/chat", payload);
    return {
      ok: r.ok === true,
      status: Number(r.status ?? 0),
      latencyMs: Number(r.latencyMs ?? Date.now() - started),
      message: typeof r.message === "string" ? r.message : undefined,
      served: r.served as Served | undefined,
      upstreamRequest: r.upstreamRequest,
      response: r.response,
      usage: r.usage,
      attemptPath: r.attemptPath,
      sentBody: body,
      sentUrl: "/admin/api/bench/chat",
    };
  };

  const addFiles = async (files: FileList | null): Promise<void> => {
    if (!files?.length) return;
    const next: Attachment[] = [];
    for (const f of Array.from(files)) next.push(await readAttachment(f));
    setAttachments((prev) => (category === "stt" ? next.slice(0, 1) : [...prev, ...next]));
  };

  if (loadError) return <ErrorNote message={loadError} />;
  if (!targets) return <Spinner label={t("bench.loading")} />;

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("bench.title")}
        subtitle={t("bench.subtitle")}
        icon="bi-clipboard-pulse"
        action={
          <div className="flex gap-2">
            {running && (
              <button className="btn-ghost" onClick={stop}>
                <i className="bi bi-stop-circle" />
                {t("bench.stop")}
              </button>
            )}
            <button className="btn-primary" disabled={!ready || running} onClick={run}>
              <i className={`bi ${running ? "bi-arrow-repeat animate-spin" : "bi-send"}`} />
              {running ? t("bench.running") : t("bench.send")}
            </button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* ---------------- request ---------------- */}
        <div className="space-y-4">
          <div className="card card-pad space-y-3">
            <h3 className="label m-0">{t("bench.section.target")}</h3>

            <div>
              <label className="label">{t("bench.field.transport")}</label>
              <div className="flex gap-2">
                {(["proxy", "internal"] as Transport[]).map((tr) => (
                  <button
                    key={tr}
                    type="button"
                    disabled={tr === "proxy" && !proxyAvailable}
                    className={transport === tr ? "btn-primary flex-1 btn-xs" : "btn-ghost flex-1 btn-xs"}
                    onClick={() => setTransport(tr)}
                  >
                    <i className={`bi ${tr === "proxy" ? "bi-globe2" : "bi-cpu"}`} />
                    {t(`bench.transport.${tr}`)}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-ink-500">
                {!proxyAvailable ? t("bench.transport.rawIsInternalOnly") : t(`bench.transport.${transport}.hint`)}
              </p>
            </div>

            <div>
              <label className="label">{t("bench.field.targetKind")}</label>
              <div className="flex gap-2">
                {(["service", "agent", "raw"] as TargetKind[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={targetKind === k ? "btn-primary flex-1 btn-xs" : "btn-ghost flex-1 btn-xs"}
                    onClick={() => setTargetKind(k)}
                  >
                    {t(`bench.targetKind.${k}`)}
                  </button>
                ))}
              </div>
            </div>

            {targetKind !== "raw" ? (
              <div>
                <label className="label">{t(`bench.targetKind.${targetKind}`)}</label>
                <select className="select" value={serviceId ?? ""} onChange={(e) => setServiceId(Number(e.target.value))}>
                  {pickable.length === 0 && <option value="">{t("bench.noTargets")}</option>}
                  {pickable.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {s.category}
                      {s.enabled ? "" : ` (${t("common.disabled")})`}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="label">{t("bench.field.model")}</label>
                  <select className="select" value={rawModel} onChange={(e) => setRawModel(e.target.value)}>
                    {rawModels.length === 0 && <option value="">{t("bench.noMappings")}</option>}
                    {rawModels.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">{t("bench.field.modelFormat")}</label>
                  <select className="select" value={ingress} onChange={(e) => setIngress(e.target.value as Family)} disabled={!isChat}>
                    {FAMILIES.map((f) => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">{t("bench.field.provider")}</label>
                  <select className="select" value={rawProvider} onChange={(e) => setRawProvider(e.target.value)}>
                    {rawProviders.map((m) => (
                      <option key={m.providerId} value={m.provider}>
                        {m.provider} → {m.upstreamModel}
                        {m.enabled ? "" : ` (${t("common.disabled")})`}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">{t("bench.field.providerFormat")}</label>
                  <select className="select" value={rawProviderFormat} onChange={(e) => setRawProviderFormat(e.target.value as Family)}>
                    {rawFamilies.map((f) => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="label">{t("bench.field.category")}</label>
                  <select className="select" value={rawCategory} onChange={(e) => setRawCategory(e.target.value as ServiceCategory)}>
                    {ALL_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>{cat}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {targetKind !== "raw" && isChat && (
              <div>
                <label className="label">{t("bench.field.modelFormat")}</label>
                <select className="select" value={ingress} onChange={(e) => setIngress(e.target.value as Family)}>
                  {FAMILIES.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-ink-500">{t("bench.field.modelFormat.hint")}</p>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-4">
              {isChat && <Toggle checked={streaming} onChange={setStreaming} label={t("bench.field.streaming")} />}
              {transport === "internal" && (
                <div className="flex items-center gap-2">
                  <label className="label m-0">{t("bench.field.timeout")}</label>
                  <input
                    className="input w-24"
                    type="number"
                    min={1}
                    value={timeoutSec}
                    onChange={(e) => setTimeoutSec(Number(e.target.value) || 1)}
                  />
                </div>
              )}
            </div>

            {transport === "proxy" && (
              <div>
                <label className="label">{t("bench.field.token")}</label>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    className="select"
                    value={tokenId ?? ""}
                    onChange={(e) => (e.target.value ? void revealToken(Number(e.target.value)) : setTokenId(null))}
                  >
                    <option value="">{t("bench.token.choose")}</option>
                    {tokens.map((tk) => (
                      <option key={tk.id} value={tk.id}>
                        {tk.name} · {tk.keyPrefix}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input font-mono text-xs"
                    type="password"
                    placeholder={t("bench.token.paste")}
                    value={tokenSecret}
                    onChange={(e) => setTokenSecret(e.target.value)}
                  />
                </div>
                <p className="mt-1 text-xs text-ink-500">
                  {user?.role === "admin" ? t("bench.token.hint") : t("bench.token.hintManager")}
                </p>
              </div>
            )}
          </div>

          <div className="card card-pad space-y-3">
            <h3 className="label m-0">{t("bench.section.request")}</h3>

            {isChat && (
              <div>
                <label className="label">{t("bench.field.system")}</label>
                <textarea className="input h-16 font-mono text-xs" value={system} onChange={(e) => setSystem(e.target.value)} />
              </div>
            )}

            <div>
              <label className="label">{isChat ? t("bench.field.message") : t("bench.field.input")}</label>
              <textarea className="input h-28 font-mono text-xs" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            </div>

            {/* Context-window probe */}
            <div className="rounded-lg border border-ink-800 bg-ink-950/50 p-3">
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <label className="label">{t("bench.filler.target")}</label>
                  <input
                    className="input w-32"
                    type="number"
                    min={0}
                    step={1000}
                    value={fillerTokens}
                    onChange={(e) => setFillerTokens(Math.max(0, Number(e.target.value) || 0))}
                  />
                </div>
                <button className="btn-ghost btn-xs" type="button" onClick={() => setFiller(loremOfTokens(fillerTokens))}>
                  <i className="bi bi-arrows-expand" />
                  {t("bench.filler.generate")}
                </button>
                {filler && (
                  <button className="btn-ghost btn-xs" type="button" onClick={() => setFiller("")}>
                    <i className="bi bi-x-lg" />
                    {t("bench.filler.clear")}
                  </button>
                )}
              </div>
              <p className="mt-2 text-xs text-ink-500">
                {filler
                  ? t("bench.filler.attached", {
                      chars: formatNumber(filler.length),
                      tokens: formatNumber(estimateTokens(filler)),
                    })
                  : t("bench.filler.hint")}
              </p>
            </div>

            <div>
              <label className="label">{category === "stt" ? t("bench.field.audio") : t("bench.field.attachments")}</label>
              <input
                className="input text-xs"
                type="file"
                multiple={category !== "stt"}
                onChange={(e) => void addFiles(e.target.files)}
              />
              {attachments.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {attachments.map((a, i) => (
                    <li key={i} className="flex items-center gap-2 text-xs text-ink-300">
                      <i className={`bi ${a.mediaType.startsWith("image/") ? "bi-image" : a.mediaType.startsWith("audio/") ? "bi-music-note-beamed" : "bi-file-earmark"}`} />
                      <span className="truncate font-mono">{a.name}</span>
                      <span className="text-ink-500">{a.mediaType}</span>
                      <button
                        className="btn-ghost btn-xs ml-auto"
                        type="button"
                        onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                      >
                        <i className="bi bi-trash" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <ParamsEditor rows={params} onChange={setParams} />
          </div>

          <BodyPanel build={buildBody} override={bodyOverride} onOverride={setBodyOverride} error={overrideError} />
        </div>

        {/* ---------------- result ---------------- */}
        <div className="space-y-4">
          {running && liveFrames.length > 0 && <LiveText frames={liveFrames} />}
          {!outcome && !running && (
            <div className="card card-pad text-sm text-ink-500">
              <i className="bi bi-info-circle mr-2" />
              {t("bench.idle")}
            </div>
          )}
          {outcome && <ResultPanel outcome={outcome} />}
        </div>
      </div>
    </div>
  );
}

/** Pull a human message out of whatever error envelope came back. */
function messageOf(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return typeof body === "string" && body ? body.slice(0, 500) : undefined;
  const b = body as Record<string, unknown>;
  const err = b.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && typeof (err as Record<string, unknown>).message === "string") {
    return (err as Record<string, string>).message;
  }
  return typeof b.message === "string" ? b.message : undefined;
}

/** Read an SSE body to completion, reporting frames as they arrive. */
async function drainSse(body: ReadableStream<Uint8Array>, onFrames: (frames: string[]) => void): Promise<string[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const all: string[] = [];
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { frames, rest } = splitFrames(buffer);
    buffer = rest;
    if (frames.length) {
      all.push(...frames);
      onFrames(frames);
    }
  }
  buffer += decoder.decode();
  const { frames } = splitFrames(`${buffer}\n\n`);
  if (frames.length) {
    all.push(...frames);
    onFrames(frames);
  }
  return all;
}

/** The text so far, during a run. Memoized on the frame list so a keystroke
 * elsewhere does not re-parse the whole stream. */
const LiveText = memo(function LiveText({ frames }: { frames: string[] }) {
  const { t } = useI18n();
  const text = useMemo(() => textFromFrames(frames), [frames]);
  return (
    <div className="card card-pad">
      <h3 className="label">{t("bench.section.live")}</h3>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-ink-800 bg-ink-950 p-3 font-mono text-xs text-ink-300">
        {text || t("bench.live.waiting")}
      </pre>
    </div>
  );
});

function ParamsEditor({
  rows,
  onChange,
}: {
  rows: Array<{ key: string; value: string }>;
  onChange: (rows: Array<{ key: string; value: string }>) => void;
}) {
  const { t } = useI18n();
  return (
    <div>
      <label className="label">{t("bench.field.params")}</label>
      <p className="mb-1 text-xs text-ink-500">{t("bench.field.params.hint")}</p>
      <div className="space-y-1.5">
        {rows.map((row, i) => (
          <div key={i} className="flex gap-1.5">
            <input
              className="input flex-1 font-mono text-xs"
              placeholder={t("bench.params.key")}
              value={row.key}
              onChange={(e) => onChange(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
            />
            <input
              className="input flex-1 font-mono text-xs"
              placeholder={t("bench.params.value")}
              value={row.value}
              onChange={(e) => onChange(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
            />
            <button className="btn-ghost btn-xs" type="button" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              <i className="bi bi-trash" />
            </button>
          </div>
        ))}
      </div>
      <button className="btn-ghost btn-xs mt-1.5" type="button" onClick={() => onChange([...rows, { key: "", value: "" }])}>
        <i className="bi bi-plus-lg" />
        {t("bench.params.add")}
      </button>
    </div>
  );
}

/**
 * The exact body that will go out, editable in place. Editing detaches it from
 * the form above until it is reset, which is what makes a hand-crafted probe
 * possible without a second UI for it.
 *
 * COLLAPSED BY DEFAULT, and nothing is assembled while it is. Open, it rebuilds
 * and re-serializes the whole body on every keystroke in the message box, which
 * with a context-window filler attached is a megabyte of JSON per character.
 * That measured cheaper than it sounds -- the pane only lays out the visible
 * slice of a scrolling <pre> -- but it is unbounded work for a preview nobody
 * is necessarily reading, and opening it is the signal that someone is.
 */
function BodyPanel({
  build,
  override,
  onOverride,
  error,
}: {
  build: () => Record<string, unknown>;
  override: string | null;
  onOverride: (v: string | null) => void;
  error: string | null;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  // An edited body is already text, so it costs nothing to show; a generated
  // one is assembled only while the panel is open.
  const text = useMemo(
    () => (override != null || !open ? "" : prettyJson(build())),
    [override, open, build],
  );
  const copy = (): void => {
    void copyToClipboard(override ?? prettyJson(build())).then(() => toast.success(t("bench.copied")));
  };
  return (
    <div className="card card-pad">
      <div className="flex items-center justify-between">
        <button type="button" className="flex items-center gap-1.5 text-left" onClick={() => setOpen((o) => !o)}>
          <i className={`bi ${open ? "bi-chevron-down" : "bi-chevron-right"} text-ink-500`} />
          <h3 className="label m-0 cursor-pointer select-none">{t("bench.section.body")}</h3>
        </button>
        <div className="flex gap-1.5">
          <button className="btn-ghost btn-xs" type="button" onClick={copy}>
            <i className="bi bi-clipboard" />
          </button>
          {override == null ? (
            <button
              className="btn-ghost btn-xs"
              type="button"
              onClick={() => {
                onOverride(prettyJson(build()));
                setOpen(true);
              }}
            >
              <i className="bi bi-pencil" />
              {t("bench.body.edit")}
            </button>
          ) : (
            <button className="btn-ghost btn-xs" type="button" onClick={() => onOverride(null)}>
              <i className="bi bi-arrow-counterclockwise" />
              {t("bench.body.reset")}
            </button>
          )}
        </div>
      </div>
      {!open ? (
        <p className="mt-2 text-xs text-ink-500">{t("bench.body.collapsed")}</p>
      ) : override == null ? (
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-ink-800 bg-ink-950 p-3 font-mono text-xs leading-relaxed text-ink-300">
          {text}
        </pre>
      ) : (
        <textarea
          className="input mt-2 h-72 font-mono text-xs"
          value={override}
          onChange={(e) => onOverride(e.target.value)}
          spellCheck={false}
        />
      )}
      {error && <p className="mt-2 text-xs text-red-300">{t("bench.body.invalid", { error })}</p>}
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  const { t } = useI18n();
  const toast = useToast();
  const [open, setOpen] = useState(true);
  // Pretty-printing an answer that carries a context-window filler is a
  // megabyte of work; doing it per render made every keystroke elsewhere on
  // the page pay for it.
  const text = useMemo(() => prettyJson(value), [value]);
  if (value === undefined || value === null) return null;
  return (
    <div>
      <div className="flex items-center justify-between">
        <button type="button" className="flex items-center gap-1.5 text-left" onClick={() => setOpen((o) => !o)}>
          <i className={`bi ${open ? "bi-chevron-down" : "bi-chevron-right"} text-ink-500`} />
          <h4 className="label m-0 cursor-pointer select-none">{title}</h4>
        </button>
        <button className="btn-ghost btn-xs" type="button" onClick={() => void copyToClipboard(text).then(() => toast.success(t("bench.copied")))}>
          <i className="bi bi-clipboard" />
        </button>
      </div>
      {open && (
        <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-ink-800 bg-ink-950 p-3 font-mono text-xs leading-relaxed text-ink-300">
          {text}
        </pre>
      )}
    </div>
  );
}

/**
 * Anything in the answer that is worth looking at rather than reading: a
 * generated image, a spoken line, a clip. A base64 blob in a JSON dump proves
 * a 200 came back and nothing about whether the model did the job.
 */
function MediaPreview({ outcome }: { outcome: Outcome }) {
  const { t } = useI18n();
  const items: Array<{ kind: "image" | "audio" | "video"; src: string; name: string }> = [];

  if (outcome.audio) {
    const src = `data:${outcome.audio.mediaType};base64,${outcome.audio.base64}`;
    items.push({
      kind: outcome.audio.mediaType.startsWith("video/") ? "video" : "audio",
      src,
      name: `bench-output.${(outcome.audio.mediaType.split("/")[1] ?? "bin").split(";")[0]}`,
    });
  }

  const r = outcome.response as Record<string, unknown> | undefined;
  const data = r && Array.isArray(r.data) ? (r.data as Array<Record<string, unknown>>) : [];
  data.forEach((d, i) => {
    if (typeof d.b64_json === "string") items.push({ kind: "image", src: `data:image/png;base64,${d.b64_json}`, name: `image-${i + 1}.png` });
    else if (typeof d.url === "string") items.push({ kind: "image", src: d.url, name: `image-${i + 1}` });
  });

  if (!items.length) return null;
  return (
    <div>
      <h4 className="label">{t("bench.section.preview")}</h4>
      <div className="flex flex-wrap gap-3">
        {items.map((it, i) => (
          <div key={i} className="space-y-1">
            {it.kind === "image" && <img src={it.src} alt={it.name} className="max-h-64 max-w-full rounded-lg border border-ink-800" />}
            {it.kind === "audio" && <audio controls src={it.src} className="w-72" />}
            {it.kind === "video" && <video controls src={it.src} className="max-h-64 rounded-lg border border-ink-800" />}
            <a className="btn-ghost btn-xs" href={it.src} download={it.name}>
              <i className="bi bi-download" />
              {t("bench.download")}
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Memoized on the outcome, which changes only when a run finishes.
 *
 * Without that, every keystroke in the message box re-rendered the whole
 * result: re-parsing each SSE frame to reassemble the text, and re-serializing
 * every JSON block -- including the body that was sent, which on a
 * context-window probe is the filler all over again. Typing while a large
 * result was on screen was the slowest thing this page did, and none of that
 * work could change until the next run.
 */
const ResultPanel = memo(function ResultPanel({ outcome }: { outcome: Outcome }) {
  const { t } = useI18n();
  const streamedText = useMemo(() => (outcome.frames ? textFromFrames(outcome.frames) : ""), [outcome.frames]);
  return (
    <div className="card card-pad space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={outcome.ok ? 200 : outcome.status || 500} label={String(outcome.status || (outcome.ok ? 200 : "error"))} />
        <span className="badge-gray">
          <i className="bi bi-stopwatch" />
          {formatNumber(outcome.latencyMs)} {t("common.ms")}
        </span>
        {outcome.served && (
          <>
            <span className="badge-blue">
              <i className="bi bi-box" />
              {outcome.served.model} @ {outcome.served.provider}
            </span>
            <span className="badge-gray">{outcome.served.family}</span>
            <span className="badge-gray font-mono">{outcome.served.upstreamModel}</span>
          </>
        )}
      </div>

      {!outcome.ok && outcome.message && <ErrorNote message={outcome.message} />}

      <MediaPreview outcome={outcome} />

      {outcome.frames && (
        <>
          <div>
            <h4 className="label">{t("bench.section.streamText")}</h4>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-ink-800 bg-ink-950 p-3 font-mono text-xs text-ink-200">
              {streamedText || t("bench.stream.noText")}
            </pre>
          </div>
          <JsonBlock title={t("bench.section.frames", { count: outcome.frames.length })} value={outcome.frames} />
        </>
      )}

      {outcome.usage !== undefined && <JsonBlock title={t("bench.section.usage")} value={outcome.usage} />}
      {outcome.response !== undefined && <JsonBlock title={t("bench.section.response")} value={outcome.response} />}
      {outcome.upstreamRequest !== undefined && <JsonBlock title={t("bench.section.upstreamRequest")} value={outcome.upstreamRequest} />}
      {outcome.attemptPath !== undefined && <JsonBlock title={t("bench.section.attemptPath")} value={outcome.attemptPath} />}
      <JsonBlock title={t("bench.section.sent", { url: outcome.sentUrl ?? "" })} value={outcome.sentBody} />
    </div>
  );
});
