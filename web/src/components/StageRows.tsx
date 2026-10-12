import type { ReactNode } from "react";
import type { AgentCondition, AgentContextBlock, AgentTransition } from "../types";
import { BLOCK_ROLES, CONDITIONS, CONTEXT_BLOCKS, GOTO_END, condHasValue, condIsOutput, condIsRegex, newCondition, type BlockRole } from "../lib/agentStage";
import { useI18n } from "../lib/i18n";
import { ACTION_ICON } from "../lib/icons";
import { Button } from "./Button";
import { RowPanel } from "./EditorCard";
import { FieldHint } from "./Field";
import { Select, TextArea, TextInput, type SelectOption } from "./inputs";

/** The compact controls of a row: `box` is the height and width ("h-7 w-24"). */
export const dense = (box: string): string => `${box} py-0 text-xs`;

/**
 * Options over stage names. The names are what the user is typing, so two can
 * be equal (or empty) at any moment: the options are keyed by position.
 */
export const stageOptions = (names: readonly string[]): SelectOption<string>[] => names.map((name, key) => ({ key, value: name, label: name }));

const ROLE_LABEL: Record<BlockRole, string> = { user: "stageEditor.roleUser", assistant: "stageEditor.roleAssistant" };

/** Who a block speaks as. `first` is the role offered first: the one a new block of that kind has. */
function RoleSelect({ value, first, onChange }: { value: BlockRole; first: BlockRole; onChange: (role: BlockRole) => void }) {
  const { t } = useI18n();
  const order = [first, ...BLOCK_ROLES.filter((r) => r !== first)];
  return <Select className={dense("h-7 w-24")} value={value} onChange={onChange} options={order.map((r) => ({ value: r, label: t(ROLE_LABEL[r]) }))} />;
}

