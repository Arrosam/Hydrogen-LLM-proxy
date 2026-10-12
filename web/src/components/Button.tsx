import type { ButtonHTMLAttributes, ReactNode } from "react";
import { ACTION_ICON } from "../lib/icons";

/** A Bootstrap icon. `name` may carry extra utility classes ("bi-key mr-1"). */
export function Icon({ name, className }: { name: string; className?: string }) {
  return <i className={`bi ${name}${className ? ` ${className}` : ""}`} />;
}

export type ButtonVariant = "primary" | "ghost" | "danger";
export type ButtonSize = "md" | "xs";

// Spelled out in full: Tailwind keeps a component class only when its whole
// name appears literally in the source, so a `btn-${variant}` template would
// drop these rules from the production CSS.
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  ghost: "btn-ghost",
  danger: "btn-danger",
};
const SIZE_CLASS: Record<ButtonSize, string> = { md: "", xs: "btn-xs" };

/** The class set of a button, for the rare non-<button> element styled as one (a router Link). */
export function buttonClass(variant: ButtonVariant, size: ButtonSize = "md", className = ""): string {
  return [VARIANT_CLASS[variant], className, SIZE_CLASS[size]].filter(Boolean).join(" ");
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon ("bi-plus-lg"). */
  icon?: string;
  /** The action is running: the button is disabled. */
  busy?: boolean;
  /** Also swap the icon for a spinner while busy. Off by default: several
   * Save buttons keep their check mark while disabled. */
  spinWhenBusy?: boolean;
  /** Icon drawn after the label instead of before it. */
  trailingIcon?: string;
  children?: ReactNode;
}

/**
 * The one button. `type` is NOT defaulted: most call sites omit it today and a
 * few set it, and that attribute is preserved per site.
 */
export function Button({
  variant,
  size = "md",
  icon,
  busy = false,
  spinWhenBusy = false,
  trailingIcon,
  className,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const leading = busy && spinWhenBusy ? ACTION_ICON.busy : icon;
  return (
    <button className={buttonClass(variant, size, className)} disabled={disabled || busy || undefined} {...rest}>
      {leading && <Icon name={leading} />}
      {children}
      {trailingIcon && <Icon name={trailingIcon} />}
    </button>
  );
}

/** The bare x that dismisses a modal or a toast. */
export function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="text-ink-500 hover:text-ink-200" onClick={onClick}>
      <Icon name={ACTION_ICON.close} />
    </button>
  );
}
