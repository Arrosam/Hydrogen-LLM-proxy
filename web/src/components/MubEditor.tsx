import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { Modal } from "./Modal";
import { Toggle } from "./common";
import { useToast } from "./Toast";
import type { AdvanceTrigger, Mapping, Model, Mub, MubStep, MubSteps, Provider, Trigger } from "../types";

const CODE_PRESETS: Trigger[] = [429, 500, 502, 503, 529];

interface Props {
  open: boolean;
  mub: Mub | null; // null = new
  models: Model[];
  providers: Provider[];
  mappings: Mapping[];
  onClose: () => void;
  onSaved: () => void;
}

function blankStep(model: string, provider: string): MubStep {
  return { model, provider, retry: { on: [], maxAttempts: 1, intervalMs: 0 } };
}

function toggle<T>(arr: T[] | undefined, val: T): T[] {
  const a = arr ?? [];
  return a.includes(val) ? a.filter((x) => x !== val) : [...a, val];
}

export function MubEditor({ open, mub, models, providers, mappings, onClose, onSaved }: Props) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [timeoutMs, setTimeoutMs] = useState(60000);
  const [steps, setSteps] = useState<MubStep[]>([]);
  const [raw, setRaw] = useState(false);
  const [rawText, setRawText] = useState("");
  const [summary, setSummary] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  // Select the whole value on focus/click so typing replaces it (no "05").
  const selectAll = (e: React.SyntheticEvent<HTMLInputElement>) => e.currentTarget.select();

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
    if (mub) {
      setName(mub.name);
      setDescription(mub.description ?? "");
      setEnabled(mub.enabled);
      setTimeoutMs(mub.steps?.timeoutMs ?? 60000);
      setSteps(mub.steps?.steps ?? []);
    } else {
      const firstModel = models[0]?.name ?? "";
      const firstProvider = providersForModel(firstModel)[0] ?? "";
      setName("");
      setDescription("");
      setEnabled(true);
      setTimeoutMs(60000);
      setSteps(firstModel && firstProvider ? [blankStep(firstModel, firstProvider)] : []);
    }
    setRaw(false);
    setSummary("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mub]);

  const buildSteps = (): MubSteps => ({ timeoutMs, steps });

  const patchStep = (i: number, patch: Partial<MubStep>) =>
    setSteps((s) => s.map((st, idx) => (idx === i ? { ...st, ...patch } : st)));

  const patchRetry = (i: number, patch: Partial<NonNullable<MubStep["retry"]>>) =>
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
      const copy = JSON.parse(JSON.stringify(s[i])) as MubStep;
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

  const syncFromRaw = (): MubSteps | null => {
    try {
      const parsed = JSON.parse(rawText) as MubSteps;
      setTimeoutMs(parsed.timeoutMs ?? 60000);
      setSteps(parsed.steps ?? []);
      return parsed;
    } catch {
      toast.error("Steps JSON is invalid");
      return null;
    }
  };

  const currentSteps = (): MubSteps => (raw ? JSON.parse(rawText || "{}") : buildSteps());

  const validate = async () => {
    let s: MubSteps;
    try {
      s = currentSteps();
    } catch {
      toast.error("Steps JSON is invalid");
      return;
    }
    const r = await api.post<{ valid: boolean; summary?: string; error?: string }>("/mubs/validate", { steps: s });
    if (r.valid) {
      setSummary(r.summary ?? "");
      toast.success("Workflow is valid");
    } else {
      setSummary("");
      toast.error(r.error ?? "Invalid workflow");
    }
  };

  const dryRun = async () => {
    let s: MubSteps;
    try {
      s = currentSteps();
    } catch {
      toast.error("Steps JSON is invalid");
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; served?: { model: string; provider: string }; message?: string; output?: string }>(
        "/mubs/test",
        { steps: s, prompt: "ping" },
      );
      if (r.ok) toast.success(`Served by ${r.served?.model}@${r.served?.provider}: "${r.output}"`);
      else toast.error(`Dry-run failed: ${r.message}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Dry-run failed");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    let s: MubSteps;
    try {
      s = currentSteps();
    } catch {
      toast.error("Steps JSON is invalid");
      return;
    }
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    setBusy(true);
    try {
      const payload = { name, description: description || null, steps: s, enabled };
      if (mub) await api.patch(`/mubs/${mub.id}`, payload);
      else await api.post("/mubs", payload);
      toast.success(mub ? "MUB updated" : "MUB created");
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const toggleRaw = () => {
    if (!raw) setRawText(JSON.stringify(buildSteps(), null, 2));
    else syncFromRaw();
    setRaw(!raw);
  };

  return (
    <Modal
      open={open}
      wide
      title={mub ? `Edit "${mub.name}"` : "New Model Use Behavior"}
      icon="bi-diagram-3"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={toggleRaw}>
            <i className="bi bi-code-slash" />
            {raw ? "Visual editor" : "Raw JSON"}
          </button>
          <button className="btn-ghost" onClick={validate}>
            <i className="bi bi-check2-circle" />
            Validate
          </button>
          <button className="btn-ghost" onClick={dryRun} disabled={busy}>
            <i className="bi bi-play-circle" />
            Dry-run
          </button>
          <div className="flex-1" />
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy}>
            <i className="bi bi-check-lg" />
            Save
          </button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Name (exposed model name)</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. sonnet-any" />
          </div>
          <div>
            <label className="label">Per-attempt timeout (ms)</label>
            <input className="input" type="text" inputMode="numeric" value={timeoutMs} onFocus={selectAll} onClick={selectAll} onChange={(e) => setTimeoutMs(Number(e.target.value.replace(/\D/g, "")) || 0)} />
          </div>
        </div>
        <div>
          <label className="label">Description (optional)</label>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <Toggle checked={enabled} onChange={setEnabled} label="Enabled" />

        {summary && (
          <div className="flex items-start gap-2 rounded-lg border border-brand-700/40 bg-brand-700/10 px-3 py-2 text-sm text-brand-400">
            <i className="bi bi-signpost-split mt-0.5" />
            <span className="text-ink-200">{summary}</span>
          </div>
        )}

        {raw ? (
          <div>
            <label className="label">Steps JSON</label>
            <textarea className="input min-h-[320px] font-mono text-xs" value={rawText} onChange={(e) => setRawText(e.target.value)} />
          </div>
        ) : (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="label mb-0">Failure chain (drag to reorder)</span>
              <button className="btn-ghost btn-xs" onClick={addStep}>
                <i className="bi bi-plus-lg" />
                Add step
              </button>
            </div>

            {steps.length === 0 && (
              <p className="rounded-lg border border-dashed border-ink-700 px-4 py-6 text-center text-xs text-ink-500">
                No steps. Add at least one (model, provider) attempt.
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
                          title="Drag to reorder"
                          className="cursor-grab text-ink-600 hover:text-ink-300"
                        >
                          <i className="bi bi-grip-vertical" />
                        </span>
                        <span className="badge-blue">Step {i + 1}</span>
                        <div className="flex-1" />
                        <button className="btn-ghost btn-xs" title="Duplicate with a different provider" onClick={() => duplicateStep(i)}>
                          <i className="bi bi-files" />
                        </button>
                        <button className="btn-danger btn-xs" onClick={() => removeStep(i)}>
                          <i className="bi bi-trash3" />
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="label">Model</label>
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
                          <label className="label">Provider</label>
                          <select className="input" value={step.provider} onChange={(e) => patchStep(i, { provider: e.target.value })}>
                            {provOptions.length === 0 && <option value="">(no providers mapped)</option>}
                            {provOptions.map((p) => (
                              <option key={p} value={p}>{p}</option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="mt-3 grid grid-cols-2 gap-3">
                        <div>
                          <label className="label">Retry attempts</label>
                          <input className="input" type="text" inputMode="numeric" value={step.retry?.maxAttempts ?? 1} onFocus={selectAll} onClick={selectAll} onChange={(e) => patchRetry(i, { maxAttempts: Math.max(1, Number(e.target.value.replace(/\D/g, "")) || 1) })} />
                        </div>
                        <div>
                          <label className="label">Retry interval (ms)</label>
                          <input className="input" type="text" inputMode="numeric" value={step.retry?.intervalMs ?? 0} onFocus={selectAll} onClick={selectAll} onChange={(e) => patchRetry(i, { intervalMs: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
                        </div>
                      </div>

                      <div className="mt-3">
                        <label className="label">Retry on</label>
                        <TriggerChips
                          options={[...CODE_PRESETS, "timeout", "error"]}
                          selected={step.retry?.on ?? []}
                          onToggle={(v) => patchRetry(i, { on: toggle(step.retry?.on, v as Trigger) })}
                        />
                      </div>

                      {i < steps.length - 1 && (
                        <div className="mt-3">
                          <label className="label">Advance to next step on <span className="normal-case text-ink-500">(empty = any failure)</span></label>
                          <TriggerChips
                            options={[...CODE_PRESETS, "timeout", "error", "exhausted"]}
                            selected={step.advanceOn ?? []}
                            onToggle={(v) => patchStep(i, { advanceOn: toggle(step.advanceOn, v as AdvanceTrigger) })}
                          />
                        </div>
                      )}
                    </div>

                    {i < steps.length - 1 && (
                      <div className="flex items-center gap-2 py-1 pl-4 text-xs text-ink-500">
                        <i className="bi bi-arrow-down" />
                        on failure
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {steps.length > 0 && (
              <div className="flex items-center gap-2 pl-4 pt-1 text-xs text-ink-500">
                <i className="bi bi-x-octagon" />
                if the last step still fails, the upstream error is returned to the client
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function TriggerChips({
  options,
  selected,
  onToggle,
}: {
  options: (Trigger | "exhausted")[];
  selected: (Trigger | "exhausted")[];
  onToggle: (v: Trigger | "exhausted") => void;
}) {
  return (
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
  );
}
