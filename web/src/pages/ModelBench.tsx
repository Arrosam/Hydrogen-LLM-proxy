import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, readResponse } from "../api";
import { Button, Icon, buttonClass } from "../components/Button";
import { SegmentedControl } from "../components/Chip";
import { CodeBlock } from "../components/CodeBlock";
import { ErrorNote, StatusBadge, Toggle } from "../components/common";
import { DisclosureHeading } from "../components/Disclosure";
import { Field } from "../components/Field";
import { Select, TextArea, TextInput, type SelectOption } from "../components/inputs";
import { KeyValueRows } from "../components/KeyValueRows";
import { ResourcePage } from "../components/Page";
import { useToast } from "../components/Toast";
import { useIsAdmin } from "../auth";
import { ANTHROPIC_VERSION, buildChatBody, defaultMediaBody, proxyPath } from "../lib/benchRequest";
import { removeAt } from "../lib/collections";
import { MS_PER_SECOND } from "../lib/constants";
import { API, apiUrl } from "../lib/endpoints";
import { errorMessage } from "../lib/errors";
import { base64ToBytes, bytesToBase64, readEncodedFile, toDataUrl, type EncodedFile } from "../lib/files";
import { formatNumber } from "../lib/format";
import { useAsync, useAttempt, useCopy } from "../lib/hooks";
import { HTTP_OK, HTTP_SERVER_ERROR, isSuccessStatus } from "../lib/http";
import { useI18n } from "../lib/i18n";
import { ACTION_ICON, ENTITY_ICON } from "../lib/icons";
import { parseJsonObject, parseJsonOrText, prettyJson } from "../lib/json";
import { rowsToObject, type KeyValueRow } from "../lib/kv";
import { msLabel, tokenLabel, withDisabledNote } from "../lib/labels";
import { estimateTokens, loremOfTokens } from "../lib/lorem";
import { fetchTokens } from "../lib/resources";
import { AGENT_KIND, DEFAULT_CATEGORY } from "../lib/serviceDef";
import { drainSse, sseDataOf, textFromFrames, usageFromFrames } from "../lib/sse";
import { FAMILIES, isChatPipelineCategory, type BenchMapping, type BenchServiceInfo, type BenchTargets, type Family, type ServiceCategory, type Token } from "../types";

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

const TRANSPORT = { proxy: "proxy", internal: "internal" } as const satisfies Record<Transport, Transport>;
const TRANSPORTS: readonly Transport[] = [TRANSPORT.proxy, TRANSPORT.internal];
const TRANSPORT_ICON: Record<Transport, string> = { proxy: "bi-globe2", internal: "bi-cpu" };
const TARGET = { service: "service", agent: "agent", raw: "raw" } as const satisfies Record<TargetKind, TargetKind>;
const TARGET_KINDS: readonly TargetKind[] = [TARGET.service, TARGET.agent, TARGET.raw];

const MEDIA_CATEGORIES: ServiceCategory[] = ["embedding", "rerank", "image", "video", "tts", "stt"];
const ALL_CATEGORIES: ServiceCategory[] = [DEFAULT_CATEGORY, ...MEDIA_CATEGORIES];
/** Speech-to-text: the one category that takes a file instead of JSON, and exactly one. */
const STT: ServiceCategory = "stt";

/** A select over names that are their own captions. */
const optionsOf = <T extends string>(values: readonly T[]): SelectOption<T>[] => values.map((value) => ({ value, label: value }));
const FAMILY_OPTIONS = optionsOf(FAMILIES);
const CATEGORY_OPTIONS = optionsOf(ALL_CATEGORIES);
const DEFAULT_FAMILY: Family = "openai_completion";

const DEFAULT_PROMPT = "Reply with the single word: pong.";
/** The context-window probe: starting size and the number input's step, in tokens. */
const FILLER_TOKENS = { default: 10_000, step: 1000 } as const;
/** Internal-transport timeout: starting value and smallest accepted, in seconds. */
const TIMEOUT_SECONDS = { default: 300, min: 1 } as const;
/** Smallest timeout ever sent to the bench route. */
const MIN_TIMEOUT_MS = 1000;