/** One block of a stage's input: its kind, the kind's own fields, and its place in the list. */
export function ContextBlockRow({
  block,
  earlier,
  onChange,
  onMove,
  onRemove,
}: {
  block: AgentContextBlock;
  earlier: string[];
  onChange: (b: AgentContextBlock) => void;
  /** -1 = one up, 1 = one down. */
  onMove: (dir: number) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const spec = CONTEXT_BLOCKS[block.kind];
  return (
    <RowPanel>
      <div className="flex items-center gap-2">
        <span className="badge-gray">{t(spec.labelKey)}</span>
        {block.kind === "stage_output" && (
          <>
            <Select
              className={dense("h-7 w-28")}
              value={block.stage}
              onChange={(stage) => onChange({ ...block, stage })}
              options={stageOptions(earlier)}
              placeholder={earlier.length === 0 ? t("stageEditor.noEarlierStage") : undefined}
            />
            <span className="text-ink-500">{t("stageEditor.as")}</span>
            <RoleSelect value={block.role} first="assistant" onChange={(role) => onChange({ ...block, role })} />
          </>
        )}
        {block.kind === "message" && <RoleSelect value={block.role} first="user" onChange={(role) => onChange({ ...block, role })} />}
        <div className="flex-1" />
        <Button variant="ghost" size="xs" title={t("stageEditor.moveUp")} icon="bi-arrow-up" onClick={() => onMove(-1)} />
        <Button variant="ghost" size="xs" title={t("stageEditor.moveDown")} icon="bi-arrow-down" onClick={() => onMove(1)} />
        <Button variant="danger" size="xs" icon={ACTION_ICON.close} onClick={onRemove} />
      </div>

      {block.kind === "message" && (
        <TextArea
          mono
          className="mt-1.5 min-h-[36px]"
          value={block.text}
          onChange={(e) => onChange({ ...block, text: e.target.value })}
          placeholder={t("stageEditor.messageTextPlaceholder")}
        />
      )}
      {block.kind === "tool_turn" && (
        <div className="mt-1.5 space-y-1.5">
          <TextInput
            mono
            className="h-8 py-0"
            value={block.name}
            onChange={(e) => onChange({ ...block, name: e.target.value })}
            placeholder={t("stageEditor.toolNamePlaceholder")}
          />
          <TextArea
            mono
            className="min-h-[32px]"
            value={block.input}
            onChange={(e) => onChange({ ...block, input: e.target.value })}
            placeholder={t("stageEditor.toolArgumentsPlaceholder")}
          />
          <TextArea
            mono
            className="min-h-[32px]"
            value={block.result}
            onChange={(e) => onChange({ ...block, result: e.target.value })}
            placeholder={t("stageEditor.toolResultPlaceholder")}
          />
          <label className="flex items-center gap-2 text-ink-400">
            <input type="checkbox" checked={!!block.isError} onChange={(e) => onChange({ ...block, isError: e.target.checked || undefined })} />
            {t("stageEditor.markAsError")}
          </label>
        </div>
      )}
      {spec.hintKey && <FieldHint tone="faint">{t(spec.hintKey)}</FieldHint>}
    </RowPanel>
  );
}

/** One line of a transition: a fixed-width caption, then its controls. */
function TransitionLine({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-12 shrink-0 text-ink-500">{caption}</span>
      {children}
    </div>
  );
}

/** One transition of a stage: when it applies, and where the run goes then. */
export function TransitionRow({
  transition,
  earlier,
  later,
  outputStages,
  onChange,
  onRemove,
}: {
  transition: AgentTransition;
  earlier: string[];
  later: string[];
  /** The stages whose output an "end" transition can return. */
  outputStages: string[];
  onChange: (t: AgentTransition) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const c = transition.when;
  const setWhen = (when: AgentCondition) => onChange({ ...transition, when });
  return (
    <RowPanel className="space-y-2">
      <TransitionLine caption={t("stageEditor.when")}>
        <Select
          className={dense("h-8 w-40")}
          value={c.type}
          onChange={(type) => setWhen(newCondition(type))}
          options={CONDITIONS.map((o) => ({ value: o.type, label: t(o.labelKey) }))}
        />
        {condIsOutput(c) && (
          <Select
            className={dense("h-8 w-32")}
            value={(c as { stage?: string }).stage ?? ""}
            onChange={(stage) => setWhen({ ...c, stage: stage || undefined } as AgentCondition)}
            options={stageOptions(earlier)}
            placeholder={t("stageEditor.thisStage")}
          />
        )}
        {condHasValue(c) && (
          <TextInput
            mono
            className="h-8 min-w-[8rem] flex-1 py-0"
            value={(c as { value: string }).value}
            onChange={(e) => setWhen({ ...c, value: e.target.value } as AgentCondition)}
            placeholder={condIsRegex(c) ? t("stageEditor.regexPlaceholder") : t("stageEditor.textToFindPlaceholder")}
          />
        )}
      </TransitionLine>
      {/* The target and, for "end", which stage's output to return. */}
      <TransitionLine caption={t("stageEditor.goTo")}>
        <Select
          className={dense("h-8 w-32")}
          value={transition.goto}
          onChange={(goto) => onChange({ ...transition, goto, output: goto === GOTO_END ? transition.output : undefined })}
          options={[{ value: GOTO_END, label: t("stageEditor.endReturn") }, ...stageOptions(later)]}
        />
        {transition.goto === GOTO_END && (
          <>
            <span className="text-ink-500">{t("stageEditor.returning")}</span>
            <Select
              className={dense("h-8 w-32")}
              value={transition.output ?? ""}
              onChange={(output) => onChange({ ...transition, output: output || undefined })}
              options={stageOptions(outputStages)}
              placeholder={t("stageEditor.thisStageOutput")}
            />
          </>
        )}
        <div className="flex-1" />
        <Button variant="danger" size="xs" className="shrink-0" onClick={onRemove} title={t("stageEditor.removeTransitionTitle")} icon={ACTION_ICON.close} />
      </TransitionLine>
    </RowPanel>
  );
}
