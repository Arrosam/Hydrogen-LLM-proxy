import { useEffect, useState } from "react";
import { intInput, selectAll } from "../lib/input";

/**
 * A whole number that is always set. The field is a text input (no spinner)
 * that selects its content on focus and on click; empty or non-numeric text
 * becomes `fallback`, and nothing goes below `min`.
 */
export function IntInput({
  value,
  onChange,
  fallback,
  min,
}: {
  value: number;
  onChange: (value: number) => void;
  fallback: number;
  min?: number;
}) {
  return (
    <input
      className="input"
      type="text"
      inputMode="numeric"
      value={value}
      onFocus={selectAll}
      onClick={selectAll}
      onChange={(e) => onChange(intInput(e.target.value, fallback, min))}
    />
  );
}

/**
 * A number box (native spinner, `min` / `max`) over a whole number that is
 * always set and always inside `limits`. The text is the user's while they
 * type -- clamping each keystroke would turn "5" on the way to "500" into the
 * minimum -- but the value handed on is clamped at once: an emptied or
 * non-numeric box stands for `fallback`. Leaving the field shows what was kept.
 */
export function BoundedIntInput({
  value,
  onChange,
  limits,
  fallback,
}: {
  value: number;
  onChange: (value: number) => void;
  limits: { min: number; max: number };
  fallback: number;
}) {
  const bounded = (raw: string): number => Math.min(limits.max, intInput(raw, fallback, limits.min));
  const [text, setText] = useState(String(value));
  useEffect(() => {
    // Re-sync only when the value was replaced from outside, not when it is
    // merely the clamped form of what is being typed.
    if (bounded(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      className="input"
      type="number"
      min={limits.min}
      max={limits.max}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(bounded(e.target.value));
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

const digitsOnly = (raw: string): string => raw.replace(/[^\d]/g, "");

/**
 * A whole number that may be left unset (empty = `undefined`, shown as the
 * placeholder). Anything but digits is stripped as it is typed; there is no
 * lower bound.
 */
export function OptionalIntInput({
  value,
  onChange,
  placeholder,
}: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  placeholder?: string;
}) {
  // Hold the raw text so intermediate values aren't collapsed by the numeric
  // round-trip; only re-sync from the prop when it truly differs.
  const [text, setText] = useState<string>(value == null ? "" : String(value));
  useEffect(() => {
    const cur = text.trim() === "" ? undefined : Number(text);
    if (cur !== value && !(Number.isNaN(cur as number) && value === undefined)) {
      setText(value == null ? "" : String(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      className="input"
      type="text"
      inputMode="numeric"
      value={text}
      placeholder={placeholder}
      onFocus={selectAll}
      onChange={(e) => {
        const cleaned = digitsOnly(e.target.value);
        setText(cleaned);
        if (cleaned.trim() === "") return onChange(undefined);
        const n = Number(cleaned);
        onChange(Number.isFinite(n) ? n : undefined);
      }}
    />
  );
}
