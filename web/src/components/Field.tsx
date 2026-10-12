import type { ReactNode } from "react";

const HINT_TONE = {
  normal: "text-xs text-ink-500",
  faint: "text-[11px] text-ink-600",
  /** Something is wrong with the choice above (a legacy definition, nothing to pick from). */
  warning: "text-xs text-amber-300",
  /** The dimmer warning of the ASR pre-pass. */
  "warning-dim": "text-xs text-amber-400/90",
} as const;
const HINT_MARGIN = { below: "mt-1", above: "mb-1", "above-loose": "mb-2" } as const;

export type HintTone = keyof typeof HINT_TONE;
export type HintPosition = keyof typeof HINT_MARGIN;

/** The small explanatory line under (or over) a control. */
export function FieldHint({
  tone = "normal",
  position = "below",
  children,
}: {
  tone?: HintTone;
  position?: HintPosition;
  children: ReactNode;
}) {
  return <p className={`${HINT_MARGIN[position]} ${HINT_TONE[tone]}`}>{children}</p>;
}

export interface FieldProps {
  label: ReactNode;
  /**
   * Lower-case note after the caption ("optional", "leave blank to keep").
   * Pass `false` for "no note right now" on a field that sometimes has one:
   * the caption then keeps its trailing space, exactly as the hand-written
   * `{label} {cond && <span/>}` did.
   */
  suffix?: ReactNode;
  hint?: ReactNode;
  hintTone?: HintTone;
  /** "below" the control (default), or "above"/"above-loose" between caption and control. */
  hintPosition?: HintPosition;
  /**
   * "div" (default): a detached <label class="label"> beside the control, as
   * nearly every form here has it. "label": the control sits inside a <label>
   * (click-to-focus) with the caption in a <span class="label"> -- the Tools
   * and hosted-tool forms.
   */
  as?: "div" | "label";
  /** Classes of the wrapper ("col-span-2", "block"). */
  className?: string;
  children: ReactNode;
}

/** Caption + control + hint: the row every form is made of. */
export function Field({ label, suffix, hint, hintTone, hintPosition = "below", as = "div", className, children }: FieldProps) {
  const caption = (
    <>
      {label}
      {suffix !== undefined && " "}
      {suffix ? <span className="normal-case text-ink-500">{suffix}</span> : null}
    </>
  );
  const hintEl = hint ? (
    <FieldHint tone={hintTone} position={hintPosition}>
      {hint}
    </FieldHint>
  ) : null;
  const above = hintPosition !== "below";
  const body = (
    <>
      {above && hintEl}
      {children}
      {!above && hintEl}
    </>
  );
  if (as === "label") {
    return (
      <label className={className}>
        <span className="label">{caption}</span>
        {body}
      </label>
    );
  }
  return (
    <div className={className}>
      <label className="label">{caption}</label>
      {body}
    </div>
  );
}
