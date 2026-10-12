import { api } from "../api";
import { useAction, useAsync, useAttempt } from "../lib/hooks";
import { nameById, setMember } from "../lib/collections";
import { useDeleteAction, useFormState, useSave } from "../lib/crud";
import { API } from "../lib/endpoints";
import { ACTION_ICON, ENTITY_ICON } from "../lib/icons";
import { fetchMappings, fetchModels, fetchProviderModels, fetchProviders, loadAll } from "../lib/resources";
import { EnabledBadge } from "../components/badges";
import { Button, Icon } from "../components/Button";
import { RemovableChip } from "../components/Chip";
import { EmptyState, Toggle, useConfirm } from "../components/common";
import { EntityCard, RowActions } from "../components/EntityCard";
import { Field, FieldHint } from "../components/Field";
import { FormModal } from "../components/FormModal";
import { CheckboxLabel, Select, TextInput } from "../components/inputs";
import { ModelList } from "../components/ModelList";
import { ResourcePage } from "../components/Page";
import { useToast } from "../components/Toast";
import { useI18n } from "../lib/i18n";
import type { Mapping, Model } from "../types";

interface ModelForm {
  id?: number;
  name: string;
  description: string;
  enabled: boolean;
}

interface MappingForm {
  /** Never set: a mapping is only ever created, not edited. */
  id?: undefined;
  modelId: number;
  providerId: number;
  upstreamModel: string;
  families: string[];
}

const EMPTY_MODEL: ModelForm = { name: "", description: "", enabled: true };

/** A provider needs at least this many wire families before the mapping form
 * offers a choice between them. */
const MIN_FAMILIES_FOR_CHOICE = 2;

