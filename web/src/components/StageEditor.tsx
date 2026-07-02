import { useState } from "react";
import type { ChainBlock, ChainPart, ChainStage, Model } from "../types";

const selectAll = (e: React.SyntheticEvent<HTMLInputElement>) => e.currentTarget.select();
const numOr = (v: string, fallback: number) => Number(v.replace(/[^\d]/g, "")) || fallback;

const PART_SOURCES: { source: ChainPart["source"]; label: string }[] = [
  { source: "original_text", label: "Original text" },
  { source: "original_images", label: "Original images" },
  { source: "original_system", label: "Original system" },
  { source: "original_messages", label: "Original conversation" },
  { source: "stage", label: "Stage output" },
  { source: "literal", label: "Literal text" },
];

export function blankStage(name: string, model: string, provider: string): ChainStage {
  return { name, steps: [{ model, provider, retry: { on: [], maxAttempts: 1, intervalMs: 0 } }], input: [] };
}

function newPart(source: ChainPart["source"], earlier: string[]): ChainPart {
  if (source === "literal") return { source, text: "" };
  if (source === "stage") return { source, name: earlier[0] ?? "" };
  return { source };
}

interface Props {
  stages: ChainStage[];
  output: string;
  onChange: (stages: ChainStage[], output: string) => void;
  models: Model[];
  providersForModel: (model: string) => string[];
}

