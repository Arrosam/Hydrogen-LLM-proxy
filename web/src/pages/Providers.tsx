import { useState } from "react";
import { api, ApiError } from "../api";
import { useAsync } from "../lib/hooks";
import { PageHeader } from "../components/Layout";
import { EmptyState, ErrorNote, Spinner, Toggle, useConfirm } from "../components/common";
import { Modal } from "../components/Modal";
import { ModelList } from "../components/ModelList";
import { useToast } from "../components/Toast";
import { useI18n } from "../lib/i18n";
import type { Provider, ProviderModels, ProviderTestResult, ProviderType } from "../types";

interface Data {
  providers: Provider[];
  providerModels: ProviderModels[];
}

/** The outcome of the last test run inside the modal. */
interface TestState {
  ok: boolean;
  message: string;
  /** What the provider reported. Saved with the provider on Save. */
  models: string[];
}

interface AltEndpoint { type: ProviderType; baseUrl: string }

interface FormState {
  id?: number;
  name: string;
  type: ProviderType;
  baseUrl: string;
  altEndpoints: AltEndpoint[];
  apiKey: string;
  extraHeaders: string;
  maxOutputTokens: string;
  enabled: boolean;
  /** The list already stored for this provider (edit only), shown until a test
   * replaces it. */
  storedModels: string[];
  /** Null until the provider is tested in this dialog; a successful test's list
   * is what gets written on Save. */
  test: TestState | null;
}

const EMPTY: FormState = {
  name: "",
  type: "openai_completion",
  baseUrl: "",
  altEndpoints: [],
  apiKey: "",
  extraHeaders: "",
  maxOutputTokens: "",
  enabled: true,
  storedModels: [],
  test: null,
};

