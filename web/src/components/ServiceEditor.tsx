import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useIsAdmin } from "../auth";
import { useFields } from "../lib/crud";
import { API } from "../lib/endpoints";
import { useAction } from "../lib/hooks";
import { useI18n } from "../lib/i18n";
import { ENTITY_ICON } from "../lib/icons";
import { formatJson, parseJsonObject } from "../lib/json";
import { fetchTools } from "../lib/resources";
import { MEDIA_ENDPOINTS, SERVICE_CATEGORIES, SERVICE_KIND, type ServiceKind } from "../lib/serviceDef";
import { EMPTY_SERVICE_FORM, attachmentMiBEdit, blankStep, defToForm, formToDef, isChatPipelineForm, newServiceForm, serviceToForm, type ServiceForm } from "../lib/serviceForm";
import { otherServices } from "../lib/services";
import type { HostedTool, Mapping, Model, ModelService, Provider, ServiceDef } from "../types";
import { THINKING_FORMATS, isAgentDef, isChatPipelineCategory, serviceCategoryOf } from "../types";
import { Button, Icon } from "./Button";
import { Toggle } from "./common";
import { Field, FieldHint } from "./Field";
import { FormModal } from "./FormModal";
import { HostedToolBinding } from "./HostedToolBinding";
import { Select, TextArea, TextInput } from "./inputs";
import { IntInput } from "./numeric";
import { AsrEditor, OcrEditor } from "./PrePassEditors";
import { StageEditor } from "./StageEditor";
import { StepList } from "./ServiceSteps";
import { useToast } from "./Toast";

/** The prompt a dry-run sends through the definition. */
const DRY_RUN_PROMPT = "ping";

interface Props {
  open: boolean;
  service: ModelService | null; // null = new
  services: ModelService[]; // all services (stages reference resilience services and other Micro Agents)
  models: Model[];
  providers: Provider[];
  mappings: Mapping[];
  defaultKind?: ServiceKind; // kind for a NEW service (fixed by the page)
  onClose: () => void;
  onSaved: () => void;
}

interface ValidateResponse { valid: boolean; summary?: string; error?: string }
interface DryRunResponse { ok: boolean; served?: { model: string; provider: string }; message?: string; output?: string }

