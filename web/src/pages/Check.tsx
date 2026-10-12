import { useCallback, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiError, readResponse } from "../api";
import { Bar } from "../components/Bar";
import { Button, buttonClass, Icon } from "../components/Button";
import { ErrorNote, Spinner } from "../components/common";
import { Field } from "../components/Field";
import { TextInput } from "../components/inputs";
import { HydrogenLogo } from "../components/Logo";
import { Notice } from "../components/Notice";
import { CardHeading } from "../components/Section";
import { MS_PER_SECOND, PERCENT } from "../lib/constants";
import { API, apiUrl } from "../lib/endpoints";
import { apiErrorMessage } from "../lib/errors";
import { HTTP_UNAUTHORIZED } from "../lib/http";
import { ENTITY_ICON } from "../lib/icons";
import { HOME_PATH } from "../lib/routes";
import { useI18n } from "../lib/i18n";
import { formatDate, formatNumber, formatQuota } from "../lib/format";
import { usePolling } from "../lib/usePolling";

interface KeyStatus {
  valid: boolean;
  expired: boolean;
  requestsExceeded: boolean;
  tokensExceeded: boolean;
  checkedAt: number;
}

interface CheckResult {
  key: {
    name: string;
    scopeServiceCount: number;
    maxRequests: number | null;
    maxTokens: number | null;
    usedRequests: number;
    usedTokens: number;
    expiresAt: number | null;
    enabled: boolean;
    createdAt: number;
  };
  status: KeyStatus;
}

/** How often a submitted key is re-checked. */
const REFRESH_INTERVAL = 5000;

const KEY_PLACEHOLDER = "sk-...";

/** Characters of the key shown back to the user. */
const KEY_PREVIEW_CHARS = 14;

/** Usage (percent of quota) from which the bar turns amber, then red. */
const USAGE_THRESHOLDS = { warning: 70, danger: 90 } as const;

/** How the verdict card draws a key that works and one that does not. */
const VERDICT = {
  valid: { border: "border-green-800/50", disc: "bg-green-950/50 text-green-400", icon: "bi-check-circle-fill", label: "check.status.valid" },
  invalid: { border: "border-red-800/50", disc: "bg-red-950/50 text-red-400", icon: "bi-x-circle-fill", label: "check.status.invalid" },
} as const;

/** The fill of a usage bar at `percent` of the quota. */
const usageTone = (percent: number): string =>
  percent >= USAGE_THRESHOLDS.danger ? "bg-red-500" : percent >= USAGE_THRESHOLDS.warning ? "bg-amber-500" : "bg-brand-500";

/**
 * Ask the server about a key. Deliberately its own `fetch` rather than
 * `api.post`: this page is public, and the request carries no credentials
 * option. Only the reading of the answer is shared with the admin client.
 */
async function checkKey(apiKey: string): Promise<CheckResult> {
  const res = await fetch(apiUrl(API.check), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  return readResponse<CheckResult>(res);
}

function ProgressBar({ used, max, label }: { used: number; max: number | null; label: string }) {
  const { t } = useI18n();
  const pct = max == null ? 0 : max <= 0 ? PERCENT : Math.min(PERCENT, (used / max) * PERCENT);
  const remaining = max != null ? Math.max(0, max - used) : null;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="text-ink-300">{label}</span>
        <span className="font-mono text-xs text-ink-400">{formatQuota(used, max, t("check.unlimited"))}</span>
      </div>
      <Bar percent={pct} tone={usageTone(pct)} size="md" animated />
      {remaining != null && (
        <div className="mt-0.5 text-right text-xs text-ink-500">
          {t("check.remaining", { count: formatNumber(remaining) })}
        </div>
      )}
    </div>
  );
}

/** One line of the details card. `tone` colours the value. */
function DetailRow({ label, tone = "text-ink-100", children }: { label: string; tone?: string; children: ReactNode }) {
  return (
    <div className="flex justify-between">
      <dt className="text-ink-400">{label}</dt>
      <dd className={tone}>{children}</dd>
    </div>
  );
}

