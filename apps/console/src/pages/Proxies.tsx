import { useState } from "react";
import { api, ApiError } from "../api";
import { useAsync } from "../lib/hooks";
import { useAuth } from "../auth";
import { PageHeader } from "../components/Layout";
import { EmptyState, ErrorNote, Spinner, Toggle, useConfirm } from "../components/common";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { useI18n } from "../lib/i18n";
import type { Proxy, ProxyTestResult } from "../types";

/**
 * Egress proxies: the optional network hop between Hydrogen and a provider.
 *
 * Nothing here changes what is sent upstream or how an answer is read -- a
 * proxy only changes how the connection is opened. A provider picks one in the
 * Providers editor; until it does, it connects directly, which is what every
 * provider did before this tab existed.
 */

interface FormState {
  id?: number;
  name: string;
  scheme: "http" | "https";
  host: string;
  port: string;
  username: string;
  /** Blank on edit means "keep the stored password". */
  password: string;
  enabled: boolean;
  test: ProxyTestResult | null;
}

const EMPTY: FormState = {
  name: "",
  scheme: "http",
  host: "",
  port: "7890",
  username: "",
  password: "",
  enabled: true,
  test: null,
};

export function Proxies() {
  const { t } = useI18n();
  const { user } = useAuth();
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const isAdmin = user?.role === "admin";

  const { data, loading, error, reload } = useAsync<{ proxies: Proxy[] }>(() => api.get("/proxies"));
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const openNew = (): void => setForm({ ...EMPTY });
  const openEdit = (p: Proxy): void =>
    setForm({
      id: p.id,
      name: p.name,
      scheme: p.scheme,
      host: p.host,
      port: String(p.port),
      username: p.username ?? "",
      password: "",
      enabled: p.enabled,
      test: null,
    });

  /** The editor's fields as the API wants them, or null when they do not add up. */
  const payload = (f: FormState): Record<string, unknown> | null => {
    const port = Number(f.port.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      toast.error(t("proxies.toast.portInvalid"));
      return null;
    }
    if (!f.host.trim()) {
      toast.error(t("proxies.toast.hostRequired"));
      return null;
    }
    return {
      name: f.name.trim(),
      scheme: f.scheme,
      host: f.host.trim(),
      port,
      username: f.username.trim() || null,
      enabled: f.enabled,
    };
  };

  /**
   * Prove the proxy actually carries traffic, before a provider depends on it.
   * An unsaved proxy is testable too -- finding out after saving that a port
   * was wrong is the workflow this avoids.
   */
  const test = async (): Promise<void> => {
    if (!form) return;
    const body = payload(form);
    if (!body) return;
    setTesting(true);
    try {
      const inline = { ...body, ...(form.password ? { password: form.password } : {}) };
      // A saved proxy with an untouched password field is tested by id, so the
      // stored password is used; anything else is tested exactly as typed.
      const req = form.id && !form.password ? { id: form.id } : { proxy: inline };
      const r = await api.post<ProxyTestResult>("/proxies/test", req);
      setForm((f) => (f ? { ...f, test: r } : f));
      if (r.ok) toast.success(t("proxies.toast.reachable"));
      else toast.error(t("proxies.toast.unreachable"));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("proxies.toast.testFailed"));
    } finally {
      setTesting(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!form) return;
    const body = payload(form);
    if (!body) return;
    setSaving(true);
    try {
      if (form.password) body.password = form.password;
      if (form.id) await api.patch(`/proxies/${form.id}`, body);
      else await api.post("/proxies", body);
      toast.success(form.id ? t("proxies.toast.updated") : t("proxies.toast.created"));
      setForm(null);
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("common.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (p: Proxy): Promise<void> => {
    if (!(await confirm(t("proxies.confirm.deleteTitle"), t("proxies.confirm.deleteBody", { name: p.name })))) return;
    try {
      await api.del(`/proxies/${p.id}`);
      toast.success(t("proxies.toast.deleted"));
      reload();
    } catch (e) {
      // A proxy still attached to a provider is refused, and the message names
      // which providers -- so this is the useful thing to surface verbatim.
      toast.error(e instanceof ApiError ? e.message : t("common.deleteFailed"));
    }
  };

  if (loading) return <Spinner label={t("proxies.loading")} />;
  if (error) return <ErrorNote message={error} />;
  const proxies = data?.proxies ?? [];

  return (
    <div>
      {confirmEl}
      <PageHeader
        title={t("proxies.title")}
        subtitle={t("proxies.subtitle")}
        icon="bi-hdd-network"
        action={
          isAdmin ? (
            <button className="btn-primary" onClick={openNew}>
              <i className="bi bi-plus-lg" />
              {t("proxies.new")}
            </button>
          ) : undefined
        }
      />

      {proxies.length === 0 ? (
        <EmptyState icon="bi-hdd-network" title={t("proxies.empty.title")} hint={t("proxies.empty.body")} />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {proxies.map((p) => (
            <div key={p.id} className="card card-pad">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <i className="bi bi-hdd-network text-brand-400" />
                    <span className="font-medium text-ink-100">{p.name}</span>
                    <span className={p.enabled ? "badge-green" : "badge-gray"}>
                      {p.enabled ? t("common.enabled") : t("common.disabled")}
                    </span>
                  </div>
                  <div className="mt-1 font-mono text-xs text-ink-400">
                    {p.scheme}://{p.username ? `${p.username}@` : ""}{p.host}:{p.port}
                  </div>
                  {p.hasPassword && (
                    <div className="mt-1 text-xs text-ink-500">
                      <i className="bi bi-key mr-1" />
                      {t("proxies.hasPassword")}
                    </div>
                  )}
                </div>
                {isAdmin && (
                  <div className="flex shrink-0 gap-1.5">
                    <button className="btn-ghost btn-xs" onClick={() => openEdit(p)}>
                      <i className="bi bi-pencil" />
                      {t("common.edit")}
                    </button>
                    <button className="btn-danger btn-xs" onClick={() => void remove(p)}>
                      <i className="bi bi-trash" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={form !== null}
        title={form?.id ? t("proxies.modal.editTitle", { name: form.name }) : t("proxies.modal.newTitle")}
        icon="bi-hdd-network"
        onClose={() => setForm(null)}
        footer={
          form ? (
            <div className="flex w-full items-center justify-between gap-2">
              <button className="btn-ghost" disabled={testing} onClick={() => void test()}>
                <i className={`bi ${testing ? "bi-arrow-repeat animate-spin" : "bi-plug"}`} />
                {testing ? t("proxies.testing") : t("proxies.test")}
              </button>
              <div className="flex gap-2">
                <button className="btn-ghost" onClick={() => setForm(null)}>{t("common.cancel")}</button>
                <button className="btn-primary" disabled={saving || !form.name.trim()} onClick={() => void save()}>
                  <i className="bi bi-check-lg" />
                  {t("common.save")}
                </button>
              </div>
            </div>
          ) : undefined
        }
      >
        {form && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">{t("proxies.field.name")}</label>
                <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("proxies.field.name.placeholder")} />
              </div>
              <div>
                <label className="label">{t("proxies.field.scheme")}</label>
                <select className="select" value={form.scheme} onChange={(e) => setForm({ ...form, scheme: e.target.value as "http" | "https" })}>
                  <option value="http">http</option>
                  <option value="https">https</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-2">
                <label className="label">{t("proxies.field.host")}</label>
                <input className="input font-mono text-xs" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="127.0.0.1" />
              </div>
              <div>
                <label className="label">{t("proxies.field.port")}</label>
                <input className="input font-mono text-xs" inputMode="numeric" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
              </div>
            </div>
            <p className="-mt-2 text-xs text-ink-500">{t("proxies.field.host.hint")}</p>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">{t("proxies.field.username")} <span className="normal-case text-ink-500">{t("common.optional")}</span></label>
                <input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" />
              </div>
              <div>
                <label className="label">
                  {t("proxies.field.password")}{" "}
                  {form.id && <span className="normal-case text-ink-500">{t("proxies.field.password.keepHint")}</span>}
                </label>
                <input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
              </div>
            </div>

            <Toggle checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label={t("common.enabled")} />
            <p className="text-xs text-ink-500">{t("proxies.field.enabled.hint")}</p>

            {form.test && (
              <div
                className={`rounded-lg border px-4 py-3 text-sm ${
                  form.test.ok
                    ? "border-emerald-900/50 bg-emerald-950/30 text-emerald-300"
                    : "border-red-900/50 bg-red-950/30 text-red-300"
                }`}
              >
                <i className={`bi ${form.test.ok ? "bi-check-circle-fill" : "bi-exclamation-octagon-fill"} mr-2`} />
                {form.test.message}
                {form.test.ok && <span className="ml-2 text-ink-500">{form.test.latencyMs} {t("common.ms")}</span>}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
