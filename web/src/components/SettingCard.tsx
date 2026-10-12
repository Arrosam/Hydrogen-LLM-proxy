import { useEffect, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { useAction, type AsyncState } from "../lib/hooks";
import { AsyncStatus } from "./Page";
import { Button, type ButtonProps } from "./Button";
import { ErrorNote } from "./common";
import { TextInput } from "./inputs";
import { SectionCard } from "./Section";
import { useToast } from "./Toast";

/**
 * What the card shows of its own load:
 * - "silent": nothing. The field is there (empty) from the first paint and
 *   Save works at once.
 * - "gated": a spinner while loading and the error when it failed; the field,
 *   the buttons and the footer appear only once there is a value.
 * - "inlineError": the field is there from the first paint showing
 *   `initialText`, Save waits for the value, and a failed load is reported
 *   under the field.
 */
export type SettingLoadDisplay = "silent" | "gated" | "inlineError";

export interface NumericSettingCardProps<D> {
  /** "card" (default): icon, h3, the field on a row with its unit. "flat": a
   * section with an h2 whose row is a <label> wrapping caption, field and Save. */
  frame?: "card" | "flat";
  icon?: string;
  title: string;
  hint: string;

  /** The stored setting, loaded by the caller (`useAsync`). */
  state: Pick<AsyncState<D>, "data" | "loading" | "error">;
  loadDisplay: SettingLoadDisplay;

  /** The field's text before the stored value arrives. */
  initialText?: string;
  /** The stored value as the field shows it. */
  toText: (data: D) => string;
  /** Rewrites every keystroke before it is kept (a number box that snaps an emptied field to "0"). */
  normalize?: (raw: string) => string;
  /** The field's text as the number to save, or null when it is not acceptable. */
  parse: (raw: string) => number | null;
  /** Toast shown when `parse` answers null. */
  invalidMessage?: string;

  /** Stores the value; resolves to the success toast's text. */
  onSave: (value: number) => Promise<string>;
  /** After the success toast: usually the caller's `reload`. Omitted = the card keeps what was typed. */
  onSaved?: () => void;
  /** The error toast's text for a failed save. */
  describeSaveError: (e: unknown) => string;

  /** Attributes of the field (`type`, `inputMode`, `min`, `max`, `placeholder`, width class). */
  input: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean };
  /** Text before the field ("flat" frame). */
  caption?: string;
  /** Text after the field ("card" frame). */
  unit?: string;
  /** Let the row wrap when the buttons do not fit beside the field ("card" frame). */
  wrap?: boolean;

  saveLabel: string;
  /** The look of Save: its variant, size, icon, and whether the icon spins while saving. */
  saveButton: Pick<ButtonProps, "variant" | "size" | "icon" | "className" | "spinWhenBusy">;
  /** More buttons after Save, on the same row. */
  extraActions?: ReactNode;
  /** A line under the row (current usage). */
  footer?: ReactNode;
  /** Rendered last inside the card (a confirm dialog). */
  children?: ReactNode;
}

/**
 * A setting that is one number: load it, show it in a field, validate, save,
 * toast. The three cards built on it differ in every incidental -- frame,
 * field type, Save button, what a load shows, whether a save reloads, how a
 * failure reads -- and each of those is a prop here rather than a second card.
 */
export function NumericSettingCard<D>({
  frame = "card",
  icon,
  title,
  hint,
  state,
  loadDisplay,
  initialText = "",
  toText,
  normalize,
  parse,
  invalidMessage,
  onSave,
  onSaved,
  describeSaveError,
  input,
  caption,
  unit,
  wrap = false,
  saveLabel,
  saveButton,
  extraActions,
  footer,
  children,
}: NumericSettingCardProps<D>) {
  const toast = useToast();
  const { data } = state;
  const [text, setText] = useState(initialText);
  const saving = useAction({ describe: describeSaveError });

  useEffect(() => {
    if (data) setText(toText(data));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const save = async () => {
    const value = parse(text);
    if (value === null) {
      if (invalidMessage) toast.error(invalidMessage);
      return;
    }
    await saving.run(async () => {
      toast.success(await onSave(value));
      onSaved?.();
    });
  };

  const field = <TextInput {...input} value={text} onChange={(e) => setText(normalize ? normalize(e.target.value) : e.target.value)} />;
  const saveEl = (
    <Button {...saveButton} busy={saving.busy} disabled={loadDisplay === "inlineError" && !data} onClick={() => void save()}>
      {saveLabel}
    </Button>
  );

  if (frame === "flat") {
    return (
      <SectionCard variant="flat" title={title} hint={hint}>
        <label className="flex items-center gap-3">
          <span className="text-sm">{caption}</span>
          {field}
          {saveEl}
        </label>
        {loadDisplay === "inlineError" && state.error && <ErrorNote message={state.error} />}
        {children}
      </SectionCard>
    );
  }

  return (
    <SectionCard icon={icon} title={title} hint={hint}>
      {loadDisplay === "gated" && <AsyncStatus state={state} />}
      {(loadDisplay !== "gated" || data) && (
        <>
          <div className={`flex ${wrap ? "flex-wrap " : ""}items-center gap-2`}>
            {field}
            {unit && <span className="text-xs text-ink-500">{unit}</span>}
            {saveEl}
            {extraActions}
          </div>
          {footer}
        </>
      )}
      {loadDisplay === "inlineError" && state.error && (
        <div className="mt-3">
          <ErrorNote message={state.error} />
        </div>
      )}
      {children}
    </SectionCard>
  );
}