export function Check() {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState("");
  const [submittedKey, setSubmittedKey] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchOnce = useCallback(async (key: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await checkKey(key);
      setResult(r);
    } catch (e) {
      setResult(null);
      setError(apiErrorMessage(e, t("check.error.fetchFailed")));
      if (e instanceof ApiError && e.status === HTTP_UNAUTHORIZED) {
        // key is invalid — stop polling
        setSubmittedKey(null);
      }
    } finally {
      setLoading(false);
    }
  }, [t]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setSubmittedKey(apiKey.trim());
    fetchOnce(apiKey.trim());
  };

  // Re-check for as long as a key is submitted.
  const recheck = useCallback(() => {
    if (submittedKey) void fetchOnce(submittedKey);
  }, [submittedKey, fetchOnce]);
  usePolling(recheck, REFRESH_INTERVAL, Boolean(submittedKey));

  const reset = () => {
    setSubmittedKey(null);
    setResult(null);
    setError(null);
    setApiKey("");
  };

  const key = result?.key;
  const status = result?.status;
  const verdict = VERDICT[status?.valid ? "valid" : "invalid"];

  return (
    <div className="min-h-screen bg-ink-950 px-4 py-8">
      <div className="mx-auto max-w-2xl">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <HydrogenLogo className="h-12 w-12" />
            <div>
              <h1 className="text-lg font-semibold text-ink-100">{t("check.title")}</h1>
              <p className="text-sm text-ink-500">{t("check.subtitle")}</p>
            </div>
          </div>
          <Link to={HOME_PATH} className={buttonClass("ghost", "xs")}>
            <Icon name="bi-house" />
            {t("check.backToDashboard")}
          </Link>
        </div>

        {/* Input form */}
        {!submittedKey && (
          <form onSubmit={submit} className="card card-pad space-y-4">
            <Field label={t("check.form.apiKey")}>
              <TextInput
                className="font-mono"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={KEY_PLACEHOLDER}
                autoFocus
                autoComplete="off"
              />
            </Field>
            {error && (
              <Notice tone="error" size="sm" icon="bi-exclamation-circle">
                {error}
              </Notice>
            )}
            <Button variant="primary" className="w-full" icon={ENTITY_ICON.check} busy={loading} spinWhenBusy disabled={!apiKey.trim()}>
              {t("check.form.submit")}
            </Button>
          </form>
        )}

        {/* Result */}
        {submittedKey && (
          <div className="space-y-4">
            {/* Key bar */}
            <div className="card card-pad flex items-center justify-between">
              <div className="flex items-center gap-2">
                <code className="rounded bg-ink-950 px-2 py-1 font-mono text-xs text-brand-400">
                  {submittedKey.slice(0, KEY_PREVIEW_CHARS)}...
                </code>
                {key && <span className="text-sm text-ink-300">{key.name}</span>}
              </div>
              <Button variant="ghost" size="xs" icon="bi-arrow-left" onClick={reset}>
                {t("check.action.checkAnother")}
              </Button>
            </div>

            {/* Loading state (initial) */}
            {loading && !result && !error && <Spinner card label={t("check.loading")} />}

            {/* Error */}
            {error && !result && (
              <div className="card card-pad">
                <ErrorNote message={error} />
              </div>
            )}

            {/* Status cards */}
            {key && status && (
              <>
                {/* Overall status */}
                <div className={`card card-pad flex items-center gap-3 ${verdict.border}`}>
                  <span className={`flex h-10 w-10 items-center justify-center rounded-full ${verdict.disc}`}>
                    <Icon name={verdict.icon} className="text-xl" />
                  </span>
                  <div>
                    <div className="text-sm font-medium text-ink-100">{t(verdict.label)}</div>
                    {!status.valid && (
                      <div className="text-xs text-ink-400">
                        {status.expired && t("check.status.expired")}
                        {status.requestsExceeded && t("check.status.requestsExceeded")}
                        {status.tokensExceeded && t("check.status.tokensExceeded")}
                      </div>
                    )}
                  </div>
                  {!status.valid && !key.enabled && (
                    <span className="badge-red ml-auto"><Icon name="bi-pause-circle" />{t("check.status.disabled")}</span>
                  )}
                </div>

                {/* Usage */}
                <div className="card card-pad space-y-4">
                  <CardHeading icon="bi-graph-up" tone="strong">
                    {t("check.section.usage")}
                  </CardHeading>
                  <ProgressBar used={key.usedRequests} max={key.maxRequests} label={t("check.usage.requests")} />
                  <ProgressBar used={key.usedTokens} max={key.maxTokens} label={t("check.usage.tokens")} />
                </div>

                {/* Details */}
                <div className="card card-pad space-y-3">
                  <CardHeading icon="bi-info-circle" tone="strong">
                    {t("check.section.details")}
                  </CardHeading>
                  <dl className="space-y-2 text-sm">
                    <DetailRow label={t("check.details.name")}>{key.name}</DetailRow>
                    <DetailRow label={t("check.details.enabled")} tone={key.enabled ? "text-green-400" : "text-red-400"}>
                      {key.enabled ? t("common.yes") : t("common.no")}
                    </DetailRow>
                    <DetailRow label={t("check.details.scope")}>
                      {key.scopeServiceCount === 0
                        ? t("check.details.allServices")
                        : t("check.details.serviceCount", { count: key.scopeServiceCount })}
                    </DetailRow>
                    <DetailRow label={t("check.details.expires")}>
                      {key.expiresAt ? formatDate(key.expiresAt) : t("common.never")}
                    </DetailRow>
                    <DetailRow label={t("check.details.created")}>{formatDate(key.createdAt)}</DetailRow>
                  </dl>
                </div>

                {/* Live indicator */}
                <div className="flex items-center justify-center gap-1.5 text-xs text-ink-500">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-500" />
                  </span>
                  {t("check.liveUpdate", { seconds: REFRESH_INTERVAL / MS_PER_SECOND })}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
