import { useState } from "react";
import { api, ApiError } from "../api";
import { useAsync } from "../lib/hooks";
import { useAuth } from "../auth";
import { PageHeader } from "../components/Layout";
import { EmptyState, ErrorNote, Spinner, Toggle, useConfirm } from "../components/common";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { useI18n } from "../lib/i18n";
import type { Proxy, Tool } from "../types";

/**
 * Server-side tools: pointers at the operator's own HTTP endpoints.
 *
 * Hydrogen implements none of them. It declares the tool upstream, receives the
 * model's call, POSTs a fixed envelope here, and feeds the result back — so this
 * tab holds only addressing, policy and a credential.
 *
 * Which providers serve a tool natively lives on Providers, and which services
 * grant one lives in the Model Services and Micro Agent editors, so every fact
 * is edited in exactly one place.
 */

interface FormState {
  id?: number;
  name: string;
  kind: Tool["kind"];
  description: string;
  /** JSON Schema text; parsed on save so a typo is caught before it is stored. */
  parameters: string;
  endpointUrl: string;
  /** Blank on edit means "keep the stored headers". */
  headers: string;
  policy: Tool["policy"];
  maxUses: string;
  timeoutMs: string;
  proxyId: number | "";
  enabled: boolean;
}

const EMPTY: FormState = {
  name: "",
  kind: "freeform",
  description: "",
  parameters: "",
  endpointUrl: "",
  headers: "",
  policy: "prefer_provider",
  maxUses: "8",
  timeoutMs: "30000",
  proxyId: "",
  enabled: true,
};

