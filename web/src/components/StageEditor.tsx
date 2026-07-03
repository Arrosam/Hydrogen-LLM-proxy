import { useEffect, useState } from "react";
import type { ChainContextBlock, ChainCondition, ChainStage, ChainTransition, Mub } from "../types";

const selectAll = (e: React.SyntheticEvent<HTMLInputElement>) => e.currentTarget.select();

const BLOCK_KINDS: { value: string; label: string }[] = [
  { value: "original_conversation", label: "Original full conversation" },
  { value: "text_conversation", label: "Text-only conversation" },
  { value: "last_user", label: "Last user request" },
  { value: "last_user_text", label: "Last user text only" },
  { value: "last_user_images", label: "Last user images only" },
  { value: "stage_output", label: "Output from another stage" },
  { value: "message", label: "New conversation turn" },
  { value: "tool_turn", label: "Tool use turn" },
  { value: "plain_text", label: "Plain text" },
];

function newContextBlock(value: string, earlier: string[]): ChainContextBlock {
  switch (value) {
    case "text_conversation":
      return { kind: "text_conversation" };
    case "last_user":
      return { kind: "last_user" };
    case "last_user_text":
      return { kind: "last_user_text" };
    case "last_user_images":
      return { kind: "last_user_images" };
    case "stage_output":
      return { kind: "stage_output", stage: earlier[0] ?? "", role: "assistant" };
    case "message":
    case "plain_text":
      return { kind: "message", role: "user", text: "" };
    case "tool_turn":
      return { kind: "tool_turn", name: "", input: "", result: "" };
    default:
      return { kind: "original_conversation" };
  }
}

const CONDITION_TYPES: { type: ChainCondition["type"]; label: string }[] = [
  { type: "always", label: "always" },
  { type: "input_has_image", label: "input has image" },
  { type: "input_contains", label: "input contains" },
  { type: "input_matches", label: "input matches (regex)" },
  { type: "output_contains", label: "output contains" },
  { type: "output_matches", label: "output matches (regex)" },
];

const ROUTER = "__router__";

function isModelStage(s: ChainStage): boolean {
  return !!s.mub || !!(s.steps && s.steps.length);
}
function newCondition(type: ChainCondition["type"]): ChainCondition {
  if (type === "input_contains" || type === "input_matches") return { type, value: "" };
  if (type === "output_contains" || type === "output_matches") return { type, value: "" };
  return { type } as ChainCondition;
}
const condHasValue = (c: ChainCondition) => c.type.endsWith("_contains") || c.type.endsWith("_matches");
const condIsOutput = (c: ChainCondition) => c.type === "output_contains" || c.type === "output_matches";

interface Props {
  stages: ChainStage[];
  output: string;
  onChange: (stages: ChainStage[], output: string) => void;
  mubs: Mub[]; // resilience MUBs available to reference
}

