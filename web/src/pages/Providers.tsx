import { useState } from "react";
import { api, ApiError } from "../api";
import { useAsync } from "../lib/hooks";
import { PageHeader } from "../components/Layout";
import { EmptyState, ErrorNote, Spinner, Toggle, useConfirm } from "../components/common";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { useI18n } from "../lib/i18n";
import type { Provider, ProviderType } from "../types";

interface FormState {
  id?: number;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  extraHeaders: string;
  maxOutputTokens: string;
  enabled: boolean;
}

const EMPTY: FormState = {
  name: "",
  type: "openai_completion",
  baseUrl: "",
  apiKey: "",
  extraHeaders: "",
  maxOutputTokens: "",
  enabled: true,
};

export function Providers() {
  const { t } = useI18n();
  const TYPE_LABELS: Record<ProviderType, string> = {
    openai_completion: t("providers.type.openai_completion"),
    openai_responses: t("providers.type.openai_responses"),
    anthropic: t("providers.type.anthropic"),
  };
  const { data, loading, error, reload } = useAsync(() => api.get<{ providers: Provider[] }>("/providers"));
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);

  const openNew = () => setForm({ ...EMPTY });
  const openEdit = (p: Provider) =>
    setForm({
      id: p.id,
      name: p.name,
      type: p.type,
      baseUrl: p.baseUrl,
      apiKey: "",
      extraHeaders: p.extraHeaders ? JSON.stringify(p.extraHeaders, null, 2) : "",
      maxOutputTokens: p.maxOutputTokens != null ? String(p.maxOutputTokens) : "",
      enabled: p.enabled,
    });

  const save = async () => {
    if (!form) return;
    let extraHeaders: Record<string, string> | null = null;
    if (form.extraHeaders.trim()) {
      try {
        extraHeaders = JSON.parse(form.extraHeaders);
      } catch {
        toast.error(t("providers.toast.extraHeadersInvalidJson"));
        return;
      }
    }
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
        enabled: form.enabled,
      };
      if (form.apiKey) payload.apiKey = form.apiKey;
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
    if (!(await confirm("Delete provider", `Delete "${p.name}"? Mappings using it will also be removed.`))) return;
    try {
      await api.del(`/providers/${p.id}`);
      toast.success("Provider deleted");
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Delete failed");
    }
  };

  const test = async (p: Provider) => {
    setTesting(p.id);
    try {
      const r = await api.post<{ ok: boolean; status: number; message: string }>(`/providers/${p.id}/test`);
      if (r.ok) toast.success(`${p.name}: ${r.message}`);
      else toast.error(`${p.name}: ${r.message}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Test failed");
    } finally {
      setTesting(null);
    }
  };

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
                <th>{t("providers.table.status")}</th>
                <th className="text-right">{t("providers.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {data.providers.map((p) => (
                <tr key={p.id}>
                  <td className="font-medium text-ink-100">{p.name}</td>
                  <td><span className="badge-gray">{TYPE_LABELS[p.type]}</span></td>
                  <td className="font-mono text-xs text-ink-400">{p.baseUrl}</td>
                  <td>
                    {p.hasKey ? (
                      <span className="badge-green"><i className="bi bi-key-fill" />{t("common.set")}</span>
                    ) : (
                      <span className="badge-gray"><i className="bi bi-dash" />{t("common.none")}</span>
                    )}
                  </td>
                  <td>
                    {p.enabled ? <span className="badge-green">{t("common.enabled")}</span> : <span className="badge-red">{t("common.disabled")}</span>}
                  </td>
                  <td>
                    <div className="flex justify-end gap-1.5">
                      <button className="btn-ghost btn-xs" onClick={() => test(p)} disabled={testing === p.id}>
                        <i className={`bi ${testing === p.id ? "bi-arrow-repeat animate-spin" : "bi-plug"}`} />
                        {t("providers.action.test")}
                      </button>
                      <button className="btn-ghost btn-xs" onClick={() => openEdit(p)}>
                        <i className="bi bi-pencil" />
                      </button>
                      <button className="btn-danger btn-xs" onClick={() => remove(p)}>
                        <i className="bi bi-trash3" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={form !== null}
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
              <label className="label">{t("providers.field.apiKey.label")} {form.id && <span className="normal-case text-ink-500">{t("providers.field.apiKey.keepCurrentHint")}</span>}</label>
              <input className="input font-mono text-xs" type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={t("providers.field.apiKey.placeholder")} />
            </div>
            <div>
              <label className="label">{t("providers.field.extraHeaders.label")}</label>
              <textarea className="input font-mono text-xs" rows={3} value={form.extraHeaders} onChange={(e) => setForm({ ...form, extraHeaders: e.target.value })} placeholder='{"x-custom": "value"}' />
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
            <Toggle checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label={t("providers.field.enabled.label")} />
          </div>
        )}
      </Modal>
      {confirmEl}
    </div>
  );
}