/** Content type of a streamed answer. */
const EVENT_STREAM = "text/event-stream";
/** Content types of an answer that is a file rather than text. */
const isBinaryType = (contentType: string): boolean =>
  contentType.startsWith("audio/") || contentType.startsWith("video/") || contentType === "application/octet-stream";
/** The trailing frame of the bench route's stream, carrying what only the server can see. */
const BENCH_FRAME = "event: bench";
const isBenchFrame = (frame: string): boolean => frame.startsWith(BENCH_FRAME);
/** What the trailing bench frame reports, or null when it carries no JSON object. */
function benchReport(frame: string): Record<string, unknown> | null {
  const data = frame.split("\n").map(sseDataOf).find((d) => d !== null);
  return parseJsonObject(data ?? "");
}
/** A JSON POST to an admin bench route, cancellable through `signal`. */
const postBench = (path: string, payload: unknown, signal: AbortSignal): Promise<Response> =>
  fetch(apiUrl(path), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
/** Longest plain-text error body shown as a message. */
const ERROR_SNIPPET_CHARS = 500;
/** Base names of downloadable results. */
const OUTPUT_FILE_BASE = "bench-output";
const IMAGE_FILE_BASE = "image";

/** Icon of an attachment, by what kind of file it is. */
function attachmentIcon(mediaType: string): string {
  if (mediaType.startsWith("image/")) return "bi-image";
  if (mediaType.startsWith("audio/")) return "bi-music-note-beamed";
  return "bi-file-earmark";
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

/** The JSON sections of a result, in display order. Each is shown only when the run produced it. */
const RESULT_SECTIONS = ["usage", "response", "upstreamRequest", "attemptPath"] as const satisfies readonly (keyof Outcome)[];

const httpLabel = (status: number): string => `HTTP ${status}`;

/**
 * The status that colours a result's badge. A run that failed is never drawn
 * as a success, whatever it was answered with: a stream that dies after its
 * headers still carries a 200.
 */
const badgeStatus = (outcome: Pick<Outcome, "ok" | "status">): number => {
  if (outcome.ok) return HTTP_OK;
  return !outcome.status || isSuccessStatus(outcome.status) ? HTTP_SERVER_ERROR : outcome.status;
};

/** A run that never produced an answer: aborted, or failed before one arrived. */
const failedOutcome = (started: number, message: string): Outcome => ({ ok: false, status: 0, latencyMs: Date.now() - started, message });

/**
 * What the bench routes report about a run in the same fields whether the
 * answer is buffered or is the trailing frame of a stream.
 */
function reportedOutcome(report: Record<string, unknown>, started: number, fallbackStatus = 0) {
  return {
    ok: report.ok === true,
    status: Number(report.status ?? fallbackStatus),
    latencyMs: Number(report.latencyMs ?? Date.now() - started),
    message: typeof report.message === "string" ? report.message : undefined,
    served: report.served as Served | undefined,
    upstreamRequest: report.upstreamRequest,
  } satisfies Partial<Outcome>;
}

export function ModelBench() {
  const { t } = useI18n();
  const isAdmin = useIsAdmin();
  const toast = useToast();
  const attempt = useAttempt();

  const load = useAsync(() => api.get<BenchTargets>(API.benchTargets));
  const targets = load.data;
  const [tokens, setTokens] = useState<Token[]>([]);

  const [transport, setTransport] = useState<Transport>(TRANSPORT.internal);
  const [targetKind, setTargetKind] = useState<TargetKind>(TARGET.service);
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [rawModel, setRawModel] = useState("");
  const [rawProvider, setRawProvider] = useState("");
  const [rawProviderFormat, setRawProviderFormat] = useState<Family>(DEFAULT_FAMILY);
  const [rawCategory, setRawCategory] = useState<ServiceCategory>(DEFAULT_CATEGORY);

  const [ingress, setIngress] = useState<Family>(DEFAULT_FAMILY);
  const [streaming, setStreaming] = useState(false);
  const [tokenId, setTokenId] = useState<number | null>(null);
  const [tokenSecret, setTokenSecret] = useState("");

  const [system, setSystem] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [attachments, setAttachments] = useState<EncodedFile[]>([]);
  const [fillerTokens, setFillerTokens] = useState<number>(FILLER_TOKENS.default);
  const [filler, setFiller] = useState("");
  const [params, setParams] = useState<KeyValueRow[]>([]);
  const [bodyOverride, setBodyOverride] = useState<string | null>(null);
  const [timeoutSec, setTimeoutSec] = useState<number>(TIMEOUT_SECONDS.default);

  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [liveFrames, setLiveFrames] = useState<string[]>([]);
  /** The run in flight. A run that is no longer this one (stopped, or replaced) has lost the page: whatever it still answers is dropped. */
  const activeRun = useRef<{ controller: AbortController; started: number } | null>(null);

  useEffect(() => {
    fetchTokens()
      .then(setTokens)
      .catch(() => setTokens([]));
  }, []);

  const services = targets?.services ?? [];
  const mappings = targets?.mappings ?? [];

  const pickable = useMemo<BenchServiceInfo[]>(
    () => services.filter((s) => s.valid && (targetKind === TARGET.agent ? s.kind === AGENT_KIND : s.kind === "model_service")),
    [services, targetKind],
  );

  // Only what the current kind offers can be the target: a service left over
  // from the other kind is no selection.
  const selectedService = useMemo(
    () => pickable.find((s) => s.id === serviceId) ?? null,
    [pickable, serviceId],
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

  const isRaw = targetKind === TARGET.raw;

  // Keep the raw tuple internally consistent as each level is chosen.
  useEffect(() => {
    if (!isRaw) return;
    if (!rawModel && rawModels.length) setRawModel(rawModels[0]);
  }, [isRaw, rawModel, rawModels]);
  useEffect(() => {
    if (rawProviders.length && !rawProviders.some((m) => m.provider === rawProvider)) {
      setRawProvider(rawProviders[0].provider);
    }
  }, [rawProviders, rawProvider]);
  useEffect(() => {
    if (rawFamilies.length && !rawFamilies.includes(rawProviderFormat)) setRawProviderFormat(rawFamilies[0]);
  }, [rawFamilies, rawProviderFormat]);
  useEffect(() => {
    if (!isRaw && !pickable.some((s) => s.id === serviceId)) {
      // The first of the kind, or nothing when the kind has no entries.
      const first = pickable[0]?.id ?? null;
      if (first !== serviceId) setServiceId(first);
    }
  }, [pickable, serviceId, isRaw]);

  const category: ServiceCategory = isRaw ? rawCategory : selectedService?.category ?? DEFAULT_CATEGORY;
  const isChat = isChatPipelineCategory(category);
  const isStt = category === STT;
  const viaProxy = transport === TRANSPORT.proxy;

  // A raw tuple has no name on the proxy surface, so it has no proxy form.
  const proxyAvailable = !isRaw;
  useEffect(() => {
    if (!proxyAvailable && viaProxy) setTransport(TRANSPORT.internal);
  }, [proxyAvailable, viaProxy]);

  const modelName = isRaw ? `${rawModel}@${rawProvider}` : selectedService?.name ?? "";

  // A bare word stays a string; anything JSON-shaped is sent as that shape,
  // so `true`, `0.7` and `["a"]` reach the provider as what they look like.
  // Values are neither trimmed nor dropped when empty.
  const paramObject = useMemo(() => rowsToObject(params), [params]);

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
      isRaw
        ? { kind: TARGET.raw, model: rawModel, provider: rawProvider, providerFormat: rawProviderFormat }
        : { kind: TARGET.service, serviceId: selectedService?.id ?? 0 },
    [isRaw, rawModel, rawProvider, rawProviderFormat, selectedService],
  );

  const ready =
    overrideError == null &&
    (isRaw ? Boolean(rawModel && rawProvider) : Boolean(selectedService)) &&
    (!viaProxy || Boolean(tokenSecret)) &&
    (!isStt || attachments.length > 0);

  const revealToken = async (id: number): Promise<void> => {
    setTokenId(id);
    if (!isAdmin) return;
    await attempt(
      async () => {
        const r = await api.post<{ secret: string }>(API.tokenSecret(id));
        setTokenSecret(r.secret);
      },
      t("bench.token.revealFailed"),
      (message) => {
        setTokenSecret("");
        toast.error(message);
      },
    );
  };

  /** Cancel the run in flight -- buffered or streamed -- and report it as stopped, now. */
  const stop = (): void => {
    const active = activeRun.current;
    if (!active) return;
    activeRun.current = null;
    active.controller.abort();
    setRunning(false);
    setOutcome(failedOutcome(active.started, t("bench.aborted")));
  };

  const run = async (): Promise<void> => {
    if (!ready || running) return;
    const active = { controller: new AbortController(), started: Date.now() };
    activeRun.current = active;
    const current = (): boolean => activeRun.current === active;
    setRunning(true);
    setOutcome(null);
    setLiveFrames([]);
    const { started } = active;
    let result: Outcome;
    try {
      // The one place the body is assembled for a send. Inside the try, so a
      // hand-edited body that will not parse is reported like any other failure
      // rather than escaping as an unhandled rejection.
      const body = currentBody();
      result = await (viaProxy ? runProxy : runInternal)(body, active.controller.signal, started, current);
    } catch (e) {
      result = failedOutcome(started, errorMessage(e));
    }
    // Stopped (and reported so by `stop`) or replaced meanwhile: a late answer is not this page's any more.
    if (!current()) return;
    activeRun.current = null;
    setRunning(false);
    setOutcome(result);
  };

  /** Frames of the run in flight; a run that lost the page shows nothing. */
  const showLive = (frames: string[], current: () => boolean): void => {
    if (current()) setLiveFrames((prev) => [...prev, ...frames]);
  };

  /** Transport A: a real client request at Hydrogen's own client surface. */
  const runProxy = async (body: Record<string, unknown>, signal: AbortSignal, started: number, current: () => boolean): Promise<Outcome> => {
    const url = proxyPath(category, ingress);
    const headers: Record<string, string> = { authorization: `Bearer ${tokenSecret}` };
    if (isChat && ingress === "anthropic") headers["anthropic-version"] = ANTHROPIC_VERSION;

    // Speech-to-text is the one multipart surface; everything else is JSON.
    let payload: BodyInit;
    let sentBody: unknown;
    if (isStt) {
      const form = new FormData();
      for (const [k, v] of Object.entries(body)) {
        if (v == null) continue;
        form.append(k, typeof v === "string" ? v : JSON.stringify(v));
      }
      const a = attachments[0];
      form.append("file", new Blob([base64ToBytes(a.data)], { type: a.mediaType }), a.name);
      payload = form;
      sentBody = { ...body, file: `(${a.name}, ${a.mediaType})` };
    } else {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
      sentBody = body;
    }

    const res = await fetch(url, { method: "POST", headers, body: payload, signal, credentials: "omit" });
    const contentType = res.headers.get("content-type") ?? "";
    /** The answer as seen from the client side, plus whatever this kind of answer carries. */
    const answered = (extra: Partial<Outcome>): Outcome => ({
      ok: res.ok,
      status: res.status,
      latencyMs: Date.now() - started,
      ...extra,
      sentBody,
      sentUrl: url,
    });

    if (contentType.includes(EVENT_STREAM) && res.body) {
      const frames = await drainSse(res.body, (f) => showLive(f, current));
      return answered({ frames, usage: usageFromFrames(frames) });
    }

    if (isBinaryType(contentType)) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      return answered({ audio: { mediaType: contentType, base64: bytesToBase64(bytes), bytes: bytes.length } });
    }

    const text = await res.text();
    const parsed = text ? parseJsonOrText(text) : null;
    const usage = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).usage : undefined;
    return answered({ response: parsed, usage, message: res.ok ? undefined : messageOf(parsed) ?? httpLabel(res.status) });
  };

  /** Transport B: the admin route that drives the executor directly. */
  const runInternal = async (body: Record<string, unknown>, signal: AbortSignal, started: number, current: () => boolean): Promise<Outcome> => {
    const timeoutMs = Math.max(MIN_TIMEOUT_MS, timeoutSec * MS_PER_SECOND);
    if (!isChat) {
      const payload: Record<string, unknown> = { target, category, body, timeoutMs };
      if (isStt) payload.file = attachments[0];
      const r = await readResponse<Record<string, unknown>>(await postBench(API.benchMedia, payload, signal));
      return {
        ...reportedOutcome(r, started),
        response: r.response,
        audio: r.audio as Outcome["audio"],
        sentBody: body,
        sentUrl: apiUrl(API.benchMedia),
      };
    }

    const payload = { target, ingress, body, timeoutMs };
    const sent = { sentBody: body, sentUrl: apiUrl(API.benchChat) };

    if (!streaming) {
      const r = await readResponse<Record<string, unknown>>(await postBench(API.benchChat, payload, signal));
      return { ...reportedOutcome(r, started), response: r.response, usage: r.usage, attemptPath: r.attemptPath, ...sent };
    }

    // The admin route answers SSE, with one trailing `event: bench` frame
    // carrying what only the server side can see.
    const res = await postBench(API.benchChat, payload, signal);
    if (!res.headers.get("content-type")?.includes(EVENT_STREAM)) {
      const parsed = parseJsonOrText(await res.text());
      return { ok: false, status: res.status, latencyMs: Date.now() - started, message: messageOf(parsed) ?? httpLabel(res.status), response: parsed };
    }
    const all = await drainSse(res.body!, (f) => showLive(f.filter((x) => !isBenchFrame(x)), current));
    const metaFrame = all.filter(isBenchFrame).pop();
    const frames = all.filter((f) => !isBenchFrame(f));
    // No trailing frame, or one that is not a JSON object, is no report at all
    // (a build that does not send it): the run is then what its HTTP status says.
    const meta = (metaFrame && benchReport(metaFrame)) || null;
    return {
      ...reportedOutcome(meta ?? { ok: res.ok }, started, res.status),
      // The server taps it off the terminal event; reading the frames is the
      // fallback when talking to a build that did not send it.
      usage: meta?.usage ?? usageFromFrames(frames),
      attemptPath: meta?.attemptPath,
      frames,
      ...sent,
    };
  };

  const addFiles = async (files: FileList | null): Promise<void> => {
    if (!files?.length) return;
    const next: EncodedFile[] = [];
    for (const f of Array.from(files)) next.push(await readEncodedFile(f));
    setAttachments((prev) => (isStt ? next.slice(0, 1) : [...prev, ...next]));
  };

  return (
    <ResourcePage
      state={load}
      loadingLabel={t("bench.loading")}
      bodyWhenLoaded
      className="space-y-4"
      title={t("bench.title")}
      subtitle={t("bench.subtitle")}
      icon={ENTITY_ICON.bench}
      action={
        <div className="flex gap-2">
          {running && (
            <Button variant="ghost" icon="bi-stop-circle" onClick={stop}>
              {t("bench.stop")}
            </Button>
          )}
          <Button variant="primary" icon="bi-send" busy={running} spinWhenBusy disabled={!ready} onClick={run}>
            {running ? t("bench.running") : t("bench.send")}
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* ---------------- request ---------------- */}
        <div className="space-y-4">
          <div className="card card-pad space-y-3">
            <h3 className="label m-0">{t("bench.section.target")}</h3>

            <Field
              label={t("bench.field.transport")}
              hint={!proxyAvailable ? t("bench.transport.rawIsInternalOnly") : t(`bench.transport.${transport}.hint`)}
            >
              <SegmentedControl
                variant="buttons"
                value={transport}
                onChange={setTransport}
                options={TRANSPORTS.map((tr) => ({
                  value: tr,
                  label: t(`bench.transport.${tr}`),
                  icon: TRANSPORT_ICON[tr],
                  disabled: tr === TRANSPORT.proxy && !proxyAvailable,
                }))}
              />
            </Field>

            <Field label={t("bench.field.targetKind")}>
              <SegmentedControl
                variant="buttons"
                value={targetKind}
                onChange={setTargetKind}
                options={TARGET_KINDS.map((k) => ({ value: k, label: t(`bench.targetKind.${k}`) }))}
              />
            </Field>

            {!isRaw ? (
              <Field label={t(`bench.targetKind.${targetKind}`)}>
                <Select
                  value={selectedService?.id ?? ""}
                  onChange={(id) => setServiceId(Number(id))}
                  options={pickable.map((s) => ({ value: s.id, label: withDisabledNote(`${s.name} · ${s.category}`, s.enabled, t) }))}
                  placeholder={pickable.length === 0 ? t("bench.noTargets") : undefined}
                />
              </Field>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <Field label={t("bench.field.model")}>
                  <Select
                    value={rawModel}
                    onChange={setRawModel}
                    options={optionsOf(rawModels)}
                    placeholder={rawModels.length === 0 ? t("bench.noMappings") : undefined}
                  />
                </Field>
                <Field label={t("bench.field.modelFormat")}>
                  <Select value={ingress} onChange={setIngress} options={FAMILY_OPTIONS} disabled={!isChat} />
                </Field>
                <Field label={t("bench.field.provider")}>
                  <Select
                    value={rawProvider}
                    onChange={setRawProvider}
                    options={rawProviders.map((m) => ({ value: m.provider, label: withDisabledNote(`${m.provider} → ${m.upstreamModel}`, m.enabled, t) }))}
                  />
                </Field>
                <Field label={t("bench.field.providerFormat")}>
                  <Select value={rawProviderFormat} onChange={setRawProviderFormat} options={optionsOf(rawFamilies)} />
                </Field>
                <Field label={t("bench.field.category")} className="col-span-2">
                  <Select value={rawCategory} onChange={setRawCategory} options={CATEGORY_OPTIONS} />
                </Field>
              </div>
            )}

            {!isRaw && isChat && (
              <Field label={t("bench.field.modelFormat")} hint={t("bench.field.modelFormat.hint")}>
                <Select value={ingress} onChange={setIngress} options={FAMILY_OPTIONS} />
              </Field>
            )}

            <div className="flex flex-wrap items-center gap-4">
              {isChat && <Toggle checked={streaming} onChange={setStreaming} label={t("bench.field.streaming")} />}
              {!viaProxy && (
                <div className="flex items-center gap-2">
                  <label className="label m-0">{t("bench.field.timeout")}</label>
                  <TextInput
                    className="w-24"
                    type="number"
                    min={TIMEOUT_SECONDS.min}
                    value={timeoutSec}
                    onChange={(e) => setTimeoutSec(Number(e.target.value) || TIMEOUT_SECONDS.min)}
                  />
                </div>
              )}
            </div>

            {viaProxy && (
              <Field label={t("bench.field.token")} hint={isAdmin ? t("bench.token.hint") : t("bench.token.hintManager")}>
                <div className="grid grid-cols-2 gap-2">
                  <Select
                    value={tokenId ?? ""}
                    onChange={(id) => (id ? void revealToken(Number(id)) : setTokenId(null))}
                    options={tokens.map((tk) => ({ value: tk.id, label: tokenLabel(tk) }))}
                    placeholder={t("bench.token.choose")}
                  />
                  <TextInput
                    mono
                    type="password"
                    placeholder={t("bench.token.paste")}
                    value={tokenSecret}
                    onChange={(e) => setTokenSecret(e.target.value)}
                  />
                </div>
              </Field>
            )}
          </div>

          <div className="card card-pad space-y-3">
            <h3 className="label m-0">{t("bench.section.request")}</h3>

            {isChat && (
              <Field label={t("bench.field.system")}>
                <TextArea mono className="h-16" value={system} onChange={(e) => setSystem(e.target.value)} />
              </Field>
            )}

            <Field label={isChat ? t("bench.field.message") : t("bench.field.input")}>
              <TextArea mono className="h-28" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            </Field>

            {/* Context-window probe */}
            <div className="rounded-lg border border-ink-800 bg-ink-950/50 p-3">
              <div className="flex flex-wrap items-end gap-2">
                <Field label={t("bench.filler.target")}>
                  <TextInput
                    className="w-32"
                    type="number"
                    min={0}
                    step={FILLER_TOKENS.step}
                    value={fillerTokens}
                    onChange={(e) => setFillerTokens(Math.max(0, Number(e.target.value) || 0))}
                  />
                </Field>
                <Button variant="ghost" size="xs" type="button" icon="bi-arrows-expand" onClick={() => setFiller(loremOfTokens(fillerTokens))}>
                  {t("bench.filler.generate")}
                </Button>
                {filler && (
                  <Button variant="ghost" size="xs" type="button" icon={ACTION_ICON.close} onClick={() => setFiller("")}>
                    {t("bench.filler.clear")}
                  </Button>
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

            <Field label={isStt ? t("bench.field.audio") : t("bench.field.attachments")}>
              <TextInput className="text-xs" type="file" multiple={!isStt} onChange={(e) => void addFiles(e.target.files)} />
              {attachments.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {attachments.map((a, i) => (
                    <li key={i} className="flex items-center gap-2 text-xs text-ink-300">
                      <Icon name={attachmentIcon(a.mediaType)} />
                      <span className="truncate font-mono">{a.name}</span>
                      <span className="text-ink-500">{a.mediaType}</span>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="ml-auto"
                        type="button"
                        icon={ACTION_ICON.removeAlt}
                        onClick={() => setAttachments((prev) => removeAt(prev, i))}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </Field>

            <Field label={t("bench.field.params")} hint={t("bench.field.params.hint")} hintPosition="above">
              <KeyValueRows
                rows={params}
                onChange={setParams}
                keyPlaceholder={t("bench.params.key")}
                valuePlaceholder={t("bench.params.value")}
                addLabel={t("bench.params.add")}
                rowsClassName="space-y-1.5"
                addClassName="mt-1.5"
              />
            </Field>
          </div>

          <BodyPanel build={buildBody} override={bodyOverride} onOverride={setBodyOverride} error={overrideError} />
        </div>

        {/* ---------------- result ---------------- */}
        <div className="space-y-4">
          {running && liveFrames.length > 0 && <LiveText frames={liveFrames} />}
          {!outcome && !running && (
            <div className="card card-pad text-sm text-ink-500">
              <Icon name="bi-info-circle" className="mr-2" />
              {t("bench.idle")}
            </div>
          )}
          {outcome && <ResultPanel outcome={outcome} />}
        </div>
      </div>
    </ResourcePage>
  );
}

/** Pull a human message out of whatever error envelope came back. */
function messageOf(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return typeof body === "string" && body ? body.slice(0, ERROR_SNIPPET_CHARS) : undefined;
  const b = body as Record<string, unknown>;
  const err = b.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && typeof (err as Record<string, unknown>).message === "string") {
    return (err as Record<string, string>).message;
  }
  return typeof b.message === "string" ? b.message : undefined;
}

/** Copies on click. `text` may be a function, for text that is only worth building when asked for. */
function CopyButton({ text }: { text: string | (() => string) }) {
  const { t } = useI18n();
  const copy = useCopy({ ok: t("bench.copied"), fail: t("bench.copyFailed") });
  return (
    <Button
      variant="ghost"
      size="xs"
      type="button"
      icon={ACTION_ICON.copy}
      onClick={() => void copy(typeof text === "function" ? text() : text)}
    />
  );
}

/** The text so far, during a run. Memoized on the frame list so a keystroke
 * elsewhere does not re-parse the whole stream. */
const LiveText = memo(function LiveText({ frames }: { frames: string[] }) {
  const { t } = useI18n();
  const text = useMemo(() => textFromFrames(frames), [frames]);
  return (
    <div className="card card-pad">
      <h3 className="label">{t("bench.section.live")}</h3>
      <CodeBlock maxHeight="sm">{text || t("bench.live.waiting")}</CodeBlock>
    </div>
  );
});

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
  const [open, setOpen] = useState(false);
  // An edited body is already text, so it costs nothing to show; a generated
  // one is assembled only while the panel is open.
  const text = useMemo(
    () => (override != null || !open ? "" : prettyJson(build())),
    [override, open, build],
  );
  return (
    <div className="card card-pad">
      <DisclosureHeading
        open={open}
        onToggle={() => setOpen((o) => !o)}
        title={t("bench.section.body")}
        as="h3"
        actions={
          <div className="flex gap-1.5">
            <CopyButton text={() => override ?? prettyJson(build())} />
            {override == null ? (
              <Button
                variant="ghost"
                size="xs"
                type="button"
                icon={ACTION_ICON.edit}
                onClick={() => {
                  onOverride(prettyJson(build()));
                  setOpen(true);
                }}
              >
                {t("bench.body.edit")}
              </Button>
            ) : (
              <Button variant="ghost" size="xs" type="button" icon="bi-arrow-counterclockwise" onClick={() => onOverride(null)}>
                {t("bench.body.reset")}
              </Button>
            )}
          </div>
        }
      />
      {!open ? (
        <p className="mt-2 text-xs text-ink-500">{t("bench.body.collapsed")}</p>
      ) : override == null ? (
        <CodeBlock className="mt-2" maxHeight="md" relaxed>{text}</CodeBlock>
      ) : (
        <TextArea mono className="mt-2 h-72" value={override} onChange={(e) => onOverride(e.target.value)} spellCheck={false} />
      )}
      {error && <p className="mt-2 text-xs text-red-300">{t("bench.body.invalid", { error })}</p>}
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  const [open, setOpen] = useState(true);
  // Pretty-printing an answer that carries a context-window filler is a
  // megabyte of work; doing it per render made every keystroke elsewhere on
  // the page pay for it.
  const text = useMemo(() => prettyJson(value), [value]);
  if (value === undefined || value === null) return null;
  return (
    <div>
      <DisclosureHeading open={open} onToggle={() => setOpen((o) => !o)} title={title} actions={<CopyButton text={text} />} />
      {open && <CodeBlock className="mt-1" maxHeight="xl" relaxed>{text}</CodeBlock>}
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
    items.push({
      kind: outcome.audio.mediaType.startsWith("video/") ? "video" : "audio",
      src: toDataUrl(outcome.audio.mediaType, outcome.audio.base64),
      name: `${OUTPUT_FILE_BASE}.${(outcome.audio.mediaType.split("/")[1] ?? "bin").split(";")[0]}`,
    });
  }

  const r = outcome.response as Record<string, unknown> | undefined;
  const data = r && Array.isArray(r.data) ? (r.data as Array<Record<string, unknown>>) : [];
  data.forEach((d, i) => {
    const name = `${IMAGE_FILE_BASE}-${i + 1}`;
    if (typeof d.b64_json === "string") items.push({ kind: "image", src: toDataUrl("image/png", d.b64_json), name: `${name}.png` });
    else if (typeof d.url === "string") items.push({ kind: "image", src: d.url, name });
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
            <a className={buttonClass("ghost", "xs")} href={it.src} download={it.name}>
              <Icon name="bi-download" />
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
        <StatusBadge status={badgeStatus(outcome)} label={String(outcome.status || (outcome.ok ? HTTP_OK : "error"))} />
        <span className="badge-gray">
          <Icon name="bi-stopwatch" />
          {msLabel(formatNumber(outcome.latencyMs), t)}
        </span>
        {outcome.served && (
          <>
            <span className="badge-blue">
              <Icon name={ENTITY_ICON.model} />
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
            <CodeBlock maxHeight="sm" tone="strong">{streamedText || t("bench.stream.noText")}</CodeBlock>
          </div>
          <JsonBlock title={t("bench.section.frames", { count: outcome.frames.length })} value={outcome.frames} />
        </>
      )}

      {RESULT_SECTIONS.map((section) => (
        <JsonBlock key={section} title={t(`bench.section.${section}`)} value={outcome[section]} />
      ))}
      <JsonBlock title={t("bench.section.sent", { url: outcome.sentUrl ?? "" })} value={outcome.sentBody} />
    </div>
  );
});
