import { useState, type ReactNode } from "react";
import type { AgentOcr } from "../types";
import { api, ApiError } from "../api";
import defaultOcrTestImage from "../assets/ocr-test-default.png";
import { isModelStage } from "../lib/agentStage";
import { MIB } from "../lib/constants";
import { API } from "../lib/endpoints";
import { toDataUrl } from "../lib/files";
import { formatNumber } from "../lib/format";
import { useAction } from "../lib/hooks";
import { useI18n } from "../lib/i18n";
import { DisclosureToggle } from "./AdvancedOverrides";
import { Button, Icon, buttonClass } from "./Button";
import { InsetPanel, ListHeader } from "./EditorCard";
import { FieldHint } from "./Field";

interface OcrTestResult {
  ok: boolean;
  served?: { model: string; provider: string };
  latencyMs?: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  description?: string;
  raw?: string;
  message?: string;
}

interface TestImage {
  name: string;
  mediaType: string;
  data: string; // base64, no data: prefix
}

/** Keep base64 expansion (~1.37x) plus JSON overhead under the 25 MB body cap. */
const MAX_TEST_IMAGE_BYTES = 15 * MIB;

/** Media type assumed for an image that does not declare one. */
const DEFAULT_IMAGE_TYPE = "image/png";
/** File name the bundled sample image is sent under. */
const DEFAULT_TEST_IMAGE_NAME = "overview.png";

/** Shown in place of a raw reply that is empty. */
const EMPTY_OUTPUT = "(empty)";

function readAsBase64(file: File): Promise<TestImage> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result);
      resolve({ name: file.name, mediaType: file.type || DEFAULT_IMAGE_TYPE, data: s.slice(s.indexOf(",") + 1) });
    };
    fr.onerror = () => reject(fr.error ?? new Error("could not read file"));
    fr.readAsDataURL(file);
  });
}

/** The small brand-coloured "back to the default" link. */
export function ResetLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button className="text-[11px] text-brand-400 hover:text-brand-300" onClick={onClick}>
      <Icon name="bi-arrow-counterclockwise" className="mr-1" />
      {children}
    </button>
  );
}

const FINE_WARNING = "text-[11px] text-amber-300";

const OUTPUT_TONE = { parsed: "text-ink-200", raw: "mt-1 text-ink-400" } as const;

/** A scrolling block of model output: the parsed description, or the raw reply under it. */
function OutputPane({ tone, children }: { tone: keyof typeof OUTPUT_TONE; children: ReactNode }) {
  return (
    <div className={`max-h-56 overflow-y-auto whitespace-pre-wrap rounded bg-ink-950 px-2.5 py-2 font-mono text-[11px] leading-relaxed ${OUTPUT_TONE[tone]}`}>
      {children}
    </div>
  );
}

/** Send a test image through the current (unsaved) OCR config and show the
 * model's reply — both the parsed description the stages would see and, on
 * demand, the raw output. Ships a default screenshot; any image can be picked. */
export function OcrTester({ ocr }: { ocr: AgentOcr }) {
  const { t } = useI18n();
  const [custom, setCustom] = useState<TestImage | null>(null);
  const [result, setResult] = useState<OcrTestResult | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const fail = (message: string | undefined) => setResult({ ok: false, message });
  const testing = useAction({ onError: fail, describe: (e) => (e instanceof ApiError ? e.message : String(e)) });

  const configured = isModelStage(ocr);
  const previewSrc = custom ? toDataUrl(custom.mediaType, custom.data) : defaultOcrTestImage;

  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return fail(t("ocr.test.notAnImage"));
    if (file.size > MAX_TEST_IMAGE_BYTES) return fail(t("ocr.test.imageTooLarge"));
    setCustom(await readAsBase64(file));
    setResult(null);
  };

  const useDefault = () => {
    setCustom(null);
    setResult(null);
  };

  const run = () => {
    setResult(null);
    setShowRaw(false);
    return testing.run(async () => {
      let image = custom;
      if (!image) {
        const blob = await (await fetch(defaultOcrTestImage)).blob();
        image = await readAsBase64(new File([blob], DEFAULT_TEST_IMAGE_NAME, { type: blob.type || DEFAULT_IMAGE_TYPE }));
      }
      setResult(await api.post<OcrTestResult>(API.servicesTestOcr, { ocr, image: { mediaType: image.mediaType, data: image.data } }));
    });
  };

  return (
    <InsetPanel>
      <ListHeader as="label" gap="xs" label={t("ocr.test.title")} />
      <FieldHint tone="faint" position="above-loose">
        {t("ocr.test.hint")}
      </FieldHint>

      <div className="flex items-center gap-3">
        <img src={previewSrc} alt="" className="h-12 w-20 shrink-0 rounded border border-ink-700 object-cover object-top" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs text-ink-300">{custom ? custom.name : t("ocr.test.defaultBadge")}</div>
          {custom && <ResetLink onClick={useDefault}>{t("ocr.test.resetDefault")}</ResetLink>}
        </div>
        <label className={buttonClass("ghost", "xs", "cursor-pointer")}>
          <Icon name="bi-upload" />
          {t("ocr.test.upload")}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              void pick(e.target.files?.[0]);
              e.target.value = ""; // allow re-picking the same file
            }}
          />
        </label>
        <Button variant="primary" size="xs" icon="bi-play-fill" busy={testing.busy} spinWhenBusy disabled={!configured} onClick={() => void run()}>
          {testing.busy ? t("ocr.test.running") : t("ocr.test.run")}
        </Button>
      </div>
      {!configured && <p className={`mt-1.5 ${FINE_WARNING}`}>{t("ocr.test.noModelHint")}</p>}

      {result && !result.ok && (
        <div className="mt-2 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          <Icon name="bi-x-circle" className="mr-1.5" />
          {t("ocr.test.failed")}: {result.message}
        </div>
      )}
      {result?.ok && (
        <div className="mt-2 rounded-lg border border-ink-800 bg-ink-900/60 p-2.5 text-xs">
          <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-400">
            <span className="badge-green">
              <Icon name="bi-check-lg" />
              {t("ocr.test.ok")}
            </span>
            {result.served && (
              <span className="font-mono">
                {result.served.model}@{result.served.provider}
              </span>
            )}
            {result.latencyMs != null && <span>{formatNumber(result.latencyMs)} ms</span>}
            {result.usage && <span>{formatNumber(result.usage.totalTokens)} tokens</span>}
          </div>
          {result.description ? (
            <>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-ink-500">{t("ocr.test.description")}</div>
              <OutputPane tone="parsed">{result.description}</OutputPane>
              <DisclosureToggle open={showRaw} onToggle={() => setShowRaw((v) => !v)} className="mt-1.5 text-[11px] text-ink-500 hover:text-ink-300">
                {t("ocr.test.showRaw")}
              </DisclosureToggle>
            </>
          ) : (
            <p className={`mb-1 ${FINE_WARNING}`}>{t("ocr.test.parseFailedNote")}</p>
          )}
          {(showRaw || !result.description) && <OutputPane tone="raw">{result.raw || EMPTY_OUTPUT}</OutputPane>}
        </div>
      )}
    </InsetPanel>
  );
}