export function StageEditor({ stages, output, onChange, mubs }: Props) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const setStages = (next: ChainStage[], nextOutput = output) => onChange(next, nextOutput);
  const patch = (i: number, p: Partial<ChainStage>) => setStages(stages.map((s, idx) => (idx === i ? { ...s, ...p } : s)));

  const addStage = () => {
    const name = uniqueName(stages, "stage");
    const first = mubs[0]?.name;
    setStages([...stages, { name, input: [], ...(first ? { mub: first } : {}) }]);
  };
  const removeStage = (i: number) => {
    const gone = stages[i].name;
    setStages(stages.filter((_, idx) => idx !== i), output === gone ? "" : output);
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
        <span className="label mb-0">Stages (run from the top; transitions branch to later stages)</span>
        <button className="btn-ghost btn-xs" onClick={addStage}>
          <i className="bi bi-plus-lg" />
          Add stage
        </button>
      </div>

      {mubs.length === 0 && (
        <p className="mb-2 rounded-lg border border-amber-700/40 bg-amber-700/10 px-3 py-2 text-xs text-amber-300">
          No resilience MUBs exist yet. Create a resilience MUB first — chain stages run one.
        </p>
      )}
      {stages.length === 0 && (
        <p className="rounded-lg border border-dashed border-ink-700 px-4 py-6 text-center text-xs text-ink-500">
          No stages. Add one; each stage runs a resilience MUB (or routes on conditions).
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
              mubs={mubs}
              earlier={stages.slice(0, i).map((s) => s.name).filter(Boolean)}
              later={stages.slice(i + 1).map((s) => s.name).filter(Boolean)}
              onPatch={(p) => patch(i, p)}
            />
          </div>
        ))}
      </div>

      {stages.length > 1 && (
        <div className="mt-3 flex items-center gap-2">
          <label className="label mb-0">Return the output of</label>
          <select className="input w-auto" value={output} onChange={(e) => setStages(stages, e.target.value)}>
            <option value="">the stage where routing ends (default)</option>
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
  mubs,
  earlier,
  later,
  onPatch,
}: {
  stage: ChainStage;
  mubs: Mub[];
  earlier: string[];
  later: string[];
  onPatch: (p: Partial<ChainStage>) => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const model = isModelStage(stage);
  const legacyInline = !stage.mub && !!(stage.steps && stage.steps.length);
  const setBlocks = (blocks: ChainContextBlock[]) => onPatch({ input: blocks });
  const setTransitions = (transitions: ChainTransition[]) => onPatch({ transitions });

  return (
    <>
      <div>
        <label className="label">Runs</label>
        <select
          className="input"
          value={stage.mub ?? (model ? "" : ROUTER)}
          onChange={(e) => {
            const v = e.target.value;
            if (v === ROUTER) onPatch({ mub: undefined, steps: undefined });
            else onPatch({ mub: v || undefined, steps: undefined });
          }}
        >
          <option value="">— pick a resilience MUB —</option>
          {mubs.map((m) => (
            <option key={m.name} value={m.name}>{m.name}</option>
          ))}
          <option value={ROUTER}>router (no model call — route by input only)</option>
        </select>
        {legacyInline && (
          <p className="mt-1 text-xs text-amber-300">Uses inline steps (legacy). Pick a MUB, or edit via Raw JSON.</p>
        )}
        {!model && (
          <p className="mt-1 text-xs text-ink-500">Router: evaluates its transitions on the original input; no model runs.</p>
        )}
      </div>

      {model && (
        <>
          <div className="mt-3">
            <div className="mb-1.5 flex items-center justify-between">
              <label className="label mb-0">Input <span className="normal-case text-ink-500">(empty = pass the original messages through)</span></label>
              <select
                className="input h-7 w-auto py-0 text-xs"
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  setBlocks([...stage.input, newContextBlock(e.target.value, earlier)]);
                }}
              >
                <option value="">+ add context block…</option>
                {BLOCK_KINDS.map((b) => (
                  <option key={b.value} value={b.value}>{b.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              {stage.input.map((block, bi) => (
                <ContextBlockRow
                  key={bi}
                  block={block}
                  earlier={earlier}
                  onChange={(b) => setBlocks(stage.input.map((x, idx) => (idx === bi ? b : x)))}
                  onMove={(dir) => {
                    const to = bi + dir;
                    if (to < 0 || to >= stage.input.length) return;
                    const next = [...stage.input];
                    const [m] = next.splice(bi, 1);
                    next.splice(to, 0, m);
                    setBlocks(next);
                  }}
                  onRemove={() => setBlocks(stage.input.filter((_, idx) => idx !== bi))}
                />
              ))}
            </div>
          </div>

          <button className="mt-2 text-xs text-ink-500 hover:text-ink-300" onClick={() => setAdvanced((a) => !a)}>
            <i className={`bi ${advanced ? "bi-chevron-down" : "bi-chevron-right"} mr-1`} />
            Advanced (system, sampling, timeout)
          </button>
          {advanced && (
            <div className="mt-2 space-y-3 rounded-lg border border-ink-800 bg-ink-950/40 p-3">
              <div>
                <label className="label">System override (optional)</label>
                <textarea
                  className="input min-h-[56px] font-mono text-xs"
                  value={stage.system ?? ""}
                  onChange={(e) => onPatch({ system: e.target.value || undefined })}
                  placeholder="Leave empty to inherit the original system prompt"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <NumOverride label="Temperature" value={stage.temperature} onChange={(v) => onPatch({ temperature: v })} decimal />
                <NumOverride label="Max tokens" value={stage.maxTokens} onChange={(v) => onPatch({ maxTokens: v })} />
                <NumOverride label="Timeout (ms)" value={stage.timeoutMs} onChange={(v) => onPatch({ timeoutMs: v })} />
              </div>
            </div>
          )}
        </>
      )}

      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <label className="label mb-0">Transitions <span className="normal-case text-ink-500">(first match wins; none = fall through to the next stage)</span></label>
          <button
            className="btn-ghost btn-xs"
            onClick={() => setTransitions([...(stage.transitions ?? []), { when: { type: "always" }, goto: later[0] ?? "end" }])}
          >
            <i className="bi bi-plus-lg" />
            Add transition
          </button>
        </div>
        <div className="space-y-1.5">
          {(stage.transitions ?? []).map((tr, ti) => (
            <TransitionRow
              key={ti}
              transition={tr}
              earlier={earlier}
              later={later}
              onChange={(t) => setTransitions((stage.transitions ?? []).map((x, idx) => (idx === ti ? t : x)))}
              onRemove={() => setTransitions((stage.transitions ?? []).filter((_, idx) => idx !== ti))}
            />
          ))}
        </div>
      </div>
    </>
  );
}

function TransitionRow({
  transition,
  earlier,
  later,
  onChange,
  onRemove,
}: {
  transition: ChainTransition;
  earlier: string[];
  later: string[];
  onChange: (t: ChainTransition) => void;
  onRemove: () => void;
}) {
  const c = transition.when;
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-ink-800 bg-ink-900/60 p-2 text-xs">
      <span className="text-ink-500">when</span>
      <select
        className="input h-8 w-40 py-0 text-xs"
        value={c.type}
        onChange={(e) => onChange({ ...transition, when: newCondition(e.target.value as ChainCondition["type"]) })}
      >
        {CONDITION_TYPES.map((o) => (
          <option key={o.type} value={o.type}>{o.label}</option>
        ))}
      </select>
      {condIsOutput(c) && (
        <select
          className="input h-8 w-32 py-0 text-xs"
          value={(c as { stage?: string }).stage ?? ""}
          onChange={(e) => onChange({ ...transition, when: { ...c, stage: e.target.value || undefined } as ChainCondition })}
        >
          <option value="">this stage</option>
          {earlier.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      )}
      {condHasValue(c) && (
        <input
          className="input h-8 flex-1 py-0 font-mono text-xs"
          value={(c as { value: string }).value}
          onChange={(e) => onChange({ ...transition, when: { ...c, value: e.target.value } as ChainCondition })}
          placeholder={c.type.endsWith("matches") ? "regex" : "text to find"}
        />
      )}
      <span className="text-ink-500">→ go to</span>
      <select
        className="input h-8 w-32 py-0 text-xs"
        value={transition.goto}
        onChange={(e) => onChange({ ...transition, goto: e.target.value })}
      >
        <option value="end">end (return)</option>
        {later.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
      <button className="btn-danger btn-xs" onClick={onRemove}>
        <i className="bi bi-x-lg" />
      </button>
    </div>
  );
}

const BLOCK_LABEL: Record<ChainContextBlock["kind"], string> = {
  original_conversation: "Full conversation",
  text_conversation: "Text-only conversation",
  last_user: "Last user request",
  last_user_text: "Last user text",
  last_user_images: "Last user images",
  stage_output: "Stage output",
  message: "Turn",
  tool_turn: "Tool turn",
};
const BLOCK_HINT: Partial<Record<ChainContextBlock["kind"], string>> = {
  original_conversation: "The original messages, images included.",
  text_conversation: "The original messages with images stripped.",
  last_user: "The last user message from the original request.",
  last_user_text: "Only the text of the last user message.",
  last_user_images: "Only the image(s) of the last user message.",
};

function ContextBlockRow({
  block,
  earlier,
  onChange,
  onMove,
  onRemove,
}: {
  block: ChainContextBlock;
  earlier: string[];
  onChange: (b: ChainContextBlock) => void;
  onMove: (dir: number) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-lg border border-ink-800 bg-ink-900/60 p-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="badge-gray">{BLOCK_LABEL[block.kind]}</span>
        {block.kind === "stage_output" && (
          <>
            <select
              className="input h-7 w-28 py-0 text-xs"
              value={block.stage}
              onChange={(e) => onChange({ ...block, stage: e.target.value })}
            >
              {earlier.length === 0 && <option value="">(no earlier stage)</option>}
              {earlier.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <span className="text-ink-500">as</span>
            <select
              className="input h-7 w-24 py-0 text-xs"
              value={block.role}
              onChange={(e) => onChange({ ...block, role: e.target.value as "user" | "assistant" })}
            >
              <option value="assistant">assistant</option>
              <option value="user">user</option>
            </select>
          </>
        )}
        {block.kind === "message" && (
          <select
            className="input h-7 w-24 py-0 text-xs"
            value={block.role}
            onChange={(e) => onChange({ ...block, role: e.target.value as "user" | "assistant" })}
          >
            <option value="user">user</option>
            <option value="assistant">assistant</option>
          </select>
        )}
        <div className="flex-1" />
        <button className="btn-ghost btn-xs" title="Move up" onClick={() => onMove(-1)}>
          <i className="bi bi-arrow-up" />
        </button>
        <button className="btn-ghost btn-xs" title="Move down" onClick={() => onMove(1)}>
          <i className="bi bi-arrow-down" />
        </button>
        <button className="btn-danger btn-xs" onClick={onRemove}>
          <i className="bi bi-x-lg" />
        </button>
      </div>

      {block.kind === "message" && (
        <textarea
          className="input mt-1.5 min-h-[36px] font-mono text-xs"
          value={block.text}
          onChange={(e) => onChange({ ...block, text: e.target.value })}
          placeholder="message text"
        />
      )}
      {block.kind === "tool_turn" && (
        <div className="mt-1.5 space-y-1.5">
          <input
            className="input h-8 py-0 font-mono text-xs"
            value={block.name}
            onChange={(e) => onChange({ ...block, name: e.target.value })}
            placeholder="tool name"
          />
          <textarea
            className="input min-h-[32px] font-mono text-xs"
            value={block.input}
            onChange={(e) => onChange({ ...block, input: e.target.value })}
            placeholder={'arguments (JSON), e.g. {"city":"SF"}'}
          />
          <textarea
            className="input min-h-[32px] font-mono text-xs"
            value={block.result}
            onChange={(e) => onChange({ ...block, result: e.target.value })}
            placeholder="tool result text"
          />
          <label className="flex items-center gap-2 text-ink-400">
            <input
              type="checkbox"
              checked={!!block.isError}
              onChange={(e) => onChange({ ...block, isError: e.target.checked || undefined })}
            />
            mark as error
          </label>
        </div>
      )}
      {BLOCK_HINT[block.kind] && <p className="mt-1 text-[11px] text-ink-600">{BLOCK_HINT[block.kind]}</p>}
    </div>
  );
}

function cleanNumeric(raw: string, decimal: boolean): string {
  let s = raw.replace(decimal ? /[^\d.]/g : /[^\d]/g, "");
  if (decimal) {
    const dot = s.indexOf(".");
    if (dot >= 0) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, ""); // keep only the first dot
  }
  return s;
}

function NumOverride({
  label,
  value,
  onChange,
  decimal,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  decimal?: boolean;
}) {
  // Hold the raw text so intermediate values ("0.", "0.70") aren't collapsed by
  // the numeric round-trip; only re-sync from the prop when it truly differs.
  const [text, setText] = useState<string>(value == null ? "" : String(value));
  useEffect(() => {
    const cur = text.trim() === "" ? undefined : Number(text);
    if (cur !== value && !(Number.isNaN(cur as number) && value === undefined)) {
      setText(value == null ? "" : String(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div>
      <label className="label">{label}</label>
      <input
        className="input"
        type="text"
        inputMode="decimal"
        value={text}
        placeholder="inherit"
        onFocus={selectAll}
        onChange={(e) => {
          const cleaned = cleanNumeric(e.target.value, !!decimal);
          setText(cleaned);
          if (cleaned.trim() === "") return onChange(undefined);
          const n = Number(cleaned);
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