export function Models() {
  const { t } = useI18n();
  const state = useAsync(() =>
    loadAll({ models: fetchModels, providers: fetchProviders, mappings: fetchMappings, providerModels: fetchProviderModels }),
  );
  const { data, reload } = state;
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const attempt = useAttempt();

  const modelFc = useFormState<ModelForm>();
  const mapFc = useFormState<MappingForm>();
  const modelForm = modelFc.form;
  const mapForm = mapFc.form;
  // One flag for both modals, as only one of them can be open.
  const action = useAction();

  const providerName = (id: number) => nameById(data?.providers, id);
  /** What the selected provider reported the last time it was tested. */
  const offeredBy = (id: number) => data?.providerModels.find((x) => x.providerId === id)?.models ?? [];

  const { save: saveModel, saving } = useSave(modelFc, {
    collection: API.models,
    member: API.model,
    toPayload: (f) => ({ name: f.name, description: f.description || null, enabled: f.enabled }),
    messages: (editing) => ({
      success: t(editing ? "models.toast.updated" : "models.toast.created"),
      failed: t("common.saveFailed"),
    }),
    onSaved: reload,
    action,
  });

  const del = useDeleteAction(confirm, reload);
  const removeModel = (m: Model) =>
    del({
      title: t("models.confirm.delete.title"),
      body: t("models.confirm.delete.body", { name: m.name }),
      path: API.model(m.id),
      success: t("models.toast.deleted"),
      fallback: t("models.toast.deleteFailed"),
    });

  const { save: saveMapping } = useSave(mapFc, {
    collection: API.mappings,
    toPayload: (f) => ({ ...f, families: f.families.length ? f.families : null }),
    messages: () => ({ success: t("models.toast.mappingCreated"), failed: t("models.toast.mappingFailed") }),
    onSaved: reload,
    action,
  });

  // Unlike a model, a mapping is removed on the spot: no confirm, no toast.
  const removeMapping = (mp: Mapping) =>
    attempt(async () => {
      await api.del(API.mapping(mp.id));
      reload();
    }, t("models.toast.mappingDeleteFailed"));

  const openNewMapping = (modelId: number) => {
    const firstProvider = data?.providers[0]?.id;
    if (!firstProvider) {
      toast.error(t("models.toast.createProviderFirst"));
      return;
    }
    mapFc.open({ modelId, providerId: firstProvider, upstreamModel: "", families: [] });
  };

  /** The wire families the mapping form's provider can speak, without repeats. */
  const familiesOf = (providerId: number): string[] => {
    const prov = data?.providers.find((p) => p.id === providerId);
    return prov ? [...new Set([prov.type, ...(prov.altEndpoints ?? []).map((e) => e.type)])] : [];
  };

  return (
    <ResourcePage
      title={t("models.title")}
      subtitle={t("models.subtitle")}
      icon={ENTITY_ICON.model}
      action={
        <Button variant="primary" icon={ACTION_ICON.add} onClick={() => modelFc.open({ ...EMPTY_MODEL })}>
          {t("models.action.new")}
        </Button>
      }
      state={state}
      isEmpty={(d) => d.models.length === 0}
      empty={<EmptyState icon={ENTITY_ICON.model} title={t("models.empty.title")} hint={t("models.empty.hint")} />}
    >
      <div className="space-y-4">
        {data?.models.map((m) => {
          const maps = data.mappings.filter((x) => x.modelId === m.id);
          return (
            <EntityCard
              key={m.id}
              title={m.name}
              badges={<EnabledBadge enabled={m.enabled} />}
              description={m.description}
              aside={
                <RowActions
                  onEdit={() => modelFc.open({ id: m.id, name: m.name, description: m.description ?? "", enabled: m.enabled })}
                  onDelete={() => removeModel(m)}
                />
              }
            >
              <div className="mt-3 border-t border-ink-800 pt-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">{t("models.section.providers")}</span>
                  <Button variant="ghost" size="xs" icon={ACTION_ICON.add} onClick={() => openNewMapping(m.id)}>
                    {t("models.action.mapProvider")}
                  </Button>
                </div>
                {maps.length === 0 ? (
                  <p className="text-xs text-ink-500">{t("models.mapping.empty")}</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {maps.map((mp) => (
                      <RemovableChip key={mp.id} onRemove={() => removeMapping(mp)}>
                        <Icon name={ENTITY_ICON.provider} className="text-brand-400" />
                        <span className="text-ink-200">{providerName(mp.providerId)}</span>
                        <Icon name="bi-arrow-right" className="text-ink-600" />
                        <span className="font-mono text-ink-400">{mp.upstreamModel}</span>
                      </RemovableChip>
                    ))}
                  </div>
                )}
              </div>
            </EntityCard>
          );
        })}
      </div>

      <FormModal
        open={modelForm !== null}
        title={modelForm?.id ? t("models.modal.edit.title") : t("models.modal.new.title")}
        icon={ENTITY_ICON.model}
        onClose={modelFc.close}
        onSubmit={saveModel}
        submitLabel={t("common.save")}
        busy={saving}
      >
        {modelForm && (
          <div className="space-y-4">
            <Field label={t("models.field.name.label")}>
              <TextInput {...modelFc.bind("name")} placeholder={t("models.field.name.placeholder")} />
            </Field>
            <Field label={t("models.field.description.label")}>
              <TextInput {...modelFc.bind("description")} />
            </Field>
            <Toggle checked={modelForm.enabled} onChange={(v) => modelFc.set("enabled", v)} label={t("models.field.enabled.label")} />
          </div>
        )}
      </FormModal>

      <FormModal
        open={mapForm !== null}
        size="lg"
        title={t("models.mappingModal.title")}
        icon={ENTITY_ICON.mapping}
        onClose={mapFc.close}
        onSubmit={saveMapping}
        submitLabel={t("common.add")}
        busy={saving}
        disabled={!mapForm?.upstreamModel}
      >
        {mapForm && (
          <div className="space-y-4">
            <Field label={t("models.mappingModal.field.provider.label")}>
              <Select
                value={mapForm.providerId}
                onChange={(providerId) => mapFc.set("providerId", providerId)}
                options={(data?.providers ?? []).map((p) => ({ value: p.id, label: `${p.name} (${p.type})` }))}
              />
            </Field>
            {familiesOf(mapForm.providerId).length >= MIN_FAMILIES_FOR_CHOICE && (
              <Field
                label={t("models.mappingModal.field.families.label")}
                hint={t("models.mappingModal.field.families.hint")}
                hintPosition="above"
              >
                <div className="flex flex-wrap gap-3">
                  {familiesOf(mapForm.providerId).map((f) => (
                    <CheckboxLabel
                      key={f}
                      size="xs"
                      checked={mapForm.families.includes(f)}
                      onChange={(on) => mapFc.set("families", setMember(mapForm.families, f, on))}
                    >
                      <code>{f}</code>
                    </CheckboxLabel>
                  ))}
                </div>
              </Field>
            )}
            <Field label={t("models.mappingModal.field.upstreamModel.label")}>
              <TextInput mono {...mapFc.bind("upstreamModel")} placeholder={t("models.mappingModal.field.upstreamModel.placeholder")} />
              <FieldHint>{t("models.mappingModal.field.upstreamModel.hint")}</FieldHint>
              {/* The field above doubles as the search box: type to narrow the
                  provider's own list, click to fill it in, or ignore the list
                  entirely and type an id it didn't report. */}
              <div className="mt-2 space-y-1.5">
                {offeredBy(mapForm.providerId).length > 0 && (
                  <div className="text-xs text-ink-500">
                    {t("models.mappingModal.picker.title", {
                      provider: providerName(mapForm.providerId),
                      count: offeredBy(mapForm.providerId).length,
                    })}
                  </div>
                )}
                <ModelList
                  models={offeredBy(mapForm.providerId)}
                  filter={mapForm.upstreamModel}
                  selected={mapForm.upstreamModel}
                  onPick={(m) => mapFc.set("upstreamModel", m)}
                  emptyText={t("models.mappingModal.picker.empty")}
                />
              </div>
            </Field>
          </div>
        )}
      </FormModal>
      {confirmEl}
    </ResourcePage>
  );
}
