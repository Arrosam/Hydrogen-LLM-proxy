import { useState } from "react";
import { api, ApiError } from "../api";
import { useAsync } from "../lib/hooks";
import { PageHeader } from "../components/Layout";
import { EmptyState, ErrorNote, Spinner, Toggle, useConfirm } from "../components/common";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import type { Mapping, Model, Provider } from "../types";

interface Data {
  models: Model[];
  providers: Provider[];
  mappings: Mapping[];
}

export function Models() {
  const { data, loading, error, reload } = useAsync<Data>(async () => {
    const [m, p, map] = await Promise.all([
      api.get<{ models: Model[] }>("/models"),
      api.get<{ providers: Provider[] }>("/providers"),
      api.get<{ mappings: Mapping[] }>("/mappings"),
    ]);
    return { models: m.models, providers: p.providers, mappings: map.mappings };
  });
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();

  const [modelForm, setModelForm] = useState<{ id?: number; name: string; description: string; enabled: boolean } | null>(null);
  const [mapForm, setMapForm] = useState<{ modelId: number; providerId: number; upstreamModel: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const providerName = (id: number) => data?.providers.find((p) => p.id === id)?.name ?? `#${id}`;

  const saveModel = async () => {
    if (!modelForm) return;
    setSaving(true);
    try {
      const payload = { name: modelForm.name, description: modelForm.description || null, enabled: modelForm.enabled };
      if (modelForm.id) await api.patch(`/models/${modelForm.id}`, payload);
      else await api.post("/models", payload);
      toast.success(modelForm.id ? "Model updated" : "Model created");
      setModelForm(null);
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const removeModel = async (m: Model) => {
    if (!(await confirm("Delete model", `Delete "${m.name}" and its provider mappings?`))) return;
    try {
      await api.del(`/models/${m.id}`);
      toast.success("Model deleted");
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Delete failed");
    }
  };

  const saveMapping = async () => {
    if (!mapForm) return;
    setSaving(true);
    try {
      await api.post("/mappings", mapForm);
      toast.success("Provider mapped");
      setMapForm(null);
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Mapping failed");
    } finally {
      setSaving(false);
    }
  };

  const removeMapping = async (mp: Mapping) => {
    try {
      await api.del(`/mappings/${mp.id}`);
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed");
    }
  };

  const openNewMapping = (modelId: number) => {
    const firstProvider = data?.providers[0]?.id;
    if (!firstProvider) {
      toast.error("Create a provider first");
      return;
    }
    setMapForm({ modelId, providerId: firstProvider, upstreamModel: "" });
  };

  return (
    <div>
      <PageHeader
        title="Models"
        subtitle="Internal catalog. Each model is provided by one or more providers."
        icon="bi-box"
        action={
          <button className="btn-primary" onClick={() => setModelForm({ name: "", description: "", enabled: true })}>
            <i className="bi bi-plus-lg" />
            New model
          </button>
        }
      />
      {loading && <Spinner />}
      {error && <ErrorNote message={error} />}
      {data && data.models.length === 0 && (
        <EmptyState icon="bi-box" title="No models yet" hint="Define a model (e.g. sonnet4.6) then map it to the providers that serve it." />
      )}

      <div className="space-y-4">
        {data?.models.map((m) => {
          const maps = data.mappings.filter((x) => x.modelId === m.id);
          return (
            <div key={m.id} className="card card-pad">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-ink-100">{m.name}</span>
                    {m.enabled ? <span className="badge-green">enabled</span> : <span className="badge-red">disabled</span>}
                  </div>
                  {m.description && <p className="mt-0.5 text-sm text-ink-400">{m.description}</p>}
                </div>
                <div className="flex gap-1.5">
                  <button className="btn-ghost btn-xs" onClick={() => setModelForm({ id: m.id, name: m.name, description: m.description ?? "", enabled: m.enabled })}>
                    <i className="bi bi-pencil" />
                  </button>
                  <button className="btn-danger btn-xs" onClick={() => removeModel(m)}>
                    <i className="bi bi-trash3" />
                  </button>
                </div>
              </div>

              <div className="mt-3 border-t border-ink-800 pt-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">Providers</span>
                  <button className="btn-ghost btn-xs" onClick={() => openNewMapping(m.id)}>
                    <i className="bi bi-plus-lg" />
                    Map provider
                  </button>
                </div>
                {maps.length === 0 ? (
                  <p className="text-xs text-ink-500">Not mapped to any provider yet.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {maps.map((mp) => (
                      <span key={mp.id} className="inline-flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1 text-xs">
                        <i className="bi bi-hdd-network text-brand-400" />
                        <span className="text-ink-200">{providerName(mp.providerId)}</span>
                        <i className="bi bi-arrow-right text-ink-600" />
                        <span className="font-mono text-ink-400">{mp.upstreamModel}</span>
                        <button className="text-ink-600 hover:text-red-400" onClick={() => removeMapping(mp)}>
                          <i className="bi bi-x-lg" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <Modal
        open={modelForm !== null}
        title={modelForm?.id ? "Edit model" : "New model"}
        icon="bi-box"
        onClose={() => setModelForm(null)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setModelForm(null)}>Cancel</button>
            <button className="btn-primary" onClick={saveModel} disabled={saving}>
              <i className="bi bi-check-lg" />Save
            </button>
          </>
        }
      >
        {modelForm && (
          <div className="space-y-4">
            <div>
              <label className="label">Name</label>
              <input className="input" value={modelForm.name} onChange={(e) => setModelForm({ ...modelForm, name: e.target.value })} placeholder="e.g. sonnet4.6" />
            </div>
            <div>
              <label className="label">Description (optional)</label>
              <input className="input" value={modelForm.description} onChange={(e) => setModelForm({ ...modelForm, description: e.target.value })} />
            </div>
            <Toggle checked={modelForm.enabled} onChange={(v) => setModelForm({ ...modelForm, enabled: v })} label="Enabled" />
          </div>
        )}
      </Modal>

      <Modal
        open={mapForm !== null}
        title="Map provider"
        icon="bi-diagram-2"
        onClose={() => setMapForm(null)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setMapForm(null)}>Cancel</button>
            <button className="btn-primary" onClick={saveMapping} disabled={saving || !mapForm?.upstreamModel}>
              <i className="bi bi-check-lg" />Add
            </button>
          </>
        }
      >
        {mapForm && (
          <div className="space-y-4">
            <div>
              <label className="label">Provider</label>
              <select className="input" value={mapForm.providerId} onChange={(e) => setMapForm({ ...mapForm, providerId: Number(e.target.value) })}>
                {data?.providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} ({p.type})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Upstream model id</label>
              <input className="input font-mono text-xs" value={mapForm.upstreamModel} onChange={(e) => setMapForm({ ...mapForm, upstreamModel: e.target.value })} placeholder="e.g. gpt-4o or claude-sonnet-4-6" />
              <p className="mt-1 text-xs text-ink-500">The exact model id this provider expects on the wire.</p>
            </div>
          </div>
        )}
      </Modal>
      {confirmEl}
    </div>
  );
}
