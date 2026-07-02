import { useState } from "react";
import { api, ApiError } from "../api";
import { useAsync } from "../lib/hooks";
import { PageHeader } from "../components/Layout";
import { EmptyState, ErrorNote, Spinner, useConfirm } from "../components/common";
import { MubEditor } from "../components/MubEditor";
import { useToast } from "../components/Toast";
import type { Mapping, Model, Mub, MubSteps, Provider } from "../types";
import { isChainDef } from "../types";

interface Data {
  mubs: Mub[];
  models: Model[];
  providers: Provider[];
  mappings: Mapping[];
}

export function Mubs() {
  const { data, loading, error, reload } = useAsync<Data>(async () => {
    const [mubs, models, providers, mappings] = await Promise.all([
      api.get<{ mubs: Mub[] }>("/mubs"),
      api.get<{ models: Model[] }>("/models"),
      api.get<{ providers: Provider[] }>("/providers"),
      api.get<{ mappings: Mapping[] }>("/mappings"),
    ]);
    return { mubs: mubs.mubs, models: models.models, providers: providers.providers, mappings: mappings.mappings };
  });
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const [editing, setEditing] = useState<Mub | null>(null);
  const [creating, setCreating] = useState(false);

  const canCreate = (data?.models.length ?? 0) > 0 && (data?.mappings.length ?? 0) > 0;

  const remove = async (m: Mub) => {
    if (!(await confirm("Delete MUB", `Delete "${m.name}"? Clients using this endpoint will start receiving 404s.`))) return;
    try {
      await api.del(`/mubs/${m.id}`);
      toast.success("MUB deleted");
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Delete failed");
    }
  };

  const startNew = () => {
    if (!canCreate) {
      toast.error("Create at least one model and provider mapping first");
      return;
    }
    setCreating(true);
  };

  return (
    <div>
      <PageHeader
        title="Model Use Behaviors"
        subtitle="The only endpoints exposed to clients. Each is a retry/fallback workflow over your catalog."
        icon="bi-diagram-3"
        action={
          <button className="btn-primary" onClick={startNew}>
            <i className="bi bi-plus-lg" />
            New MUB
          </button>
        }
      />
      {loading && <Spinner />}
      {error && <ErrorNote message={error} />}

      {data && data.mubs.length === 0 && (
        <EmptyState
          icon="bi-diagram-3"
          title="No Model Use Behaviors yet"
          hint={canCreate ? "Create a MUB to expose a resilient endpoint (e.g. sonnet-any: sonnet then fall back to gpt)." : "First add a provider, a model, and map them. Then build a MUB here."}
          action={canCreate ? <button className="btn-primary" onClick={startNew}><i className="bi bi-plus-lg" />New MUB</button> : undefined}
        />
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {data?.mubs.map((m) => (
          <div key={m.id} className="card card-pad">
            <div className="flex items-start justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <i className="bi bi-diagram-3 text-brand-400" />
                  <span className="truncate font-mono text-sm font-semibold text-ink-100">{m.name}</span>
                  {m.enabled ? <span className="badge-green">enabled</span> : <span className="badge-red">disabled</span>}
                </div>
                {m.description && <p className="mt-1 text-xs text-ink-400">{m.description}</p>}
              </div>
              <span className="badge-gray shrink-0">
                {isChainDef(m.steps)
                  ? `${m.steps.stages?.length ?? 0} stages`
                  : `${(m.steps as MubSteps)?.steps?.length ?? 0} steps`}
              </span>
            </div>

            <div className="mt-3 flex items-start gap-2 rounded-lg bg-ink-950/50 px-3 py-2 text-xs text-ink-300">
              <i className="bi bi-signpost-split mt-0.5 text-ink-500" />
              <span>{m.summary}</span>
            </div>

            <div className="mt-3 flex justify-end gap-1.5">
              <button className="btn-ghost btn-xs" onClick={() => setEditing(m)}>
                <i className="bi bi-pencil" />
                Edit
              </button>
              <button className="btn-danger btn-xs" onClick={() => remove(m)}>
                <i className="bi bi-trash3" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {data && (
        <MubEditor
          open={creating || editing !== null}
          mub={editing}
          models={data.models}
          providers={data.providers}
          mappings={data.mappings}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={reload}
        />
      )}
      {confirmEl}
    </div>
  );
}
