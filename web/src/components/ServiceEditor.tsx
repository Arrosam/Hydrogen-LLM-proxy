import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { Modal } from "./Modal";
import { Toggle } from "./common";
import { useToast } from "./Toast";
import { OcrEditor, StageEditor } from "./StageEditor";
import { OverridesEditor } from "./OverridesEditor";
import { useI18n } from "../lib/i18n";
import { intInput, selectAll } from "../lib/input";
import type {
  AdvanceTrigger,
  AgentDef,
  AgentOcr,
  AgentStage,
  Mapping,
  Model,
  ModelService,
  ServiceDef,
  ServiceStep,
  ServiceSteps,
  Provider,
  Trigger,
} from "../types";
import { isAgentDef } from "../types";

const CODE_PRESETS: Trigger[] = [429, 499, 500, 502, 503, 529];

interface Props {
  open: boolean;
  service: ModelService | null; // null = new
  services: ModelService[]; // all services (stages reference resilience services and other Micro Agents)
  models: Model[];
  providers: Provider[];
  mappings: Mapping[];
  defaultKind?: "resilience" | "chain"; // kind for a NEW service (fixed by the page)
  onClose: () => void;
  onSaved: () => void;
}

function blankStep(model: string, provider: string): ServiceStep {
  return { model, provider, retry: { on: [], maxAttempts: 1, intervalMs: 0 } };
}

function toggle<T>(arr: T[] | undefined, val: T): T[] {
  const a = arr ?? [];
  return a.includes(val) ? a.filter((x) => x !== val) : [...a, val];
}

