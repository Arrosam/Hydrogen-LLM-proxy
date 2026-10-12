import type { ReactNode } from "react";
import { Icon } from "./Button";

const HEADING_TONE = { normal: "text-ink-200", strong: "text-ink-100" } as const;

/**
 * The heading of a content card: a brand-coloured icon and a small bold title.
 * `tone` is the title's brightness; `className` carries the spacing under it
 * ("mb-3") where the card does not space its children itself.
 */
export function CardHeading({
  icon,
  tone = "normal",
  className,
  children,
}: {
  icon: string;
  tone?: keyof typeof HEADING_TONE;
  className?: string;
  children: ReactNode;
}) {
  return (
    <h3 className={`${className ? `${className} ` : ""}flex items-center gap-2 text-sm font-semibold ${HEADING_TONE[tone]}`}>
      <Icon name={icon} className="text-brand-400" />
      {children}
    </h3>
  );
}

const HINT_GAP = { md: "mb-3", lg: "mb-4" } as const;

/**
 * How a section is framed:
 * - "card": a settings card -- brand icon, h3 title, fine-print hint.
 * - "box": a sub-section inside a card -- bordered inset, muted icon, h4 title.
 * - "flat": the plain form -- a <section> with an h2 and a body-size hint, no
 *   icon, its children spaced by the section itself.
 */
export type SectionVariant = "card" | "box" | "flat";

export interface SectionCardProps {
  variant?: SectionVariant;
  /** Leading icon of the title. Not drawn by the "flat" variant. */
  icon?: string;
  title: string;
  hint: ReactNode;
  /** Space between the hint and the body ("card" and "box"). */
  hintGap?: keyof typeof HINT_GAP;
  /** Extra classes of the frame ("mt-4"). */
  className?: string;
  children?: ReactNode;
}

/** A titled, explained block of a settings-style page: frame + title row + hint + body. */
export function SectionCard({ variant = "card", icon, title, hint, hintGap = "md", className, children }: SectionCardProps) {
  if (variant === "flat") {
    return (
      <section className="card mb-5 space-y-3 p-5">
        <h2 className="font-semibold">{title}</h2>
        <p className="text-sm text-ink-400">{hint}</p>
        {children}
      </section>
    );
  }
  const box = variant === "box";
  const frame = box ? "rounded-lg border border-ink-800 bg-ink-950/40 p-4" : "card card-pad mt-6";
  return (
    <div className={`${className ? `${className} ` : ""}${frame}`}>
      <div className="mb-1 flex items-center gap-2">
        {icon && <Icon name={icon} className={box ? "text-ink-400" : "text-brand-400"} />}
        {box ? <h4 className="text-sm font-medium text-ink-200">{title}</h4> : <h3 className="font-medium text-ink-100">{title}</h3>}
      </div>
      <p className={`${HINT_GAP[hintGap]} text-xs text-ink-500`}>{hint}</p>
      {children}
    </div>
  );
}
