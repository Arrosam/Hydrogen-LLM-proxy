import { useRef } from "react";
import type { AgentContextBlock, AgentStage, AgentTransition, ModelService } from "../types";
import {
  CONTEXT_BLOCK_MENU,
  GOTO_END,
  ROUTER,
  TOOLS_MODE,
  duplicateStage,
  hasLegacyInlineSteps,
  isModelStage,
  newContextBlock,
  newStage,
  renameStage,
  stageNameFromInput,
} from "../lib/agentStage";
import { moveItem, patchAt, removeAt, replaceAt } from "../lib/collections";
import { useI18n } from "../lib/i18n";
import { agentServices, chatServices, stageServices } from "../lib/services";
import { useReorderableList } from "../lib/useReorderableList";
import { AdvancedOverrides, useDisclosure } from "./AdvancedOverrides";
import { AddButton, EditorCard, ListHeader } from "./EditorCard";
import { Field, FieldHint } from "./Field";
import { Select, TextInput } from "./inputs";
import { DashedHint } from "./Notice";
import { ServiceOptions, ServiceSelect } from "./PrePassEditors";
import { ContextBlockRow, TransitionRow, dense, stageOptions } from "./StageRows";

interface Props {
  stages: AgentStage[];
  /** Name of the stage whose output the agent returns; "" = the default. */
  output: string;
  onChange: (stages: AgentStage[], output: string) => void;
  services: ModelService[]; // the services a stage may reference
}

/** The stages of a Micro Agent: an ordered, reorderable list, and which stage's output is returned. */
export function StageEditor({ stages, output, onChange, services }: Props) {
  const { t } = useI18n();
  const setStages = (next: AgentStage[]) => onChange(next, output);
  const list = useReorderableList(stages, setStages);
  const names = (of: AgentStage[]) => of.map((s) => s.name).filter(Boolean);
  /** Per stage (by its list key): the name its references still carry while its own cannot identify it, see `renameStage`. */
  const pendingNames = useRef(new Map<number, string>());

  const rename = (i: number, name: string) => {
    const key = list.keys[i];
    const next = renameStage(stages, output, i, name, pendingNames.current.get(key));
    if (next.pending === undefined) pendingNames.current.delete(key);
    else pendingNames.current.set(key, next.pending);
    onChange(next.stages, next.output);
  };

  return (
    <div>
      <ListHeader
        label={t("stageEditor.stagesLabel")}
        // A new stage runs the first service a stage can run (the "runs" select offers no other).
        action={<AddButton onClick={() => list.append(newStage(stages, stageServices(services)[0]?.name))}>{t("stageEditor.addStage")}</AddButton>}
      />

      {services.length === 0 && (
        <p className="mb-2 rounded-lg border border-amber-700/40 bg-amber-700/10 px-3 py-2 text-xs text-amber-300">{t("stageEditor.noServicesWarning")}</p>
      )}
      {stages.length === 0 && <DashedHint size="lg">{t("stageEditor.noStagesHint")}</DashedHint>}

      <div className="space-y-2">
        {stages.map((stage, i) => {
          const patch = (p: Partial<AgentStage>) => setStages(patchAt(stages, i, p));
          const before = stages.slice(0, i);
          return (
            <EditorCard
              key={list.keys[i]}
              badge={t("stageEditor.stageNumber", { n: i + 1 })}
              headerExtra={
                <TextInput
                  mono
                  className="h-7 w-40 py-0"
                  value={stage.name}
                  onChange={(e) => rename(i, stageNameFromInput(e.target.value))}
                  placeholder={t("stageEditor.stageNamePlaceholder")}
                />
              }
              dragTitle={t("stageEditor.dragToReorder")}
              duplicateTitle={t("stageEditor.duplicateStageTitle")}
              onDuplicate={() => list.insertAfter(i, duplicateStage(stages, stage))}
              // Removing the stage the agent returns falls back to the default output.
              onRemove={() => list.remove(i, (next) => onChange(next, output === stage.name ? "" : output))}
              dragHandleProps={list.dragHandleProps(i)}
              dropTargetProps={list.dropTargetProps(i)}
            >
              <StageBody
                stage={stage}
                services={services}
                earlier={names(before)}
                earlierModel={names(before.filter(isModelStage))}
                later={names(stages.slice(i + 1))}
                onPatch={patch}
              />
            </EditorCard>
          );
        })}
      </div>

      {stages.length > 1 && (
        <div className="mt-3 flex items-center gap-2">
          <label className="label mb-0">{t("stageEditor.returnOutputOf")}</label>
          <Select
            className="w-auto"
            value={output}
            onChange={(v) => onChange(stages, v)}
            options={stageOptions(stages.map((s) => s.name))}
            placeholder={t("stageEditor.defaultOutput")}
          />
        </div>
      )}
    </div>
  );
}