export function StageEditor({ stages, output, onChange, models, providersForModel }: Props) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const setStages = (next: ChainStage[], nextOutput = output) => onChange(next, nextOutput);
  const patch = (i: number, p: Partial<ChainStage>) =>
    setStages(stages.map((s, idx) => (idx === i ? { ...s, ...p } : s)));

  const addStage = () => {
    const model = models[0]?.name ?? "";
    const provider = providersForModel(model)[0] ?? "";
    const name = uniqueName(stages, "stage");
    setStages([...stages, blankStage(name, model, provider)]);
  };

  const removeStage = (i: number) => {
    const gone = stages[i].name;
    const next = stages.filter((_, idx) => idx !== i);
    setStages(next, output === gone ? "" : output);
  };

  const duplicateStage = (i: number) => {
    const copy = JSON.parse(JSON.stringify(stages[i])) as ChainStage;
    copy.name = uniqueName(stages, `${stages[i].name}_copy`);
    setStages([...stages.slice(0, i + 1), copy, ...stages.slice(i + 1)]);
  };

  const onDrop = (i: number) => {
    if (dragIndex === null || dragIndex === i) return;
    const next = [...stages];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(i, 0, moved);
    setStages(next);
    setDragIndex(null);
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="label mb-0">Stages (run top to bottom; outputs feed later stages)</span>
        <button className="btn-ghost btn-xs" onClick={addStage}>
          <i className="bi bi-plus-lg" />
          Add stage
        </button>
      </div>

      {stages.length === 0 && (
        <p className="rounded-lg border border-dashed border-ink-700 px-4 py-6 text-center text-xs text-ink-500">
          No stages. Add at least one model call.
        </p>
      )}

      <div className="space-y-2">
        {stages.map((stage, i) => (
          <div
            key={i}
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
              <span className="badge-blue">Stage {i + 1}</span>
              <input
                className="input h-7 w-40 py-0 font-mono text-xs"
                value={stage.name}
                onChange={(e) => patch(i, { name: e.target.value.replace(/\s+/g, "_") })}
                placeholder="stage name"
              />
              <div className="flex-1" />
              <button className="btn-ghost btn-xs" title="Duplicate stage" onClick={() => duplicateStage(i)}>
                <i className="bi bi-files" />
              </button>
              <button className="btn-danger btn-xs" onClick={() => removeStage(i)}>
                <i className="bi bi-trash3" />
              </button>
            </div>

            <StageBody
              stage={stage}
              earlier={stages.slice(0, i).map((s) => s.name).filter(Boolean)}
              models={models}
              providersForModel={providersForModel}
              onPatch={(p) => patch(i, p)}
            />
          </div>
        ))}
      </div>

      {stages.length > 1 && (
        <div className="mt-3 flex items-center gap-2">
          <label className="label mb-0">Return the output of</label>
          <select className="input w-auto" value={output} onChange={(e) => setStages(stages, e.target.value)}>
            <option value="">last stage ({stages[stages.length - 1]?.name})</option>
            {stages.map((s) => (
              <option key={s.name} value={s.name}>{s.name}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

function StageBody({
  stage,
  earlier,
  models,
  providersForModel,
  onPatch,
}: {
  stage: ChainStage;
  earlier: string[];
  models: Model[];
  providersForModel: (model: string) => string[];
  onPatch: (p: Partial<ChainStage>) => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const step = stage.steps[0] ?? { model: "", provider: "", retry: { on: [], maxAttempts: 1, intervalMs: 0 } };
  const provOptions = providersForModel(step.model);
  const patchStep = (p: Partial<typeof step>) => onPatch({ steps: [{ ...step, ...p }] });
  const patchRetry = (p: Partial<NonNullable<typeof step.retry>>) =>
    onPatch({ steps: [{ ...step, retry: { on: [], maxAttempts: 1, intervalMs: 0, ...step.retry, ...p } }] });

  const setBlocks = (blocks: ChainBlock[]) => onPatch({ input: blocks });

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Model</label>
          <select
            className="input"
            value={step.model}
            onChange={(e) => {
              const model = e.target.value;
              const provs = providersForModel(model);
              patchStep({ model, provider: provs.includes(step.provider) ? step.provider : provs[0] ?? "" });
            }}
          >
            {models.map((m) => (
              <option key={m.id} value={m.name}>{m.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Provider</label>
          <select className="input" value={step.provider} onChange={(e) => patchStep({ provider: e.target.value })}>
            {provOptions.length === 0 && <option value="">(no providers mapped)</option>}
            {provOptions.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <label className="label mb-0">Input <span className="normal-case text-ink-500">(empty = pass the original messages through)</span></label>
          <button
            className="btn-ghost btn-xs"
            onClick={() => setBlocks([...stage.input, { role: "user", parts: [] }])}
          >
            <i className="bi bi-plus-lg" />
            Add message
          </button>
        </div>
        <div className="space-y-2">
          {stage.input.map((block, bi) => (
            <BlockRow
              key={bi}
              block={block}
              earlier={earlier}
              onChange={(b) => setBlocks(stage.input.map((x, idx) => (idx === bi ? b : x)))}
              onRemove={() => setBlocks(stage.input.filter((_, idx) => idx !== bi))}
            />
          ))}
        </div>
      </div>

      <button className="mt-2 text-xs text-ink-500 hover:text-ink-300" onClick={() => setAdvanced((a) => !a)}>
        <i className={`bi ${advanced ? "bi-chevron-down" : "bi-chevron-right"} mr-1`} />
        Advanced (retry, system, sampling)
      </button>
      {advanced && (
        <div className="mt-2 space-y-3 rounded-lg border border-ink-800 bg-ink-950/40 p-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Retry attempts</label>
              <input className="input" type="text" inputMode="numeric" value={step.retry?.maxAttempts ?? 1} onFocus={selectAll} onClick={selectAll} onChange={(e) => patchRetry({ maxAttempts: Math.max(1, numOr(e.target.value, 1)) })} />
            </div>
            <div>
              <label className="label">Retry interval (ms)</label>
              <input className="input" type="text" inputMode="numeric" value={step.retry?.intervalMs ?? 0} onFocus={selectAll} onClick={selectAll} onChange={(e) => patchRetry({ intervalMs: numOr(e.target.value, 0) })} />
            </div>
          </div>
          <div>
            <label className="label">System override (optional)</label>
            <textarea
              className="input min-h-[56px] font-mono text-xs"
              value={stage.system?.map((p) => (p.source === "literal" ? p.text : "")).join("") ?? ""}
              onChange={(e) => onPatch({ system: e.target.value ? [{ source: "literal", text: e.target.value }] : undefined })}
              placeholder="Leave empty to inherit the original system prompt"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <NumOverride label="Temperature" value={stage.temperature} onChange={(v) => onPatch({ temperature: v })} step="0.1" />
            <NumOverride label="Max tokens" value={stage.maxTokens} onChange={(v) => onPatch({ maxTokens: v })} />
            <NumOverride label="Timeout (ms)" value={stage.timeoutMs} onChange={(v) => onPatch({ timeoutMs: v })} />
          </div>
        </div>
      )}
    </>
  );
}

function BlockRow({
  block,
  earlier,
  onChange,
  onRemove,
}: {
  block: ChainBlock;
  earlier: string[];
  onChange: (b: ChainBlock) => void;
  onRemove: () => void;
}) {
  const setParts = (parts: ChainPart[]) => onChange({ ...block, parts });
  const move = (from: number, to: number) => {
    if (to < 0 || to >= block.parts.length) return;
    const next = [...block.parts];
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    setParts(next);
  };

  return (
    <div className="rounded-lg border border-ink-800 bg-ink-900/60 p-2">
      <div className="mb-1.5 flex items-center gap-2">
        <select
          className="input h-7 w-28 py-0 text-xs"
          value={block.role}
          onChange={(e) => onChange({ ...block, role: e.target.value as ChainBlock["role"] })}
        >
          <option value="user">user</option>
          <option value="assistant">assistant</option>
        </select>
        <div className="flex-1" />
        <button
          className="btn-ghost btn-xs"
          onClick={() => setParts([...block.parts, newPart("literal", earlier)])}
        >
          <i className="bi bi-plus-lg" />
          Add part
        </button>
        <button className="btn-danger btn-xs" onClick={onRemove}>
          <i className="bi bi-trash3" />
        </button>
      </div>
      {block.parts.length === 0 && (
        <p className="px-1 py-1 text-[11px] text-ink-600">Empty message — add a content part.</p>
      )}
      <div className="space-y-1.5">
        {block.parts.map((part, pi) => (
          <div key={pi} className="flex items-start gap-1.5">
            <select
              className="input h-8 w-44 py-0 text-xs"
              value={part.source}
              onChange={(e) =>
                setParts(block.parts.map((x, idx) => (idx === pi ? newPart(e.target.value as ChainPart["source"], earlier) : x)))
              }
            >
              {PART_SOURCES.map((s) => (
                <option key={s.source} value={s.source}>{s.label}</option>
              ))}
            </select>
            {part.source === "literal" && (
              <textarea
                className="input min-h-[32px] flex-1 py-1 font-mono text-xs"
                value={part.text}
                onChange={(e) => setParts(block.parts.map((x, idx) => (idx === pi ? { source: "literal", text: e.target.value } : x)))}
                placeholder="literal text"
              />
            )}
            {part.source === "stage" && (
              <select
                className="input h-8 flex-1 py-0 text-xs"
                value={part.name}
                onChange={(e) => setParts(block.parts.map((x, idx) => (idx === pi ? { source: "stage", name: e.target.value } : x)))}
              >
                {earlier.length === 0 && <option value="">(no earlier stage)</option>}
                {earlier.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            )}
            {part.source !== "literal" && part.source !== "stage" && <div className="flex-1" />}
            <button className="btn-ghost btn-xs" title="Move up" onClick={() => move(pi, pi - 1)}>
              <i className="bi bi-arrow-up" />
            </button>
            <button className="btn-ghost btn-xs" title="Move down" onClick={() => move(pi, pi + 1)}>
              <i className="bi bi-arrow-down" />
            </button>
            <button className="btn-danger btn-xs" onClick={() => setParts(block.parts.filter((_, idx) => idx !== pi))}>
              <i className="bi bi-x-lg" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function NumOverride({
  label,
  value,
  onChange,
  step,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  step?: string;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <input
        className="input"
        type="text"
        inputMode="decimal"
        value={value ?? ""}
        placeholder="inherit"
        onChange={(e) => {
          const t = e.target.value.trim();
          if (!t) return onChange(undefined);
          const n = Number(step ? t.replace(/[^\d.]/g, "") : t.replace(/[^\d]/g, ""));
          onChange(Number.isFinite(n) ? n : undefined);
        }}
      />
    </div>
  );
}

function uniqueName(stages: ChainStage[], base: string): string {
  const taken = new Set(stages.map((s) => s.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
}