export function ServiceEditor({ open, service, services, models, providers, mappings, defaultKind = SERVICE_KIND.resilience, onClose, onSaved }: Props) {
  const isAdmin = useIsAdmin();
  const toast = useToast();
  const { t } = useI18n();
  const form = useFields<ServiceForm>(EMPTY_SERVICE_FORM);
  const f = form.values;
  const [hostedTools, setHostedTools] = useState<HostedTool[]>([]);
  /** The raw-JSON view: while on, `rawText` is the definition and the form is not consulted. */
  const [raw, setRaw] = useState(false);
  const [rawText, setRawText] = useState("");
  const [summary, setSummary] = useState("");
  const action = useAction();

  const providersForModel = useMemo(() => {
    const providerNameById = new Map(providers.map((p) => [p.id, p.name]));
    const modelIdByName = new Map(models.map((m) => [m.name, m.id]));
    return (modelName: string): string[] => {
      const id = modelIdByName.get(modelName);
      if (id == null) return [];
      return mappings
        .filter((m) => m.modelId === id)
        .map((m) => providerNameById.get(m.providerId))
        .filter((n): n is string => Boolean(n));
    };
  }, [models, providers, mappings]);

  useEffect(() => {
    if (open && isAdmin) fetchTools().then(setHostedTools).catch(() => setHostedTools([]));
  }, [open, service, isAdmin]);

  useEffect(() => {
    if (!open) return;
    if (service) form.patch(serviceToForm(service));
    else {
      const model = models[0]?.name ?? "";
      const provider = providersForModel(model)[0] ?? "";
      form.patch(newServiceForm(defaultKind, defaultKind === SERVICE_KIND.resilience && model && provider ? blankStep(model, provider) : null));
    }
    setRaw(false);
    setSummary("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, service]);

  const isChain = f.kind === SERVICE_KIND.chain;
  const chatPipeline = isChatPipelineForm(f);
  const reliableStreamingOffered = !isChain && isChatPipelineCategory(f.category);
  const referable = useMemo(() => otherServices(services, service), [services, service]);

  /** The definition to send: the typed JSON verbatim in the raw view, else the form's. Null (and a toast) when the JSON does not parse. */
  const readDef = (): ServiceDef | null => {
    if (!raw) return formToDef(f);
    try {
      return JSON.parse(rawText || "{}") as ServiceDef;
    } catch {
      toast.error(t("serviceEditor.toast.stepsJsonInvalid"));
      return null;
    }
  };

  const validate = async () => {
    const steps = readDef();
    if (!steps) return;
    await action.run(async () => {
      const r = await api.post<ValidateResponse>(API.servicesValidate, { steps });
      setSummary(r.valid ? (r.summary ?? "") : "");
      if (r.valid) toast.success(t("serviceEditor.toast.workflowValid"));
      else toast.error(r.error ?? t("serviceEditor.toast.workflowInvalid"));
    }, t("serviceEditor.toast.validateFailed"));
  };

  const dryRun = async () => {
    const steps = readDef();
    if (!steps) return;
    await action.run(async () => {
      const r = await api.post<DryRunResponse>(API.servicesTest, { steps, prompt: DRY_RUN_PROMPT });
      if (r.ok) toast.success(t("serviceEditor.toast.servedBy", { model: r.served?.model ?? "", provider: r.served?.provider ?? "", output: r.output ?? "" }));
      else toast.error(t("serviceEditor.toast.dryRunFailedWithMessage", { message: r.message ?? "" }));
    }, t("serviceEditor.toast.dryRunFailed"));
  };

  const save = async () => {
    const steps = readDef();
    if (!steps) return;
    if (!f.name.trim()) {
      toast.error(t("serviceEditor.toast.nameRequired"));
      return;
    }
    await action.run(async () => {
      // Tools can only be bound to what runs the chat pipeline; anything else is saved unbound.
      // Judged by the definition being sent, which in the raw view is not the form's.
      const bindable = isChatPipelineCategory(serviceCategoryOf(steps));
      const payload = { name: f.name, description: f.description || null, steps, enabled: f.enabled, ...(isAdmin ? { toolIds: bindable ? f.toolIds : [] } : {}) };
      if (service) await api.patch(API.service(service.id), payload);
      else await api.post(API.services, payload);
      const kindLabel = isAgentDef(steps) ? t("common.microAgent") : t("common.modelService");
      const verb = service ? t("common.updated") : t("common.created");
      toast.success(t("serviceEditor.toast.serviceSaved", { kindLabel, action: verb }));
      onSaved();
      onClose();
    }, t("serviceEditor.toast.saveFailed"));
  };

  /**
   * Entering the raw view prints the form's definition. Leaving it loads the
   * typed JSON back over the form: only what the definition determines (see
   * `defToForm`), so name, description, enabled and the bound tools stay.
   * Text that is not a JSON object cannot be loaded: it toasts and the raw
   * view stays open with the text as typed, rather than discarding it.
   */
  const toggleRaw = () => {
    if (!raw) setRawText(formatJson(formToDef(f)));
    else {
      const def = parseJsonObject(rawText);
      if (!def) {
        toast.error(t("serviceEditor.toast.stepsJsonInvalid"));
        return;
      }
      form.patch(defToForm(def as unknown as ServiceDef));
    }
    setRaw(!raw);
  };

  return (
    <FormModal
      open={open}
      size="xl"
      title={service ? t("serviceEditor.editTitle", { name: service.name }) : isChain ? t("serviceEditor.newMicroAgentTitle") : t("serviceEditor.newModelServiceTitle")}
      icon={isChain ? ENTITY_ICON.microAgent : ENTITY_ICON.service}
      onClose={onClose}
      onSubmit={save}
      submitLabel={t("common.save")}
      busy={action.busy}
      footerLead={
        <>
          <Button variant="ghost" icon="bi-code-slash" onClick={toggleRaw}>
            {raw ? t("serviceEditor.visualEditor") : t("serviceEditor.rawJson")}
          </Button>
          <Button variant="ghost" icon="bi-check2-circle" busy={action.busy} onClick={validate}>
            {t("serviceEditor.validate")}
          </Button>
          <Button variant="ghost" icon="bi-play-circle" busy={action.busy} onClick={dryRun}>
            {t("serviceEditor.dryRun")}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-4">
          <Field label={t("serviceEditor.nameLabel")}>
            <TextInput {...form.bind("name")} placeholder={t("serviceEditor.namePlaceholder")} />
          </Field>
          <Field label={t("serviceEditor.timeoutLabel")}>
            <IntInput value={f.timeoutMs} fallback={0} onChange={(v) => form.set("timeoutMs", v)} />
          </Field>
        </div>
        <Field label={t("serviceEditor.descriptionLabel")}>
          <TextInput {...form.bind("description")} />
        </Field>
        {!isChain && (
          <Field label={t("serviceEditor.categoryLabel")}>
            <Select
              className="w-auto"
              value={f.category}
              onChange={(v) => form.set("category", v)}
              options={SERVICE_CATEGORIES.map((c) => ({ value: c, label: t(`serviceEditor.category.${c}`) }))}
            />
            {f.category === "ocr" && <FieldHint tone="faint">{t("serviceEditor.categoryHintOcr")}</FieldHint>}
            {f.category !== "chat" && f.category !== "ocr" && (
              <FieldHint tone="faint">{t("serviceEditor.categoryHint", { endpoint: MEDIA_ENDPOINTS[f.category] })}</FieldHint>
            )}
          </Field>
        )}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Toggle checked={f.enabled} onChange={(v) => form.set("enabled", v)} label={t("serviceEditor.enabled")} />
          {reliableStreamingOffered && (
            <Toggle checked={f.reliableStreaming} onChange={(v) => form.set("reliableStreaming", v)} label={t("serviceEditor.reliableStreaming")} />
          )}
        </div>
        {isAdmin && !raw && chatPipeline && (
          <HostedToolBinding tools={hostedTools} ids={f.toolIds} config={f.toolConfig} onIds={(v) => form.set("toolIds", v)} onConfig={(v) => form.set("toolConfig", v)} />
        )}
        {reliableStreamingOffered && f.reliableStreaming && (
          <p className="-mt-2 text-xs text-ink-500">{t("serviceEditor.reliableStreamingDescription")}</p>
        )}

        {chatPipeline && (
          <Field label={t("serviceEditor.thinkingFormat")}>
            <Select
              className="w-auto"
              value={f.thinkingFormat}
              onChange={(v) => form.set("thinkingFormat", v)}
              options={THINKING_FORMATS.map((v) => ({ value: v, label: t(`serviceEditor.thinkingFormat.${v}`) }))}
            />
            <FieldHint>{t(`serviceEditor.thinkingFormatHint.${f.thinkingFormat}`)}</FieldHint>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Field label={t("serviceEditor.thinkingOpen")}>
                <TextInput {...form.bind("thinkingOpen")} placeholder={t("serviceEditor.thinkingOpenPlaceholder")} />
              </Field>
              <Field label={t("serviceEditor.thinkingClose")}>
                <TextInput {...form.bind("thinkingClose")} placeholder={t("serviceEditor.thinkingClosePlaceholder")} />
              </Field>
            </div>
            <FieldHint>{t("serviceEditor.thinkingDelimitersHint")}</FieldHint>
          </Field>
        )}

        {!raw && chatPipeline && (
          <Field label={t("serviceEditor.maxAttachmentLabel")} hint={t("serviceEditor.maxAttachmentHint")}>
            <IntInput value={f.maxAttachmentMiB} fallback={0} onChange={(v) => form.patch(attachmentMiBEdit(v))} />
          </Field>
        )}

        {!raw && <p className="text-xs text-ink-500">{isChain ? t("serviceEditor.microAgentDescription") : t("serviceEditor.modelServiceDescription")}</p>}

        {summary && (
          <div className="flex items-start gap-2 rounded-lg border border-brand-700/40 bg-brand-700/10 px-3 py-2 text-sm text-brand-400">
            <Icon name="bi-signpost-split" className="mt-0.5" />
            <span className="text-ink-200">{summary}</span>
          </div>
        )}

        {raw ? (
          <Field label={isChain ? t("serviceEditor.chainJsonLabel") : t("serviceEditor.stepsJsonLabel")}>
            <TextArea mono className="min-h-[320px]" value={rawText} onChange={(e) => setRawText(e.target.value)} />
          </Field>
        ) : isChain ? (
          <div className="space-y-4">
            <OcrEditor ocr={f.ocr} onChange={(v) => form.set("ocr", v)} services={referable} />
            <AsrEditor asr={f.asr} onChange={(v) => form.set("asr", v)} services={referable} />
            <StageEditor stages={f.stages} output={f.output} onChange={(stages, output) => form.patch({ stages, output })} services={referable} />
          </div>
        ) : (
          <StepList steps={f.steps} onChange={(v) => form.set("steps", v)} models={models} providersForModel={providersForModel} />
        )}
      </div>
    </FormModal>
  );
}