function StageBody({
  stage,
  services,
  earlier,
  earlierModel,
  later,
  onPatch,
}: {
  stage: AgentStage;
  services: ModelService[];
  /** Names of the stages before this one, of those that call a model, and of the stages after it. */
  earlier: string[];
  earlierModel: string[];
  later: string[];
  onPatch: (p: Partial<AgentStage>) => void;
}) {
  const { t } = useI18n();
  const advanced = useDisclosure();
  const model = isModelStage(stage);
  const agents = agentServices(services);
  const transitions = stage.transitions ?? [];
  const setBlocks = (input: AgentContextBlock[]) => onPatch({ input });
  const setTransitions = (next: AgentTransition[]) => onPatch({ transitions: next });

  return (
    <>
      <Field label={t("stageEditor.runs")}>
        <ServiceSelect
          value={stage.service ?? (model ? "" : ROUTER)}
          // The router and the placeholder both leave the stage without a service.
          onChange={(v) => onPatch({ service: v === ROUTER ? undefined : v, steps: undefined })}
          placeholder={t("stageEditor.pickService")}
        >
          <optgroup label={t("stageEditor.modelServicesGroup")}>
            <ServiceOptions services={chatServices(services)} />
          </optgroup>
          {agents.length > 0 && (
            <optgroup label={t("stageEditor.microAgentsGroup")}>
              <ServiceOptions services={agents} />
            </optgroup>
          )}
          <option value={ROUTER}>{t("stageEditor.routerOption")}</option>
        </ServiceSelect>
        {hasLegacyInlineSteps(stage) && <FieldHint tone="warning">{t("stageEditor.legacyInlineWarning")}</FieldHint>}
        {!model && <FieldHint>{t("stageEditor.routerHint")}</FieldHint>}
      </Field>

      {model && (
        <>
          <div className="mt-3">
            <ListHeader
              as="label"
              gap="sm"
              label={t("stageEditor.input")}
              hint={t("stageEditor.inputHint")}
              action={
                <Select
                  className={dense("h-7 w-auto")}
                  value=""
                  onChange={(v) => {
                    if (v) setBlocks([...stage.input, newContextBlock(v, earlier)]);
                  }}
                  options={CONTEXT_BLOCK_MENU.map((b) => ({ value: b.value, label: t(b.labelKey) }))}
                  placeholder={t("stageEditor.addContextBlock")}
                />
              }
            />
            <div className="space-y-1.5">
              {stage.input.map((block, bi) => (
                <ContextBlockRow
                  key={bi}
                  block={block}
                  earlier={earlier}
                  onChange={(b) => setBlocks(replaceAt(stage.input, bi, b))}
                  onMove={(dir) => {
                    const to = bi + dir;
                    if (to >= 0 && to < stage.input.length) setBlocks(moveItem(stage.input, bi, to));
                  }}
                  onRemove={() => setBlocks(removeAt(stage.input, bi))}
                />
              ))}
            </div>
          </div>

          <AdvancedOverrides
            {...advanced}
            variant="stage"
            label={t("stageEditor.advancedLabel")}
            timeout={{ label: t("stageEditor.timeoutMs"), value: stage.timeoutMs, onChange: (timeoutMs) => onPatch({ timeoutMs }) }}
            overrides={stage.overrides}
            onOverrides={(overrides) => onPatch({ overrides })}
          >
            <Field label={t("stageEditor.tools")} hint={t("stageEditor.toolsHint")} hintTone="faint">
              <Select
                value={stage.tools ?? TOOLS_MODE.inherit}
                onChange={(v) => onPatch({ tools: v === TOOLS_MODE.none ? TOOLS_MODE.none : undefined })}
                options={[
                  { value: TOOLS_MODE.inherit, label: t("stageEditor.toolsInherit") },
                  { value: TOOLS_MODE.none, label: t("stageEditor.toolsListedOnly") },
                ]}
              />
            </Field>
          </AdvancedOverrides>
        </>
      )}

      <div className="mt-3">
        <ListHeader
          as="label"
          gap="sm"
          label={t("stageEditor.transitions")}
          hint={t("stageEditor.transitionsHint")}
          action={
            <AddButton onClick={() => setTransitions([...transitions, { when: { type: "always" }, goto: later[0] ?? GOTO_END }])}>
              {t("stageEditor.addTransition")}
            </AddButton>
          }
        />
        <div className="space-y-1.5">
          {transitions.map((tr, ti) => (
            <TransitionRow
              key={ti}
              transition={tr}
              earlier={earlier}
              later={later}
              outputStages={earlierModel}
              onChange={(next) => setTransitions(replaceAt(transitions, ti, next))}
              onRemove={() => setTransitions(removeAt(transitions, ti))}
            />
          ))}
        </div>
      </div>
    </>
  );
}
