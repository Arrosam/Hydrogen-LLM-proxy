import { useState } from "react";
import { api, ApiError } from "../api";
import { useAsync } from "../lib/hooks";
import { PageHeader } from "../components/Layout";
import { EmptyState, ErrorNote, Spinner, useConfirm } from "../components/common";
import { ServiceEditor } from "../components/ServiceEditor";
import { useToast } from "../components/Toast";
import type { Mapping, Model, ModelService, ServiceSteps, Provider } from "../types";
import { isAgentDef } from "../types";

interface Data {
  services: ModelService[];
  models: Model[];
  providers: Provider[];
  mappings: Mapping[];
}

type Kind = "resilience" | "chain";

const COPY: Record<Kind, { title: string; subtitle: string; icon: string; newLabel: string; emptyTitle: string; emptyHint: string }> = {
  resilience: {
    title: "Model Services",
    subtitle: "How this proxy serves a model to clients: try a chain of (model, provider) attempts until one succeeds.",
    icon: "bi-diagram-3",
    newLabel: "New Model Service",
    emptyTitle: "No Model Services yet",
    emptyHint: "Create a Model Service to expose a resilient endpoint (e.g. sonnet-any: sonnet then fall back to gpt).",
  },
  chain: {
    title: "Micro Agents",
    subtitle: "Composable pipelines -?routing, evaluation, image OCR, nested agents -?built on your Model Services.",
    icon: "bi-robot",
    newLabel: "New Micro Agent",
    emptyTitle: "No Micro Agents yet",
    emptyHint: "Build a Micro Agent: stages that each run a Model Service (or another Micro Agent), routed by conditions.",
  },
};

export function ModelServices({ kind = "resilience" }: { kind?: Kind }) {
  const { data, loading, error, reload } = useAsync<Data>(async () => {
    const [services, models, providers, mappings] = await Promise.all([
      api.get<{ services: ModelService[] }>("/services"),
      api.get<{ models: Model[] }>("/models"),
      api.get<{ providers: Provider[] }>("/providers"),
      api.get<{ mappings: Mapping[] }>("/mappings"),
    ]);
    return { services: services.services, models: models.models, providers: providers.providers, mappings: mappings.mappings };
  });
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const [editing, setEditing] = useState<ModelService | null>(null);
  const [creating, setCreating] = useState(false);

  const copy = COPY[kind];
  const isKind = (m: ModelService) => (kind === "chain" ? isAgentDef(m.steps) : !isAgentDef(m.steps));
  const visible = data?.services.filter(isKind) ?? [];
  // A Micro Agent needs at least one Model Service to run; a Model Service needs a mapping.
  const canCreate =
    kind === "chain"
      ? (data?.services.some((m) => !isAgentDef(m.steps)) ?? false)
      : (data?.models.length ?? 0) > 0 && (data?.mappings.length ?? 0) > 0;

  const remove = async (m: ModelService) => {
    if (!(await confirm(`Delete ${copy.newLabel.replace("New ", "")}`, `Delete "${m.name}"? Clients using this endpoint will start receiving 404s.`))) return;
    try {
      await api.del(`/services/${m.id}`);
      toast.success("Deleted");
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Delete failed");
    }
  };

  const startNew = () => {
    if (!canCreate) {
      toast.error(
        kind === "chain"
          ? "Create at least one Model Service first -?Micro Agent stages run them."
          : "Create at least one model and provider mapping first",
      );
      return;
    }
    setCreating(true);
  };

  return (
    <div>
      <PageHeader
        title={copy.title}
        subtitle={copy.subtitle}
        icon={copy.icon}
        action={
          <button className="btn-primary" onClick={startNew}>
            <i className="bi bi-plus-lg" />
            {copy.newLabel}
          </button>
        }
      />
      {loading && <Spinner />}
      {error && <ErrorNote message={error} />}

      {data && visible.length === 0 && (
        <EmptyState
          icon={copy.icon}
          title={copy.emptyTitle}
          hint={canCreate ? copy.emptyHint : kind === "chain" ? "First create a Model Service. Then compose Micro Agents here." : "First add a provider, a model, and map them. Then build a Model Service here."}
          action={canCreate ? <button className="btn-primary" onClick={startNew}><i className="bi bi-plus-lg" />{copy.newLabel}</button> : undefined}
        />
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {visible.map((m) => (
          <div key={m.id} className="card card-pad">
            <div className="flex items-start justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <i className={`bi ${copy.icon} text-brand-400`} />
                  <span className="truncate font-mono text-sm font-semibold text-ink-100">{m.name}</span>
                  {m.enabled ? <span className="badge-green">enabled</span> : <span className="badge-red">disabled</span>}
                </div>
                {m.description && <p className="mt-1 text-xs text-ink-400">{m.description}</p>}
              </div>
              <span className="badge-gray shrink-0">
                {isAgentDef(m.steps)
                  ? `${m.steps.stages?.length ?? 0} stages`
                  : `${(m.steps as ServiceSteps)?.steps?.length ?? 0} steps`}
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
        <ServiceEditor
          open={creating || editing !== null}
          service={editing}
          services={data.services}
          models={data.models}
          providers={data.providers}
          mappings={data.mappings}
          defaultKind={kind}
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
