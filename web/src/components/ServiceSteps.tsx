import type { AdvanceTrigger, Model, ServiceStep, Trigger } from "../types";
import { replaceAt, toggleMember } from "../lib/collections";
import { HTTP_STATUS_RANGE } from "../lib/http";
import { useI18n } from "../lib/i18n";
import { DEFAULT_RETRY, DEFAULT_RETRY_ON } from "../lib/serviceDef";
import { blankStep, duplicateStep, withRetry } from "../lib/serviceForm";
import { useReorderableList } from "../lib/useReorderableList";
import { AdvancedOverrides, useDisclosure } from "./AdvancedOverrides";
import { Icon } from "./Button";
import { ChipMultiSelect, type ChipOption } from "./Chip";
import { AddButton, EditorCard, ListHeader } from "./EditorCard";
import { Field } from "./Field";
import { Select, nameOptions } from "./inputs";
import { DashedHint } from "./Notice";
import { IntInput } from "./numeric";

/** Fewest attempts a retry policy can ask for (one try, no retry). */
const MIN_RETRY_ATTEMPTS = 1;

const CODE_PRESETS: Trigger[] = [429, 499, 500, 502, 503, 529];

/**
 * One selectable trigger: `value` is the wire enum the server validates against,
 * `label` is only what the user reads. They must stay separate — a label is
 * translated, and a translated value is not a trigger the server accepts.
 */
type TriggerOption = ChipOption<AdvanceTrigger>;

/** The non-numeric triggers, each with the i18n key for its label. */
const SYMBOLIC_TRIGGERS = {
  timeout: "trigger.timeout",
  network: "trigger.network",
  error: "trigger.error",
  exhausted: "trigger.exhausted",
} as const;

type SymbolicTrigger = keyof typeof SYMBOLIC_TRIGGERS;

/** What a step can retry on, and what it can additionally hand over to the next step on. */
const RETRY_TRIGGERS: readonly SymbolicTrigger[] = ["timeout", "network", "error"];
const ADVANCE_TRIGGERS: readonly SymbolicTrigger[] = [...RETRY_TRIGGERS, "exhausted"];

const CODE_OPTIONS: TriggerOption[] = CODE_PRESETS.map((c) => ({ value: c, label: String(c) }));

/** The preset codes followed by the symbolic triggers in `names` order, labelled in the current language. */
function triggerOptions(t: (key: string) => string, names: readonly SymbolicTrigger[]): TriggerOption[] {
  return [...CODE_OPTIONS, ...names.map((name) => ({ value: name, label: t(SYMBOLIC_TRIGGERS[name]) }))];
}

/** A typed entry of the trigger box: an HTTP status code, or one of the
 * symbolic triggers the box offers (`names`), by its wire name (compared by
 * fixed enum value, never by label). */
function parseTrigger(raw: string, names: readonly SymbolicTrigger[]): AdvanceTrigger | null {
  const code = Number(raw);
  if (Number.isInteger(code) && code >= HTTP_STATUS_RANGE.min && code <= HTTP_STATUS_RANGE.max) return code;
  return (names as readonly string[]).includes(raw) ? (raw as SymbolicTrigger) : null;
}

/**
 * Trigger chip editor: preset chips plus a box for any other HTTP status code.
 *
 * Used for both `retry.on` (Trigger[]) and `advanceOn` (AdvanceTrigger[], which
 * also includes "exhausted").
 */
function TriggerChips({
  names,
  selected,
  onToggle,
}: {
  names: readonly SymbolicTrigger[];
  selected: readonly AdvanceTrigger[];
  onToggle: (v: AdvanceTrigger) => void;
}) {
  const { t } = useI18n();
  return (
    <ChipMultiSelect
      options={triggerOptions(t, names)}
      selected={selected}
      onToggle={onToggle}
      removeTitle={t("serviceEditor.clickToRemove")}
      custom={{
        parse: (raw) => parseTrigger(raw, names),
        placeholder: t("serviceEditor.httpCodePlaceholder"),
        addLabel: t("serviceEditor.add"),
        hint: t("serviceEditor.httpCodeHint"),
        inputMode: "numeric",
      }}
    />
  );
}

