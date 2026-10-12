import { useState, type ReactNode } from "react";
import type { Overrides } from "../types";
import { useI18n } from "../lib/i18n";
import { Chevron } from "./Disclosure";
import { InsetPanel } from "./EditorCard";
import { Field } from "./Field";
import { OptionalIntInput } from "./numeric";
import { OverridesEditor } from "./OverridesEditor";

/** The text button with a chevron that opens and closes a section below it. */
export function DisclosureToggle({
  open,
  onToggle,
  className = "text-xs text-ink-500 hover:text-ink-300",
  type,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  className?: string;
  /** Only the step editor's toggle declares `type="button"`. */
  type?: "button";
  children: ReactNode;
}) {
  return (
    <button type={type} className={className} onClick={onToggle}>
      <Chevron open={open} className="mr-1" />
      {children}
    </button>
  );
}

/** Closed-by-default state for a `DisclosureToggle` or `AdvancedOverrides`: spread it onto either. */
export function useDisclosure(): { open: boolean; onToggle: () => void } {
  const [open, setOpen] = useState(false);
  return { open, onToggle: () => setOpen((o) => !o) };
}

/**
 * Where the section sits, which the three editors do differently:
 * - `step`: toggle flush, a dot on it once overrides exist, the overrides editor alone below;
 * - `stage`: toggle and panel each set off by a top margin, the panel holding
 *   the caller's fields, an optional timeout and the overrides editor;
 * - `ocr`: the same panel, spaced by the surrounding stack instead.
 */
const VARIANT = {
  step: { toggle: "", body: "mt-2", panel: false, flagOverrides: true, type: "button" },
  stage: { toggle: "mt-2 ", body: "mt-2 space-y-3", panel: true, flagOverrides: false, type: undefined },
  ocr: { toggle: "", body: "space-y-3", panel: true, flagOverrides: false, type: undefined },
} as const;

/**
 * An "advanced" section ending in the sampling overrides. It renders the
 * toggle and the section as siblings, so the caller's container decides their
 * spacing. Whether it is open is the caller's state: a section that is
 * conditionally rendered (a stage that stops calling a model, a pre-pass
 * switched off) is still open when it comes back.
 */
export function AdvancedOverrides({
  variant,
  label,
  open,
  onToggle,
  overrides,
  onOverrides,
  timeout,
  children,
}: {
  variant: keyof typeof VARIANT;
  label: string;
  open: boolean;
  onToggle: () => void;
  overrides: Overrides | undefined;
  onOverrides: (overrides: Overrides | undefined) => void;
  /** An optional per-call timeout above the overrides (panel variants). */
  timeout?: { label: string; value: number | undefined; onChange: (value: number | undefined) => void };
  /** Fields at the top of the panel (panel variants). */
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const v = VARIANT[variant];
  const editor = <OverridesEditor overrides={overrides} onChange={onOverrides} />;
  return (
    <>
      <DisclosureToggle
        open={open}
        onToggle={onToggle}
        type={v.type}
        className={`${v.toggle}text-xs text-ink-500 hover:text-ink-300`}
      >
        {label}
        {v.flagOverrides && !!overrides && Object.keys(overrides).length > 0 && <span className="ml-1 text-brand-400">●</span>}
      </DisclosureToggle>
      {open &&
        (v.panel ? (
          <InsetPanel className={v.body}>
            {children}
            {timeout && (
              <div className="grid grid-cols-3 gap-3">
                <Field label={timeout.label}>
                  <OptionalIntInput value={timeout.value} onChange={timeout.onChange} placeholder={t("stageEditor.inheritPlaceholder")} />
                </Field>
              </div>
            )}
            {editor}
          </InsetPanel>
        ) : (
          <div className={v.body}>{editor}</div>
        ))}
    </>
  );
}
