import type { ReactNode } from "react";
import type { AgentAsr, AgentOcr, ModelService } from "../types";
import { hasLegacyInlineSteps } from "../lib/agentStage";
import { useI18n } from "../lib/i18n";
import { intInput } from "../lib/input";
import { DEFAULT_OCR_PROMPT } from "../lib/ocrPrompt";
import { DEFAULT_SERVICE_TIMEOUT_MS } from "../lib/serviceDef";
import { chatServices, sttServices } from "../lib/services";
import { AdvancedOverrides, useDisclosure } from "./AdvancedOverrides";
import { Toggle } from "./common";
import { EditorPanel, ListHeader } from "./EditorCard";
import { Field, FieldHint } from "./Field";
import { TextArea, TextInput } from "./inputs";
import { OcrTester, ResetLink } from "./OcrTester";

/** Shortest timeout the ASR pre-pass accepts. */
const MIN_PREPASS_TIMEOUT_MS = 1_000;

/**
 * Pick a service by name. The services are listed after the placeholder;
 * `children` are further <option>/<optgroup> elements after those. Picking the
 * placeholder reports `undefined`.
 */
export function ServiceSelect({
  value,
  onChange,
  placeholder,
  services = [],
  children,
}: {
  value: string;
  onChange: (name: string | undefined) => void;
  placeholder: string;
  services?: readonly ModelService[];
  children?: ReactNode;
}) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">{placeholder}</option>
      <ServiceOptions services={services} />
      {children}
    </select>
  );
}

/** One <option> per service, by name. */
export function ServiceOptions({ services }: { services: readonly ModelService[] }) {
  return (
    <>
      {services.map((m) => (
        <option key={m.name} value={m.name}>
          {m.name}
        </option>
      ))}
    </>
  );
}

/**
 * An optional step that runs before an agent's first stage: a switch, what it
 * does, and -- while on -- its settings. Switching on creates the settings
 * with `create`, switching off discards them.
 */
function PrePassCard<T>({
  value,
  create,
  onChange,
  label,
  description,
  children,
}: {
  value: T | undefined;
  create: () => T;
  onChange: (value: T | undefined) => void;
  label: string;
  description: string;
  children: (value: T) => ReactNode;
}) {
  return (
    <EditorPanel>
      <Toggle checked={Boolean(value)} onChange={(on) => onChange(on ? create() : undefined)} label={label} />
      <FieldHint>{description}</FieldHint>
      {value ? children(value) : null}
    </EditorPanel>
  );
}

interface PrePassProps<T> {
  onChange: (value: T | undefined) => void;
  services: ModelService[];
}

/** Optional audio→text ASR pre-pass configured on a chain (runs before stage 1).
 * Points at an stt-category Model Service — the pre-pass drives the provider's
 * /audio/transcriptions endpoint with the chain's retry rules. */
export function AsrEditor({ asr, onChange, services }: PrePassProps<AgentAsr> & { asr: AgentAsr | undefined }) {
  const { t } = useI18n();
  const candidates = sttServices(services);
  return (
    <PrePassCard
      value={asr}
      create={() => ({ service: candidates[0]?.name })}
      onChange={onChange}
      label={t("asr.toggleLabel")}
      description={t("asr.description")}
    >
      {(asr) => {
        const patch = (p: Partial<AgentAsr>) => onChange({ ...asr, ...p });
        return (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label={t("asr.modelRuns")}>
              <ServiceSelect
                value={asr.service ?? ""}
                onChange={(service) => patch({ service, steps: undefined })}
                placeholder={t("asr.pickService")}
                services={candidates}
              />
              {candidates.length === 0 && <FieldHint tone="warning-dim">{t("asr.noSttServices")}</FieldHint>}
            </Field>
            <Field label={t("asr.timeout")}>
              {/* Unlike the stage and OCR timeouts (`OptionalIntInput`: digits only, no floor), this one
                  is clamped to a floor as it is typed, and non-numeric text becomes the default. */}
              <TextInput
                mono
                inputMode="numeric"
                value={asr.timeoutMs ?? ""}
                placeholder={String(DEFAULT_SERVICE_TIMEOUT_MS)}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  patch({ timeoutMs: v ? intInput(v, DEFAULT_SERVICE_TIMEOUT_MS, MIN_PREPASS_TIMEOUT_MS) : undefined });
                }}
              />
            </Field>
          </div>
        );
      }}
    </PrePassCard>
  );
}

/** Optional image→text OCR pre-pass configured on a chain (runs before stage 1). */
export function OcrEditor({ ocr, onChange, services }: PrePassProps<AgentOcr> & { ocr: AgentOcr | undefined }) {
  const { t } = useI18n();
  // Held here, not inside the card: switching the pre-pass off and on again leaves the section as it was.
  const advanced = useDisclosure();
  // The OCR pre-pass is a single vision-model call — chat or ocr resilience
  // services (an "ocr" service is the natural pick), never Micro Agents.
  const candidates = chatServices(services);
  return (
    <PrePassCard
      value={ocr}
      create={() => ({ service: candidates[0]?.name })}
      onChange={onChange}
      label={t("ocr.toggleLabel")}
      description={t("ocr.description")}
    >
      {(ocr) => {
        const patch = (p: Partial<AgentOcr>) => onChange({ ...ocr, ...p });
        return (
          <div className="mt-3 space-y-3">
            <Field label={t("ocr.modelRuns")}>
              <ServiceSelect
                value={ocr.service ?? ""}
                onChange={(service) => patch({ service, steps: undefined })}
                placeholder={t("ocr.pickService")}
                services={candidates}
              />
              {hasLegacyInlineSteps(ocr) && <FieldHint tone="warning">{t("stageEditor.legacyInlineWarning")}</FieldHint>}
              {candidates.length === 0 && <FieldHint tone="warning">{t("ocr.noServicesWarning")}</FieldHint>}
            </Field>

            <AdvancedOverrides
              {...advanced}
              variant="ocr"
              label={t("ocr.advancedLabel")}
              timeout={{ label: t("stageEditor.timeoutMs"), value: ocr.timeoutMs, onChange: (timeoutMs) => patch({ timeoutMs }) }}
              overrides={ocr.overrides}
              onOverrides={(overrides) => patch({ overrides })}
            >
              <div>
                <ListHeader
                  as="label"
                  gap="xs"
                  label={t("ocr.promptLabel")}
                  action={<ResetLink onClick={() => patch({ prompt: DEFAULT_OCR_PROMPT })}>{t("ocr.loadDefault")}</ResetLink>}
                />
                <TextArea
                  mono
                  className="min-h-[120px]"
                  value={ocr.prompt ?? ""}
                  onChange={(e) => patch({ prompt: e.target.value || undefined })}
                  placeholder={t("ocr.promptPlaceholder")}
                />
                <FieldHint tone="faint">{t("ocr.promptHint")}</FieldHint>
              </div>
            </AdvancedOverrides>

            <OcrTester ocr={ocr} />
          </div>
        );
      }}
    </PrePassCard>
  );
}
