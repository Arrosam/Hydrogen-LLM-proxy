import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

const MONO = "font-mono text-xs";

const controlClass = (base: string, mono: boolean | undefined, className: string | undefined): string =>
  [base, mono ? MONO : "", className ?? ""].filter(Boolean).join(" ");

/** An `.input`. `mono` is the small monospace look of ids, URLs, hosts and numbers. */
export function TextInput({ mono, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input className={controlClass("input", mono, className)} {...rest} />;
}

/** A multi-line `.input`. */
export function TextArea({ mono, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return <textarea className={controlClass("input", mono, className)} {...rest} />;
}

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
  /** React key of the option, for a list whose values may repeat (names being typed). Default: the value. */
  key?: string | number;
}

export interface SelectProps<T extends string | number>
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange"> {
  value: T | "";
  /** Receives the chosen option's value in its own type (a numeric option list yields numbers). */
  onChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  /**
   * A leading option with the empty value ("Direct connection", "Select...").
   * Choosing it reports that same empty value `""` -- whatever the list's type,
   * never a made-up id 0 -- so a caller that offers one tests for a falsy value.
   */
  placeholder?: string;
}

/** Options whose label is their value: a list of names. */
export const nameOptions = (names: readonly string[]): SelectOption<string>[] => names.map((name) => ({ value: name, label: name }));

/** A `.select` over an option list. */
export function Select<T extends string | number>({ value, onChange, options, placeholder, className, ...rest }: SelectProps<T>) {
  const numeric = typeof options[0]?.value === "number";
  return (
    <select
      className={controlClass("select", false, className)}
      value={value}
      onChange={(e) => onChange((numeric && e.target.value !== "" ? Number(e.target.value) : e.target.value) as T)}
      {...rest}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.key ?? o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

const CHECKBOX_SIZE = { sm: "gap-2 text-sm", xs: "gap-1.5 text-xs" } as const;

/** A checkbox with its caption on one row. */
export function CheckboxLabel({
  checked,
  onChange,
  size = "sm",
  className,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  size?: keyof typeof CHECKBOX_SIZE;
  /** Extra classes of the row ("mb-2"). */
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`${className ? `${className} ` : ""}flex items-center ${CHECKBOX_SIZE[size]} text-ink-300`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}
