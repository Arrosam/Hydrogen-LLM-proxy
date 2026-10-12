import { useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { ACTION_ICON } from "../lib/icons";
import { Button, Icon } from "./Button";

/** Padding + type size of a chip. "fine" is the 11px one inside dense editors;
 * "md" is the roomier settings-card one. */
const CHIP_SIZE = {
  fine: "px-2 py-0.5 text-[11px]",
  xs: "px-2 py-0.5 text-xs",
  md: "px-3 py-1 text-xs",
} as const;

/** How an unselected chip reads. "muted" is the default; "soft" is one step
 * brighter (the language picker). */
const CHIP_OFF = {
  muted: "border border-ink-700 bg-ink-900 text-ink-400 hover:text-ink-200",
  soft: "border border-ink-700 bg-ink-900 text-ink-300 hover:text-ink-100",
} as const;

const CHIP_ON = "bg-brand-600 text-white";

export type ChipSize = keyof typeof CHIP_SIZE;
export type ChipTone = keyof typeof CHIP_OFF;

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active: boolean;
  size?: ChipSize;
  tone?: ChipTone;
}

/** A small toggle button: filled when active, outlined when not. */
export function Chip({ active, size = "xs", tone = "muted", className, children, ...rest }: ChipProps) {
  return (
    <button
      type="button"
      className={`rounded-md ${CHIP_SIZE[size]} font-medium transition-colors ${active ? CHIP_ON : CHIP_OFF[tone]}${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentOption<T>[];
  /**
   * - "chips": separate `Chip`s in a row (overrides mode switch, language picker).
   * - "joined": borderless segments inside one bordered pill (log payload view).
   * - "buttons": equal-width primary/ghost `Button`s (bench transport / target kind).
   */
  variant?: "chips" | "joined" | "buttons";
  /** Chip size and tone, for the "chips" variant. */
  size?: ChipSize;
  tone?: ChipTone;
  /** Gap between chips ("chips" variant): tight inside an editor, loose on a card. */
  gap?: "tight" | "loose";
  /** Disables every segment. */
  disabled?: boolean;
}

const CHIPS_GAP = { tight: "gap-1", loose: "gap-2" } as const;

/** Pick exactly one of a few options. */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  variant = "chips",
  size,
  tone,
  gap = "tight",
  disabled,
}: SegmentedControlProps<T>) {
  if (variant === "joined") {
    return (
      <div className="inline-flex rounded-lg border border-ink-700 p-0.5 text-xs">
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            disabled={disabled || o.disabled || undefined}
            className={`rounded-md px-2.5 py-1 font-medium capitalize transition-colors ${
              value === o.value ? CHIP_ON : "text-ink-400 hover:text-ink-200"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    );
  }
  if (variant === "buttons") {
    return (
      <div className="flex gap-2">
        {options.map((o) => (
          <Button
            key={o.value}
            type="button"
            variant={value === o.value ? "primary" : "ghost"}
            size="xs"
            className="flex-1"
            icon={o.icon}
            disabled={disabled || o.disabled}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </Button>
        ))}
      </div>
    );
  }
  return (
    <div className={`flex items-center ${CHIPS_GAP[gap]}`}>
      {options.map((o) => (
        <Chip
          key={o.value}
          active={value === o.value}
          size={size}
          tone={tone}
          disabled={disabled || o.disabled || undefined}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <Icon name={o.icon} className="mr-1" />}
          {o.label}
        </Chip>
      ))}
    </div>
  );
}

export interface ChipOption<T> {
  /** What is stored and sent. */
  value: T;
  /** What the user reads. */
  label: string;
}

export interface ChipCustomEntry<T> {
  /** The value a typed entry stands for, or null when it is not acceptable. */
  parse: (raw: string) => T | null;
  placeholder: string;
  addLabel: string;
  hint: string;
  inputMode?: InputHTMLAttributes<HTMLInputElement>["inputMode"];
}

/**
 * Pick any number of values: preset chips toggle on click; with `custom`, a
 * text box adds values outside the presets. Selected values that are not
 * presets show as filled chips that remove themselves on click -- which also
 * surfaces a bad stored value so it can be clicked away.
 */
export function ChipMultiSelect<T extends string | number>({
  options,
  selected,
  onToggle,
  custom,
  removeTitle,
}: {
  options: readonly ChipOption<T>[];
  selected: readonly T[];
  onToggle: (value: T) => void;
  custom?: ChipCustomEntry<T>;
  /** Tooltip of a removable (non-preset) chip. */
  removeTitle: string;
}) {
  const [input, setInput] = useState("");

  const addCustom = (): void => {
    const raw = input.trim();
    if (!raw || !custom) return;
    const value = custom.parse(raw);
    if (value === null) return;
    if (!selected.includes(value)) onToggle(value);
    setInput("");
  };

  const presetValues = options.map((o) => o.value);
  const extras = selected.filter((s) => !presetValues.includes(s));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <Chip key={String(o.value)} active={selected.includes(o.value)} onClick={() => onToggle(o.value)}>
            {o.label}
          </Chip>
        ))}
      </div>

      {custom && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            inputMode={custom.inputMode}
            className="input w-32 text-xs"
            placeholder={custom.placeholder}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCustom();
              }
            }}
          />
          <Button type="button" variant="ghost" size="xs" icon={ACTION_ICON.add} onClick={addCustom} disabled={!input.trim()}>
            {custom.addLabel}
          </Button>
          <span className="text-[11px] text-ink-500">{custom.hint}</span>
        </div>
      )}

      {extras.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {extras.map((c) => (
            <button
              key={String(c)}
              type="button"
              onClick={() => onToggle(c)}
              className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-brand-500"
              title={removeTitle}
            >
              {String(c)}
              <Icon name={ACTION_ICON.close} className="text-[10px]" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const REMOVE_TONE = { faint: "text-ink-600", muted: "text-ink-500" } as const;

/**
 * A pill holding a value plus an x that removes it. `mono` is the form for a
 * bare identifier (monospace, brighter text); `removeTone` is the resting
 * colour of the x.
 */
export function RemovableChip({
  onRemove,
  mono,
  removeTone = "faint",
  removeTitle,
  disabled,
  children,
}: {
  onRemove: () => void;
  mono?: boolean;
  removeTone?: keyof typeof REMOVE_TONE;
  removeTitle?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1 ${mono ? "font-mono text-xs text-ink-200" : "text-xs"}`}
    >
      {children}
      <button className={`${REMOVE_TONE[removeTone]} hover:text-red-400`} title={removeTitle} disabled={disabled} onClick={onRemove}>
        <Icon name={ACTION_ICON.close} />
      </button>
    </span>
  );
}
