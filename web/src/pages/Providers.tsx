import { useState } from "react";
import { api, ApiError } from "../api";
import { useAsync } from "../lib/hooks";
import { useAuth } from "../auth";
import { PageHeader } from "../components/Layout";
import { EmptyState, ErrorNote, Spinner, Toggle, useConfirm } from "../components/common";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import type { Provider, ProviderType } from "../types";

const TYPE_LABELS: Record<ProviderType, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  openai_compatible: "OpenAI-compatible",
  openai_responses: "OpenAI Responses",
};

interface FormState {
  id?: number;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  extraHeaders: string;
  enabled: boolean;
}

const EMPTY: FormState = {
  name: "",
  type: "openai_compatible",
  baseUrl: "",
  apiKey: "",
  extraHeaders: "",
  enabled: true,
};

export function Providers() {
  const { data, loading, error, reload } = useAsync(() => api.get<{ providers: Provider[] }>("/providers"));
  const { user } = useAuth();
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
      enabled: p.enabled,
    });

  const save = async () => {
    if (!form) return;
    let extraHeaders: Record<string, string> | null = null;
    if (form.extraHeaders.trim()) {
      try {
        extraHeaders = JSON.parse(form.extraHeaders);
      } catch {
        toast.error("Extra headers must be valid JSON");
        return;
      }
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        type: form.type,
        baseUrl: form.baseUrl,
        extraHeaders,
        enabled: form.enabled,
      };
      if (form.apiKey) payload.apiKey = form.apiKey;
      if (form.id) {
        if (!form.apiKey) delete payload.apiKey; // keep existing key
        await api.patch(`/providers/${form.id}`, payload);
      } else {
        await api.post("/providers", payload);
      }
      toast.success(form.id ? "Provider updated" : "Provider created");
      setForm(null);
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Save failed");
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
        title="Providers"
        subtitle="Upstream API endpoints. Keys are encrypted at rest."
        icon="bi-hdd-network"
        action={
          <button className="btn-primary" onClick={openNew}>
            <i className="bi bi-plus-lg" />
            New provider
          </button>
        }
      />
      {loading && <Spinner />}
      {error && <ErrorNote message={error} />}
      {data && data.providers.length === 0 && (
        <EmptyState icon="bi-hdd-network" title="No providers yet" hint="Add an upstream like OpenAI or Anthropic to start routing." action={<button className="btn-primary" onClick={openNew}><i className="bi bi-plus-lg" />New provider</button>} />
      )}
      {data && data.providers.length > 0 && (
        <div className="card overflow-hidden">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Base URL</th>
                <th>Key</th>
                <th>Status</th>
                <th className="text-right">Actions</th>
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
                      <span className="badge-green"><i className="bi bi-key-fill" />set</span>
                    ) : (
                      <span className="badge-gray"><i className="bi bi-dash" />none</span>
                    )}
                  </td>
                  <td>
                    {p.enabled ? <span className="badge-green">enabled</span> : <span className="badge-red">disabled</span>}
                  </td>
                  <td>
                    <div className="flex justify-end gap-1.5">
                      <button className="btn-ghost btn-xs" onClick={() => test(p)} disabled={testing === p.id}>
                        <i className={`bi ${testing === p.id ? "bi-arrow-repeat animate-spin" : "bi-plug"}`} />
                        Test
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

      {user?.role === "admin" && <AllowlistCard />}

      <Modal
        open={form !== null}
        title={form?.id ? "Edit provider" : "New provider"}
        icon="bi-hdd-network"
        onClose={() => setForm(null)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn-primary" onClick={save} disabled={saving}>
              {saving ? <i className="bi bi-arrow-repeat animate-spin" /> : <i className="bi bi-check-lg" />}
              Save
            </button>
          </>
        }
      >
        {form && (
          <div className="space-y-4">
            <div>
              <label className="label">Name</label>
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. openai-official" />
            </div>
            <div>
              <label className="label">Type</label>
              <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as ProviderType })}>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="openai_compatible">OpenAI-compatible</option>
                <option value="openai_responses">OpenAI Responses (/v1/responses)</option>
              </select>
            </div>
            <div>
              <label className="label">Base URL</label>
              <input className="input font-mono text-xs" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder={form.type === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"} />
              <p className="mt-1 text-xs text-ink-500">
                {form.type === "anthropic"
                  ? "Host root; /v1/messages is appended."
                  : form.type === "openai_responses"
                    ? "The /v1-style base; /responses is appended."
                    : "The /v1-style base; /chat/completions is appended."}
              </p>
            </div>
            <div>
              <label className="label">API key {form.id && <span className="normal-case text-ink-500">(leave blank to keep current)</span>}</label>
              <input className="input font-mono text-xs" type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-..." />
            </div>
            <div>
              <label className="label">Extra headers (JSON, optional)</label>
              <textarea className="input font-mono text-xs" rows={3} value={form.extraHeaders} onChange={(e) => setForm({ ...form, extraHeaders: e.target.value })} placeholder='{"x-custom": "value"}' />
            </div>
            <Toggle checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="Enabled" />
          </div>
        )}
      </Modal>
      {confirmEl}
    </div>
  );
}

function AllowlistCard() {
  const toast = useToast();
  const { data, reload } = useAsync(() => api.get<{ entries: string[] }>("/settings/upstream-allowlist"));
  const [entry, setEntry] = useState("");
  const [saving, setSaving] = useState(false);
  const entries = data?.entries ?? [];

  const put = async (next: string[]) => {
    setSaving(true);
    try {
      await api.put("/settings/upstream-allowlist", { entries: next });
      reload();
      toast.success("Allowlist updated");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const add = () => {
    const v = entry.trim();
    if (!v || entries.includes(v)) {
      setEntry("");
      return;
    }
    void put([...entries, v]).then(() => setEntry(""));
  };

  return (
    <div className="card card-pad mt-6">
      <div className="mb-1 flex items-center gap-2">
        <i className="bi bi-shield-lock text-brand-400" />
        <h3 className="font-medium text-ink-100">Trusted private upstreams</h3>
      </div>
      <p className="mb-3 text-xs text-ink-500">
        Provider URLs resolving to private/loopback/LAN addresses are blocked by default. Add a trusted IP, CIDR, or
        hostname to permit it — e.g. <code className="text-ink-300">10.0.0.5</code>,{" "}
        <code className="text-ink-300">192.168.0.0/16</code>, <code className="text-ink-300">models.lan</code>.
      </p>
      <div className="mb-3 flex flex-wrap gap-2">
        {entries.length === 0 && <span className="text-xs text-ink-600">No entries — all private hosts blocked.</span>}
        {entries.map((e) => (
          <span key={e} className="inline-flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1 font-mono text-xs text-ink-200">
            {e}
            <button className="text-ink-500 hover:text-red-400" title="Remove" disabled={saving} onClick={() => void put(entries.filter((x) => x !== e))}>
              <i className="bi bi-x-lg" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          className="input font-mono text-xs"
          value={entry}
          onChange={(e) => setEntry(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="IP, CIDR, or hostname"
        />
        <button className="btn-ghost btn-xs whitespace-nowrap" onClick={add} disabled={saving}>
          <i className="bi bi-plus-lg" />
          Add
        </button>
      </div>
    </div>
  );
}
