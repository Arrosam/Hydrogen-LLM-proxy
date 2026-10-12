import { useState } from "react";
import { useAsync } from "../lib/hooks";
import { useDeleteAction } from "../lib/crud";
import { API } from "../lib/endpoints";
import { ACTION_ICON, ENTITY_ICON } from "../lib/icons";
import { fetchMappings, fetchModels, fetchProviders, fetchServices, loadAll } from "../lib/resources";
import { DEFAULT_CATEGORY, SERVICE_KIND, type ServiceKind } from "../lib/serviceDef";
import { EnabledBadge } from "../components/badges";
import { Button } from "../components/Button";
import { EmptyState, useConfirm } from "../components/common";
import { EntityCard, RowActions } from "../components/EntityCard";
import { ResourcePage } from "../components/Page";
import { ServiceEditor } from "../components/ServiceEditor";
import { useToast } from "../components/Toast";
import { useI18n } from "../lib/i18n";
import type { ModelService, ServiceSteps } from "../types";
import { isAgentDef, serviceCategoryOf } from "../types";

/** Per kind: the entity's icon and the i18n keys of everything the page says about it. */
const KIND_COPY: Record<
  ServiceKind,
  {
    icon: string;
    title: string;
    subtitle: string;
    newLabel: string;
    emptyTitle: string;
    emptyHint: string;
    /** Empty-state hint while nothing can be created yet. */
    emptyHintBlocked: string;
    /** Toast when "new" is pressed before its prerequisite exists. */
    prerequisiteMissing: string;
    deleteTitle: string;
  }
> = {
  resilience: {
    icon: ENTITY_ICON.service,
    title: "services.resilience.title",
    subtitle: "services.resilience.subtitle",
    newLabel: "services.resilience.action.new",
    emptyTitle: "services.resilience.empty.title",
    emptyHint: "services.resilience.empty.hint",
    emptyHintBlocked: "services.resilience.empty.hintNoMapping",
    prerequisiteMissing: "services.resilience.toast.needMappingFirst",
    deleteTitle: "services.resilience.confirm.delete.title",
  },
  chain: {
    icon: ENTITY_ICON.microAgent,
    title: "services.chain.title",
    subtitle: "services.chain.subtitle",
    newLabel: "services.chain.action.new",
    emptyTitle: "services.chain.empty.title",
    emptyHint: "services.chain.empty.hint",
    emptyHintBlocked: "services.chain.empty.hintNoService",
    prerequisiteMissing: "services.chain.toast.needServiceFirst",
    deleteTitle: "services.chain.confirm.delete.title",
  },
};

export function ModelServices({ kind = SERVICE_KIND.resilience }: { kind?: ServiceKind }) {
  const { t } = useI18n();
  const state = useAsync(() =>
    loadAll({ services: fetchServices, models: fetchModels, providers: fetchProviders, mappings: fetchMappings }),
  );
  const { data, reload } = state;
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const [editing, setEditing] = useState<ModelService | null>(null);
  const [creating, setCreating] = useState(false);

  const copy = KIND_COPY[kind];
  const isChain = kind === SERVICE_KIND.chain;
  const isKind = (m: ModelService) => (isChain ? isAgentDef(m.steps) : !isAgentDef(m.steps));
  const visible = data?.services.filter(isKind) ?? [];
  // A Micro Agent needs at least one Model Service to run; a Model Service needs a mapping.
  const canCreate = isChain
    ? (data?.services.some((m) => !isAgentDef(m.steps)) ?? false)
    : (data?.models.length ?? 0) > 0 && (data?.mappings.length ?? 0) > 0;

  const del = useDeleteAction(confirm, reload);
  const remove = (m: ModelService) =>
    del({
      title: t(copy.deleteTitle),
      body: t("services.confirm.delete.body", { name: m.name }),
      path: API.service(m.id),
      success: t("services.toast.deleted"),
      fallback: t("services.toast.deleteFailed"),
    });

  const startNew = () => {
    if (!canCreate) {
      toast.error(t(copy.prerequisiteMissing));
      return;
    }
    setCreating(true);
  };

  const newButton = (
    <Button variant="primary" icon={ACTION_ICON.add} onClick={startNew}>
      {t(copy.newLabel)}
    </Button>
  );

  return (
    <ResourcePage
      title={t(copy.title)}
      subtitle={t(copy.subtitle)}
      icon={copy.icon}
      action={newButton}
      state={state}
      isEmpty={() => visible.length === 0}
      empty={
        <EmptyState
          icon={copy.icon}
          title={t(copy.emptyTitle)}
          hint={t(canCreate ? copy.emptyHint : copy.emptyHintBlocked)}
          action={canCreate ? newButton : undefined}
        />
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        {visible.map((m) => {
          const category = serviceCategoryOf(m.steps);
          return (
            <EntityCard
              key={m.id}
              icon={copy.icon}
              title={m.name}
              titleStyle="mono"
              badges={
                <>
                  <EnabledBadge enabled={m.enabled} />
                  {category !== DEFAULT_CATEGORY && <span className="badge-blue">{t(`serviceEditor.category.${category}`)}</span>}
                </>
              }
              description={m.description}
              descriptionSize="xs"
              shrinkText
              aside={
                <span className="badge-gray shrink-0">
                  {isAgentDef(m.steps)
                    ? t("services.chain.stagesCount", { count: m.steps.stages?.length ?? 0 })
                    : t("services.resilience.stepsCount", { count: (m.steps as ServiceSteps)?.steps?.length ?? 0 })}
                </span>
              }
            >
              <div className="mt-3 flex items-start gap-2 rounded-lg bg-ink-950/50 px-3 py-2 text-xs text-ink-300">
                <i className="bi bi-signpost-split mt-0.5 text-ink-500" />
                <span>{m.summary}</span>
              </div>

              <RowActions
                className="mt-3 justify-end"
                onEdit={() => setEditing(m)}
                editLabel={t("services.action.edit")}
                onDelete={() => remove(m)}
              />
            </EntityCard>
          );
        })}
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
    </ResourcePage>
  );
}
