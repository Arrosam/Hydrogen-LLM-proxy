import { useState } from "react";
import { api, ApiError } from "../api";
import { useAsync } from "../lib/hooks";
import { PageHeader } from "../components/Layout";
import { EmptyState, ErrorNote, Spinner, useConfirm } from "../components/common";
import { ServiceEditor } from "../components/ServiceEditor";
import { useToast } from "../components/Toast";
import { useI18n } from "../lib/i18n";
import type { Mapping, Model, ModelService, ServiceSteps, Provider } from "../types";
import { isAgentDef } from "../types";

interface Data {
  services: ModelService[];
  models: Model[];
  providers: Provider[];
  mappings: Mapping[];
}

type Kind = "resilience" | "chain";

export function ModelServices({ kind = "resilience" }: { kind?: Kind }) {
  const { t } = useI18n();
  const COPY: Record<Kind, { title: string; subtitle: string; icon: string; newLabel: string; emptyTitle: string; emptyHint: string }> = {
    resilience: {
      title: t("services.resilience.title"),
      subtitle: t("services.resilience.subtitle"),
      icon: "bi-diagram-3",
      newLabel: t("services.resilience.action.new"),
      emptyTitle: t("services.resilience.empty.title"),
      emptyHint: t("services.resilience.empty.hint"),
    },
    chain: {
      title: t("services.chain.title"),
      subtitle: t("services.chain.subtitle"),
      icon: "bi-robot",
      newLabel: t("services.chain.action.new"),
      emptyTitle: t("services.chain.empty.title"),
      emptyHint: t("services.chain.empty.hint"),
    },
  };
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
    if (!(await confirm(kind === "chain" ? t("services.chain.confirm.delete.title") : t("services.resilience.confirm.delete.title"), t("services.confirm.delete.body", { name: m.name })))) return;
    try {
      await api.del(`/services/${m.id}`);
      toast.success(t("services.toast.deleted"));
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("services.toast.deleteFailed"));
    }
  };

  const startNew = () => {
    if (!canCreate) {
      toast.error(
        kind === "chain"
          ? t("services.chain.toast.needServiceFirst")
          : t("services.resilience.toast.needMappingFirst"),
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
          hint={canCreate ? copy.emptyHint : kind === "chain" ? t("services.chain.empty.hintNoService") : t("services.resilience.empty.hintNoMapping")}
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
                  {m.enabled ? <span className="badge-green">{t("common.enabled")}</span> : <span className="badge-red">{t("common.disabled")}</span>}
                </div>
                {m.description && <p className="mt-1 text-xs text-ink-400">{m.description}</p>}
              </div>
              <span className="badge-gray shrink-0">
                {isAgentDef(m.steps)
                  ? t("services.chain.stagesCount", { count: m.steps.stages?.length ?? 0 })
                  : t("services.resilience.stepsCount", { count: (m.steps as ServiceSteps)?.steps?.length ?? 0 })}
              </span>
            </div>

            <div className="mt-3 flex items-start gap-2 rounded-lg bg-ink-950/50 px-3 py-2 text-xs text-ink-300">
              <i className="bi bi-signpost-split mt-0.5 text-ink-500" />
              <span>{m.summary}</span>
            </div>

            <div className="mt-3 flex justify-end gap-1.5">
              <button className="btn-ghost btn-xs" onClick={() => setEditing(m)}>
                <i className="bi bi-pencil" />
                {t("services.action.edit")}
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