export function Providers() {
  const { t } = useI18n();
  const TYPE_LABELS: Record<ProviderType, string> = {
    openai_completion: t("providers.type.openai_completion"),
    openai_responses: t("providers.type.openai_responses"),
    anthropic: t("providers.type.anthropic"),
  };
  const { data, loading, error, reload } = useAsync<Data>(async () => {
    const [p, pm] = await Promise.all([
      api.get<{ providers: Provider[] }>("/providers"),
      api.get<{ providerModels: ProviderModels[] }>("/provider-models"),
    ]);
    return { providers: p.providers, providerModels: pm.providerModels };
  });
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const storedFor = (providerId: number) => data?.providerModels.find((x) => x.providerId === providerId)?.models ?? [];

  const openNew = () => setForm({ ...EMPTY });
  const openEdit = (p: Provider) =>
    setForm({
      id: p.id,
      name: p.name,
      type: p.type,
      baseUrl: p.baseUrl,
      altEndpoints: (p as unknown as { altEndpoints?: AltEndpoint[] | null }).altEndpoints ?? [],
      apiKey: "",
      extraHeaders: p.extraHeaders ? JSON.stringify(p.extraHeaders, null, 2) : "",
      maxOutputTokens: p.maxOutputTokens != null ? String(p.maxOutputTokens) : "",
      enabled: p.enabled,
      storedModels: storedFor(p.id),
      test: null,
    });

  /** Parse the extra-headers textarea, reporting the failure the same way for
   * both the test and the save (both send headers upstream). */
  const parseHeaders = (raw: string): Record<string, string> | null | "invalid" => {
    if (!raw.trim()) return null;
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      toast.error(t("providers.toast.extraHeadersInvalidJson"));
      return "invalid";
    }
  };

  const test = async () => {
    if (!form) return;
    if (!form.baseUrl.trim()) {
      toast.error(t("providers.toast.baseUrlRequired"));
      return;
    }
    const extraHeaders = parseHeaders(form.extraHeaders);
    if (extraHeaders === "invalid") return;
    setTesting(true);
    try {
      const payload: Record<string, unknown> = { type: form.type, baseUrl: form.baseUrl, extraHeaders };
      // A blank key field on an existing provider means "keep the stored one",
      // so let the server use it rather than testing with no key at all.
      if (form.apiKey) payload.apiKey = form.apiKey;
      else if (form.id) payload.id = form.id;
      else payload.apiKey = null;
      const r = await api.post<ProviderTestResult>("/providers/test", payload);
      setForm((f) => (f ? { ...f, test: { ok: r.ok, message: r.message, models: r.models } } : f));
      if (!r.ok) toast.error(r.message);
      else if (r.models.length === 0) toast.error(t("providers.toast.testNoModels"));
      else toast.success(t("providers.toast.testFetched", { count: r.models.length }));
    } catch (e) {
      const message = e instanceof ApiError ? e.message : t("providers.toast.testFailed");
      setForm((f) => (f ? { ...f, test: { ok: false, message, models: [] } } : f));
      toast.error(message);
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!form) return;
    const extraHeaders = parseHeaders(form.extraHeaders);
    if (extraHeaders === "invalid") return;
    const motRaw = form.maxOutputTokens.trim();
    if (motRaw && !/^[1-9]\d*$/.test(motRaw)) {
      toast.error(t("providers.toast.maxOutputTokensNotPositive"));
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        type: form.type,
        baseUrl: form.baseUrl,
        extraHeaders,
        maxOutputTokens: motRaw ? Number(motRaw) : null,
        altEndpoints: form.altEndpoints.filter((e) => e.baseUrl.trim()).length
          ? form.altEndpoints.filter((e) => e.baseUrl.trim())
          : null,
        enabled: form.enabled,
      };
      if (form.apiKey) payload.apiKey = form.apiKey;
      // Only a successful test writes the model list; omitting the field leaves
      // whatever is stored untouched.
      if (form.test?.ok) payload.availableModels = form.test.models;
      if (form.id) {
        if (!form.apiKey) delete payload.apiKey; // keep existing key
        await api.patch(`/providers/${form.id}`, payload);
      } else {
        await api.post("/providers", payload);
      }
      toast.success(form.id ? t("providers.toast.updated") : t("providers.toast.created"));
      setForm(null);
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("common.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (p: Provider) => {
    if (!(await confirm(t("providers.confirm.delete.title"), t("providers.confirm.delete.body", { name: p.name })))) return;
    try {
      await api.del(`/providers/${p.id}`);
      toast.success(t("providers.toast.deleted"));
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("providers.toast.deleteFailed"));
    }
  };

  // The list shown in the dialog: the fresh one once tested, else what's stored.
  const shownModels = form?.test?.ok ? form.test.models : (form?.storedModels ?? []);

  return (
    <div>
      <PageHeader
        title={t("providers.title")}
        subtitle={t("providers.subtitle")}
        icon="bi-hdd-network"
        action={
          <button className="btn-primary" onClick={openNew}>
            <i className="bi bi-plus-lg" />
            {t("providers.action.new")}
          </button>
        }
      />
      {loading && <Spinner />}
      {error && <ErrorNote message={error} />}
      {data && data.providers.length === 0 && (
        <EmptyState icon="bi-hdd-network" title={t("providers.empty.title")} hint={t("providers.empty.hint")} action={<button className="btn-primary" onClick={openNew}><i className="bi bi-plus-lg" />{t("providers.action.new")}</button>} />
      )}
      {data && data.providers.length > 0 && (
        <div className="card overflow-hidden">
          <table className="table">
            <thead>
              <tr>
                <th>{t("providers.table.name")}</th>
                <th>{t("providers.table.type")}</th>
                <th>{t("providers.table.baseUrl")}</th>
                <th>{t("providers.table.key")}</th>
                <th>{t("providers.table.models")}</th>
                <th>{t("providers.table.status")}</th>
                <th className="text-right">{t("providers.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {data.providers.map((p) => {
                const count = storedFor(p.id).length;
                return (
                  <tr key={p.id}>
                    <td className="font-medium text-ink-100">{p.name}</td>
                    <td><span className="badge-gray">{TYPE_LABELS[p.type]}</span></td>
                    <td className="font-mono text-xs text-ink-400 max-w-[240px] truncate" title={p.baseUrl}>{p.baseUrl}</td>
                    <td>
                      {p.hasKey ? (
                        <span className="badge-green"><i className="bi bi-key-fill" />{t("common.set")}</span>
                      ) : (
                        <span className="badge-gray"><i className="bi bi-dash" />{t("common.none")}</span>
                      )}
                    </td>
                    <td>
                      {count > 0 ? (
                        <span className="badge-blue"><i className="bi bi-box" />{count}</span>
                      ) : (
                        <span className="badge-gray"><i className="bi bi-dash" />{t("common.none")}</span>
                      )}
                    </td>
                    <td>
                      {p.enabled ? <span className="badge-green">{t("common.enabled")}</span> : <span className="badge-red">{t("common.disabled")}</span>}
                    </td>
                    <td>
                      <div className="flex justify-end gap-1.5">
                        <button className="btn-ghost btn-xs" onClick={() => openEdit(p)}>
                          <i className="bi bi-pencil" />
                        </button>
                        <button className="btn-danger btn-xs" onClick={() => remove(p)}>
                          <i className="bi bi-trash3" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={form !== null}
        size="lg"
        title={form?.id ? t("providers.modal.edit.title") : t("providers.modal.new.title")}
        icon="bi-hdd-network"
        onClose={() => setForm(null)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setForm(null)}>{t("common.cancel")}</button>
            <button className="btn-primary" onClick={save} disabled={saving}>
              {saving ? <i className="bi bi-arrow-repeat animate-spin" /> : <i className="bi bi-check-lg" />}
              {t("common.save")}
            </button>
          </>
        }
      >
        {form && (
          <div className="space-y-4">
            {/* The short fields pair up; anything that holds a URL, a JSON blob
                or a list keeps the full width. */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label">{t("providers.field.name.label")}</label>
                <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("providers.field.name.placeholder")} />
              </div>
              <div>
                <label className="label">{t("providers.field.type.label")}</label>
                <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as ProviderType })}>
                  <option value="openai_completion">{t("providers.type.openai_completion")}</option>
                  <option value="openai_responses">{t("providers.type.openai_responses")}</option>
                  <option value="anthropic">{t("providers.type.anthropic")}</option>
                </select>
              </div>
            </div>
            <div>
              <label className="label">{t("providers.field.baseUrl.label")}</label>
              <input className="input font-mono text-xs" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder={form.type === "anthropic" ? t("providers.field.baseUrl.placeholder.anthropic") : t("providers.field.baseUrl.placeholder.openai")} />
              <p className="mt-1 text-xs text-ink-500">
                {form.type === "anthropic"
                  ? t("providers.field.baseUrl.hint.anthropic")
                  : form.type === "openai_responses"
                    ? t("providers.field.baseUrl.hint.openai_responses")
                    : t("providers.field.baseUrl.hint.openai_completion")}
              </p>
            </div>
            <div>
              <label className="label">{t("providers.field.altEndpoints.label")} <span className="normal-case text-ink-500">{t("providers.field.altEndpoints.optional")}</span></label>
              <p className="mb-2 text-xs text-ink-500">{t("providers.field.altEndpoints.hint")}</p>
              {form.altEndpoints.map((ep, i) => (
                <div key={i} className="mb-2 flex gap-2">
                  <select
                    className="input w-48"
                    value={ep.type}
                    onChange={(e) => setForm({ ...form, altEndpoints: form.altEndpoints.map((x, j) => (j === i ? { ...x, type: e.target.value as ProviderType } : x)) })}
                  >
                    {(Object.keys(TYPE_LABELS) as ProviderType[]).map((tp) => (
                      <option key={tp} value={tp}>{TYPE_LABELS[tp]}</option>
                    ))}
                  </select>
                  <input
                    className="input font-mono text-xs"
                    value={ep.baseUrl}
                    onChange={(e) => setForm({ ...form, altEndpoints: form.altEndpoints.map((x, j) => (j === i ? { ...x, baseUrl: e.target.value } : x)) })}
                    placeholder="https://…/v1"
                  />
                  <button className="btn-ghost btn-xs" onClick={() => setForm({ ...form, altEndpoints: form.altEndpoints.filter((_, j) => j !== i) })}>
                    <i className="bi bi-x-lg" />
                  </button>
                </div>
              ))}
              {form.altEndpoints.length < 3 && (
                <button className="btn-ghost btn-xs" onClick={() => setForm({ ...form, altEndpoints: [...form.altEndpoints, { type: form.type === "openai_completion" ? "openai_responses" : "openai_completion", baseUrl: "" }] })}>
                  <i className="bi bi-plus-lg" />
                  {t("providers.field.altEndpoints.add")}
                </button>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label">{t("providers.field.apiKey.label")} {form.id && <span className="normal-case text-ink-500">{t("providers.field.apiKey.keepCurrentHint")}</span>}</label>
                <input className="input font-mono text-xs" type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={t("providers.field.apiKey.placeholder")} />
              </div>
              <div>
                <label className="label">{t("providers.field.maxOutputTokens.label")} <span className="normal-case text-ink-500">{t("providers.field.maxOutputTokens.optionalCap")}</span></label>
                <input
                  className="input font-mono text-xs"
                  inputMode="numeric"
                  value={form.maxOutputTokens}
                  onChange={(e) => setForm({ ...form, maxOutputTokens: e.target.value })}
                  placeholder={t("providers.field.maxOutputTokens.placeholder")}
                />
                <p className="mt-1 text-xs text-ink-500">{t("providers.field.maxOutputTokens.hint")}</p>
              </div>
            </div>
            <div>
              <label className="label">{t("providers.field.extraHeaders.label")}</label>
              <textarea className="input font-mono text-xs" rows={3} value={form.extraHeaders} onChange={(e) => setForm({ ...form, extraHeaders: e.target.value })} placeholder='{"x-custom": "value"}' />
            </div>

            <div className="rounded-lg border border-ink-800 bg-ink-950/30 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">{t("providers.test.title")}</div>
                  <p className="mt-1 text-xs text-ink-500">{t("providers.test.hint")}</p>
                </div>
                <button className="btn-ghost btn-xs shrink-0" onClick={test} disabled={testing}>
                  <i className={`bi ${testing ? "bi-arrow-repeat animate-spin" : "bi-plug"}`} />
                  {t("providers.action.test")}
                </button>
              </div>

              {form.test && !form.test.ok && (
                <p className="mt-3 flex items-start gap-2 text-xs text-red-300">
                  <i className="bi bi-exclamation-octagon-fill mt-px shrink-0" />
                  <span className="break-words">{form.test.message}</span>
                </p>
              )}

              {(shownModels.length > 0 || form.test?.ok) && (
                <div className="mt-3 space-y-2">
                  <div className="flex items-center gap-2 text-xs">
                    {form.test?.ok ? (
                      <span className="badge-green"><i className="bi bi-check-lg" />{t("providers.test.fetched", { count: form.test.models.length })}</span>
                    ) : (
                      <span className="badge-gray"><i className="bi bi-clock-history" />{t("providers.test.stored", { count: shownModels.length })}</span>
                    )}
                    {form.test?.ok && <span className="text-ink-500">{t("providers.test.savedOnSave")}</span>}
                  </div>
                  <ModelList models={shownModels} emptyText={t("providers.test.none")} />
                </div>
              )}
            </div>

            <Toggle checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label={t("providers.field.enabled.label")} />
          </div>
        )}
      </Modal>
      {confirmEl}
    </div>
  );
}