export function ServiceEditor({ open, service, services, models, providers, mappings, defaultKind = "resilience", onClose, onSaved }: Props) {
  const toast = useToast();
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [timeoutMs, setTimeoutMs] = useState(60000);
  const [steps, setSteps] = useState<ServiceStep[]>([]);
  const [kind, setKind] = useState<"resilience" | "chain">("resilience");
  const [stages, setStages] = useState<AgentStage[]>([]);
  const [output, setOutput] = useState("");
  const [ocr, setOcr] = useState<AgentOcr | undefined>(undefined);
  const [reliableStreaming, setReliableStreaming] = useState(false);
  const [raw, setRaw] = useState(false);
  const [rawText, setRawText] = useState("");
  const [summary, setSummary] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const providerNameById = useMemo(() => new Map(providers.map((p) => [p.id, p.name])), [providers]);
  const modelIdByName = useMemo(() => new Map(models.map((m) => [m.name, m.id])), [models]);

  const providersForModel = (modelName: string): string[] => {
    const id = modelIdByName.get(modelName);
    if (id == null) return [];
    return mappings
      .filter((m) => m.modelId === id)
      .map((m) => providerNameById.get(m.providerId))
      .filter((n): n is string => Boolean(n));
  };

  useEffect(() => {
    if (!open) return;
    if (service) {
      setName(service.name);
      setDescription(service.description ?? "");
      setEnabled(service.enabled);
      setTimeoutMs(service.steps?.timeoutMs ?? 60000);
      if (isAgentDef(service.steps)) {
        setKind("chain");
        setStages((service.steps.stages ?? []).map((s) => {
          if (s.thinking === undefined) return s;
          const { thinking, ...rest } = s;
          return { ...rest, overrides: { ...(rest.overrides ?? {}), thinking } };
        }));
        setOutput(service.steps.output ?? "");
        setOcr(service.steps.ocr);
        setSteps([]);
        setReliableStreaming(false);
      } else {
        setKind("resilience");
        setSteps((service.steps as ServiceSteps)?.steps.map((s) => {
          if (s.thinking === undefined) return s;
          const { thinking, ...rest } = s;
          return { ...rest, overrides: { ...(rest.overrides ?? {}), thinking } };
        }) ?? []);
        setStages([]);
        setOutput("");
        setOcr(undefined);
        setReliableStreaming(Boolean(service.steps?.reliableStreaming));
      }
    } else {
      const firstModel = models[0]?.name ?? "";
      const firstProvider = providersForModel(firstModel)[0] ?? "";
      setName("");
      setDescription("");
      setEnabled(true);
      setTimeoutMs(60000);
      setKind(defaultKind);
      setSteps(defaultKind === "resilience" && firstModel && firstProvider ? [blankStep(firstModel, firstProvider)] : []);
      setStages([]);
      setOutput("");
      setOcr(undefined);
      setReliableStreaming(false);
    }
    setRaw(false);
    setSummary("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, service]);

  const buildDef = (): ServiceDef =>
    kind === "chain"
      ? ({ kind: "agent", timeoutMs, stages, ...(output ? { output } : {}), ...(ocr ? { ocr } : {}) } as AgentDef)
      : ({ timeoutMs, steps, ...(reliableStreaming ? { reliableStreaming: true } : {}) } as ServiceSteps);

  const patchStep = (i: number, patch: Partial<ServiceStep>) =>
    setSteps((s) => s.map((st, idx) => (idx === i ? { ...st, ...patch } : st)));

  const patchRetry = (i: number, patch: Partial<NonNullable<ServiceStep["retry"]>>) =>
    setSteps((s) =>
      s.map((st, idx) =>
        idx === i ? { ...st, retry: { on: [], maxAttempts: 1, intervalMs: 0, ...st.retry, ...patch } } : st,
      ),
    );

  const addStep = () => {
    const model = models[0]?.name ?? "";
    const provider = providersForModel(model)[0] ?? "";
    setSteps((s) => [...s, blankStep(model, provider)]);
  };

  const duplicateStep = (i: number) => {
    setSteps((s) => {
      const copy = JSON.parse(JSON.stringify(s[i])) as ServiceStep;
      const alt = providersForModel(copy.model).filter((p) => p !== copy.provider);
      if (alt[0]) copy.provider = alt[0]; // shortcut for provider-fallback
      return [...s.slice(0, i + 1), copy, ...s.slice(i + 1)];
    });
  };

  const removeStep = (i: number) => setSteps((s) => s.filter((_, idx) => idx !== i));

  const onDrop = (i: number) => {
    if (dragIndex === null || dragIndex === i) return;
    setSteps((s) => {
      const next = [...s];
      const [moved] = next.splice(dragIndex, 1);
      next.splice(i, 0, moved);
      return next;
    });
    setDragIndex(null);
  };

  const syncFromRaw = (): ServiceDef | null => {
    try {
      const parsed = JSON.parse(rawText) as ServiceDef;
      setTimeoutMs(parsed.timeoutMs ?? 60000);
      if (isAgentDef(parsed)) {
        setKind("chain");
        setStages(parsed.stages ?? []);
        setOutput(parsed.output ?? "");
        setOcr(parsed.ocr);
        setReliableStreaming(false);
      } else {
        setKind("resilience");
        setSteps((parsed as ServiceSteps).steps ?? []);
        setReliableStreaming(Boolean(parsed.reliableStreaming));
      }
      return parsed;
    } catch {
      toast.error(t("serviceEditor.toast.stepsJsonInvalid"));
      return null;
    }
  };

  const currentDef = (): ServiceDef => (raw ? (JSON.parse(rawText || "{}") as ServiceDef) : buildDef());

  const validate = async () => {
    let s: ServiceDef;
    try {
      s = currentDef();
    } catch {
      toast.error(t("serviceEditor.toast.stepsJsonInvalid"));
      return;
    }
    const r = await api.post<{ valid: boolean; summary?: string; error?: string }>("/services/validate", { steps: s });
    if (r.valid) {
      setSummary(r.summary ?? "");
      toast.success(t("serviceEditor.toast.workflowValid"));
    } else {
      setSummary("");
      toast.error(r.error ?? t("serviceEditor.toast.workflowInvalid"));
    }
  };

  const dryRun = async () => {
    let s: ServiceDef;
    try {
      s = currentDef();
    } catch {
      toast.error(t("serviceEditor.toast.stepsJsonInvalid"));
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; served?: { model: string; provider: string }; message?: string; output?: string }>(
        "/services/test",
        { steps: s, prompt: "ping" },
      );
      if (r.ok) toast.success(t("serviceEditor.toast.servedBy", { model: r.served?.model ?? "", provider: r.served?.provider ?? "", output: r.output ?? "" }));
      else toast.error(t("serviceEditor.toast.dryRunFailedWithMessage", { message: r.message ?? "" }));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("serviceEditor.toast.dryRunFailed"));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    let s: ServiceDef;
    try {
      s = currentDef();
    } catch {
      toast.error(t("serviceEditor.toast.stepsJsonInvalid"));
      return;
    }
    if (!name.trim()) {
      toast.error(t("serviceEditor.toast.nameRequired"));
      return;
    }
    setBusy(true);
    try {
      const payload = { name, description: description || null, steps: s, enabled };
      if (service) await api.patch(`/services/${service.id}`, payload);
      else await api.post("/services", payload);
      const kindLabel = kind === "chain" ? t("common.microAgent") : t("common.modelService");
      const action = service ? t("common.updated") : t("common.created");
      toast.success(t("serviceEditor.toast.serviceSaved", { kindLabel, action }));
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("serviceEditor.toast.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const toggleRaw = () => {
    if (!raw) setRawText(JSON.stringify(buildDef(), null, 2));
    else syncFromRaw();
    setRaw(!raw);
  };

  return (
    <Modal
      open={open}
      wide
      title={service ? t("serviceEditor.editTitle", { name: service.name }) : kind === "chain" ? t("serviceEditor.newMicroAgentTitle") : t("serviceEditor.newModelServiceTitle")}
      icon={kind === "chain" ? "bi-robot" : "bi-diagram-3"}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={toggleRaw}>
            <i className="bi bi-code-slash" />
            {raw ? t("serviceEditor.visualEditor") : t("serviceEditor.rawJson")}
          </button>
          <button className="btn-ghost" onClick={validate}>
            <i className="bi bi-check2-circle" />
            {t("serviceEditor.validate")}
          </button>
          <button className="btn-ghost" onClick={dryRun} disabled={busy}>
            <i className="bi bi-play-circle" />
            {t("serviceEditor.dryRun")}
          </button>
          <div className="flex-1" />
          <button className="btn-ghost" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn-primary" onClick={save} disabled={busy}>
            <i className="bi bi-check-lg" />
            {t("common.save")}
          </button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">{t("serviceEditor.nameLabel")}</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("serviceEditor.namePlaceholder")} />
          </div>
          <div>
            <label className="label">{t("serviceEditor.timeoutLabel")}</label>
            <input className="input" type="text" inputMode="numeric" value={timeoutMs} onFocus={selectAll} onClick={selectAll} onChange={(e) => setTimeoutMs(intInput(e.target.value, 0))} />
          </div>
        </div>
        <div>
          <label className="label">{t("serviceEditor.descriptionLabel")}</label>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Toggle checked={enabled} onChange={setEnabled} label={t("serviceEditor.enabled")} />
          {kind === "resilience" && (
            <Toggle checked={reliableStreaming} onChange={setReliableStreaming} label={t("serviceEditor.reliableStreaming")} />
          )}
        </div>
        {kind === "resilience" && reliableStreaming && (
          <p className="-mt-2 text-xs text-ink-500">
            {t("serviceEditor.reliableStreamingDescription")}
          </p>
        )}

        {!raw && (
          <p className="text-xs text-ink-500">
            {kind === "resilience"
              ? t("serviceEditor.modelServiceDescription")
              : t("serviceEditor.microAgentDescription")}
          </p>
        )}

        {summary && (
          <div className="flex items-start gap-2 rounded-lg border border-brand-700/40 bg-brand-700/10 px-3 py-2 text-sm text-brand-400">
            <i className="bi bi-signpost-split mt-0.5" />
            <span className="text-ink-200">{summary}</span>
          </div>
        )}

        {raw ? (
          <div>
            <label className="label">{kind === "chain" ? t("serviceEditor.chainJsonLabel") : t("serviceEditor.stepsJsonLabel")}</label>
            <textarea className="input min-h-[320px] font-mono text-xs" value={rawText} onChange={(e) => setRawText(e.target.value)} />
          </div>
        ) : kind === "chain" ? (
          <div className="space-y-4">
            <OcrEditor ocr={ocr} onChange={setOcr} services={services.filter((m) => m.id !== service?.id)} />
            <StageEditor
              stages={stages}
              output={output}
              onChange={(s, o) => {
                setStages(s);
                setOutput(o);
              }}
              services={services.filter((m) => m.id !== service?.id)}
            />
          </div>
        ) : (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="label mb-0">{t("serviceEditor.failureChain")}</span>
              <button className="btn-ghost btn-xs" onClick={addStep}>
                <i className="bi bi-plus-lg" />
                {t("serviceEditor.addStep")}
              </button>
            </div>

            {steps.length === 0 && (
              <p className="rounded-lg border border-dashed border-ink-700 px-4 py-6 text-center text-xs text-ink-500">
                {t("serviceEditor.noStepsHint")}
              </p>
            )}

            <div className="space-y-1">
              {steps.map((step, i) => {
                const provOptions = providersForModel(step.model);
                return (
                  <div key={i}>
                    <div
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => onDrop(i)}
                      className="rounded-xl border border-ink-700 bg-ink-850/70 p-3"
                    >
                      <div className="mb-2.5 flex items-center gap-2">
                        <span
                          draggable
                          onDragStart={() => setDragIndex(i)}
                          onDragEnd={() => setDragIndex(null)}
                          title={t("serviceEditor.dragToReorder")}
                          className="cursor-grab text-ink-600 hover:text-ink-300"
                        >
                          <i className="bi bi-grip-vertical" />
                        </span>
                        <span className="badge-blue">{t("serviceEditor.stepNumber", { n: i + 1 })}</span>
                        <div className="flex-1" />
                        <button className="btn-ghost btn-xs" title={t("serviceEditor.duplicateStepTitle")} onClick={() => duplicateStep(i)}>
                          <i className="bi bi-files" />
                        </button>
                        <button className="btn-danger btn-xs" onClick={() => removeStep(i)}>
                          <i className="bi bi-trash3" />
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="label">{t("serviceEditor.model")}</label>
                          <select
                            className="input"
                            value={step.model}
                            onChange={(e) => {
                              const model = e.target.value;
                              const provs = providersForModel(model);
                              patchStep(i, { model, provider: provs.includes(step.provider) ? step.provider : provs[0] ?? "" });
                            }}
                          >
                            {models.map((m) => (
                              <option key={m.id} value={m.name}>{m.name}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="label">{t("serviceEditor.provider")}</label>
                          <select className="input" value={step.provider} onChange={(e) => patchStep(i, { provider: e.target.value })}>
                            {provOptions.length === 0 && <option value="">{t("serviceEditor.noProvidersMapped")}</option>}
                            {provOptions.map((p) => (
                              <option key={p} value={p}>{p}</option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="mt-3 grid grid-cols-2 gap-3">
                        <div>
                          <label className="label">{t("serviceEditor.retryAttempts")}</label>
                          <input className="input" type="text" inputMode="numeric" value={step.retry?.maxAttempts ?? 1} onFocus={selectAll} onClick={selectAll} onChange={(e) => patchRetry(i, { maxAttempts: intInput(e.target.value, 1, 1) })} />
                        </div>
                        <div>
                          <label className="label">{t("serviceEditor.retryInterval")}</label>
                          <input className="input" type="text" inputMode="numeric" value={step.retry?.intervalMs ?? 0} onFocus={selectAll} onClick={selectAll} onChange={(e) => patchRetry(i, { intervalMs: intInput(e.target.value, 0) })} />
                        </div>
                      </div>

                      <div className="mt-3">
                        <label className="label">{t("serviceEditor.retryOn")}</label>
                        <TriggerChips
                          options={[...CODE_PRESETS, t("trigger.timeout") as Trigger, t("trigger.network") as Trigger, t("trigger.error") as Trigger]}
                          selected={step.retry?.on ?? []}
                          onToggle={(v) => patchRetry(i, { on: toggle(step.retry?.on, v as Trigger) })}
                          allowCustomCodes
                        />
                      </div>

                      <StepAdvanced step={step} onPatch={(p) => patchStep(i, p)} />

                      {i < steps.length - 1 && (
                        <div className="mt-3">
                          <label className="label">{t("serviceEditor.advanceOnLabel")} <span className="normal-case text-ink-500">{t("serviceEditor.advanceOnHint")}</span></label>
                          <TriggerChips
                            options={[...CODE_PRESETS, t("trigger.timeout") as AdvanceTrigger, t("trigger.network") as AdvanceTrigger, t("trigger.error") as AdvanceTrigger, t("trigger.exhausted") as AdvanceTrigger]}
                            selected={step.advanceOn ?? []}
                            onToggle={(v) => patchStep(i, { advanceOn: toggle(step.advanceOn, v as AdvanceTrigger) })}
                            allowCustomCodes
                          />
                        </div>
                      )}
                    </div>

                    {i < steps.length - 1 && (
                      <div className="flex items-center gap-2 py-1 pl-4 text-xs text-ink-500">
                        <i className="bi bi-arrow-down" />
                        {t("serviceEditor.onFailure")}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {steps.length > 0 && (
              <div className="flex items-center gap-2 pl-4 pt-1 text-xs text-ink-500">
                <i className="bi bi-x-octagon" />
                {t("serviceEditor.lastStepFailsHint")}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * Trigger chip editor with custom error code input. Renders quick-select preset
 * chips (click to toggle) plus a free-form input where the user types any HTTP
 * status code and presses Enter to add it to the selected list. Selected items
 * appear as removable chips above the input.
 *
 * Used for both `retry.on` (Trigger[]) and `advanceOn` (AdvanceTrigger[], which
 * also includes "exhausted").
 */
function TriggerChips({
  options,
  selected,
  onToggle,
  allowCustomCodes = false,
}: {
  options: (Trigger | "exhausted")[];
  selected: (Trigger | "exhausted")[];
  onToggle: (v: Trigger | "exhausted") => void;
  /** When true, shows a text input for adding arbitrary HTTP status codes. */
  allowCustomCodes?: boolean;
}) {
  const { t } = useI18n();
  const [input, setInput] = useState("");

  const addCustomCode = () => {
    const raw = input.trim();
    if (!raw) return;
    // Parse as integer HTTP status code (100-599)
    const code = Number(raw);
    if (Number.isInteger(code) && code >= 100 && code <= 599) {
      if (!selected.includes(code)) {
        onToggle(code);
      }
      setInput("");
    } else if (raw === "timeout" || raw === "network" || raw === "error" || raw === "exhausted") {
      // Also allow symbolic triggers via the input
      if (!selected.includes(raw)) {
        onToggle(raw);
      }
      setInput("");
    }
  };

  // Determine which selected values are NOT in the preset options (custom adds)
  const customSelected = selected.filter((s) => !options.includes(s));

  return (
    <div className="space-y-2">
      {/* Quick-select preset chips */}
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const active = selected.includes(o);
          return (
            <button
              key={String(o)}
              type="button"
              onClick={() => onToggle(o)}
              className={`rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${
                active ? "bg-brand-600 text-white" : "border border-ink-700 bg-ink-900 text-ink-400 hover:text-ink-200"
              }`}
            >
              {o}
            </button>
          );
        })}
      </div>

      {/* Custom error code input */}
      {allowCustomCodes && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            inputMode="numeric"
            className="input w-32 text-xs"
            placeholder={t("serviceEditor.httpCodePlaceholder")}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCustomCode();
              }
            }}
          />
          <button
            type="button"
            className="btn-ghost btn-xs"
            onClick={addCustomCode}
            disabled={!input.trim()}
          >
            <i className="bi bi-plus-lg" />
            {t("serviceEditor.add")}
          </button>
          <span className="text-[11px] text-ink-500">{t("serviceEditor.httpCodeHint")}</span>
        </div>
      )}

      {/* Custom-added triggers shown as removable chips */}
      {customSelected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {customSelected.map((c) => (
            <button
              key={String(c)}
              type="button"
              onClick={() => onToggle(c)}
              className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-brand-500"
              title={t("serviceEditor.clickToRemove")}
            >
              {c}
              <i className="bi bi-x-lg text-[10px]" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StepAdvanced({ step, onPatch }: { step: ServiceStep; onPatch: (p: Partial<ServiceStep>) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const hasOverrides = !!step.overrides && Object.keys(step.overrides).length > 0;
  return (
    <div className="mt-3">
      <button type="button" className="text-xs text-ink-500 hover:text-ink-300" onClick={() => setOpen((a) => !a)}>
        <i className={`bi ${open ? "bi-chevron-down" : "bi-chevron-right"} mr-1`} />
        {t("serviceEditor.advancedOverrides")}
        {hasOverrides && <span className="ml-1 text-brand-400">●</span>}
      </button>
      {open && (
        <div className="mt-2">
          <OverridesEditor
            overrides={step.overrides}
            onChange={(ov) => onPatch({ overrides: ov })}
          />
        </div>
      )}
    </div>
  );
}