/** The form of one step: what to call, how to retry it, and when to give up on it. */
function StepFields({
  step,
  last,
  models,
  providersForModel,
  onChange,
}: {
  step: ServiceStep;
  /** The last step has nothing to advance to. */
  last: boolean;
  models: Model[];
  providersForModel: (model: string) => string[];
  onChange: (step: ServiceStep) => void;
}) {
  const { t } = useI18n();
  const advanced = useDisclosure();
  const patch = (p: Partial<ServiceStep>) => onChange({ ...step, ...p });
  const retry = (p: Parameters<typeof withRetry>[1]) => onChange(withRetry(step, p));
  const providers = providersForModel(step.model);
  // No explicit policy (or one without `on`): the server retries on its default set, so that is what is shown.
  const retryOn: readonly Trigger[] = step.retry?.on ?? DEFAULT_RETRY_ON;
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("serviceEditor.model")}>
          <Select
            value={step.model}
            options={nameOptions(models.map((m) => m.name))}
            onChange={(model) => {
              const mapped = providersForModel(model);
              patch({ model, provider: mapped.includes(step.provider) ? step.provider : mapped[0] ?? "" });
            }}
          />
        </Field>
        <Field label={t("serviceEditor.provider")}>
          <Select
            value={step.provider}
            options={nameOptions(providers)}
            placeholder={providers.length === 0 ? t("serviceEditor.noProvidersMapped") : undefined}
            onChange={(provider) => patch({ provider })}
          />
        </Field>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label={t("serviceEditor.retryAttempts")}>
          <IntInput
            value={step.retry?.maxAttempts ?? DEFAULT_RETRY.maxAttempts}
            fallback={MIN_RETRY_ATTEMPTS}
            min={MIN_RETRY_ATTEMPTS}
            onChange={(maxAttempts) => retry({ maxAttempts })}
          />
        </Field>
        <Field label={t("serviceEditor.retryInterval")}>
          <IntInput
            value={step.retry?.intervalMs ?? DEFAULT_RETRY.intervalMs}
            fallback={DEFAULT_RETRY.intervalMs}
            onChange={(intervalMs) => retry({ intervalMs })}
          />
        </Field>
      </div>

      <Field className="mt-3" label={t("serviceEditor.retryOn")}>
        <TriggerChips names={RETRY_TRIGGERS} selected={retryOn} onToggle={(v) => retry({ on: toggleMember(retryOn, v as Trigger) })} />
      </Field>

      <div className="mt-3">
        <AdvancedOverrides
          {...advanced}
          variant="step"
          label={t("serviceEditor.advancedOverrides")}
          overrides={step.overrides}
          onOverrides={(overrides) => patch({ overrides })}
        />
      </div>

      {!last && (
        <Field className="mt-3" label={t("serviceEditor.advanceOnLabel")} suffix={t("serviceEditor.advanceOnHint")}>
          <TriggerChips
            names={ADVANCE_TRIGGERS}
            selected={step.advanceOn ?? []}
            onToggle={(v) => patch({ advanceOn: toggleMember(step.advanceOn, v) })}
          />
        </Field>
      )}
    </>
  );
}

/** A line of small print between or under the step cards. */
function ChainNote({ icon, className, children }: { icon: string; className: string; children: string }) {
  return (
    <div className={`flex items-center gap-2 ${className} text-xs text-ink-500`}>
      <Icon name={icon} />
      {children}
    </div>
  );
}

/** The failure chain of a Model Service: an ordered, reorderable list of steps. */
export function StepList({
  steps,
  onChange,
  models,
  providersForModel,
}: {
  steps: ServiceStep[];
  onChange: (steps: ServiceStep[]) => void;
  models: Model[];
  providersForModel: (model: string) => string[];
}) {
  const { t } = useI18n();
  const list = useReorderableList(steps, onChange);

  const addStep = () => {
    const model = models[0]?.name ?? "";
    list.append(blankStep(model, providersForModel(model)[0] ?? ""));
  };

  return (
    <div>
      <ListHeader label={t("serviceEditor.failureChain")} action={<AddButton onClick={addStep}>{t("serviceEditor.addStep")}</AddButton>} />

      {steps.length === 0 && <DashedHint size="lg">{t("serviceEditor.noStepsHint")}</DashedHint>}

      <div className="space-y-1">
        {steps.map((step, i) => {
          const last = i === steps.length - 1;
          return (
            <div key={list.keys[i]}>
              <EditorCard
                badge={t("serviceEditor.stepNumber", { n: i + 1 })}
                dragTitle={t("serviceEditor.dragToReorder")}
                duplicateTitle={t("serviceEditor.duplicateStepTitle")}
                onDuplicate={() => list.insertAfter(i, duplicateStep(step, providersForModel(step.model)))}
                onRemove={() => list.remove(i)}
                dragHandleProps={list.dragHandleProps(i)}
                dropTargetProps={list.dropTargetProps(i)}
              >
                <StepFields
                  step={step}
                  last={last}
                  models={models}
                  providersForModel={providersForModel}
                  onChange={(next) => onChange(replaceAt(steps, i, next))}
                />
              </EditorCard>
              {!last && (
                <ChainNote icon="bi-arrow-down" className="py-1 pl-4">
                  {t("serviceEditor.onFailure")}
                </ChainNote>
              )}
            </div>
          );
        })}
      </div>
      {steps.length > 0 && (
        <ChainNote icon="bi-x-octagon" className="pl-4 pt-1">
          {t("serviceEditor.lastStepFailsHint")}
        </ChainNote>
      )}
    </div>
  );
}