export function Tools() {
  const { t } = useI18n();
  const { user } = useAuth();
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const isAdmin = user?.role === "admin";

  const { data, loading, error, reload } = useAsync<{ tools: Tool[] }>(() => api.get("/tools"));
  const { data: proxyData } = useAsync<{ proxies: Proxy[] }>(() => api.get("/proxies"));
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);

  const openNew = (): void => setForm({ ...EMPTY });
  const openEdit = (tool: Tool): void =>
    setForm({
      id: tool.id,
      name: tool.name,
      kind: tool.kind,
      description: tool.description ?? "",
      parameters: tool.parameters ? JSON.stringify(tool.parameters, null, 2) : "",
      endpointUrl: tool.endpointUrl ?? "",
      headers: "",
      policy: tool.policy,
      maxUses: String(tool.maxUses),
      timeoutMs: String(tool.timeoutMs),
      proxyId: tool.proxyId ?? "",
      enabled: tool.enabled,
    });

  /** The editor's fields as the API wants them, or null when they do not add up. */
  const payload = (f: FormState): Record<string, unknown> | null => {
    if (!f.name.trim()) {
      toast.error(t("tools.toast.nameRequired"));
      return null;
    }
    if (!f.endpointUrl.trim()) {
      toast.error(t("tools.toast.endpointRequired"));
      return null;
    }
    const maxUses = Number(f.maxUses.trim());
    const timeoutMs = Number(f.timeoutMs.trim());
    if (!Number.isInteger(maxUses) || maxUses < 1) {
      toast.error(t("tools.toast.maxUsesInvalid"));
      return null;
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100) {
      toast.error(t("tools.toast.timeoutInvalid"));
      return null;
    }
    // Parsed here rather than sent as text: a schema typo that reaches the model
    // is a tool it cannot call, and the symptom appears far from the cause.
    let parameters: Record<string, unknown> | null = null;
    if (f.parameters.trim()) {
      try {
        const parsed: unknown = JSON.parse(f.parameters);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        parameters = parsed as Record<string, unknown>;
      } catch {
        toast.error(t("tools.toast.schemaInvalid"));
        return null;
      }
    }
    return {
      name: f.name.trim(),
      kind: f.kind,
      description: f.description.trim() || null,
      parameters,
      endpointUrl: f.endpointUrl.trim(),
      policy: f.policy,
      maxUses,
      timeoutMs,
      proxyId: f.proxyId === "" ? null : f.proxyId,
      enabled: f.enabled,
    };
  };

  const save = async (): Promise<void> => {
    if (!form) return;
    const body = payload(form);
    if (!body) return;
    setSaving(true);
    try {
      // Blank leaves the stored headers alone; anything typed replaces them.
      if (form.headers.trim()) {
        try {
          const parsed: unknown = JSON.parse(form.headers);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
          body.headers = parsed;
        } catch {
          toast.error(t("tools.toast.headersInvalid"));
          setSaving(false);
          return;
        }
      }
      if (form.id) await api.patch(`/tools/${form.id}`, body);
      else await api.post("/tools", body);
      toast.success(form.id ? t("tools.toast.updated") : t("tools.toast.created"));
      setForm(null);
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("common.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (tool: Tool): Promise<void> => {
    if (!(await confirm(t("tools.confirm.deleteTitle"), t("tools.confirm.deleteBody", { name: tool.name })))) return;
    try {
      await api.del(`/tools/${tool.id}`);
      toast.success(t("tools.toast.deleted"));
      reload();
    } catch (e) {
      // A tool a service still grants is refused, and the message names which
      // services — so that is the useful thing to surface verbatim.
      toast.error(e instanceof ApiError ? e.message : t("common.deleteFailed"));
    }
  };

  if (loading) return <Spinner label={t("tools.loading")} />;
  if (error) return <ErrorNote message={error} />;
  const tools = data?.tools ?? [];
  const proxies = proxyData?.proxies ?? [];

  return (
    <div>
      {confirmEl}
      <PageHeader
        title={t("tools.title")}
        subtitle={t("tools.subtitle")}
        icon="bi-tools"
        action={
          isAdmin ? (
            <button className="btn-primary" onClick={openNew}>
              <i className="bi bi-plus-lg" />
              {t("tools.new")}
            </button>
          ) : undefined
        }
      />

      {tools.length === 0 ? (
        <EmptyState icon="bi-tools" title={t("tools.empty.title")} hint={t("tools.empty.body")} />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {tools.map((tool) => (
            <div key={tool.id} className="card card-pad">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <i className="bi bi-tools text-brand-400" />
                    <span className="font-mono font-medium text-ink-100">{tool.name}</span>
                    <span className={tool.kind === "vocabulary" ? "badge-blue" : "badge-gray"}>
                      {t(`tools.kind.${tool.kind}`)}
                    </span>
                    <span className={tool.enabled ? "badge-green" : "badge-gray"}>
                      {tool.enabled ? t("common.enabled") : t("common.disabled")}
                    </span>
                  </div>
                  {tool.description && <div className="mt-1 text-xs text-ink-400">{tool.description}</div>}
                  {tool.endpointUrl && <div className="mt-1 truncate font-mono text-xs text-ink-400">{tool.endpointUrl}</div>}
                  <div className="mt-1 flex flex-wrap gap-3 text-xs text-ink-500">
                    <span>
                      <i className="bi bi-shuffle mr-1" />
                      {t(`tools.policy.${tool.policy}`)}
                    </span>
                    <span>
                      <i className="bi bi-repeat mr-1" />
                      {t("tools.maxUses.badge", { n: tool.maxUses })}
                    </span>
                    {tool.headerNames.length > 0 && (
                      <span>
                        <i className="bi bi-key mr-1" />
                        {tool.headerNames.join(", ")}
                      </span>
                    )}
                  </div>
                </div>
                {isAdmin && (
                  <div className="flex shrink-0 gap-1.5">
                    <button className="btn-ghost btn-xs" onClick={() => openEdit(tool)}>
                      <i className="bi bi-pencil" />
                      {t("common.edit")}
                    </button>
                    <button className="btn-danger btn-xs" onClick={() => void remove(tool)}>
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
        title={form?.id ? t("tools.modal.editTitle", { name: form.name }) : t("tools.modal.newTitle")}
        icon="bi-tools"
        onClose={() => setForm(null)}
        footer={
          form ? (
            <div className="flex w-full items-center justify-end gap-2">
              <button className="btn-ghost" onClick={() => setForm(null)}>{t("common.cancel")}</button>
              <button className="btn-primary" disabled={saving || !form.name.trim()} onClick={() => void save()}>
                <i className="bi bi-check-lg" />
                {t("common.save")}
              </button>
            </div>
          ) : undefined
        }
      >
        {form && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">{t("tools.field.name")}</label>
                <input
                  className="input font-mono text-xs"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder={t("tools.field.name.placeholder")}
                />
              </div>
              <div>
                <label className="label">{t("tools.field.kind")}</label>
                <select
                  className="select"
                  value={form.kind}
                  onChange={(e) => setForm({ ...form, kind: e.target.value as Tool["kind"] })}
                >
                  <option value="freeform">{t("tools.kind.freeform")}</option>
                  <option value="vocabulary">{t("tools.kind.vocabulary")}</option>
                </select>
              </div>
            </div>
            <p className="-mt-2 text-xs text-ink-500">{t(`tools.field.kind.hint.${form.kind}`)}</p>

            <div>
              <label className="label">{t("tools.field.endpoint")}</label>
              <input
                className="input font-mono text-xs"
                value={form.endpointUrl}
                onChange={(e) => setForm({ ...form, endpointUrl: e.target.value })}
                placeholder="https://tools.example.com/search"
              />
              <p className="mt-1 text-xs text-ink-500">{t("tools.field.endpoint.hint")}</p>
            </div>

            <div>
              <label className="label">
                {t("tools.field.description")} <span className="normal-case text-ink-500">{t("common.optional")}</span>
              </label>
              <input
                className="input"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder={t("tools.field.description.placeholder")}
              />
            </div>

            <div>
              <label className="label">
                {t("tools.field.parameters")} <span className="normal-case text-ink-500">{t("common.optional")}</span>
              </label>
              <textarea
                className="input h-24 font-mono text-xs"
                value={form.parameters}
                onChange={(e) => setForm({ ...form, parameters: e.target.value })}
                placeholder='{"type":"object","properties":{"query":{"type":"string"}}}'
              />
              <p className="mt-1 text-xs text-ink-500">{t("tools.field.parameters.hint")}</p>
            </div>

            <div>
              <label className="label">
                {t("tools.field.headers")}{" "}
                {form.id && <span className="normal-case text-ink-500">{t("tools.field.headers.keepHint")}</span>}
              </label>
              <textarea
                className="input h-20 font-mono text-xs"
                value={form.headers}
                onChange={(e) => setForm({ ...form, headers: e.target.value })}
                placeholder='{"Authorization":"Bearer ..."}'
                autoComplete="off"
              />
              <p className="mt-1 text-xs text-ink-500">{t("tools.field.headers.hint")}</p>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="label">{t("tools.field.policy")}</label>
                <select
                  className="select"
                  value={form.policy}
                  onChange={(e) => setForm({ ...form, policy: e.target.value as Tool["policy"] })}
                >
                  <option value="prefer_provider">{t("tools.policy.prefer_provider")}</option>
                  <option value="override">{t("tools.policy.override")}</option>
                </select>
              </div>
              <div>
                <label className="label">{t("tools.field.maxUses")}</label>
                <input
                  className="input font-mono text-xs"
                  inputMode="numeric"
                  value={form.maxUses}
                  onChange={(e) => setForm({ ...form, maxUses: e.target.value })}
                />
              </div>
              <div>
                <label className="label">{t("tools.field.timeout")}</label>
                <input
                  className="input font-mono text-xs"
                  inputMode="numeric"
                  value={form.timeoutMs}
                  onChange={(e) => setForm({ ...form, timeoutMs: e.target.value })}
                />
              </div>
            </div>
            <p className="-mt-2 text-xs text-ink-500">{t("tools.field.policy.hint")}</p>

            <div>
              <label className="label">
                {t("tools.field.proxy")} <span className="normal-case text-ink-500">{t("common.optional")}</span>
              </label>
              <select
                className="select"
                value={form.proxyId}
                onChange={(e) => setForm({ ...form, proxyId: e.target.value === "" ? "" : Number(e.target.value) })}
              >
                <option value="">{t("tools.field.proxy.direct")}</option>
                {proxies.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>

            <Toggle checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label={t("common.enabled")} />
            <p className="text-xs text-ink-500">{t("tools.field.enabled.hint")}</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
