import type { ReactNode } from "react";
import { Icon } from "./Button";

const CHEVRON = { open: "bi-chevron-down", closed: "bi-chevron-right" } as const;

/** The down/right arrow of anything that expands. `className` is its spacing and tone. */
export function Chevron({ open, className = "text-ink-500" }: { open: boolean; className?: string }) {
  return <Icon name={open ? CHEVRON.open : CHEVRON.closed} className={className} />;
}

export interface DisclosureHeadingProps {
  open: boolean;
  onToggle: () => void;
  title: ReactNode;
  /** Heading level of the caption: "h3" on a card, "h4" inside one. */
  as?: "h3" | "h4";
  /** The toggle spans the row, so the whole line is the click target. */
  fullWidth?: boolean;
  /** Announce the state with `aria-expanded` (the log payload blocks do; the bench blocks do not). */
  announce?: boolean;
  /** Buttons on the right of the heading row (copy, edit). Their presence puts the heading in a spread row. */
  actions?: ReactNode;
}

/** A section caption that collapses what is under it: chevron + `label` heading. */
export function DisclosureHeading({ open, onToggle, title, as: Heading = "h4", fullWidth, announce, actions }: DisclosureHeadingProps) {
  const toggle = (
    <button
      type="button"
      className={`flex ${fullWidth ? "w-full " : ""}items-center gap-1.5 text-left`}
      onClick={onToggle}
      aria-expanded={announce ? open : undefined}
    >
      <Chevron open={open} />
      <Heading className="label m-0 cursor-pointer select-none">{title}</Heading>
    </button>
  );
  if (actions === undefined) return toggle;
  return (
    <div className="flex items-center justify-between">
      {toggle}
      {actions}
    </div>
  );
}
